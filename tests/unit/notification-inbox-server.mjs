// 通知の一覧（ADR 0149）をサーバー越しに（fake バックエンド）: 完了・失敗・あなた待ち（承認の成立と決着）が行になり、会話の既読・見ている会話（presence）で既読になる・
// bot の @あなた（チャンネルの投稿）が行になり、チャンネルの既読で既読になる・出来事 notificationsChanged が全接続へ・ops（notifications.list / count / markRead）・
// 再起動しても残り、再起動で消えた承認は決着する・会話を消すと行も消える。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'notification-inbox-server';
export const title = '通知の一覧をサーバー越しに: 完了・失敗・あなた待ち・@あなた が行になる・既読の整合・再起動で残る・会話を消すと消える・ops';

const until = async (fn, { ms = 15_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'notification-inbox-server-')));
  const servers = [], clients = [];
  try {
    const dataDir = path.join(tmp, 'data');
    const boot = async () => {
      const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_NOTIFY_MIN_TURN_MS: '0' }, dataDir, timeoutMs: 60_000 });
      const host = await open({ port: server.port, token: server.token });
      servers.push(server); clients.push(host);
      return { server, host, call: (op, args) => host.cmd('invoke', { op, args }) };
    };
    let { server, host, call } = await boot();
    const run = (prompt, sessionId = null) => host.runTurn({ prompt, sessionId, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    const list = (args) => call('notifications.list', args);

    // ---- 完了
    let from = host.mark();
    const done = await run('echo:終わった');
    const completedAt = host.since(from).find((e) => e.type === 'turnEnd' && e.sessionId === done.sessionId)?.completedAt;
    const doneRow = await until(async () => (await list()).items.find((x) => x.kind === 'done' && x.target.sessionId === done.sessionId), { label: '完了の行' });
    // 会話の題は控えた時点で決まっていなければ無い（最初のターンの終わりは題の生成より早いことがある）。画面は会話の一覧の題を先に使う
    t.ok('ターンの完了が行になる（未読・最後の発言の uuid・時刻は completedAt）', doneRow.unread === true && (doneRow.title === undefined || doneRow.title === 'echo:終わった') && typeof doneRow.target.uuid === 'string' && doneRow.at === completedAt, JSON.stringify(doneRow));
    const changed = host.since(from).find((e) => e.type === 'notificationsChanged');
    t.ok('notificationsChanged が { unread, waiting } で全接続へ（会話の一覧は作り直さない）', changed && changed.unread === 1 && changed.waiting === 0 && changed.sessionId === null, JSON.stringify(changed));
    t.ok('notifications.count が同じ件数を返す', JSON.stringify(await call('notifications.count', {})) === JSON.stringify({ unread: 1, waiting: 0 }));

    // 会話の既読（markRead）で通知も既読
    await host.cmd('markRead', { reads: [[done.sessionId, completedAt]] });
    t.ok('会話の既読（markRead）で、その完了の通知も既読になる', (await list()).items.find((x) => x.id === doneRow.id).unread === false && (await call('notifications.count', {})).unread === 0);

    // ---- あなた待ち（承認）
    from = host.mark();
    const asking = run('ask');
    const perm = await host.waitFor((e) => e.type === 'permission' && !e.relay, { from, ms: 15_000 });
    const waitRow = await until(async () => (await list({ filter: 'wait' })).items.find((x) => x.target.sessionId === perm.sessionId), { label: 'あなた待ちの行' });
    t.ok('承認が成立すると、あなた待ちの行（未読・待っている）になる。件数の waiting も 1', waitRow.unread === true && waitRow.ask === 'approval' && waitRow.resolvedAt === undefined && (await call('notifications.count', {})).waiting === 1);
    await host.cmd('resolvePermission', { id: perm.id, allow: true });
    await asking;
    const settled = await until(async () => { const x = (await list({ filter: 'wait' })).items.find((r) => r.id === waitRow.id); return x?.outcome ? x : null; }, { label: '決着' });
    t.ok('許可すると決着（outcome: allowed）。既読になり、waiting は 0', settled.outcome === 'allowed' && settled.unread === false && settled.resolvedAt > 0 && (await call('notifications.count', {})).waiting === 0);

    // 拒否・ターンの終了で取り消し
    from = host.mark();
    const denying = run('ask');
    const perm2 = await host.waitFor((e) => e.type === 'permission' && !e.relay, { from, ms: 15_000 });
    await host.cmd('resolvePermission', { id: perm2.id, allow: false });
    await denying;
    t.ok('拒否は denied', (await until(async () => (await list({ filter: 'wait' })).items.find((x) => x.outcome === 'denied'), { label: '拒否' })) !== null);

    // ---- 失敗
    const failed = await run('fail');
    const failRow = await until(async () => (await list()).items.find((x) => x.kind === 'failed' && x.target.sessionId === failed.sessionId), { label: '失敗の行' });
    t.ok('失敗が行になる（未読）', failRow.unread === true);

    // ---- 見ている会話: presence で、その会話の通知（あなた待ち・完了・失敗）が既読になる
    const before = (await call('notifications.count', {})).unread;
    await host.cmd('presence', { visible: true, sessionId: failed.sessionId });
    t.ok('その会話を見る（presence）と、その会話の未読の通知が既読になる', (await until(async () => (await list()).items.find((x) => x.id === failRow.id && x.unread === false), { label: '既読' })) && (await call('notifications.count', {})).unread < before);
    const watched = await run('echo:見ている', failed.sessionId);
    const watchedRow = await until(async () => (await list()).items.find((x) => x.kind === 'done' && x.target.sessionId === failed.sessionId), { label: '見ている会話の完了' });
    t.ok('見ている会話で終わったターンは、最初から既読で載る', watchedRow.unread === false && watched.sessionId === failed.sessionId);
    await host.cmd('presence', { visible: false, sessionId: failed.sessionId });

    // ---- ops: ids・all・ページ
    const fresh = await run('fail');
    await until(async () => (await list()).items.find((x) => x.kind === 'failed' && x.target.sessionId === fresh.sessionId), { label: '2 つ目の失敗' });
    const unreadIds = (await list()).items.filter((x) => x.unread).map((x) => x.id);
    const marked = await call('notifications.markRead', { ids: [unreadIds[0]] });
    t.ok('notifications.markRead（ids）で 1 件だけ既読。件数も返る', marked.changed === 1 && marked.unread === (await call('notifications.count', {})).unread);
    const page = await list({ limit: 2 });
    t.ok('notifications.list のページ（limit・hasMore・before）', page.items.length === 2 && page.hasMore === true && (await list({ limit: 2, before: page.items[1].seq })).items.every((x) => x.seq < page.items[1].seq));
    t.ok('不正な引数（limit 0・filter 違い）は INVALID で断る', await call('notifications.list', { limit: 0 }).then(() => false, () => true) && await call('notifications.list', { filter: 'x' }).then(() => false, () => true));

    // ---- @あなた（bot の投稿）。チャンネルの既読で既読
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev', members: [owl.id] });
    from = host.mark();
    const root = await call('channels.post', { channelId: dev.id, text: '@Owl echo:@あなた 確認してください' });
    const mention = await until(async () => (await list({ filter: 'mention' })).items.find((x) => x.target.channelId === dev.id), { ms: 20_000, label: '@あなた' });
    t.ok('bot の @あなた が行になる（書いた bot・チャンネル名・スレッドの題・投稿へ飛ぶ。未読）', mention.unread === true && mention.actor?.name === 'Owl' && mention.channelName === 'dev' && mention.target.threadId === root.id && typeof mention.target.postId === 'string' && mention.threadTitle.includes('@Owl'), JSON.stringify(mention));
    await call('channels.markRead', { channelId: dev.id, at: Date.now() });
    t.ok('チャンネルを既読にすると、その通知も既読になる', (await until(async () => (await list({ filter: 'mention' })).items.find((x) => x.id === mention.id && x.unread === false), { label: '既読' })) !== null);

    // ---- 再起動
    const ids = (await list({ limit: 100 })).items.map((x) => x.id).join();
    await server.stop();
    ({ server, host, call } = await boot());
    t.ok('再起動しても通知の一覧が残る', (await call('notifications.list', { limit: 100 })).items.map((x) => x.id).join() === ids);

    // 再起動で消えた承認（メモリにしか無い）は、決着させて起動する
    from = host.mark();
    const pending = run('ask');
    const perm3 = await host.waitFor((e) => e.type === 'permission' && !e.relay, { from, ms: 15_000 });
    pending.catch(() => {});
    await until(async () => (await call('notifications.count', {})).waiting === 1, { label: '承認の待ち' });
    await server.stop();
    ({ server, host, call } = await boot());
    const afterRestart = await call('notifications.list', { filter: 'wait', limit: 100 });
    t.ok('再起動で承認は消える。待っていたあなた待ちは取り消し（cancelled）で決着し、waiting は 0', afterRestart.waiting === 0 && afterRestart.items.find((x) => x.target.sessionId === perm3.sessionId)?.outcome === 'cancelled', JSON.stringify(afterRestart.items.map((x) => x.outcome)));

    // ---- 会話を消すと行も消える
    const all = (await call('notifications.list', { limit: 100 })).items;
    const victim = all.find((x) => x.kind === 'done' && x.target.sessionId === done.sessionId);
    t.ok('（前提）消す会話の行がある', !!victim);
    await host.cmd('deleteSession', { sessionId: done.sessionId });
    t.ok('会話を消すと、その会話の通知の行も消える', (await until(async () => (await call('notifications.list', { limit: 100 })).items.every((x) => x.target.sessionId !== done.sessionId), { label: '削除' })) === true);

    // ---- チャンネルをアーカイブすると行が消える
    await call('channels.archive', { channelId: dev.id, on: true });
    t.ok('チャンネルをアーカイブすると、そのチャンネルの通知の行も消える', (await until(async () => (await call('notifications.list', { limit: 100 })).items.every((x) => x.target.channelId !== dev.id), { label: 'アーカイブ' })) === true);
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
