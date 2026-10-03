import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'agent-tasks-silence';
export const title = '子の無音通知と最後の活動時刻';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(10); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-silence-'));
  let clock = 0, approval = false, lockWait = false, release;
  const notices = [];
  const manager = await createAgentTasks({
    dataDir: dir, now: () => clock, silenceMinutes: 15, log: () => {},
    prepare: async () => ({ sessionId: 'child', backend: 'fake' }),
    execute: async (_task, _prompt, signal) => { await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return { outcome: 'ok', text: 'done' }; },
    deliver: async () => 'ok', deliverSilence: async (task, minutes) => { notices.push({ task, minutes }); return 'ok'; },
    waiting: () => approval, lockWaiting: () => lockWait,
  });
  try {
    const task = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'work', title: 'Long work' });
    await until(() => release);
    t.ok('開始時刻を status と list に載せる', (await manager.call('parent', 'ply_task_status', { taskId: task.taskId })).lastActivityAt === 0
      && (await manager.call('parent', 'ply_task_list')).tasks[0].lastActivityAt === 0);
    clock = 14 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('15 分未満は通知しない', notices.length === 0);
    clock = 15 * 60000; manager.checkSilence();
    await until(() => notices.length === 1);
    t.ok('親へ題・時刻・分数を渡す', notices[0].task.title === 'Long work' && notices[0].task.taskId === task.taskId && notices[0].minutes === 15);
    const ja = agentT('ja', 'delegation.silenceNotice', { taskId: task.taskId, title: notices[0].task.title, minutes: notices[0].minutes });
    const en = agentT('en', 'delegation.silenceNotice', { taskId: task.taskId, title: notices[0].task.title, minutes: notices[0].minutes });
    t.ok('親へ届く文面が英日とも題・経過・確認と停止の口を示す', [ja, en].every(s => s.includes(task.taskId) && s.includes('Long work') && s.includes('15') && s.includes('ply_task_status') && s.includes('ply_task_cancel')));
    clock = 60 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('同じ無音の間は一度だけ', notices.length === 1);
    manager.activity('child');
    clock = 74 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('動き出した後は数え直す', notices.length === 1 && (await manager.call('parent', 'ply_task_status', { taskId: task.taskId })).silenceMinutes === 14);
    clock = 75 * 60000; manager.checkSilence(); await until(() => notices.length === 2);
    approval = true; manager.checkSilence();
    clock = 200 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('承認待ちは動きとして記録し、無音を数えない', notices.length === 2
      && (await manager.call('parent', 'ply_task_status', { taskId: task.taskId })).lastActivityAt === 75 * 60000
      && (await manager.call('parent', 'ply_task_status', { taskId: task.taskId })).status === 'waiting'
      && (await manager.call('parent', 'ply_task_list')).tasks[0].silenceMinutes === null);
    approval = false; manager.checkSilence();
    clock = 214 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('承認後は待機時間を除いて数え直す', notices.length === 2);
    clock = 215 * 60000; manager.checkSilence(); await until(() => notices.length === 3);
    // コンピューターの操作のロックを待っている間（承認待ちではない）も、無音に数えない。status は waiting にしない
    manager.activity('child');
    lockWait = true; manager.checkSilence();
    clock = 400 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('ロック待ちは無音に数えず、承認待ち（status: waiting）にもしない', notices.length === 3
      && (await manager.call('parent', 'ply_task_status', { taskId: task.taskId })).status === 'running'
      && (await manager.call('parent', 'ply_task_list')).tasks[0].silenceMinutes === null);
    lockWait = false; manager.checkSilence();
    clock = 400 * 60000 + 14 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('ロック待ちが終わったら数え直す', notices.length === 3);
    clock = 400 * 60000 + 15 * 60000; manager.checkSilence(); await until(() => notices.length === 4);
    release(); await until(() => manager.get(task.taskId).status === 'completed');
  } finally { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); }

  const offDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-silence-off-'));
  let offRelease, offCount = 0, offClock = 0;
  const off = await createAgentTasks({ dataDir: offDir, now: () => offClock, silenceMinutes: 0, log: () => {},
    prepare: async () => ({ sessionId: 'off-child', backend: 'fake' }),
    execute: async () => { await new Promise(resolve => { offRelease = resolve; }); return { outcome: 'ok' }; },
    deliver: async () => 'ok', deliverSilence: async () => { offCount++; return 'ok'; } });
  try {
    await off.call('parent', 'ply_delegate', { backend: 'fake', task: 'work' }); await until(() => offRelease);
    offClock = 999 * 60000; off.checkSilence(); await sleep(20);
    t.ok('設定 0 は通知を無効にする', offCount === 0);
    offRelease(); await until(() => off.list()[0].status === 'completed');
  } finally { await off.close(); await fs.rm(offDir, { recursive: true, force: true }); }
}
