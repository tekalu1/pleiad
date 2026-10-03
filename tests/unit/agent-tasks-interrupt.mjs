// 会話の中断で委譲タスクを止めるとき（cancelOwner）と、1 件を取り消すとき（cancel）の完了通知（docs/design.md「中断と再開」）。
//   - 終わっていて完了通知がまだ届いていない（pending）タスクは、中断で通知を止める（勝手に新しいターンを始めない）が、
//     「終わっていたが渡せていない結果」として返す。結果は ply_task_status で読める
//   - 走っていたタスクは取り消したものとして返す。通知を送り終えたタスクは返さない
//   - cancel: 終わったタスクには止めるものが無いので、届いていない完了通知はそのまま届ける。子孫の分は今どおり止める
//   - 再起動で止まったタスク（interrupted）は restored に載る。正常終了（close）は走っていた子を cancelled にせず、走っていた状態のまま残す
//     （利用者の取り消し cancel は cancelled を書く）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';

export const name = 'agent-tasks-interrupt';
export const title = '中断で委譲タスクを止める: 届いていない結果を捨てずに返す・取り消したものを返す・cancel は終わったタスクの通知を止めない';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-task-interrupt-'));
  let seq = 0, parentReady = false;
  const delivered = [], started = new Set();
  // 保存の動き（writeFile / rename）を数える。close の後に古い manager の書き込みが届かないことを、落ち着くのを待って確かめる
  let inflight = 0, lastIo = Date.now();
  const track = name => async (...args) => { inflight++; lastIo = Date.now(); try { return await fs[name](...args); } finally { inflight--; lastIo = Date.now(); } };
  const io = { ...fs, writeFile: track('writeFile'), rename: track('rename') };
  const settle = () => until(() => inflight === 0 && Date.now() - lastIo > 150);
  const options = {
    io, dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    execute: async (_task, prompt, signal) => {
      started.add(prompt);
      if (prompt.startsWith('slow')) await new Promise(resolve => { const timer = setTimeout(resolve, 5000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      return { outcome: signal.aborted ? 'aborted' : 'ok', text: `result:${prompt}` };
    },
    ready: async () => parentReady,
    deliver: async tasks => { if (!parentReady) return 'requeue'; delivered.push(tasks.map(x => x.taskId)); return 'ok'; },
  };
  let manager = await createAgentTasks(options);
  const delegate = async (owner, prompt, extra = {}) => manager.call(owner, 'ply_delegate', { backend: 'fake', task: prompt, ...extra });
  try {
    // ---- cancelOwner: 終わって通知を待っているタスク・走っているタスク・通知を送り終えたタスク
    const sent = await delegate('p1', 'sent-a', { title: 'Sent' });
    parentReady = true;
    await until(() => manager.get(sent.taskId).notification === 'sent');
    parentReady = false;
    const finished = await delegate('p1', 'done-a', { title: 'Done A' });
    await until(() => manager.get(finished.taskId).notification === 'pending');
    const running = await delegate('p1', 'slow-a', { title: 'Slow A' });
    await until(() => manager.get(running.taskId).status === 'running');
    const stopped = await manager.cancelOwner('p1');
    t.ok('中断の後も、終わっていたタスクの完了通知は送らない（勝手に新しいターンを始めない）', manager.get(finished.taskId).notification === 'suppressed', manager.get(finished.taskId).notification);
    const unread = stopped.find(x => x.taskId === finished.taskId);
    t.ok('終わっていて届いていなかった結果は unread として返る（捨てない）',
      unread?.unread === true && unread.status === 'completed' && unread.parentSessionId === 'p1' && unread.title === 'Done A', JSON.stringify(unread));
    const cut = stopped.find(x => x.taskId === running.taskId);
    t.ok('走っていたタスクは取り消したものとして返る（止めた時点の状態付き）', cut && !cut.unread && cut.status === 'running' && cut.title === 'Slow A', JSON.stringify(cut));
    t.ok('通知を送り終えたタスクは返さない', !stopped.some(x => x.taskId === sent.taskId), JSON.stringify(stopped.map(x => x.taskId)));
    const read = await manager.call('p1', 'ply_task_status', { taskId: finished.taskId });
    t.ok('届いていなかった結果は ply_task_status で読める', read.status === 'completed' && read.result === 'result:done-a', JSON.stringify({ status: read.status, result: read.result }));
    await until(() => manager.get(running.taskId).status === 'cancelled');
    parentReady = true; await sleep(1200);
    t.ok('親が空いても、止めたタスクの通知は送らない', !delivered.flat().some(id => [finished.taskId, running.taskId].includes(id)), JSON.stringify(delivered));
    t.ok('もう一度止めても何も返らない（止め終えたもの）', (await manager.cancelOwner('p1')).length === 0);

    // ---- cancelOwner の since: 巻き戻して送り直す（ADR 0091）ときに、切り口より後に作ったタスクだけを止める
    parentReady = false;
    const older = await delegate('p3', 'slow-older', { title: 'Older' });
    await sleep(30);
    const cutAt = Date.now();
    await sleep(30);
    const newer = await delegate('p3', 'slow-newer', { title: 'Newer' });
    await until(() => manager.get(older.taskId).status === 'running' && manager.get(newer.taskId).status === 'running');
    const limited = await manager.cancelOwner('p3', { since: cutAt });
    t.ok('since より後に作ったタスクだけを止めて返す', limited.length === 1 && limited[0].taskId === newer.taskId, JSON.stringify(limited.map(x => x.taskId)));
    await until(() => manager.get(newer.taskId).status === 'cancelled');
    t.ok('since より前に作ったタスクは走ったまま（結果も後で届く）', ['running', 'queued'].includes(manager.get(older.taskId).status), manager.get(older.taskId).status);
    await manager.cancelOwner('p3');

    // ---- cancel: 終わったタスクには止めるものが無い。届いていない完了通知はそのまま届ける
    parentReady = false;
    const lone = await delegate('p2', 'done-b', { title: 'Done B' });
    await until(() => manager.get(lone.taskId).notification === 'pending');
    await manager.cancel(lone.taskId);
    t.ok('cancel は終わったタスクの届いていない通知を止めない', manager.get(lone.taskId).notification === 'pending', manager.get(lone.taskId).notification);
    parentReady = true;
    await until(() => delivered.some(ids => ids.includes(lone.taskId)));
    t.ok('その結果は親へ届く', manager.get(lone.taskId).notification === 'sent');
    // 走っているタスクの cancel は今どおり取り消して通知を止める
    const live = await delegate('p2', 'slow-b');
    await until(() => manager.get(live.taskId).status === 'running');
    await manager.cancel(live.taskId);
    await until(() => manager.get(live.taskId).status === 'cancelled');
    t.ok('走っているタスクの cancel は通知を止める', manager.get(live.taskId).notification === 'suppressed');
    await settle();
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'))[live.taskId];
    t.ok('取り消し（close 以外の abort）は cancelled として保存される', onDisk.status === 'cancelled' && onDisk.notification === 'suppressed', JSON.stringify({ status: onDisk.status, notification: onDisk.notification }));

    // ---- 正常終了（close）で走っていた子は、止めたことを書かない。再起動で restored に載り interrupted になる（依頼元・題・止まった時点の状態）
    parentReady = false;
    const cut2 = await delegate('p3', 'slow-c', { title: 'Slow C' });
    await until(() => manager.get(cut2.taskId).status === 'running' && started.has('slow-c'));
    manager.close();
    await settle();
    const closedOnDisk = JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'))[cut2.taskId];
    t.ok('close は走っていた子を cancelled にしない（走っていた状態のまま保存される）', closedOnDisk.status === 'running' && closedOnDisk.notification === 'none', JSON.stringify({ status: closedOnDisk.status, notification: closedOnDisk.notification }));
    manager = await createAgentTasks(options);
    const restored = manager.restored;
    t.ok('再起動で止まったタスクが restored に載る', restored.length === 1 && restored[0].taskId === cut2.taskId && restored[0].parentSessionId === 'p3'
      && restored[0].status === 'running' && restored[0].title === 'Slow C', JSON.stringify(restored));
    t.ok('そのタスクは interrupted になる', manager.get(cut2.taskId).status === 'interrupted');
    t.ok('依頼元へ完了通知を送らない（close の後に通知を作らない）', manager.get(cut2.taskId).notification === 'none' && !delivered.flat().includes(cut2.taskId), manager.get(cut2.taskId).notification);
  } finally {
    manager.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
