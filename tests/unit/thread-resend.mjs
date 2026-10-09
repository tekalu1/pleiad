// スレッドの送り直し（channels.resend。ADR 0157 の 4.5・ADR 0102）: あなたの返信 H を新しい本文で送り直すと、H と後ろを取り下げ、
// スレッドの bot の会話を H の手前まで巻き戻してから新しい本文を書く。H より後に会話が始まった bot はスレッドから外す。
// 走っている bot は stopRunning が無ければ断る。根は送り直せない。取り下げた投稿は流れ・スレッド・要約の件数から消える。
// fake バックエンドのサーバー越しに通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'thread-resend';
export const title = 'スレッドの送り直し: 取り下げ・bot の会話の巻き戻し・後から入った bot を外す・走っている bot・根は断る';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(60); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-resend-'));
  let server = null, c = null;
  try {
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(tmp, 'data'), timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const call = (op, args) => c.cmd('invoke', { op, args });
    const fails = async (op, args) => { try { await call(op, args); return null; } catch (e) { return String(e?.message ?? e); } };
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const lynx = await call('bots.create', { name: 'Lynx', icon: '🐺', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev', members: [owl.id, lynx.id] });
    const read = (threadId) => call('channels.read', { channelId: dev.id, threadId });
    const done = async (root, bot) => (await read(root)).posts.filter((p) => p.turn?.botId === bot.id && p.state === 'done');
    const idle = (root) => until(async () => { const th = (await read(root)).threads[0]; return th?.state === 'idle' ? th : null; }, { label: 'idle' });

    const root = await call('channels.post', { channelId: dev.id, text: '@Owl echo:A' });
    await until(async () => (await done(root.id, owl)).length === 1, { label: 'A' });
    await idle(root.id);
    const h = await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:B' });
    await until(async () => (await done(root.id, owl)).length === 2, { label: 'B' });
    await idle(root.id);
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: '@Lynx echo:C' });
    await until(async () => (await done(root.id, lynx)).length === 1, { label: 'C' });
    const th = await idle(root.id);
    const owlSession = th.sessions[owl.id];
    t.ok('前提: Owl と Lynx がスレッドの会話を持つ', Boolean(owlSession) && Boolean(th.sessions[lynx.id]));

    t.ok('根は送り直せない', Boolean(await fails('channels.resend', { channelId: dev.id, postId: root.id, text: 'echo:X' })));
    const botPost = (await done(root.id, owl))[0];
    t.ok('bot の投稿は送り直せない（自分の投稿だけ）', Boolean(await fails('channels.resend', { channelId: dev.id, postId: botPost.id, text: 'echo:X' })));

    // ---- 送り直す
    const made = await call('channels.resend', { channelId: dev.id, postId: h.id, text: 'echo:B2', clientId: 'resend-0001' });
    t.ok('新しい本文の投稿が書かれる', made.text === 'echo:B2' && made.threadId === root.id);
    const after = await read(root.id);
    t.ok('H と後ろの投稿は取り下げられる（スレッドから消える）', !after.posts.some((p) => [h.id].includes(p.id) || p.text === 'C' || p.text === 'B' || p.text === '@Lynx echo:C'),
      JSON.stringify(after.posts.map((p) => p.text)));
    t.ok('H の前の投稿は残る（根・Owl の A の返事）', after.posts[0].id === root.id && after.posts.some((p) => p.id === botPost.id));
    await until(async () => (await done(root.id, owl)).some((p) => p.text === 'B2'), { label: 'B2 の返事' });
    const th2 = await idle(root.id);
    t.ok('Owl は同じ会話で続ける（巻き戻した）', th2.sessions[owl.id] === owlSession);
    t.ok('H より後に会話が始まった Lynx はスレッドから外れる', !th2.sessions[lynx.id], JSON.stringify(th2.sessions));
    const history = (await c.cmd('loadSession', { sessionId: owlSession })).messages;
    t.ok('Owl の会話から B・C の配達が消え、B2 が入る', !history.some((m) => m.kind === 'channelEvent' && /echo:B<|echo:B$/.test(m.body ?? '') && m.postId === h.id)
      && history.some((m) => m.kind === 'channelEvent' && (m.body ?? '').includes('echo:B2')), JSON.stringify(history.map((m) => [m.role, m.kind, (m.body ?? m.text ?? '').slice(0, 20)])));
    const feed = await call('channels.read', { channelId: dev.id });
    t.ok('流れの要約の件数は取り下げた分を数えない', feed.summaries[root.id]?.count === 3, JSON.stringify(feed.summaries[root.id]));

    // ---- 走っている bot
    const h2 = await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'ask' });
    await until(async () => (await read(root.id)).posts.some((p) => p.turn?.botId === owl.id && p.state === 'waiting'), { label: '承認待ち' });
    const refused = await fails('channels.resend', { channelId: dev.id, postId: h2.id, text: 'echo:E' });
    t.ok('bot が走っている間は stopRunning が無ければ断る', Boolean(refused), String(refused));
    const stopped = await call('channels.resend', { channelId: dev.id, postId: h2.id, text: 'echo:E', stopRunning: true, clientId: 'resend-0002' });
    await until(async () => (await done(root.id, owl)).some((p) => p.text === 'E'), { label: 'E の返事' });
    t.ok('stopRunning で止めて送り直す', stopped.text === 'echo:E' && !(await read(root.id)).posts.some((p) => p.id === h2.id));
    // ---- 添付つきで送り直す（入力欄の「編集中」から送る形。ADR 0178）
    const file = path.join(tmp, 'note.txt');
    await fs.writeFile(file, 'memo');
    const h3 = await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:F' });
    await until(async () => (await done(root.id, owl)).some((p) => p.text === 'F'), { label: 'F の返事' });
    await idle(root.id);
    const withFile = await call('channels.resend', { channelId: dev.id, postId: h3.id, text: `echo:G\n[添付] ${file}`, attachments: [{ path: file, name: 'note.txt' }], clientId: 'resend-0003' });
    t.ok('送り直した新しい投稿に添付が付く（本文の印と対）', withFile.attachments?.length === 1 && withFile.attachments[0].path === file && withFile.text.includes('[添付]'), JSON.stringify(withFile));
    t.ok('サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(server.tail(80)), server.tail(30));
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
