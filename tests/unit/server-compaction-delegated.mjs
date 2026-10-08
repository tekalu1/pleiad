import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-compaction-delegated';
export const title = '委譲の子の Claude だけ自動圧縮の窓（閾値 + 33000）を渡す。親・設定オフ・利用者の環境変数ではそのまま（ADR 0163）';
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

/** 親の会話から fake の子を 1 つ作り、compact-window の台本が返した値（compactWindow:…）を読む */
async function childWindow(c, parent, seen) {
  const delegate = ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'compact-window' });
  await c.runTurn({ prompt: delegate, sessionId: parent, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
  const row = await pollTask(c, parent, task => !seen.has(task.taskId) && task.sessionId && task.status === 'completed');
  seen.add(row.taskId);
  const text = JSON.stringify((await c.cmd('loadSession', { sessionId: row.sessionId })).messages ?? []);
  return /compactWindow:(\w+)/.exec(text)?.[1] ?? null;
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-delegated-'));
  // 利用者の環境変数が漏れ込まないよう、空文字（= 無いもの）で上書きする
  const server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', [VARIABLE]: '' }, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const seen = new Set();
  try {
    const parentTurn = await c.runTurn({ prompt: 'compact-window', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const parent = parentTurn.sessionId;
    const parentText = JSON.stringify((await c.cmd('loadSession', { sessionId: parent })).messages ?? []);
    t.ok('親の会話には窓を渡さない', parentText.includes('compactWindow:none'), parentText.slice(0, 200));

    t.ok('既定の設定は 150000', (await c.cmd('prefs')).autoCompaction.delegatedTokens === 150000);
    t.ok('委譲の子には 150000 + 33000 = 183000 を渡す', await childWindow(c, parent, seen) === '183000');

    const saved = await c.cmd('setAutoCompaction', { settings: { enabled: false, minTokens: 60000, delegatedTokens: 100000,
      claude: { enabled: false, delayMinutes: 15 }, codex: { enabled: false, delayMinutes: 50 } } });
    t.ok('閾値の保存', saved.delegatedTokens === 100000 && (await c.cmd('prefs')).autoCompaction.delegatedTokens === 100000);
    t.ok('放置圧縮を切っていても、子には新しい閾値の窓（133000）を渡す', await childWindow(c, parent, seen) === '133000');

    const refused = await c.cmd('setAutoCompaction', { settings: { enabled: true, minTokens: 60000, delegatedTokens: 50000,
      claude: { enabled: true, delayMinutes: 15 }, codex: { enabled: false, delayMinutes: 50 } } }).then(() => false, () => true);
    t.ok('70000 未満（0 を除く）の閾値は断る', refused && (await c.cmd('prefs')).autoCompaction.delegatedTokens === 100000);

    await c.cmd('setAutoCompaction', { settings: { enabled: true, minTokens: 60000, delegatedTokens: 0,
      claude: { enabled: true, delayMinutes: 15 }, codex: { enabled: false, delayMinutes: 50 } } });
    t.ok('0（オフ）なら子にも渡さない', await childWindow(c, parent, seen) === 'none');
  } finally {
    c.close();
    await server.stop();
  }

  // 利用者が同じ環境変数を置いていれば、それを優先して Pleiad は渡さない
  const userServer = await startServer({ dataDir: path.join(scratch, 'user-data'), env: { AGENT_HOST_BACKENDS: 'fake', [VARIABLE]: '400000' }, timeoutMs: 30_000 });
  const uc = await open({ port: userServer.port, token: userServer.token, autoAllow: true });
  try {
    const parent = (await uc.runTurn({ prompt: 'echo:first', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 })).sessionId;
    t.ok('利用者の環境変数が先にあれば、子にも渡さない', await childWindow(uc, parent, new Set()) === 'none');
  } finally {
    uc.close();
    await userServer.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
