// 再発防止（ADR 0106）: 会話 2,000 件・タスク 2,000 件・使用量 2,000 件を入れた状態で、1 件の更新が全体を直列化しない。
// 見るもの: 更新の間に JSON.stringify が返した最大の文字列の長さ（全体を直列化すれば MB になる）と、DB（WAL）に増えたバイト数。
// どちらも件数に比例してはならない。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';
import { writeSessions, writeAgentTasks, writeUsage } from '../lib/data-store.mjs';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createUsageStore } from '../../core/usage.mjs';
import { hookedTaskStorage } from '../lib/task-storage.mjs';

export const name = 'store-write-scale';
export const title = '再発防止: 件数が増えても、1 件の更新は全体を直列化せず、書くバイト数も件数に比例しない';

const N = 2000;
const LIMIT = 64 * 1024;   // 1 件の更新で許す、1 回の JSON.stringify の長さ。全体は数十 MB
const WAL_LIMIT = 256 * 1024;   // 1 件の更新で許す、WAL の増加（ページ単位で書くので数ページ分の余裕を見る）
const pad = i => `x${i}-`.repeat(40);

// 会話 1 件の記録。実データに近い大きさ（contextSession の report.entries と hookRuns を持つ）
const session = i => ({
  history: [{ at: '2026-10-01T00:00:00Z', by: 'human', field: 'title', from: null, to: `t${i}`, reason: null }],
  backend: 'fake', title: `title-${i}`, cwd: 'C:/work', createdAt: 1, lastModified: 2, completedAt: 3,
  contextSession: { version: 3, policy: { removedMcp: [] }, report: { cwd: 'C:/work', at: 1, entries: Array.from({ length: 12 }, (_, k) => ({ id: `e${k}`, name: `n${k}`, path: `C:/p/${k}`, hash: pad(k) })) } },
  hookRuns: Array.from({ length: 30 }, (_, k) => ({ phase: 'started', hookId: `h${k}`, name: pad(i), at: k })),
});
const task = i => ({ taskId: `ply-task-${i}`, sessionId: `child-${i}`, parentSessionId: `parent-${i % 50}`, manager: 'ply', backend: 'fake', depth: 1,
  task: pad(i), title: `t${i}`, createdAt: 1, updatedAt: 1, status: 'completed', notification: 'sent', result: pad(i).repeat(5), error: null, instructions: [], instructionRevision: 0, queue: [] });

/** fn の間に JSON.stringify が返した最大の長さと、呼び出し回数 */
async function measure(fn) {
  const original = JSON.stringify;
  let max = 0, calls = 0;
  JSON.stringify = function (...args) {
    const out = original.apply(this, args);
    if (typeof out === 'string') { calls++; if (out.length > max) max = out.length; }
    return out;
  };
  try { await fn(); } finally { JSON.stringify = original; }
  return { max, calls };
}

const run = (dir, script) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], {
  env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: pathToFileURL(path.join(ROOT, 'core', 'store.mjs')).href },
  maxBuffer: 16 * 1024 * 1024,
}, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));

