// 再発防止（ADR 0115）: 会話・タスク・使用量を 2,000 件入れた状態で、1 件の更新が全体を書かない。
// 数えるもの: 更新が書いた行の数（SQL の changes）と、文に渡した値の大きさ（文字列・バイト列の引数の長さ。tests/lib/sql-counter.mjs）。
// どちらも件数に比例してはならない: 会話は 100 件の置き場と 2,000 件の置き場で、同じ操作の数字が同じになることも確かめる。
// （ファイルの長さ（WAL）の差は、WAL を使い回すと実際の書き込み量を表さないので見ない）
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';
import { writeSessions, writeAgentTasks, writeUsage } from '../lib/data-store.mjs';
import { sqlCounter } from '../lib/sql-counter.mjs';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createUsageStore } from '../../core/usage.mjs';
import { createThreadStore } from '../../core/channels/threads.mjs';
import { createMemoryLearner } from '../../core/memory/learn.mjs';
import { threadTable, memoryStateTable, openRaw, dbPath } from '../../core/db.mjs';
import { hookedTaskStorage } from '../lib/task-storage.mjs';

export const name = 'store-write-scale';
export const title = '再発防止: 件数が増えても、1 件の更新が書く行数と値の大きさは変わらない（全体を書かない）';

const N = 2000, SMALL = 100;
const MAX_ROWS = 40;           // 1 件の更新で変わってよい行の数（contextSession は参照の行を張り直すので多め。全体は数万行）
const MAX_BYTES = 64 * 1024;   // 1 件の更新で文に渡してよい値の大きさ。全体は数十 MB
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

const url = file => pathToFileURL(path.join(ROOT, file)).href;
const run = (dir, script) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], {
  env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: url('core/store.mjs'), COUNTER_URL: url('tests/lib/sql-counter.mjs') },
  maxBuffer: 16 * 1024 * 1024,
}, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop()))));

// 子プロセスで store を読み込み、操作ごとに書いた行数と値の大きさを数える
const STORE_SCRIPT = `
  const store = await import(process.env.STORE_URL);
  const { sqlCounter } = await import(process.env.COUNTER_URL);
  const counter = sqlCounter();
  const all = await store.getAll();
  const results = {};
  const ops = {
    setSessionData: () => store.setSessionData('s50', 'draft', { text: 'hello' }),
    setMeta: () => store.setMeta('s51', { title: 'changed', lastModified: 99 }),
    recordChange: () => store.recordChange('s52', { by: 'human', field: 'title', from: 'a', to: 'b', reason: null }),
    setMode: () => store.setMode('s53', 'plan'),
    bot: () => store.setSessionData('s58', 'bot', { botId: 'b_x', kind: 'thread', channelId: 'c_1', threadId: 'p_1', memoryIndex: 3 }, { durable: true }),
    markRead: () => store.markRead([['s54', 3]]),
    outbox: () => store.setSessionData('s55', 'outbox', [{ id: 'm', status: 'queued' }], { durable: true }),
    contextSession: () => store.setSessionData('s56', 'contextSession', { ...all.s56.contextSession, at: 2 }),
    newConversation: () => store.setMeta('brand-new', { title: 'new' }),
    removeSession: () => store.removeSession('s57'),
    botCleared: () => store.setSessionData('s58', 'bot', null),
  };
  for (const [name, op] of Object.entries(ops)) results[name] = await counter.measure(op);
  console.log(JSON.stringify({ count: Object.keys(all).length, results }));
`;

