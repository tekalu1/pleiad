import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
export const name = 'server-running-slim';
export const title = 'running は過去の委譲を配らない（会話の分は agentTasks の tree・taskIds で読む）・定期便は同じ中身を送らない';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

/** 終わって通知も届いた過去のタスク。依頼文・振り分けの記録・結果は実データ並みに長くする */
const seeded = (taskId, parentSessionId, sessionId, at) => ({
  taskId, parentSessionId, sessionId, backend: 'fake', model: null, effort: null, mode: null, cwd: ROOT, title: `seed ${taskId}`,
  task: `依頼 ${taskId}\n` + 'x'.repeat(4000), result: 'r'.repeat(2000), status: 'completed', notification: 'sent', error: null,
  routing: { mode: 'auto', kind: 'implement', target: { backend: 'fake', model: null }, reasons: ['y'.repeat(600)] },
  instructions: [], queue: [], createdAt: at, updatedAt: at,
});

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-running-slim-'));
  const records = {};
  for (let i = 0; i < 300; i++) records[`seed-${i}`] = seeded(`seed-${i}`, 'seed-parent', `seed-child-${i}`, 1_000 + i);
  // 子の会話がさらに委譲した孫と、別の会話の委譲
  records['seed-grand'] = seeded('seed-grand', 'seed-child-0', 'seed-grandchild', 5_000);
  records['seed-other'] = seeded('seed-other', 'other-parent', 'other-child', 6_000);
  await fs.writeFile(path.join(scratch, 'agent-tasks.json'), JSON.stringify(records));

  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: scratch });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const idle = await c.cmd('running');
    const size = JSON.stringify(idle).length;
    t.ok('終わって通知が届いた過去のタスク（302 件）は running に載らない。大きさは件数に比例しない', idle.tasks.length === 0 && size < 3000, `${idle.tasks.length} 件 / ${size} 字`);

    const tree = await c.cmd('agentTasks', { sessionId: 'seed-parent', tree: true });
    const ids = new Set(tree.map((r) => r.taskId));
    t.ok('会話の分（tree）は子孫の委譲まで返し、別の会話の分は返さない', tree.length === 301 && ids.has('seed-grand') && !ids.has('seed-other'), String(tree.length));
    t.ok('会話の分は依頼文・振り分けの記録を持ち、結果の本文は載せない',
      tree.every((r) => !('result' in r) && !('rejections' in r)) && tree.find((r) => r.taskId === 'seed-5')?.routing?.mode === 'auto' && tree.find((r) => r.taskId === 'seed-5')?.task.startsWith('依頼 seed-5'));
    const picked = await c.cmd('agentTasks', { taskIds: ['seed-5', 'seed-other', 'missing'] });
    t.ok('taskIds はその行だけを返す', picked.map((r) => r.taskId).sort().join() === 'seed-5,seed-other' && picked.every((r) => !('result' in r)));
    const direct = await c.cmd('agentTasks', { sessionId: 'seed-parent' });
    t.ok('tree・taskIds が無ければ今までの形（直の子だけ、結果付き）', direct.length === 300 && direct[0].result === 'r'.repeat(2000));

    // 走っている委譲は、短い行（依頼文・振り分けの記録なし）で running に載る
    const parent = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow', title: 'slow child' }) });
    let row;
    for (let i = 0; i < 300 && !(row = (await c.cmd('running')).tasks.find((r) => r.parentSessionId === parent.sessionId && r.status === 'running')); i++) await sleep(50);
    t.ok('走っている委譲は running に載る（題・状態・依頼元・子の会話）', row?.title === 'slow child' && Boolean(row.sessionId), JSON.stringify(row));
    t.ok('running の行は依頼文・振り分けの記録・結果を持たない', row && !('task' in row) && !('routing' in row) && !('result' in row) && !('context' in row), JSON.stringify(Object.keys(row ?? {})));

    // 子のターンが走っている間の 4 秒ごとの定期便。中身が変わらなければ送らない
    await sleep(1500);
    const from = c.mark();
    await sleep(9000);
    const polls = c.since(from).filter((e) => e.type === 'running');
    t.ok('定期便は、中身が前と同じなら送らない（9 秒で 2 回の機会）', polls.length === 0, `${polls.length} 回`);

    await c.cmd('cancelAgentTask', { taskId: row.taskId });
    let gone = false;
    for (let i = 0; i < 300 && !(gone = !(await c.cmd('running')).tasks.some((r) => r.taskId === row.taskId)); i++) await sleep(50);
    const [after] = await c.cmd('agentTasks', { taskIds: [row.taskId] });
    t.ok('止めて通知が済んだ委譲は running から外れ、taskIds で終わった状態を読める', gone && after?.status === 'cancelled' && after.title === 'slow child', JSON.stringify({ gone, status: after?.status, notification: after?.notification }));
    const reopened = await c.cmd('agentTasks', { sessionId: parent.sessionId, tree: true });
    t.ok('会話を開き直すと（tree）、終わった委譲の行が依頼文付きで返る', reopened.some((r) => r.taskId === row.taskId && r.status === 'cancelled' && r.task === 'slow'));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
