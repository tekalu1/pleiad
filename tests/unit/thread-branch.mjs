// スレッドの「ここから分岐」（channels.branchThread。ADR 0157 の 4.3・4.4）と、bot の会話のまとまりの切り口。
//   - splitLeadingNotes は 1 つの発言から分けた行に元の uuid（groupUuid）を全部付ける
//   - bot の会話を発言の手前で分けると、まとまりの先頭で切る（今の Chats から bot の会話を分岐したときも）
//   - 根から P までを黙って写す（bot は起きない）・bot の会話は P より後の投稿を最初に含むまとまりの手前で分ける・子の sidecar・続きは子の会話で返す
// fake バックエンドのサーバー越しに通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { splitLeadingNotes } from '../../core/system-messages.mjs';

export const name = 'thread-branch';
export const title = 'スレッドの分岐: まとまりの uuid・会話の切り口・黙って写す・bot の会話を分ける・子の会話で続く';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(60); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

export default async function (t) {
  // ---- まとまり（純粋）
  const rows = splitLeadingNotes([
    { role: 'user', uuid: 'u1', text: '<pleiad-turn-context>\n時刻\n</pleiad-turn-context><pleiad-channel channel="#d" thread="p_1" post="p_1" from="あなた">やって</pleiad-channel>' },
    { role: 'assistant', uuid: 'a1', text: 'はい' },
    { role: 'user', uuid: 'u2', text: '<pleiad-turn-context>\nx\n</pleiad-turn-context>続きの本文' },
  ]);
  t.ok('分けた行はどれも元の発言の uuid（groupUuid）を持つ。uuid は最後の行だけ', rows[0].groupUuid === 'u1' && rows[1].groupUuid === 'u1' && !rows[0].uuid && rows[1].uuid === 'u1'
    && rows[3].groupUuid === 'u2' && rows[4].groupUuid === 'u2' && rows[4].uuid === 'u2' && rows[2].groupUuid === undefined, JSON.stringify(rows));
  t.ok('何度かけても同じ', JSON.stringify(splitLeadingNotes(rows)) === JSON.stringify(rows));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-branch-'));
  let server = null, c = null;
  try {
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(tmp, 'data'), timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const call = (op, args) => c.cmd('invoke', { op, args });
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev', members: [owl.id] });
    const read = (threadId) => call('channels.read', { channelId: dev.id, threadId });
    const done = async (root) => (await read(root)).posts.filter((p) => p.turn?.botId === owl.id && p.state === 'done');
    const idle = (root) => until(async () => { const th = (await read(root)).threads[0]; return th?.state === 'idle' ? th : null; }, { label: 'idle' });

    const root = await call('channels.post', { channelId: dev.id, text: '@Owl echo:A' });
    await until(async () => (await done(root.id)).length === 1, { label: 'A' });
    await idle(root.id);
    const b = await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:B' });
    await until(async () => (await done(root.id)).length === 2, { label: 'B' });
    await idle(root.id);
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:C' });
    await until(async () => (await done(root.id)).length === 3, { label: 'C' });
    const th = await idle(root.id);
    const parentSession = th.sessions[owl.id];

    // ---- 今の Chats から bot の会話を分岐（まとまりの先頭で切る）
    const loaded = (await c.cmd('loadSession', { sessionId: parentSession })).messages;
    const second = loaded.filter((m) => m.kind === 'channelEvent' && m.postId === b.id)[0];
    const forked = await c.cmd('fork', { sessionId: parentSession, beforeMessageId: second.groupUuid ?? second.uuid });
    const childRows = (await c.cmd('loadSession', { sessionId: forked.sessionId })).messages;
    const tailRow = childRows.at(-1);
    t.ok('bot の会話を発言の手前で分けると、まとまりの先頭で切る（その発言の文脈の行を前に残さない）', tailRow?.role === 'assistant' && !childRows.some((m) => m.groupUuid && m.groupUuid === (second.groupUuid ?? second.uuid)),
      JSON.stringify(childRows.map((m) => [m.role, m.kind, m.groupUuid])));

    // ---- ここから分岐（B のところ）
    const before = (await read(root.id)).posts.length;
    const made = await call('channels.branchThread', { channelId: dev.id, threadId: root.id, atPostId: b.id });
    const branch = await read(made.threadId);
    const copies = branch.posts;
    t.ok('根から B までを写した新しいスレッド（根・Owl の A の返事・B）', made.threadId !== root.id && copies.length === 3 && copies[0].branchOf?.threadId === root.id && copies[0].branchOf.postId === b.id
      && copies.map((p) => p.copyOf).join() === [root.id, (await done(root.id))[0].id, b.id].join(), JSON.stringify(copies.map((p) => [p.text, p.copyOf])));
    await sleep(800);
    t.ok('写した投稿は bot を起こさない（新しい返事が無い）', (await read(made.threadId)).posts.length === 3);
    t.ok('元のスレッドは変わらない', (await read(root.id)).posts.length === before);
    const bth = (await read(made.threadId)).threads[0];
    const child = bth?.sessions?.[owl.id];
    t.ok('新しいスレッドの Owl の会話は、元の会話から分けた別の会話', Boolean(child) && child !== parentSession, JSON.stringify(bth));
    t.ok('写した Owl の返事のターンは子の会話を指す', copies[1].turn?.sessionId === child);
    const childLoaded = (await c.cmd('loadSession', { sessionId: child })).messages;
    t.ok('子の会話は C を運ぶまとまりの手前で切れている（B までの配達だけ）', childLoaded.some((m) => m.kind === 'channelEvent' && m.postId === b.id) && !childLoaded.some((m) => m.kind === 'channelEvent' && /echo:C/.test(m.body ?? '')),
      JSON.stringify(childLoaded.map((m) => [m.role, m.kind, (m.body ?? m.text ?? '').slice(0, 30)])));

    // ---- 続きは子の会話で返す
    await call('channels.post', { channelId: dev.id, threadId: made.threadId, text: 'echo:D' });
    // 子の会話の最初のターンは、写した履歴の引き継ぎ（host が持つ分岐の会話。fake は引き継ぎの文ごと返す）で始まる
    const reply = await until(async () => (await done(made.threadId)).find((p) => p.at > copies[2].at && p.text.includes('echo:D')), { label: '分岐先の返事' });
    t.ok('分岐先で書くと、子の会話の Owl が返す', reply.turn.sessionId === child);
    t.ok('元のスレッドには届かない', !(await read(root.id)).posts.some((p) => p.text.includes('echo:D') && p.author.kind === 'bot'));
    const bad = await call('channels.branchThread', { channelId: dev.id, threadId: root.id, atPostId: 'p_nope' }).then(() => false, () => true);
    t.ok('知らない投稿では分けない', bad);
    t.ok('サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(server.tail(80)), server.tail(30));
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