const seedDir = async (label, count) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ply-write-scale-${label}-`));
  writeSessions(dir, Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, session(i)])));
  return dir;
};

export default async function (t) {
  const dirs = [], closers = [];
  try {
    const small = await seedDir('small', SMALL), large = await seedDir('large', N);
    dirs.push(small, large);
    const total = JSON.stringify(Object.fromEntries(Array.from({ length: N }, (_, i) => [`s${i}`, session(i)]))).length;

    // ---- 会話（store）
    const outSmall = await run(small, STORE_SCRIPT), outLarge = await run(large, STORE_SCRIPT);
    t.ok(`会話 ${SMALL} 件・${N} 件の置き場を読み込めている`, outSmall.count === SMALL && outLarge.count === N, `${outSmall.count} / ${outLarge.count}`);
    for (const [op, r] of Object.entries(outLarge.results)) {
      t.ok(`会話: ${op} は 1 件ぶんだけ書く（変わった行 ${r.changes} ≤ ${MAX_ROWS}、値 ${r.bytes}B < ${MAX_BYTES}B。全体は ${total}B）`, r.changes >= 1 && r.changes <= MAX_ROWS && r.bytes < MAX_BYTES, JSON.stringify(r));
      const s = outSmall.results[op];
      t.ok(`会話: ${op} が書く行数と値の大きさは、${SMALL} 件でも ${N} 件でも同じ（件数に比例しない）`, s.changes === r.changes && s.bytes === r.bytes && s.statements === r.statements, `${JSON.stringify(s)} / ${JSON.stringify(r)}`);
    }

    // ---- 委譲のタスク: 更新で書く行は 1 つで、起動（変わっていない行）では何も書かない
    writeAgentTasks(large, Object.fromEntries(Array.from({ length: N }, (_, i) => [`ply-task-${i}`, task(i)])));
    const counter = sqlCounter();
    closers.push(() => counter.restore());
    const hooked = hookedTaskStorage(large);
    closers.push(hooked.close);
    let manager;
    const opened = await counter.measure(async () => {
      manager = await createAgentTasks({ dataDir: large, taskStorage: hooked.taskStorage, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
        prepare: async () => ({ sessionId: 'child-new', backend: 'fake' }), execute: async () => ({ outcome: 'ok', text: 'ok' }), deliver: async () => 'ok' });
    });
    closers.push(() => manager.close());
    t.ok(`タスク ${N} 件を読み込み、変わっていない行は起動で書き直さない（変わった行 ${opened.changes}）`, manager.list().length === N && opened.changes === 0 && hooked.state.written.flat().length === 0, `${manager.list().length} / ${JSON.stringify(opened)}`);
    const sent = await counter.measure(async () => { await manager.call('parent-1', 'ply_task_send', { taskId: 'ply-task-1', message: 'more' }); await new Promise(resolve => setTimeout(resolve, 150)); });
    const writtenRows = hooked.state.written.flat();
    t.ok(`タスク: 状態の変化（追加の指示）が書く行は、そのタスクの 1 行だけ（変わった行 ${sent.changes}、値 ${sent.bytes}B）`, writtenRows.length >= 1 && writtenRows.every(id => id === 'ply-task-1') && sent.changes === writtenRows.length && sent.bytes < MAX_BYTES, `${writtenRows.join(',')} / ${JSON.stringify(sent)}`);
    const cancelled = await counter.measure(async () => { await manager.cancel('ply-task-2'); await new Promise(resolve => setTimeout(resolve, 150)); });
    t.ok(`タスク: 取り消しも 1 行だけ（変わった行 ${cancelled.changes}、値 ${cancelled.bytes}B）`, cancelled.changes >= 1 && cancelled.changes <= 3 && cancelled.bytes < MAX_BYTES, JSON.stringify(cancelled));
    await manager.close();

    // ---- 使用量
    writeUsage(large, { since: 1, records: Array.from({ length: N }, (_, i) => ({ id: `u${i}`, backend: 'fake', at: Date.now(), inputTokens: i, outputTokens: 1, cachedTokens: 0, costUsd: 0.01 })) });
    const usage = createUsageStore(large);
    closers.push(() => usage.close());
    const recorded = await counter.measure(() => usage.record({ id: 'u-new', backend: 'fake', inputTokens: 5, outputTokens: 1 }));
    t.ok(`使用量: 1 件の記録は 1 行を足すだけ（変わった行 ${recorded.changes}、値 ${recorded.bytes}B）`, recorded.changes === 1 && recorded.bytes < 1024, JSON.stringify(recorded));
    const summarized = await counter.measure(() => usage.summary('fake'));
    t.ok('使用量: 集計は何も書かない', summarized.changes === 0 && summarized.statements === 0, JSON.stringify(summarized));
    const summary = await usage.summary('fake');
    t.ok('使用量: 集計は件数どおり（2,000 件 + 1 件）', summary.sevenDay.turns === N + 1, String(summary.sevenDay.turns));

    // ---- bot・Channels・記憶（main で足された保存先。スレッドの状態は 1 スレッド 1 行、夜の整理の進みは 1 カーソル 1 行）
    const botScale = async (dir, count) => {
      // スレッド: count 件を入れておき、1 件を更新する
      const raw = openRaw(dbPath(dir), { create: true });
      const table = threadTable(raw);
      for (let i = 0; i < count; i++) table.put(`c_1/p_${i}`, 'c_1', JSON.stringify({ channelId: 'c_1', threadId: `p_${i}`, sessions: { b_x: `s-${i}` }, state: 'idle', tokens: { input: 1, output: 1, cached: 0 }, calls: 1, stopped: null, updatedAt: 1 }));
      raw.close();
      const threads = createThreadStore({ dir: path.join(dir, 'channels'), now: () => 5 });
      closers.push(() => threads.close());
      await threads.load();
      const thread = await counter.measure(() => threads.update('c_1', 'p_7', (cur) => ({ tokens: { input: cur.tokens.input + 10, output: 5 }, calls: cur.calls + 1 })));
      // 夜の整理: count 件の会話のカーソルを持ち、1 件だけ増えたとき
      let clock = 1000;
      const rows = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, backend: 'fake', lastModified: 1 }));
      const learner = createMemoryLearner({ dataDir: dir, channels: { dir: path.join(dir, 'channels') }, bots: { get: async () => null }, memory: {}, host: {}, clock: {},
        readPrefs: async () => ({}), listSessions: async () => rows, readMessages: async () => [], now: () => (clock += 1000) });
      closers.push(() => learner.close());
      await learner.runNow();
      const rerun = await counter.measure(() => learner.runNow());
      rows.push({ id: 'new-session', backend: 'fake', lastModified: 1 });
      const added = await counter.measure(() => learner.runNow());
      const cursors = openRaw(dbPath(dir)); const stored = cursors.prepare("SELECT COUNT(*) AS n FROM memory_state WHERE kind = 'cursor.sessions'").get().n; cursors.close();
      return { thread, rerun, added, stored };
    };
    const botSmall = await botScale(small, SMALL), botLarge = await botScale(large, N);
    t.ok(`スレッド: 1 件の更新（トークンの足し算）が書く行は 1 行（変わった行 ${botLarge.thread.changes}、値 ${botLarge.thread.bytes}B）。${SMALL} 件でも ${N} 件でも同じ`, botLarge.thread.changes === 1 && botLarge.thread.bytes < MAX_BYTES
      && JSON.stringify(botSmall.thread) === JSON.stringify(botLarge.thread), `${JSON.stringify(botSmall.thread)} / ${JSON.stringify(botLarge.thread)}`);
    t.ok(`夜の整理: ${N} 件のカーソルを持っていても、同じ内容の再実行が書くのは lastRunAt と様子（status。ADR 0117）の 2 行（変わった行 ${botLarge.rerun.changes}）`, botLarge.rerun.changes === 2 && JSON.stringify(botSmall.rerun) === JSON.stringify(botLarge.rerun), `${JSON.stringify(botSmall.rerun)} / ${JSON.stringify(botLarge.rerun)}`);
    t.ok(`夜の整理: 会話が 1 件増えたときに書くのは、そのカーソル（読んだ位置と最後まで読んだ印 seen）と lastRunAt・様子の 4 行（変わった行 ${botLarge.added.changes}）。${SMALL} 件でも ${N} 件でも同じ`, botLarge.added.changes === 4 && JSON.stringify(botSmall.added) === JSON.stringify(botLarge.added), `${JSON.stringify(botSmall.added)} / ${JSON.stringify(botLarge.added)}`);
    t.ok(`夜の整理: カーソルは 1 会話 1 行で DB に入っている（${botLarge.stored} 行）`, botLarge.stored === N + 1 && botSmall.stored === SMALL + 1, `${botSmall.stored} / ${botLarge.stored}`);
  } finally {
    for (const close of closers.reverse()) await close();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
