// スレッドの送信待ち（channels.pending・channels.withdrawPending。ADR 9101 の F12）: bot が承認待ちの間に書いた投稿は、bot へ届く前（inbox の pending）。
// 一覧に出し、取り下げると inbox からも外れて、スレッドから消える。届け始めたものは取り下げない。fake バックエンドのサーバー越しに通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'thread-pending';
export const title = 'スレッドの送信待ち: bot へ届く前の投稿の一覧・取り下げ・届いた投稿は取り下げない';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(60); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-pending-'));
  let server = null, c = null;
  try {
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(tmp, 'data'), timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const call = (op, args) => c.cmd('invoke', { op, args });
    const fails = async (op, args) => { try { await call(op, args); return false; } catch { return true; } };
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev', members: [owl.id] });
    const read = (threadId) => call('channels.read', { channelId: dev.id, threadId });

    const root = await call('channels.post', { channelId: dev.id, text: '@Owl ask' });
    await until(async () => (await read(root.id)).posts.some((p) => p.turn?.botId === owl.id && p.state === 'waiting'), { label: '承認待ち' });
    const queued = await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:待っている間の問い' });
    const list = await until(async () => { const r = await call('channels.pending', { channelId: dev.id, threadId: root.id }); return r.items.length ? r : null; }, { label: '送信待ち' });
    t.ok('承認待ちの間に書いた投稿は送信待ちに出る（宛先の bot つき）', list.items[0].postId === queued.id && list.items[0].botIds.includes(owl.id), JSON.stringify(list));

    const done = await call('channels.withdrawPending', { channelId: dev.id, postId: queued.id });
    t.ok('取り下げると送信待ちから消え、スレッドからも消える', done.withdrawn && !(await call('channels.pending', { channelId: dev.id, threadId: root.id })).items.length
      && !(await read(root.id)).posts.some((p) => p.id === queued.id));
    t.ok('知らない投稿・届いていない投稿でないものは取り下げない', await fails('channels.withdrawPending', { channelId: dev.id, postId: root.id }));
    await call('channels.stopThread', { channelId: dev.id, threadId: root.id });
    await sleep(500);
    t.ok('止めた後も取り下げた投稿は bot に届かない', !(await read(root.id)).posts.some((p) => p.turn?.botId === owl.id && p.text.includes('待っている間')));
    t.ok('サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(server.tail(80)), server.tail(30));
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
