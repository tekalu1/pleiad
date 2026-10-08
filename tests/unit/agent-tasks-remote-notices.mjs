import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createRemoteDelegation } from '../../core/remote-delegation.mjs';

export const name = 'agent-tasks-remote-notices';
export const title = 'リモートの子の無音・長いコマンド・裏待ちの通知';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = n => `ply-task-${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(10); } throw new Error('timeout'); };

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-remote-notices-'));
  let clock = 0;
  const silence = [], commands = [], background = [];
  const manager = await createAgentTasks({ dataDir: dir, now: () => clock,
    silenceMinutes: 5, commandMinutes: 5, backgroundMinutes: 5, log: () => {},
    prepare: async () => ({ sessionId: 'local', backend: 'fake' }), execute: async () => ({ outcome: 'ok' }),
    ready: async () => true, deliver: async () => 'ok',
    deliverSilence: async (row, minutes) => { silence.push([row.taskId, minutes]); return 'ok'; },
    deliverCommand: async (row, command) => { commands.push([row.taskId, command.noticeId]); return 'ok'; },
    deliverBackground: async (row, notice) => { background.push([row.taskId, notice.count, row.hostBackground?.reply]); return 'ok'; },
  });
  const adopt = n => manager.adopt({ taskId: id(n), parentSessionId: 'parent', host: { hostId: 'h1', name: 'MSI' }, status: 'running', title: `task ${n}` }, 'ja');
  const telemetry = (n, extra = {}) => manager.mirror(id(n), { status: 'running', hostTelemetry: true,
    lastActivityAt: 0, lastOutputAt: null, activeCommands: [], hostWaiting: false, hostLockWaiting: false, hostBackground: null, ...extra });
  try {
    await adopt(1);
    clock = 10 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('古いホストの便りには活動の写しがなく、通知しない', silence.length === 0);
    await telemetry(1); manager.checkSilence(); await until(() => silence.length === 1);
    manager.checkSilence(); await sleep(20);
    t.ok('無音は依頼元に 1 回だけ届く', silence.length === 1 && silence[0][1] === 10);

    await adopt(2);
    await telemetry(2, { activeCommands: [{ noticeId: 'cmd-1', command: 'build', state: 'running', observedAt: 0, startedAt: 0, pausedMs: 0, pausedAt: null, notified: false }] });
    manager.checkSilence(); await until(() => commands.length === 1);
    manager.checkSilence(); await sleep(20);
    t.ok('長いコマンドは 1 回だけ届く', commands.length === 1 && commands[0][1] === 'cmd-1');

    await adopt(3); await telemetry(3, { hostWaiting: true, activeCommands: [{ noticeId: 'waiting-command',
      command: 'build', state: 'running', observedAt: 0, startedAt: 0, pausedMs: 0, pausedAt: 0, notified: false }] });
    await adopt(4); await telemetry(4, { hostLockWaiting: true });
    clock = 30 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('承認待ちとロック待ちは無音と数えず、承認待ちのコマンドも知らせない',
      !silence.some(x => [id(3), id(4)].includes(x[0])) && !commands.some(x => x[0] === id(3)));
    await telemetry(3, { hostWaiting: false, lastActivityAt: clock });
    clock += 4 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('承認待ちの後は数え直す', !silence.some(x => x[0] === id(3)));

    await adopt(5); await telemetry(5, { hostBackground: { since: 0, tasks: [{ kind: 'shell', label: 'job' }], reply: 'working' } });
    manager.checkSilence(); await until(() => background.length === 1);
    t.ok('裏待ちの知らせに子の返答を添え、無音は重ならない', background[0][0] === id(5) && background[0][2] === 'working' && !silence.some(x => x[0] === id(5)));

    await manager.mirror(id(1), { status: 'completed' });
    await manager.mirror(id(2), { status: 'completed' });
    clock += 30 * 60000; manager.checkSilence(); await sleep(20);
    t.ok('完了後は知らせを増やさない', silence.filter(x => x[0] === id(1)).length === 1 && commands.length === 1);

    await adopt(6); await telemetry(6);
    await manager.mirror(id(6), { status: 'failed', hostLost: true });
    manager.checkSilence(); await sleep(20);
    t.ok('hostLost は無音・コマンドの対象から外す', !silence.some(x => x[0] === id(6)));

    // 偽のホストから task の便りを通し、写しの取り込みから通知までを確かめる。
    const listeners = [];
    const bridge = { hosts: [{ hostId: 'h1', name: 'MSI', state: 'ready', allowed: true, agentUse: true }],
      onEvent: fn => { listeners.push(fn); return () => {}; }, onState: () => () => {}, onReady: () => () => {}, onHosts: () => () => {},
      refresh: async () => {}, sync: async () => true };
    const remote = createRemoteDelegation({ bridge, tasks: () => manager, agentT: () => '', log: () => {} });
    remote.start();
    await adopt(7);
    const emit = ev => listeners.forEach(fn => fn('h1', { t: 'task', task: ev }));
    clock = 100 * 60000;
    emit({ taskId: id(7), status: 'running', telemetry: { version: 1, lastActivityAt: 0,
      lastOutputAt: null, activeCommands: [], lockWaiting: false, background: null } });
    await until(() => manager.get(id(7)).hostTelemetry === true);
    manager.checkSilence(); await until(() => silence.some(x => x[0] === id(7)));
    t.ok('偽のホストの便りから、依頼元の通知まで届く', silence.filter(x => x[0] === id(7)).length === 1);
    await adopt(8);
    emit({ taskId: id(8), status: 'running', telemetry: { version: 1, lastActivityAt: 0,
      lastOutputAt: null, lockWaiting: false, background: null,
      activeCommands: [{ noticeId: 'host-command', command: 'build', state: 'running',
        observedAt: 0, startedAt: 0, pausedMs: 0, pausedAt: null, notified: true }] } });
    await until(() => manager.get(id(8)).hostTelemetry === true);
    manager.checkSilence(); await until(() => commands.some(x => x[0] === id(8)));
    t.ok('ホスト側の通知済み印に妨げられず、長いコマンドが依頼元へ届く', commands.filter(x => x[0] === id(8)).length === 1);
    emit({ taskId: id(7), status: 'completed', result: 'done' });
    await until(() => manager.get(id(7)).status === 'completed');
    manager.checkSilence(); await sleep(20);
    t.ok('偽のホストの完了便りの後は停滞通知しない', silence.filter(x => x[0] === id(7)).length === 1);
  } finally { await manager.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
