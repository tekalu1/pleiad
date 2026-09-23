// 中断（WS の abort）の順序。実際の中断を先に同期的に行い、Pleiad タスクの停止・送信待ちの保留（ディスクへの書き込み）は後。
// fake バックエンドだけで、LLM は呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-abort';
export const title = '中断は委譲タスクの数によらず先に効き、受け付けたことをすぐ知らせる';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-abort-'));
  const dataDir = path.join(scratch, 'data');
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  let c = await open(server);
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    c.close(); await server.stop();
    // この会話が作った Pleiad タスクを多めに置く。終わって通知も済んだもの（abort で通知を抑える＝書き換えが要る）と、
    // もう抑えてあるもの（書き換えが要らない）を混ぜる
    const now = Date.now();
    const records = {};
    for (let i = 0; i < 40; i++) {
      const taskId = `ply-task-seed-${i}`;
      records[taskId] = { taskId, sessionId: `child-${i}`, parentSessionId: sessionId, backend: 'fake', manager: 'ply', depth: 1,
        task: `t${i}`, createdAt: now, updatedAt: now, status: 'completed', notification: i % 2 ? 'suppressed' : 'sent',
        result: 'done', error: null, queue: [] };
    }
    await fs.writeFile(path.join(dataDir, 'agent-tasks.json'), JSON.stringify(records));
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
    c = await open(server);

    const from = c.mark();
    await c.cmd('runTurn', { sessionId, prompt: 'slow' });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === sessionId, { from, ms: 5000 });
    const before = c.mark();
    const stopped = await c.cmd('abort', { sessionId });
    // 応答が返った時点で、バックエンドはもう中断を見て turnResult を出している（以前は書き込みを全部待ってから中断した）
    const atReply = c.since(before);
    t.ok('中断できる', stopped.aborted === 1, JSON.stringify(stopped));
    t.ok('(f) 委譲タスクの後始末より先に中断が効く（応答より先に turnResult aborted が届く）',
      atReply.some(e => e.type === 'turnResult' && e.outcome === 'aborted' && e.sessionId === sessionId),
      JSON.stringify(atReply.map(e => e.type)));
    t.ok('受け付けた時点で「中断している」の activity を出す',
      atReply.some(e => e.type === 'activity' && e.state === 'stopping' && e.sessionId === sessionId));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: before, ms: 5000 });
    // 受け付けたときに配る running には、止め終えるまでのターン行に stopping が乗る
    t.ok('running のターン行に stopping が立つ', c.since(before).some(e => e.type === 'running'
      && e.turns?.some(x => x.sessionId === sessionId && x.stopping === true)));
    const rows = await c.cmd('agentTasks', { sessionId });
    t.ok('会話の Pleiad タスクの通知はこれまでどおり抑える', rows.length === 40 && rows.every(r => r.notification === 'suppressed'),
      JSON.stringify(rows.map(r => r.notification)));
    t.ok('止め終わっていた分は書き換えない', rows.filter(r => r.revision).length === 20, String(rows.filter(r => r.revision).length));
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
