import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-compaction-delegated';
export const title = '委譲の子の Claude だけ自動圧縮の窓（固定の部分 + 空き + 33000）を渡す。固定の部分は子自身 → 同じ作業場所・モデル → 直近 → 7 万（ADR 0166）';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const VARIABLE = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

async function pollTask(c, parent, fn, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = (await c.cmd('agentTasks')).find(row => row.parentSessionId === parent && fn(row));
    if (found) return found;
    await sleep(50);
  }
  throw new Error('委譲タスクが条件を満たさなかった');
}

/** 親の会話へ送る。前の子の完了の知らせが親に届くターンと重なったら、終わるのを待って送り直す */
async function parentTurn(c, parent, prompt) {
  const end = Date.now() + 20_000;
  for (;;) {
    try { return await c.runTurn({ prompt, sessionId: parent, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 }); }
    catch (err) {
      if (Date.now() > end || !/切り替え中|実行中/.test(String(err?.message ?? err))) throw err;
      await sleep(100);
    }
  }
}

/** 子の会話で compact-window の台本が返した値（compactWindow:…）をすべて読む */
async function windows(c, sessionId) {
  const text = JSON.stringify((await c.cmd('loadSession', { sessionId })).messages ?? []);
  return [...text.matchAll(/compactWindow:(\w+)/g)].map(m => m[1]);
}

/**
 * 親の会話から fake の子を 1 つ作り、compact-window の台本が返した値を読む。
 * task に base:N を付けると、子の最初の返答が固定の部分 N を出す（core/backends/fake.mjs）
 */
async function childWindow(c, parent, seen, { task = 'compact-window', cwd } = {}) {
  const delegate = ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task, ...(cwd ? { cwd } : {}) });
  await parentTurn(c, parent, delegate);
  const row = await pollTask(c, parent, task => !seen.has(task.taskId) && task.sessionId && task.status === 'completed');
  seen.add(row.taskId);
  return { window: (await windows(c, row.sessionId)).at(-1) ?? null, row };
}

