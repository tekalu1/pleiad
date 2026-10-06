// 通知の一覧（ADR 9102）: 書き込み（重複を作らない・いま見ている会話は既読で載せる）・絞り込みとページ・件数・既読の整合（通知ごと・会話の既読・チャンネルの既読・見た会話）・
// あなた待ちの決着・再起動で残る・上限（件数・日数）・会話の削除とチャンネルのアーカイブで消える・出来事から行を作る規則（完了・失敗・あなた待ち・@あなた）。
// 保存は一時のデータ置き場の DB（notifications 表）、会話・チャンネルは身代わり。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotifications, completionKind, permissionOutcome, NOTIFICATION_MAX, NOTIFICATION_KEEP_MS } from '../../core/notifications.mjs';
import { createNotificationSources } from '../../core/notification-sources.mjs';
import { HIDDEN_BOT_KINDS } from '../../core/channels/types.mjs';

export const name = 'notification-inbox';
export const title = '通知の一覧: 重複しない・見ている会話は既読・絞り込みとページ・既読の整合（通知・会話・チャンネル）・あなた待ちの決着・再起動で残る・上限・削除で消える・出来事から作る規則';

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notifications-'));
  let clock = new Date(2026, 9, 6, 12, 0, 0).getTime();
  const now = () => clock;
  const events = [];
  let inbox = createNotifications({ dataDir: dir, emit: (e) => events.push(e), now });
  try {
    // ---- 載せる・重複
    const a = inbox.add({ kind: 'done', dedupeKey: 'done:s1:100', at: 100 + clock, sessionId: 's1', data: { title: 'ログイン画面のバグ調査', uuid: 'u-1' } });
    t.ok('完了を載せる（未読・飛び先の会話と発言の uuid・会話の題）', a && a.unread === true && a.target.sessionId === 's1' && a.target.uuid === 'u-1' && a.title === 'ログイン画面のバグ調査');
    t.ok('同じ dedupeKey は載せない（null）。件数は 1 のまま', inbox.add({ kind: 'done', dedupeKey: 'done:s1:100', at: clock, sessionId: 's1', data: {} }) === null && inbox.counts().unread === 1);
    t.ok('載せるたびに notificationsChanged が { unread, waiting } で出る（重複では出ない）', events.length === 1 && events[0].type === 'notificationsChanged' && events[0].unread === 1 && events[0].waiting === 0);
    t.ok('種類が決まりの外・dedupeKey なしは投げる', (() => { try { inbox.add({ kind: 'routine', dedupeKey: 'x', data: {} }); return false; } catch { return true; } })() && (() => { try { inbox.add({ kind: 'done', data: {} }); return false; } catch { return true; } })());
    const seen = inbox.add({ kind: 'failed', dedupeKey: 'failed:s2:1', at: clock, sessionId: 's2', viewing: true, data: { title: '見ている会話' } });
    t.ok('いま見ている会話で起きたものは既読で載せる（未読の件数は増えない）', seen && seen.unread === false && inbox.counts().unread === 1);

    // ---- あなた待ち・決着
    const w = inbox.add({ kind: 'wait', dedupeKey: 'wait:card-1', sessionId: 's3', data: { ask: 'approval', actor: { kind: 'bot', name: 'Owl', icon: '🦉' }, title: '依存の更新' } });
    t.ok('あなた待ちは未読の「待っている」件数に数える（waiting）', w && inbox.counts().waiting === 1 && inbox.counts().unread === 2 && w.actor.name === 'Owl' && w.ask === 'approval');
    t.ok('決着すると resolvedAt・outcome が付き、既読になる。waiting は 0。決着済みを重ねて決着させても false', inbox.settle('wait:card-1', 'allowed') === true && inbox.settle('wait:card-1', 'denied') === false
      && inbox.counts().waiting === 0 && inbox.counts().unread === 1 && (() => { const x = inbox.list({ filter: 'wait' }).items[0]; return x.resolvedAt != null && x.outcome === 'allowed' && x.unread === false; })());

    // ---- @あなた・絞り込み・並び
    clock += 1000;
    inbox.add({ kind: 'mention', dedupeKey: 'mention:p1', at: clock, channelId: 'c1', data: { threadId: 't1', postId: 'p1', actor: { kind: 'bot', name: 'Lynx' }, channelName: 'release-ci', threadTitle: 'CI が落ちています' } });
    const all = inbox.list();
    t.ok('載せた順の逆（新しいものが先）で返る', all.items.length === 4 && all.items.every((x, i) => i === 0 || all.items[i - 1].seq > x.seq) && all.items[0].kind === 'mention');
    t.ok('飛び先（チャンネル・スレッド・投稿）と名前の控えが載る', all.items[0].target.channelId === 'c1' && all.items[0].target.threadId === 't1' && all.items[0].target.postId === 'p1' && all.items[0].channelName === 'release-ci' && all.items[0].threadTitle === 'CI が落ちています');
    t.ok('絞り込み: あなた待ち・@あなた', inbox.list({ filter: 'wait' }).items.map((x) => x.kind).join() === 'wait' && inbox.list({ filter: 'mention' }).items.map((x) => x.kind).join() === 'mention');
    const page1 = inbox.list({ limit: 2 });
    const page2 = inbox.list({ limit: 2, before: page1.items.at(-1).seq });
    t.ok('ページ: limit で区切り、before（seq）で続きを取る。hasMore で続きがあるか分かる', page1.items.length === 2 && page1.hasMore === true && page2.items.length === 2 && page2.hasMore === false
      && new Set([...page1.items, ...page2.items].map((x) => x.id)).size === 4);

    // ---- 既読の整合
    t.ok('通知ごとの既読（ids）。既読済みを重ねても変えない', inbox.markRead({ ids: [all.items[0].id] }).changed === 1 && inbox.markRead({ ids: [all.items[0].id] }).changed === 0);
    inbox.add({ kind: 'done', dedupeKey: 'done:s4:1', at: clock, sessionId: 's4', data: { title: 'A' } });
    inbox.add({ kind: 'failed', dedupeKey: 'failed:s4:2', at: clock + 10, sessionId: 's4', data: { title: 'A' } });
    t.ok('会話の既読が進むと、その会話の完了・失敗の通知を upTo まで既読にする（それより後の分は未読のまま）', inbox.markSession('s4', clock + 5) === 1
      && inbox.list().items.find((x) => x.id && x.target.sessionId === 's4' && x.kind === 'failed').unread === true);
    inbox.add({ kind: 'wait', dedupeKey: 'wait:card-2', sessionId: 's5', data: { ask: 'question' } });
    t.ok('markSession は既定で完了・失敗だけ。あなた待ちには効かない', inbox.markSession('s5', Number.MAX_SAFE_INTEGER) === 0 && inbox.counts().waiting === 1);
    t.ok('その会話を見たら（viewSession）、あなた待ちも含めて既読になる', inbox.viewSession('s5') === 1 && inbox.counts().waiting === 0);
    inbox.add({ kind: 'mention', dedupeKey: 'mention:p9', at: clock + 50, channelId: 'c2', data: { threadId: 't9', postId: 'p9' } });
    inbox.add({ kind: 'failed', dedupeKey: 'failed:s6:1', at: clock + 20, sessionId: 's6', channelId: 'c2', data: { threadId: 't9' } });
    t.ok('チャンネルの既読（readAt）が進むと、そのチャンネルの通知を readAt まで既読にする（bot のスレッドの失敗も）', inbox.markChannel('c2', clock + 30) === 1
      && inbox.list().items.find((x) => x.target.postId === 'p9').unread === true && inbox.list().items.find((x) => x.target.sessionId === 's6').unread === false);
    t.ok('すべて既読（all）で未読は 0', inbox.markRead({ all: true }).changed > 0 && inbox.counts().unread === 0 && inbox.counts().waiting === 0);

    // ---- 再起動
    const before = inbox.list().items.map((x) => x.id).join();
    inbox.close();
    inbox = createNotifications({ dataDir: dir, emit: (e) => events.push(e), now });
    t.ok('再起動（DB を開き直し）しても行・既読・決着が残る', inbox.list().items.map((x) => x.id).join() === before && inbox.list({ filter: 'wait' }).items.some((x) => x.outcome === 'allowed'));
    inbox.add({ kind: 'wait', dedupeKey: 'wait:old', sessionId: 's7', data: { ask: 'approval' } });
    t.ok('起動時に、決着していないあなた待ちを（既読のものも）取り消しで決着させる（承認はメモリにしか無い）', inbox.settleAllWaiting('cancelled') === 2 && inbox.counts().waiting === 0 && inbox.list({ filter: 'wait' }).items.find((x) => x.target.sessionId === 's7').outcome === 'cancelled');

    // ---- 削除
    const n = inbox.counts();
    t.ok('会話を消すとその会話の行が消える', inbox.removeSession('s4') === 2 && inbox.list().items.every((x) => x.target.sessionId !== 's4') && n.unread === 0);
    t.ok('チャンネルをアーカイブすると（removeChannel）そのチャンネルの行が消える', inbox.removeChannel('c2') === 2 && inbox.list().items.every((x) => x.target.channelId !== 'c2'));

    // ---- 上限
    const room = await fs.mkdtemp(path.join(os.tmpdir(), 'notifications-cap-'));
    const cap = createNotifications({ dataDir: room, now });
    try {
      for (let i = 0; i < NOTIFICATION_MAX + 20; i++) { clock += 1; cap.add({ kind: 'done', dedupeKey: `done:c:${i}`, at: clock, sessionId: `c${i}`, viewing: i < 10, data: {} }); }
      const items = cap.list({ limit: 100 }).items;
      t.ok(`件数は ${NOTIFICATION_MAX} 件まで。新しい方を残す`, (() => { const rows = []; let before = null; for (;;) { const p = cap.list({ limit: 100, before }); rows.push(...p.items); if (!p.hasMore) break; before = p.items.at(-1).seq; } return rows.length === NOTIFICATION_MAX && rows[0].target.sessionId === `c${NOTIFICATION_MAX + 19}`; })());
      t.ok('捨てるのは既読が先（先頭の 10 件は既読だったので、未読の古い分より先に消える）', cap.list({ limit: 100 }).items.length === 100 && items.every((x) => x.unread));
      clock += NOTIFICATION_KEEP_MS + 1000;
      t.ok(`${NOTIFICATION_KEEP_MS / 86_400_000} 日より古い行は、次に載せるとき消える。古い at の出来事は載せない`,
        cap.add({ kind: 'done', dedupeKey: 'done:ancient', at: 1, sessionId: 'z', data: {} }) === null
        && cap.add({ kind: 'done', dedupeKey: 'done:fresh', at: clock, sessionId: 'z', data: {} }) !== null && cap.list({ limit: 100 }).items.length === 1);
    } finally { cap.close(); await fs.rm(room, { recursive: true, force: true }); }

    // ---- 規則
    t.ok('completionKind: 通常の会話は完了=done・失敗=failed。中断は載せない', completionKind({ outcome: 'ok' }) === 'done' && completionKind({ outcome: 'error' }) === 'failed' && completionKind({ outcome: 'aborted' }) === null);
    t.ok('completionKind: bot の会話は失敗だけ。隠れた会話・委譲の子は載せない', completionKind({ outcome: 'ok', bot: { kind: 'thread' } }) === null && completionKind({ outcome: 'error', bot: { kind: 'thread' }, hiddenKinds: HIDDEN_BOT_KINDS }) === 'failed'
      && completionKind({ outcome: 'error', bot: { kind: 'pulse' }, hiddenKinds: HIDDEN_BOT_KINDS }) === null && completionKind({ outcome: 'error', delegation: { parentSessionId: 'p' } }) === null);
    t.ok('permissionOutcome: 許可=allowed・質問に答えた=answered・拒否=denied・ターンの終了・中断=cancelled', permissionOutcome({ allow: true }) === 'allowed' && permissionOutcome({ allow: true }, { kind: 'question' }) === 'answered'
      && permissionOutcome({ allow: false }) === 'denied' && permissionOutcome({ allow: false, messageKey: 'aborted' }) === 'cancelled');

    // ---- 出来事から作る（sources）
    const sessions = {
      chat: { title: 'ホームの会話' },
      bot: { bot: { botId: 'b_kit', kind: 'thread', channelId: 'c_dev', threadId: 'p_root' } },
      pulse: { bot: { botId: 'b_kit', kind: 'pulse', channelId: null, threadId: null } },
      child: { delegation: { parentSessionId: 'chat' } },
    };
    const lookups = { views: new Set() };
    const store = { get: async (id) => sessions[id] ?? {} };
    const channels = {
      get: async ({ channelId }) => ({ id: channelId, kind: 'channel', name: 'dev' }),
      getPost: async ({ postId }) => ({ id: postId, text: '\n  ヘッダーの余白を揃える\n詳細' }),
    };
    const bots = { get: async ({ botId }) => ({ id: botId, name: 'Kit', icon: '🦊' }) };
    const sources = createNotificationSources({ inbox, store, viewing: (id) => lookups.views.has(id), titleOf: async (id) => (id === 'chat' ? 'ログイン画面のバグ調査' : ''), channels: () => channels, bots: () => bots, hiddenKinds: HIDDEN_BOT_KINDS });
    clock += 1000;
    await sources.completion({ sessionId: 'chat', outcome: 'ok', completedAt: clock, uuid: 'uu-1' });
    await sources.completion({ sessionId: 'chat', outcome: 'ok', completedAt: clock, uuid: 'uu-1' });
    const done = inbox.list().items.find((x) => x.target.uuid === 'uu-1');
    t.ok('完了: 会話の題と最後の発言の uuid を持つ行が 1 件（同じ completedAt の再通知は重複しない）', done && done.kind === 'done' && done.title === 'ログイン画面のバグ調査' && done.at === clock && inbox.list().items.filter((x) => x.target.uuid === 'uu-1').length === 1);
    lookups.views.add('chat');
    await sources.completion({ sessionId: 'chat', outcome: 'error', completedAt: clock + 5 });
    t.ok('見ている会話の失敗は既読で載る', inbox.list().items.find((x) => x.kind === 'failed' && x.at === clock + 5)?.unread === false);
    const beforeCount = inbox.list({ limit: 100 }).items.length;
    await sources.completion({ sessionId: 'child', outcome: 'error', completedAt: clock + 6 });
    await sources.completion({ sessionId: 'pulse', outcome: 'error', completedAt: clock + 7 });
    await sources.completion({ sessionId: 'bot', outcome: 'ok', completedAt: clock + 8 });
    t.ok('委譲の子・隠れた bot の会話・bot の完了は載せない', inbox.list({ limit: 100 }).items.length === beforeCount);
    await sources.completion({ sessionId: 'bot', outcome: 'error', completedAt: clock + 9, uuid: 'uu-bot' });
    const botFail = inbox.list().items.find((x) => x.kind === 'failed' && x.at === clock + 9);
    t.ok('bot の会話の失敗は、チャンネル・スレッドへ飛ぶ（会話の uuid は持たない）。bot の名前・チャンネル名・スレッドの題（根の投稿の最初の行）を控える',
      botFail && botFail.target.channelId === 'c_dev' && botFail.target.threadId === 'p_root' && !botFail.target.uuid && botFail.actor?.name === 'Kit' && botFail.channelName === 'dev' && botFail.threadTitle === 'ヘッダーの余白を揃える');

    lookups.views.delete('chat');
    await sources.permissionOpened({ id: 'card-9', sessionId: 'child', kind: 'tool', via: 'chat' });
    const asked = inbox.list({ filter: 'wait' }).items.find((x) => x.target.sessionId === 'chat' && x.outcome === undefined);
    t.ok('あなた待ち: 委譲の子の承認は、カードが出ている依頼元の会話へ飛ぶ。未読', asked && asked.unread === true && asked.ask === 'approval');
    await sources.permissionSettled({ id: 'card-9', answer: { allow: true }, kind: 'tool' });
    t.ok('決着で「承認済み」（allowed）・既読', (() => { const x = inbox.list({ filter: 'wait' }).items.find((r) => r.id === asked.id); return x.outcome === 'allowed' && x.unread === false && x.resolvedAt != null; })());
    const waitBefore = inbox.counts();
    await sources.permissionOpened({ id: 'card-hidden', sessionId: 'pulse', kind: 'tool' });
    t.ok('隠れた会話の承認は載せない', inbox.counts().waiting === waitBefore.waiting);

    const post = (over = {}) => ({ type: 'channelPost', op: 'add', post: { id: 'p_m1', channelId: 'c_dev', threadId: 'p_root', at: clock + 100, author: { kind: 'bot', botId: 'b_kit' }, text: 'どうぞ @あなた', mentions: ['you'], ...over } });
    await sources.observe(post());
    await sources.observe(post({ op: 'edit' }));
    const men = inbox.list({ filter: 'mention' }).items;
    t.ok('@あなた: 人以外の投稿で 1 件（編集で重複しない）。書いた bot・チャンネル・スレッドの題・投稿へ飛ぶ', men.length === 1 && men[0].actor.name === 'Kit' && men[0].channelName === 'dev' && men[0].threadTitle === 'ヘッダーの余白を揃える' && men[0].target.postId === 'p_m1' && men[0].target.threadId === 'p_root');
    await sources.observe(post({ op: 'add', post: undefined }));
    await sources.observe({ type: 'channelPost', op: 'add', post: { ...post().post, id: 'p_h', author: { kind: 'human' } } });
    await sources.observe({ type: 'channelPost', op: 'add', post: { ...post().post, id: 'p_d', deletedAt: 1 } });
    await sources.observe({ type: 'channelPost', op: 'add', post: { ...post().post, id: 'p_n', mentions: ['b_kit'] } });
    t.ok('人の投稿・削除済み・@あなた でない投稿は載せない', inbox.list({ filter: 'mention' }).items.length === 1);
    await sources.observe({ type: 'channelPost', op: 'add', post: { ...post().post, id: 'p_top', threadId: null } });
    t.ok('流れの根の投稿（threadId なし）への @あなた は、その投稿がスレッドの根', inbox.list({ filter: 'mention' }).items.find((x) => x.target.postId === 'p_top')?.target.threadId === 'p_top');
    await sources.observe({ type: 'channelRead', channelId: 'c_dev', readAt: clock + 1000 });
    t.ok('channelRead（チャンネルの既読）で、そのチャンネルの通知が既読になる', inbox.list({ filter: 'mention' }).items.every((x) => x.unread === false) && inbox.list().items.find((x) => x.target.threadId === 'p_root' && x.kind === 'failed').unread === false);
    await sources.observe({ type: 'channelsChanged', channel: { id: 'c_dev', archivedAt: 5 } });
    t.ok('channelsChanged でアーカイブされたチャンネルの行は消える', inbox.list({ limit: 100 }).items.every((x) => x.target.channelId !== 'c_dev'));
    await sources.sessionRemoved('chat');
    t.ok('会話を消すと（sessionRemoved）その会話の行が消える', inbox.list({ limit: 100 }).items.every((x) => x.target.sessionId !== 'chat'));
    const broken = createNotificationSources({ inbox: { add() { throw new Error('boom'); } }, store, log: () => {} });
    t.ok('書き込みの失敗は呼び出し元へ投げない（ターン・承認・投稿を止めない）', (await broken.completion({ sessionId: 'chat', outcome: 'ok', completedAt: 1 })) === null);
  } finally {
    inbox.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
