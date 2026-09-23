import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
export const name = 'message-steer';
export const title = 'Codexの実行中ターンへ追加指示を一度だけ配送する';
export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-steer-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"` } });
  const c = await open(server);
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ROOT });
    await c.cmd('sendMessage', { sessionId, messageId: 'initial-0001', prompt: 'slow' });
    await c.waitFor(e => e.type === 'text.delta', { ms: 5000 });
    const from = c.mark();
    const upload = await c.cmd('attachFile', { sessionId, name: 'memo.txt', mime: 'text/plain', data: Buffer.from('attachment').toString('base64') });
    const request = { sessionId, messageId: 'steer-0001', prompt: 'additional instruction', attachments: [{ path: upload.path, name: 'memo.txt', mime: 'text/plain' }] };
    await Promise.all([c.cmd('sendMessage', request), c.cmd('sendMessage', request)]);
    const said = await c.waitFor(e => e.type === 'userMessage' && e.messageId === request.messageId, { from, ms: 5000 });
    const running = await c.cmd('running');
    t.ok('中断や新しいターンを作らず稼働を維持', running.count === 1 && !c.since(from).some(e => e.type === 'turnEnd'));
    t.ok('追加発言は一度だけ通知する', c.since(from).filter(e => e.type === 'userMessage').length === 1);
    // 受理（吹き出しを出す）と「走っているターンに入った」は別の瞬間。画面は渡るまで待っていることを出す
    t.ok('渡るまでは pending として届く', said.pending === true, JSON.stringify(said));
    const delivered = await c.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === request.messageId, { from, ms: 5000 });
    t.ok('会話に入ったら配達を知らせる', delivered.sessionId === sessionId);
    t.ok('最初のプロンプトも準備後に配達を知らせる',
      c.events.some(e => e.type === 'userMessage.delivered' && e.messageId === 'initial-0001'));
    const loaded = await c.cmd('loadSession', { sessionId, live: true });
    t.ok('途中で開いても初回発言と追加発言を復元できる', loaded.initialMessageId === 'initial-0001'
      && loaded.stream.events.some(e => e.type === 'userMessage' && e.text === request.prompt));
    t.ok('開き直しても配達済みのまま復元できる',
      loaded.stream.events.some(e => e.type === 'userMessage.delivered' && e.messageId === request.messageId));
    await c.cmd('abort', { sessionId });
    await c.waitFor(e => e.type === 'turnEnd', { from, ms: 5000 });
    const transcript = await c.cmd('loadSession', { sessionId });
    t.ok('追加指示がネイティブ履歴にも一度だけ保存される', transcript.messages.filter(m => m.role === 'user' && m.text === request.prompt).length === 1);
    const user = transcript.messages.find(m => m.role === 'user' && m.text === request.prompt);
    t.ok('途中送信の添付をその追加発言に紐づける', transcript.presents.some(p => p.path === upload.path && p.messageId === user?.uuid));
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
}