const settings = (patch) => ({ enabled: true, minTokens: 60000, delegatedHeadroom: 100000,
  claude: { enabled: true, delayMinutes: 15 }, codex: { enabled: false, delayMinutes: 50 }, ...patch });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-delegated-'));
  const dataDir = path.join(scratch, 'data');
  const elsewhere = path.join(scratch, 'elsewhere');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(elsewhere, { recursive: true });
  // 前の版の固定の閾値（delegatedTokens。ADR 0163）が prefs に残っている状態から始める。移行はせず、空きは既定に戻る
  await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ autoCompaction: { enabled: true, minTokens: 150000, delegatedTokens: 180000,
    claude: { enabled: true, delayMinutes: 50 }, codex: { enabled: false, delayMinutes: 25 } } }));
  // 利用者の環境変数が漏れ込まないよう、空文字（= 無いもの）で上書きする
  const env = { AGENT_HOST_BACKENDS: 'fake', [VARIABLE]: '' };
  let server = await startServer({ dataDir, env, timeoutMs: 30_000 });
  let c = await open({ port: server.port, token: server.token, autoAllow: true });
  const seen = new Set();
  let parent;
  try {
    const opened = await c.runTurn({ prompt: 'compact-window', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    parent = opened.sessionId;
    t.ok('親の会話には窓を渡さない', (await windows(c, parent)).includes('none'));

    const loaded = (await c.cmd('prefs')).autoCompaction;
    t.ok('前の版の delegatedTokens が残っていても読めて、空きは既定の 100000 になる', loaded.delegatedHeadroom === 100000
      && !('delegatedTokens' in loaded) && loaded.minTokens === 150000, JSON.stringify(loaded));

    const first = await childWindow(c, parent, seen, { task: 'compact-window base:80000' });
    t.ok('測った値が無い最初の子には 70000 + 100000 + 33000 = 203000 を渡す', first.window === '203000', first.window);
    t.ok('タスクの記録に閾値と内訳（固定の部分・出どころ・空き）が残る', JSON.stringify(first.row.compaction)
      === JSON.stringify({ threshold: 170000, base: 70000, source: 'default', headroom: 100000 }), JSON.stringify(first.row.compaction));

    const second = await childWindow(c, parent, seen, { task: 'compact-window base:60000' });
    t.ok('次の子は同じ作業場所・同じモデルの直近の子の固定の部分を使う（80000 + 100000 + 33000 = 213000）',
      second.window === '213000' && second.row.compaction?.source === 'same' && second.row.compaction.base === 80000, JSON.stringify(second.row.compaction));

    const other = await childWindow(c, parent, seen, { cwd: elsewhere });
    t.ok('別の作業場所の子は直近の値を使う（60000 + 100000 + 33000 = 193000）',
      other.window === '193000' && other.row.compaction?.source === 'recent' && other.row.compaction.base === 60000, JSON.stringify(other.row.compaction));

    // 最初の子に追加の指示を送る。2 ターン目からは子自身の固定の部分（80000）を使い、直近の値（60000）は使わない
    await parentTurn(c, parent, ply('ply_task_send', { taskId: first.row.taskId, message: 'compact-window' }));
    const end = Date.now() + 30_000;
    let again = [];
    while (Date.now() < end && (again = await windows(c, first.row.sessionId)).length < 2) await sleep(50);
    const firstRow = (await c.cmd('agentTasks')).find(row => row.taskId === first.row.taskId);
    t.ok('子の 2 ターン目からは子自身の固定の部分を使う（80000 + 100000 + 33000 = 213000）', again.at(-1) === '213000'
      && firstRow?.compaction?.source === 'own' && firstRow.compaction.threshold === 180000, `${again} ${JSON.stringify(firstRow?.compaction)}`);

    const saved = await c.cmd('setAutoCompaction', { settings: settings({ enabled: false, delegatedHeadroom: 50000, claude: { enabled: false, delayMinutes: 15 } }) });
    t.ok('空きの保存', saved.delegatedHeadroom === 50000 && (await c.cmd('prefs')).autoCompaction.delegatedHeadroom === 50000);
    t.ok('放置圧縮を切っていても、子には新しい空きの窓（60000 + 50000 + 33000 = 143000）を渡す', (await childWindow(c, parent, seen)).window === '143000');

    const refused = await c.cmd('setAutoCompaction', { settings: settings({ delegatedHeadroom: 20000 }) }).then(() => false, () => true);
    t.ok('30000 未満（0 を除く）の空きは断る', refused && (await c.cmd('prefs')).autoCompaction.delegatedHeadroom === 50000);
  } finally {
    c.close();
    await server.stop();
  }

  // 同じデータ置き場で起動し直しても、直近の固定の部分（context-bases.json）が残る
  server = await startServer({ dataDir, env, timeoutMs: 30_000 });
  c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const restarted = await childWindow(c, parent, seen);
    t.ok('起動し直しても直近の固定の部分を使う（60000 + 50000 + 33000 = 143000）',
      restarted.window === '143000' && restarted.row.compaction?.source === 'same', JSON.stringify(restarted.row.compaction));

    await c.cmd('setAutoCompaction', { settings: settings({ delegatedHeadroom: 0 }) });
    const off = await childWindow(c, parent, seen);
    t.ok('0（オフ）なら子にも渡さず、タスクに閾値を残さない', off.window === 'none' && off.row.compaction == null);
  } finally {
    c.close();
    await server.stop();
  }

  // 利用者が同じ環境変数を置いていれば、それを優先して Pleiad は渡さない
  const userServer = await startServer({ dataDir: path.join(scratch, 'user-data'), env: { AGENT_HOST_BACKENDS: 'fake', [VARIABLE]: '400000' }, timeoutMs: 30_000 });
  const uc = await open({ port: userServer.port, token: userServer.token, autoAllow: true });
  try {
    const userParent = (await uc.runTurn({ prompt: 'echo:first', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 })).sessionId;
    t.ok('利用者の環境変数が先にあれば、子にも渡さない', (await childWindow(uc, userParent, new Set())).window === 'none');
  } finally {
    uc.close();
    await userServer.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
