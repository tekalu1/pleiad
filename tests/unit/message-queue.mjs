import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createMessageQueue } from '../../core/message-queue.mjs';

export const name = 'message-queue';
export const title = '実行中の送信を保存し、順序・取消・再接続・途中入力を保つ';
export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-outbox-'));
  const dataDir = path.join(scratch, 'data');
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  let c = await open(server);
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.cmd('runTurn', { sessionId, prompt: 'ask' });
    const permission = await c.waitFor(e => e.type === 'permission');
    const first = { sessionId, messageId: 'message-0001', prompt: 'echo:first' };
    await Promise.all([c.cmd('sendMessage', first), c.cmd('sendMessage', first)]);
    await c.cmd('sendMessage', { sessionId, messageId: 'message-0002', prompt: 'echo:second' });
    await c.cmd('sendMessage', { sessionId, messageId: 'message-0003', prompt: 'echo:cancel' });
    await c.cmd('messageAction', { sessionId, messageId: 'message-0003', action: 'cancel' });
    let queue = await c.cmd('listMessages', { sessionId });
    t.ok('同じIDの再送は増えず、本文と順序を保持', queue.length === 3 && queue[0].args.prompt === 'echo:first');
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions.json'), 'utf8'));
    t.ok('受領応答より先にディスクへ保存', saved[sessionId].outbox[1].args.prompt === 'echo:second');
    c.close(); c = await open(server);
    t.ok('接続し直しても送信待ちを取得できる', (await c.cmd('listMessages', { sessionId }))[0].status === 'queued');
    await c.cmd('resolvePermission', { id: permission.id, allow: true });
    await c.waitFor(e => e.type === 'outbox' && e.messages[1]?.status === 'sent', { ms: 5000 });
    await c.waitFor(e => e.type === 'text.delta' && e.text.includes('second'), { ms: 5000 });
    await c.waitFor(e => e.type === 'running' && e.count === 0, { ms: 5000, from: c.events.findIndex(e => e.type === 'userMessage' && e.messageId === 'message-0002') });
    const history = await c.cmd('loadSession', { sessionId });
    const users = history.messages.filter(m => m.role === 'user').map(m => m.text);
    t.ok('完了後に順番どおり一度だけ実行、取消は実行しない', JSON.stringify(users) === JSON.stringify(['ask', 'echo:first', 'echo:second']), JSON.stringify(users));
    const from = c.mark();
    await c.cmd('runTurn', { sessionId, prompt: 'slow' });
    await c.waitFor(e => e.type === 'activity', { from, ms: 3000 });
    await c.cmd('sendMessage', { sessionId, messageId: 'message-0004', prompt: 'echo:paused' });
    await c.cmd('abort', { sessionId });
    await c.waitFor(e => e.type === 'turnEnd', { from, ms: 3000 });
    t.ok('停止は待機メッセージも保留し、勝手に再開しない', (await c.cmd('listMessages', { sessionId }))[3].status === 'paused');
    c.close(); await server.stop();
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir }); c = await open(server);
    queue = await c.cmd('listMessages', { sessionId });
    t.ok('サーバー再起動後も本文を保持', queue[3].args.prompt === 'echo:paused');
    // A fresh conversation permits testing startup validation without relying on fake's volatile history.
    const bad = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.cmd('sendMessage', { sessionId: bad.sessionId, messageId: 'message-0005', prompt: 'echo:kept', cwd: path.join(scratch, 'missing') });
    await c.waitFor(e => e.type === 'outbox' && e.messages.some(m => m.status === 'failed'), { ms: 3000 });
    t.ok('開始失敗でも入力が再送可能な状態で残る', (await c.cmd('listMessages', { sessionId: bad.sessionId }))[0].status === 'failed');
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }

  // A transport failure after delivery must never fall back to a new turn.
  const data = {};
  let calls = 0;
  const store = { get: async id => data[id] ?? {}, getAll: async () => data,
    setSessionData: async (id, field, value) => { (data[id] ??= {})[field] = structuredClone(value); } };
  const queue = createMessageQueue({ store, active: () => ({ steer: async () => { calls++; throw new Error('connection lost'); } }),
    start: () => { throw new Error('must not start'); }, changed: () => {}, delivered: () => {} });
  await queue.accept('s', 'request-1', { prompt: 'do it' });
  await queue.kick('s');
  await queue.kick('s');
  t.ok('途中入力の結果不明は自動再送しない', calls === 1 && (await queue.list('s'))[0].status === 'unknown');
  data.s.outbox.push({ id: 'request-2', status: 'sending', args: { prompt: 'two' } });
  await queue.recover();
  t.ok('配送中に再起動した場合も結果不明として復元', (await queue.list('s'))[1].status === 'unknown');

  // requeue: the agent was running a turn Pleiad did not start, nothing was delivered.
  const later = {};
  const starts = [];
  let busy = false;
  const store2 = { get: async id => later[id] ?? {}, getAll: async () => later,
    setSessionData: async (id, field, value) => { (later[id] ??= {})[field] = structuredClone(value); } };
  const requeue = createMessageQueue({ store: store2, active: () => (busy ? { blocked: true } : null),
    start: async (args, onStarted) => {
      starts.push(args.prompt);
      await onStarted();
      if (starts.length === 1) { busy = true; return 'requeue'; }
      return 'ok';
    }, changed: () => {}, delivered: () => {} });
  await requeue.accept('r', 'request-3', { prompt: 'after wake' });
  await requeue.accept('r', 'request-4', { prompt: 'next' });
  for (let i = 0; i < 50 && (await requeue.list('r'))[0].status !== 'queued'; i++) await new Promise(r => setTimeout(r, 10));
  const held = await requeue.list('r');
  t.ok('requeue は送信待ちへ戻し、後続を保留しない', held[0].status === 'queued' && held[1].status === 'queued' && starts.length === 1, JSON.stringify(held.map(m => m.status)));
  busy = false;
  await requeue.kick('r');
  for (let i = 0; i < 50 && (await requeue.list('r'))[1].status !== 'sent'; i++) await new Promise(r => setTimeout(r, 10));
  t.ok('相手のターンが終わると同じ順で送り直す', JSON.stringify(starts) === JSON.stringify(['after wake', 'after wake', 'next']), JSON.stringify(starts));
}
