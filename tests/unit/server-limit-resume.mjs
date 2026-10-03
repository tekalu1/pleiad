import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-limit-resume';
export const title = '上限で中断し、指示を送信待ちに置き、解除後に一度だけ再開する';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-limit-'));
  const dataDir = path.join(scratch, 'data');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  t.ok('fake サーバーを起動', Number.isFinite(server.port), server.tail());
  const c = await open({ port: server.port, token: server.token });
  t.ok('fake サーバーに接続', Boolean(c.ready));
  const op = (name, args = {}) => c.cmd('invoke', { op: name, args });
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('会話を作成', Boolean(sessionId), sessionId);
    const resetsAt = Date.now() + 2300;
    const from = c.mark();
    const result = await c.runTurn({ sessionId, prompt: `limit ${resetsAt}` }, { ms: 3000 })
      .catch(err => { throw new Error(`${err.message}\n${JSON.stringify(c.since(from))}\n${server.tail()}`); });
    const end = c.since(from).find(e => e.type === 'turnEnd' && e.sessionId === sessionId);
    t.ok('上限は完了・失敗ではなく limited', result.outcome === 'limited' && end?.interrupted?.reason === 'limit', JSON.stringify(end));
    t.ok('解除時刻と枠が会話に残る', end.interrupted.resetsAt === resetsAt && end.interrupted.window === 'five_hour');
    t.ok('完了通知は出ない', !c.since(from).some(e => e.type === 'completionReady' && e.sessionId === sessionId));
    const plan = await op('sessions.schedules', { sessionId });
    t.ok('再開予定が schedule.json にある', plan.length === 1 && plan[0].kind === 'resume');

    const id = 'limitqueued0001';
    await c.cmd('sendMessage', { sessionId, messageId: id, prompt: 'echo:after-reset' });
    let items = await c.cmd('listMessages', { sessionId });
    t.ok('解除前は API に渡さず limit で待つ', items.find(m => m.id === id)?.waiting?.reason === 'limit', JSON.stringify(items));
    await sleep(150);
    t.ok('解除前に新しい指示を流さない', !c.since(from).some(e => e.type === 'userMessage' && e.messageId === id));
    const again = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from, ms: 10000 });
    items = await c.cmd('listMessages', { sessionId });
    const messages = (await c.cmd('loadSession', { sessionId })).messages.filter(m => m.role === 'user').map(m => m.text);
    t.ok('解除後に待っていた指示を一度だけ送る', again.interrupted === null && items.find(m => m.id === id)?.status === 'sent'
      && messages.filter(x => x === 'echo:after-reset').length === 1, JSON.stringify(messages));
    t.ok('最初の上限を出した指示は送り直さない', messages.filter(x => x === `limit ${resetsAt}`).length === 1);
    t.ok('再開の予定を消す', (await op('sessions.schedules', { sessionId })).length === 0);

    const second = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('二つ目の会話を作成', Boolean(second.sessionId));
    const secondReset = Date.now() + 2300;
    const secondFrom = c.mark();
    await c.runTurn({ sessionId: second.sessionId, prompt: `limit ${secondReset}` });
    t.ok('二つ目も上限で止まる', true);
    const setting = await op('resumeQueue.set', { action: 'auto', sessionId: second.sessionId, enabled: false });
    t.ok('会話ごとに自動再開を外せる', !setting.schedules.some(r => r.sessionId === second.sessionId));
    await sleep(2600);
    const still = (await c.cmd('listSessions')).find(s => s.id === second.sessionId);
    t.ok('自動を外した会話は解除後も止まる', still.interrupted?.reason === 'limit'
      && !c.since(secondFrom).some(e => e.type === 'turnEnd' && e.sessionId === second.sessionId && e.outcome === 'ok'));

    await c.cmd('setPref', { key: 'limitResume', value: { mode: 'ask', concurrency: 3, guardPercent: 50 } });
    const third = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const thirdFrom = c.mark();
    await c.runTurn({ sessionId: third.sessionId, prompt: `limit ${Date.now() + 2300}` });
    await c.waitFor(e => e.type === 'limitResumeReady' && e.sessionId === third.sessionId, { from: thirdFrom, ms: 10000 });
    const waiting = (await c.cmd('listSessions')).find(s => s.id === third.sessionId);
    t.ok('開き直した画面にも「知らせて再開する」の状態が残る', waiting?.interrupted?.notifyAtReset === true
      && waiting.interrupted.autoResume === false);
    await c.cmd('sendMessage', { sessionId: third.sessionId, messageId: 'askqueued0001', prompt: 'echo:after-approval' });
    const askMessages = await c.cmd('listMessages', { sessionId: third.sessionId });
    t.ok('確認待ちは解除時刻の後でも押すまで API に流さない',
      askMessages.find(m => m.id === 'askqueued0001')?.waiting?.reason === 'limit');
    t.ok('確認してからの設定は解除時刻に知らせ、まだ送らない',
      !c.since(thirdFrom).some(e => e.type === 'turnEnd' && e.sessionId === third.sessionId && e.outcome === 'ok'));
    await op('resumeQueue.set', { action: 'release' });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === third.sessionId && e.outcome === 'ok', { from: thirdFrom, ms: 10000 });
    t.ok('人が押した後、再開待ち行列から続ける',
      (await c.cmd('listSessions')).find(s => s.id === third.sessionId)?.interrupted === null);
  } finally {
    c.close(); await server.stop();
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }
}
