// テストの補助 runTurn（tests/lib/ws-client.mjs）が、自分が始めた会話の session・turnEnd だけを見ること。
// 以前はどの会話の turnEnd でも返り、最初の session の ID を返していた。裏で委譲の完了通知のターンが走ると、
// 別の会話の ID か null を返してテストが時間切れになった（CI の ubuntu/Node 20）。fake バックエンドだけで、LLM は呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'ws-client-run-turn';
export const title = 'runTurn は裏で別の会話のターンが終わっても、自分の会話の終わりまで待つ';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-runturn-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data') });
  const c = await open(server);
  try {
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'hello' });
    const other = first.sessionId;
    t.ok('新しい会話の ID を返す', typeof other === 'string' && other.length > 0, String(other));

    // 裏の会話（other）で終わらないターンを走らせておく
    let from = c.mark();
    await c.cmd('runTurn', { sessionId: other, prompt: 'slow' });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === other, { from, ms: 5000 });

    // 新しい会話を始め、その session が来てから裏の会話を止める。裏の turnEnd は新しい会話のターンの途中に届く
    from = c.mark();
    let returned = null;
    const running = c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'slow' }, { ms: 20000 }).then(r => { returned = r; return r; });
    const own = (await c.waitFor(e => e.type === 'session' && e.sessionId && e.sessionId !== other, { from, ms: 5000 })).sessionId;
    await c.cmd('abort', { sessionId: other });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === other, { from, ms: 5000 });
    await sleep(200);
    t.ok('裏の会話の turnEnd では返らない', returned === null, JSON.stringify(returned && { sessionId: returned.sessionId, outcome: returned.outcome }));

    await c.cmd('abort', { sessionId: own });
    const result = await running;
    t.ok('自分の会話の ID を返す', result.sessionId === own, `${result.sessionId} / ${own}`);
    t.ok('自分の会話の turnEnd まで待つ', result.events.some(e => e.type === 'turnEnd' && e.sessionId === own));
    t.ok('結果は自分の会話のもの', result.outcome === 'aborted', String(result.outcome));

    // 続きの会話（sessionId を渡す）も、その会話の turnEnd で返る
    const again = await c.runTurn({ sessionId: other, prompt: 'hello again' });
    t.ok('既存の会話では渡した ID を返す', again.sessionId === other && again.outcome === 'ok', `${again.sessionId} ${again.outcome}`);
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