// 子プロセスで store を読み込み、更新の間の stringify の最大長と WAL の増えた量を測る
const STORE_SCRIPT = `
  const fs = await import('node:fs');
  const store = await import(process.env.STORE_URL);
  const wal = process.env.AGENT_HOST_DATA + '/pleiad.db-wal';
  const walSize = () => { try { return fs.statSync(wal).size; } catch { return 0; } };
  const all = await store.getAll();
  const original = JSON.stringify;
  const results = {};
  async function measure(name, fn) {
    let max = 0, calls = 0;
    JSON.stringify = function (...args) { const out = original.apply(this, args); if (typeof out === 'string') { calls++; if (out.length > max) max = out.length; } return out; };
    const before = walSize();
    try { await fn(); } finally { JSON.stringify = original; }
    results[name] = { max, calls, wal: walSize() - before };
  }
  await measure('setSessionData', () => store.setSessionData('s1000', 'draft', { text: 'hello' }));
  await measure('setMeta', () => store.setMeta('s1001', { title: 'changed', lastModified: 99 }));
  await measure('recordChange', () => store.recordChange('s1002', { by: 'human', field: 'title', from: 'a', to: 'b', reason: null }));
  await measure('setMode', () => store.setMode('s1003', 'plan'));
  await measure('markRead', () => store.markRead([['s1004', 3]]));
  await measure('outbox', () => store.setSessionData('s1005', 'outbox', [{ id: 'm', status: 'queued' }], { durable: true }));
  console.log(JSON.stringify({ count: Object.keys(all).length, results }));
`;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-write-scale-'));
  const closers = [];
  try {
    const sessions = Object.fromEntries(Array.from({ length: N }, (_, i) => [`s${i}`, session(i)]));
    writeSessions(dir, sessions);
    writeAgentTasks(dir, Object.fromEntries(Array.from({ length: N }, (_, i) => [`ply-task-${i}`, task(i)])));
    writeUsage(dir, { since: 1, records: Array.from({ length: N }, (_, i) => ({ id: `u${i}`, backend: 'fake', at: Date.now(), inputTokens: i, outputTokens: 1, cachedTokens: 0, costUsd: 0.01 })) });
    const total = JSON.stringify(sessions).length;

    // ---- 会話（store）
    const out = JSON.parse((await run(dir, STORE_SCRIPT)).trim().split(/\r?\n/).pop());
    t.ok(`会話 ${N} 件を読み込めている`, out.count === N, String(out.count));
    for (const [op, r] of Object.entries(out.results)) {
      t.ok(`会話: ${op} は全体を直列化しない（stringify の最大 ${r.max}B < ${LIMIT}B。全体は ${total}B）`, r.max < LIMIT, JSON.stringify(r));
      t.ok(`会話: ${op} が DB に書くのは 1 件ぶんだけ（WAL の増加 ${r.wal}B < ${WAL_LIMIT}B）`, r.wal < WAL_LIMIT, JSON.stringify(r));
    }

    // ---- 委譲のタスク。更新で書く行は 1 つで、起動（変わっていない行）では何も書かない
    const hooked = hookedTaskStorage(dir);
    closers.push(hooked.close);
    const manager = await createAgentTasks({ dataDir: dir, taskStorage: hooked.taskStorage, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
      prepare: async () => ({ sessionId: 'child-new', backend: 'fake' }), execute: async () => ({ outcome: 'ok', text: 'ok' }), deliver: async () => 'ok' });
    t.ok(`タスク ${N} 件を読み込み、変わっていない行は起動で書き直さない`, manager.list().length === N && hooked.state.written.flat().length === 0, `${manager.list().length} / ${hooked.state.written.flat().length}`);
    const sentWith = await measure(() => manager.call('parent-1', 'ply_task_send', { taskId: 'ply-task-1', message: 'more' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const writtenRows = hooked.state.written.flat();
    t.ok(`タスク: 状態の変化（追加の指示）は全体を直列化しない（stringify の最大 ${sentWith.max}B < ${LIMIT}B）`, sentWith.max < LIMIT, JSON.stringify(sentWith));
    t.ok('タスク: 状態の変化で書く行は、そのタスクの行だけ', writtenRows.length >= 1 && writtenRows.every(id => id === 'ply-task-1'), writtenRows.slice(0, 5).join(','));
    const cancelled = await measure(() => manager.cancel('ply-task-2'));
    await new Promise(resolve => setTimeout(resolve, 100));
    t.ok(`タスク: 取り消しも全体を直列化しない（stringify の最大 ${cancelled.max}B < ${LIMIT}B）`, cancelled.max < LIMIT, JSON.stringify(cancelled));
    await manager.close();

    // ---- 使用量
    const usage = createUsageStore(dir);
    closers.push(() => usage.close());
    const recorded = await measure(() => usage.record({ id: 'u-new', backend: 'fake', inputTokens: 5, outputTokens: 1 }));
    t.ok(`使用量: 1 件の記録は 1 行を足すだけ（stringify の最大 ${recorded.max}B < ${LIMIT}B）`, recorded.max < LIMIT, JSON.stringify(recorded));
    const summarized = await measure(() => usage.summary('fake'));
    t.ok(`使用量: 集計も全体を直列化しない（stringify の最大 ${summarized.max}B）`, summarized.max < LIMIT, JSON.stringify(summarized));
    const summary = await usage.summary('fake');
    t.ok('使用量: 集計は件数どおり（2,000 件 + 1 件）', summary.sevenDay.turns === N + 1, String(summary.sevenDay.turns));
  } finally {
    for (const close of closers) await close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
