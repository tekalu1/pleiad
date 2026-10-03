import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { hookedTaskStorage } from '../lib/task-storage.mjs';
import { readAgentTasks } from '../lib/data-store.mjs';

export const name = 'agent-tasks-command-storage';
export const title = 'コマンド観測はメモリだけに置き、タスクの状態変化は保存する';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error('timeout');
}

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-command-storage-'));
  let manager, release;
  const hooked = hookedTaskStorage(dir);
  try {
    manager = await createAgentTasks({ dataDir: dir, taskStorage: hooked.taskStorage, log: () => {},
      prepare: async () => ({ sessionId: 'child', backend: 'codex' }),
      execute: async () => { await new Promise(resolve => { release = resolve; }); return { outcome: 'ok', text: 'done' }; },
      deliver: async () => 'requeue',
    });
    const job = await manager.call('parent', 'ply_delegate', { backend: 'codex', task: 'hold' });
    await until(() => release && manager.get(job.taskId).status === 'running');
    const before = hooked.state.saves;
    manager.observe('child', { type: 'tool.start', name: 'run_command', id: 'command-1', input: { command: 'echo hi' } });
    t.ok('開始したコマンドはメモリ上の一覧に見える', manager.get(job.taskId).activeCommands.length === 1);
    manager.observe('child', { type: 'tool.result', id: 'command-1', commandCompleted: true });
    await sleep(100);
    t.ok('開始と終了の観測だけでは記録を書かない', hooked.state.saves === before && manager.get(job.taskId).activeCommands.length === 0);
    release();
    await until(() => manager.get(job.taskId).status === 'completed');
    await until(async () => readAgentTasks(dir)[job.taskId].status === 'completed');
    t.ok('タスクの完了は従来どおり保存する', hooked.state.saves > before);
  } finally {
    release?.();
    await manager?.close();
    hooked.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
