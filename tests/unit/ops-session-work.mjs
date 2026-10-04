// 画面の中だけ（ui-internal）から操作に移したもの（ADR 0105）を、依存を差し替えて確かめる（サーバーは立てない）。
//   - 分け方: 移した 24 のコマンドはどれかの操作の legacyCommand、残した 11 は ui-internal のままで AI の一覧（list_ops）に出ない
//   - 危険度: shell.run・sessions.switchBackend は guarded（承認待ち・bypass は記録して通る・束縛なしは NEEDS_UI・読み取りの会話は断る）、
//     切り替えで承認モードが緩くなるときは AI から NEEDS_UI。止める・印だけの書き込みは write
//   - AI の形: 一覧は limit / cursor、本文と出力は切る、コマンド・引数・env・URL の秘密は伏せる。省いた会話・場所はその会話
//   - 人（画面）の形: 今までどおり（uiHandler）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '../../core/ops/index.mjs';
import { MASK } from '../../core/ops/registry.mjs';
import { SHELL_OUTPUT_CHARS } from '../../core/ops/shell.mjs';
import { loosens } from '../../core/ops/session-work.mjs';
import { patchText } from '../../core/ops/git.mjs';
import { t as t0 } from '../../core/i18n.mjs';

export const name = 'ops-session-work';
export const title = '画面の中だけから移した操作: 分け方・危険度・AI に返す形（区切り・切る・伏せる）・画面の形';

const MARKER = 'SECRET-MARKER-41ab';
const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ops-baseline.json');

// 移したコマンドと操作（ADR 0105 の表）
export const MOVED = {
  notifyStatus: 'notify.status', slashSkills: 'context.skills', sessionContext: 'context.session', contextDiff: 'context.diff', gitStatus: 'git.status',
  gitPanel: 'git.changes', gitDiff: 'git.diff', worktreeCheck: 'worktrees.check', worktreeSettings: 'worktrees.settings', agentMcp: 'context.agentMcp',
  nativeInstructions: 'context.nativeInstructions', contextFindings: 'context.findings', scanContext: 'context.scan', hooksUnifyPreview: 'hooks.unifyPreview',
  runShell: 'shell.run', stopShell: 'shell.stop', skipShell: 'shell.skip', switchBackend: 'sessions.switchBackend', setGrouped: 'sessions.setGrouped',
  listDirs: 'files.listDirs', loadSubagent: 'sessions.readSubagent', findSubagent: 'sessions.subagents', loadBackground: 'sessions.background', stopBackground: 'sessions.stopBackground',
};
// 画面の中だけに残したもの（理由は ADR 0105 の表）
export const KEPT = ['presence', 'notifyRegister', 'plyHookPreview', 'hookTargets', 'onboardingStatus', 'onboardingSeen', 'completeSetup', 'hostCapabilities', 'resolvePath', 'prefs', 'uploadCheck'];

const human = { by: 'human', via: 'ui', local: true };
const MODES = { bypass: { scope: 'full', autonomy: 'never' }, ask: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'readonly', autonomy: 'ask' } };
const agent = (mode) => ({ by: 'agent', via: 'mcp', sessionId: 's1', _mode: mode });
const CLAUDE_MODES = { default: { scope: 'workspace', autonomy: 'ask' }, bypass: { scope: 'full', autonomy: 'never' } };
const AGY_MODES = { yolo: { scope: 'full', autonomy: 'never' } };

function fakeDeps() {
  const calls = [];
  const deps = {
    locale: 'ja', calls,
    modeOf: async () => deps.mode,
    audit: async (e) => calls.push(['audit', e.op, e.risk]),
    approve: async (req) => { calls.push(['approve', req.op, req.change]); return { pending: true, requestId: 'setting-x' }; },
    sessionCwd: async () => 'C:/work',
    sessionBackend: async () => 'claude',
    shell: {
      describe: async (id) => ({ backend: 'claude', cwd: 'C:/work', title: `会話 ${id}` }),
      run: async (a) => { calls.push(['shell.run', a]); return { runId: a.runId }; },
      wait: async (runId, ms) => { calls.push(['shell.wait', runId, ms]); return { exitCode: 0, stdout: `${'x'.repeat(SHELL_OUTPUT_CHARS + 100)}END`, stderr: '', durationMs: 5 }; },
      stop: (runId) => { calls.push(['shell.stop', runId]); return { stopped: true }; },
      skip: async (a) => { calls.push(['shell.skip', a]); return { runId: a.runId, skip: a.skip }; },
    },
    sessionWork: {
      switchPlan: async (id, to) => (id === 'missing' ? null : { title: 't', from: { backend: 'claude', mode: 'default', position: CLAUDE_MODES.default },
        to: to === 'antigravity' ? { backend: 'antigravity', label: 'Antigravity', mode: 'yolo', position: AGY_MODES.yolo }
          : to === 'codex' ? { backend: 'codex', label: 'Codex', mode: 'ask', position: { scope: 'workspace', autonomy: 'ask' } } : null }),
      switchBackend: async (id, to) => { calls.push(['switch', id, to]); return { sessionId: id, backend: to }; },
      setGrouped: async (id, ungrouped) => { calls.push(['setGrouped', id, ungrouped]); return { sessionId: id, ungrouped }; },
      backgroundTasks: async (id) => { calls.push(['backgroundTasks', id]); return [{ id: 't1', kind: 'terminal', label: `serve --token ${MARKER}` }]; },
      background: async (id, taskId) => ({ task: { id: taskId, status: 'running', output: `${'o'.repeat(9000)}TAIL` } }),
      stopBackground: async (id, taskId) => { calls.push(['stopBackground', id, taskId]); return { stopped: true }; },
      findSubagent: async (id, toolId) => ({ agentId: toolId === 'tool-1' ? 'a1' : null, status: 'completed', startedAt: null, endedAt: null }),
      subagents: async () => Array.from({ length: 35 }, (_, i) => ({ agentId: `a${i}`, origin: `tool-${i}`, status: null })),
      readSubagent: async (id, agentId) => ({ agentId, sessionId: id, origin: 'tool-1', prompt: 'p'.repeat(3000),
        messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}:${'m'.repeat(2500)}`, tools: null, toolCalls: [{ name: 'Bash', input: { command: 'x' } }], thinking: 'secret thinking', at: null })) }),
    },
    context: {
      session: async (id) => { calls.push(['context.session', id]); return { report: { entries: [{ kind: 'mcp', name: 'leak', command: 'node', args: ['srv.js', '--token', MARKER], env: { K: MARKER }, content: `{"args":["--token",\n"${MARKER}"]}` }] }, pinned: false, changed: null }; },
      diff: async () => ({ files: [{ path: 'AGENTS.md', before: 'b'.repeat(5000), after: 'a' }] }),
      scan: async (a) => { calls.push(['context.scan', a]); return { cwd: a.cwd, configs: [{ path: '.claude.json', content: `"--token",\n"${MARKER}"` }], entries: [
        ...Array.from({ length: 33 }, (_, i) => ({ kind: 'instruction', name: `i${i}`, content: 'c'.repeat(3000) })),
        { kind: 'mcp', name: 'web', url: `https://mcp.example/m?key=${MARKER}`, headers: { X: MARKER }, content: MARKER },
        { kind: 'mcp', name: 'leak', command: 'node', args: ['srv.js', '--token', MARKER], env: { K: MARKER } },
      ] }; },
      skills: async () => Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, description: 'd' })),
      agentMcp: async () => ({ cwd: 'C:/work', agents: { claude: [{ name: 'x', command: `node srv.js --token ${MARKER}`, endpoint: `https://e.example/?k=${MARKER}` }], codex: [] } }),
      nativeInstructions: async (cwd, backend) => { calls.push(['nativeInstructions', cwd, backend]); return { cwd, agent: backend, entries: [{ id: 'e', name: 'AGENTS.md', tokens: 10 }] }; },
      findings: async () => ({ duplicates: [], missing: [], more: { duplicates: 0, missing: 0 } }),
    },
    git: {
      status: async (a) => { calls.push(['git.status', a]); return { git: { branch: 'main' } }; },
      panel: async (a, o) => { calls.push(['git.panel', a, o]); return { git: { branch: 'main' }, timeline: Array.from({ length: 30 }, (_, i) => ({ n: i })),
        changes: { range: 'uncommitted', hasSession: false, total: { files: 45, add: 1, del: 0 }, files: Array.from({ length: 45 }, (_, i) => ({ path: `f${i}`, add: 1, del: 0 })) }, worktrees: { current: null, leftovers: [] }, at: 1 }; },
      diff: async (a) => ({ diff: a.path ? { range: 'uncommitted', path: a.path, hunks: [{ header: '@@ -1 +1 @@', lines: [{ t: '-', s: 'old' }, { t: '+', s: `new --token ${MARKER}` }] }], binary: false, truncated: false } : null }),
    },
    notify: { status: async () => ({ pc: { done: true, reply: false, failed: true }, relayConnected: true, devices: [{ id: 'dev-secret-id', platform: 'ios', notify: { muted: true } }, { id: 'dev-2', platform: 'android', notify: {} }] }) },
    worktrees: { check: async (a) => { calls.push(['worktrees.check', a]); return { git: true, current: null, conflicts: [], canSplit: true, always: false }; }, getSettings: async () => ({ always: true }) },
    hooks: { unifyPreview: async (a) => { calls.push(['unifyPreview', a]); return { imports: [{ id: 'i', digest: 'd', command: `deploy --token ${MARKER}` }], revision: 'r1' }; } },
    files: { listDirs: async (p, o) => { calls.push(['listDirs', p, o]); return { path: p ?? 'C:/home', parent: null, dirs: Array.from({ length: 40 }, (_, i) => `d${i}`), files: o.files ? [{ name: 'a.txt', size: 1, mtime: 0 }] : undefined, truncated: false, roots: [] }; } },
  };
  return deps;
}

const call = async (who, id, args, deps = fakeDeps()) => {
  if (who._mode) deps.mode = MODES[who._mode];
  const { _mode, ...principal } = who;
  return { r: await registry.invoke(principal, id, args, deps), deps };
};
const has = (r) => JSON.stringify(r).includes(MARKER);

export default async function (t) {
  // ---- 分け方
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).commands;
  const legacy = new Map(registry.ops.flatMap((op) => [op.legacyCommand, ...(op.legacyAliases ?? [])].filter(Boolean).map((n) => [n, op.id])));
  const wrong = Object.entries(MOVED).filter(([cmd, id]) => legacy.get(cmd) !== id || cmd in baseline);
  t.ok('移した 24 のコマンドは表のとおりの操作の legacyCommand で、基準（ui-internal）から外れた', Object.keys(MOVED).length === 24 && wrong.length === 0, JSON.stringify(wrong));
  t.ok('残した 11 は ui-internal のまま、どの操作にもなっていない', KEPT.every((c) => baseline[c] === 'ui-internal' && !legacy.has(c)), KEPT.filter((c) => baseline[c] !== 'ui-internal' || legacy.has(c)).join(','));
  for (const via of ['mcp', 'cli', 'mcp-stdio']) {
    const seen = registry.list({ by: 'agent', via, sessionId: via === 'mcp' ? 's1' : undefined, mode: MODES.bypass }).flatMap((op) => [op.legacyCommand, ...(op.legacyAliases ?? [])]);
    t.ok(`残した ui-internal は AI の一覧（list_ops・${via}）に出ない`, KEPT.every((c) => !seen.includes(c)));
    t.ok(`移した操作は AI の一覧（${via}）に出る`, Object.values(MOVED).every((id) => registry.list({ by: 'agent', via, sessionId: 's1', mode: MODES.bypass }).some((op) => op.id === id)));
  }
  const listOps = registry.describe({ by: 'agent', via: 'mcp', sessionId: 's1', mode: MODES.bypass }, 'ja');
  t.ok('list_ops の説明（describe）に移した操作が辞書の文で載る', Object.values(MOVED).every((id) => listOps.some((e) => e.id === id && e.summary && !e.summary.startsWith('ops.'))));
  t.ok('ui-internal の件数は 16（42 から、この ADR で 24、ADR 0104 で messageAction・markRead を移した）', Object.values(baseline).filter((k) => k === 'ui-internal').length === 16);

  // ---- 危険度
  const risks = Object.fromEntries(Object.values(MOVED).map((id) => [id, registry.get(id).risk]));
  t.ok('任意のコマンドを動かす shell.run と、承認モードの掛かる範囲が変わる sessions.switchBackend は guarded', risks['shell.run'] === 'guarded' && risks['sessions.switchBackend'] === 'guarded');
  const writes = ['shell.stop', 'shell.skip', 'sessions.stopBackground', 'sessions.setGrouped'];
  t.ok('止める・印だけの書き込みは write（riskReason つき）', writes.every((id) => risks[id] === 'write' && registry.get(id).riskReason));
  t.ok('ほかは読むだけ（read）', Object.entries(risks).filter(([id]) => ![...writes, 'shell.run', 'sessions.switchBackend'].includes(id)).every(([, r]) => r === 'read'));

  const asked = await call(agent('ask'), 'shell.run', { command: `echo ${MARKER}`, reason: '確かめる' });
  const card = asked.deps.calls.find((c) => c[0] === 'approve');
  t.ok('shell.run: 承認が要る会話では承認待ち（PENDING_APPROVAL）で返り、まだ動かさない', asked.r.pending === true && asked.r.result.code === 'PENDING_APPROVAL' && asked.r.result.message.includes('コマンドの実行は') && asked.r.result.message.includes('まだ実行していません') && !asked.r.result.message.includes('shell.run') && !asked.deps.calls.some((c) => c[0] === 'shell.run'));
  t.ok('shell.run: 承認カードはどの会話で何を動かすか（コマンドの行・説明・緩める印）', card?.[1] === 'shell.run' && card[2].rows[0].path === 'shell.command' && card[2].rows[0].before === undefined && card[2].rows[0].after.includes('echo') && card[2].note.includes('会話 s1') && card[2].loosens === true, JSON.stringify(card?.[2]));
  const ran = await call(agent('bypass'), 'shell.run', { command: 'echo hi' });
  const runArgs = ran.deps.calls.find((c) => c[0] === 'shell.run')?.[1];
  t.ok('shell.run: 承認なしの会話（bypass）は確認なしで通り、記録（audit）が残る。会話を省くとその会話、runId は作る', ran.r.ok && runArgs?.sessionId === 's1' && /^ply-[0-9a-f-]{36}$/.test(runArgs.runId)
    && ran.deps.calls.some((c) => c[0] === 'audit' && c[1] === 'shell.run' && c[2] === 'guarded'), JSON.stringify(runArgs));
  t.ok('shell.run: 終わるまで待った結果を返し、出力は末尾を残して切る', ran.r.result.status === 'done' && ran.r.result.exitCode === 0 && ran.r.result.stdout.endsWith('END')
    && ran.r.result.stdout.length === SHELL_OUTPUT_CHARS && ran.r.result.truncated === true && ran.deps.calls.find((c) => c[0] === 'shell.wait')?.[2] === 30_000, JSON.stringify({ ...ran.r.result, stdout: ran.r.result.stdout?.length }));
  const noWait = await call(agent('bypass'), 'shell.run', { command: 'serve', waitMs: 0 });
  t.ok('shell.run: waitMs: 0 は待たずに running で返る', noWait.r.result.status === 'running' && !noWait.deps.calls.some((c) => c[0] === 'shell.wait'));
  t.ok('shell.run: 束縛されない呼び出しは NEEDS_UI、読み取りの会話は READ_ONLY_MODE', (await registry.invoke({ by: 'agent', via: 'cli' }, 'shell.run', { command: 'x', sessionId: 's1' }, fakeDeps())).code === 'NEEDS_UI'
    && (await call(agent('plan'), 'shell.run', { command: 'x' })).r.code === 'READ_ONLY_MODE');
  const screen = await call(human, 'shell.run', { sessionId: 's9', runId: 'run-12345678', command: 'ls', cwd: 'C:/x' });
  t.ok('shell.run: 画面（人）は承認なしで、今までどおりすぐ runId を返す（待たない）', screen.r.ok && screen.r.result.runId === 'run-12345678' && !screen.deps.calls.some((c) => c[0] === 'shell.wait'));
  const stopped = await call(agent('ask'), 'shell.stop', { runId: 'run-12345678' });
  t.ok('shell.stop: 承認なしで止める（write）。読み取りの会話からは断る', stopped.r.ok && stopped.r.result.stopped === true && (await call(agent('plan'), 'shell.stop', { runId: 'run-12345678' })).r.code === 'READ_ONLY_MODE');
  const skipped = await call(agent('ask'), 'shell.skip', { runId: 'run-12345678', skip: true });
  t.ok('shell.skip: 会話を省くとその会話', skipped.r.ok && skipped.deps.calls.find((c) => c[0] === 'shell.skip')?.[1].sessionId === 's1');

  const loose = await call(agent('bypass'), 'sessions.switchBackend', { sessionId: 's2', backend: 'antigravity' });
  t.ok('sessions.switchBackend: 承認モードが緩くなる切り替え（Antigravity の全自動）は、bypass の会話からでも NEEDS_UI で断り、切り替えない', loose.r.code === 'NEEDS_UI' && !loose.deps.calls.some((c) => c[0] === 'switch'), JSON.stringify(loose.r));
  const switchAsk = await call(agent('ask'), 'sessions.switchBackend', { sessionId: 's2', backend: 'codex' });
  const switchCard = switchAsk.deps.calls.find((c) => c[0] === 'approve');
  t.ok('sessions.switchBackend: 緩くならない切り替えは承認待ち。カードにエージェントと承認モードの前後', switchAsk.r.pending === true && switchCard?.[2].rows.some((r) => r.path === 'backend' && r.after === '"codex"') && switchCard[2].rows.some((r) => r.path === 'mode'), JSON.stringify(switchCard?.[2]));
  const switchBypass = await call(agent('bypass'), 'sessions.switchBackend', { sessionId: 's2', backend: 'codex' });
  t.ok('sessions.switchBackend: bypass の会話は確認なしで切り替え、記録が残る', switchBypass.r.ok && switchBypass.deps.calls.some((c) => c[0] === 'switch' && c[1] === 's2' && c[2] === 'codex') && switchBypass.deps.calls.some((c) => c[0] === 'audit'));
  t.ok('sessions.switchBackend: 無い会話は SESSION_NOT_FOUND、知らないエージェントは INVALID（カードの前に断る）', (await call(agent('ask'), 'sessions.switchBackend', { sessionId: 'missing', backend: 'codex' })).r.code === 'SESSION_NOT_FOUND'
    && (await call(agent('ask'), 'sessions.switchBackend', { sessionId: 's2', backend: 'nope' })).r.code === 'INVALID');
  t.ok('sessions.switchBackend: 画面（人）は今までどおり承認なしで切り替える（緩くなる切り替えも人は選べる）', (await call(human, 'sessions.switchBackend', { sessionId: 's2', backend: 'antigravity' })).r.ok);
  const humanNoSession = (await call(human, 'sessions.switchBackend', { backend: 'codex' })).r;
  t.ok('sessions.switchBackend: 画面が会話を言わなければ今までの文で断る（code なし）', humanNoSession.ok === false && humanNoSession.code === 'FAILED' && humanNoSession.error === t0('session.required'), JSON.stringify(humanNoSession));
  t.ok('loosens: 範囲が広い・聞く回数が少ないほうへの切り替えだけ緩くなる', loosens(CLAUDE_MODES.default, AGY_MODES.yolo) && !loosens(CLAUDE_MODES.bypass, CLAUDE_MODES.default) && !loosens(CLAUDE_MODES.default, { scope: 'workspace', autonomy: 'ask' })
    && loosens({ scope: 'readonly', autonomy: 'ask' }, { scope: 'workspace', autonomy: 'ask' }));
  const grouped = await call(agent('ask'), 'sessions.setGrouped', { ungrouped: true });
  t.ok('sessions.setGrouped: 承認なし（write）、会話を省くとその会話', grouped.r.ok && grouped.deps.calls.some((c) => c[0] === 'setGrouped' && c[1] === 's1' && c[2] === true));

  // ---- バックグラウンドの処理・サブエージェント
  const tasks = await call(agent('ask'), 'sessions.background', {});
  t.ok('sessions.background: taskId を省くとその会話の一覧（ラベルの秘密は伏せる）', tasks.r.ok && tasks.r.result.tasks[0].id === 't1' && !has(tasks.r) && tasks.deps.calls.some((c) => c[0] === 'backgroundTasks' && c[1] === 's1'), JSON.stringify(tasks.r));
  const detail = (await call(agent('ask'), 'sessions.background', { taskId: 't1' })).r.result.task;
  t.ok('sessions.background: 詳細の出力は末尾を残して切る（既定 8000 字）', detail.output.endsWith('TAIL') && detail.output.length === 8000 && detail.truncated === true);
  const screenTask = (await call(human, 'sessions.background', { sessionId: 's1', taskId: 't1' })).r.result.task;
  t.ok('sessions.background: 画面には出力を切らずに返す', screenTask.output.length === 9004);
  t.ok('sessions.background: 画面が id を揃えなければ今までの文で断る', (await call(human, 'sessions.background', { sessionId: 's1' })).r.code === 'FAILED');
  const stopBg = await call(agent('ask'), 'sessions.stopBackground', { taskId: 't1' });
  t.ok('sessions.stopBackground: 承認なしで止める（write）、会話を省くとその会話。読み取りの会話からは断る', stopBg.r.result.stopped === true && stopBg.deps.calls.some((c) => c[0] === 'stopBackground' && c[1] === 's1')
    && (await call(agent('plan'), 'sessions.stopBackground', { taskId: 't1' })).r.code === 'READ_ONLY_MODE');
  const subs = (await call(agent('ask'), 'sessions.subagents', {})).r.result;
  const subs2 = (await call(agent('ask'), 'sessions.subagents', { cursor: subs.next })).r.result;
  t.ok('sessions.subagents: 一覧は 30 件ずつ区切り、next で続きを返す', subs.total === 35 && subs.subagents.length === 30 && subs2.subagents.length === 5 && subs2.next === null && subs2.subagents[0].agentId === 'a30');
  t.ok('sessions.subagents: toolId を渡すとその子だけ（画面の findSubagent と同じ形）', (await call(agent('ask'), 'sessions.subagents', { toolId: 'tool-1' })).r.result.agentId === 'a1'
    && (await call(human, 'sessions.subagents', { sessionId: 's1', toolId: 'tool-1' })).r.result.agentId === 'a1');
  const read = (await call(agent('ask'), 'sessions.readSubagent', { agentId: 'a1', limit: 5 })).r.result;
  t.ok('sessions.readSubagent: 発言を区切り、本文と依頼文を切る。考えとツールの入力は返さない', read.total === 40 && read.messages.length === 5 && read.next && read.messages[0].text.length === 2000 && read.messages[0].truncated === true
    && read.prompt.length === 2000 && !JSON.stringify(read).includes('secret thinking') && !JSON.stringify(read).includes('"input"'), JSON.stringify(read).slice(0, 300));
  const screenRead = (await call(human, 'sessions.readSubagent', { sessionId: 's1', agentId: 'a1' })).r.result;
  t.ok('sessions.readSubagent: 画面には全量（ツールの入力・考えも）を返す', screenRead.messages.length === 40 && screenRead.messages[0].thinking === 'secret thinking' && screenRead.messages[0].toolCalls);

  // ---- コンテキスト
  const scan = await call(agent('ask'), 'context.scan', {});
  t.ok('context.scan: 会話から cwd を省くとその会話の作業場所', scan.deps.calls.find((c) => c[0] === 'context.scan')?.[1].cwd === 'C:/work');
  t.ok('context.scan: scope: directory で作業場所の範囲だけを探す', (await call(agent('ask'), 'context.scan', { scope: 'directory' })).deps.calls.find((c) => c[0] === 'context.scan')?.[1].scope === 'directory');
  t.ok('context.scan: entries を 30 件ずつ区切り、本文を 2000 字に切る', scan.r.result.total === 35 && scan.r.result.entries.length === 30 && scan.r.result.entries[0].content.length === 2000 && scan.r.result.entries[0].truncated === true);
  const mcpOnly = (await call(agent('ask'), 'context.scan', { kind: 'mcp' })).r;
  t.ok('context.scan: 種類で絞れ、MCP の行の生の本文と configs の本文は返さない。引数・env・ヘッダー・URL のクエリは伏せる', mcpOnly.result.total === 2 && mcpOnly.result.entries.every((e) => e.content === undefined)
    && mcpOnly.result.configs.every((c) => c.content === undefined) && !has(mcpOnly) && mcpOnly.result.entries.find((e) => e.name === 'leak').args[2] === MASK, JSON.stringify(mcpOnly.result));
  const screenScan = (await call(human, 'context.scan', { cwd: 'C:/x' })).r.result;
  t.ok('context.scan: 画面には今までどおり全部（区切らない・本文も）', screenScan.entries.length === 35 && screenScan.entries[0].content.length === 3000 && screenScan.cwd === 'C:/x');
  const busy = { run: async () => { throw Object.assign(new Error('busy'), { code: 'SCAN_BUSY' }); }, busy: () => true };
  const busyScan = await registry.invoke({ by: 'agent', via: 'mcp', sessionId: 's1' }, 'context.scan', {}, { ...fakeDeps(), modeOf: async () => MODES.ask, scanLock: busy });
  t.ok('context.scan: 探索の錠が塞がっていれば SCAN_BUSY', busyScan.code === 'SCAN_BUSY', JSON.stringify(busyScan));
  const skills = (await call(agent('ask'), 'context.skills', { limit: 10 })).r.result;
  t.ok('context.skills: 一覧を区切る。画面は配列のまま', skills.total === 40 && skills.skills.length === 10 && Array.isArray((await call(human, 'context.skills', {})).r.result));
  const session = await call(agent('ask'), 'context.session', {});
  t.ok('context.session: 会話を省くとその会話。MCP の行の本文は返さず、引数・env を伏せる', session.r.ok && session.deps.calls.some((c) => c[0] === 'context.session' && c[1] === 's1') && !has(session.r), JSON.stringify(session.r));
  t.ok('context.session: 画面が会話を言わなければ null（新しい会話の右パネル）', (await call(human, 'context.session', {})).r.result === null);
  const diff = (await call(agent('ask'), 'context.diff', {})).r.result;
  t.ok('context.diff: 前後の本文を切る', diff.files[0].before.length === 2000 && diff.files[0].truncated === true);
  t.ok('context.agentMcp: コマンドの引数と URL のクエリを伏せる', !has((await call(agent('ask'), 'context.agentMcp', {})).r));
  const native = await call(agent('ask'), 'context.nativeInstructions', {});
  t.ok('context.nativeInstructions: 省くとその会話の作業場所とエージェント', native.deps.calls.some((c) => c[0] === 'nativeInstructions' && c[1] === 'C:/work' && c[2] === 'claude') && native.r.result.total === 1);
  t.ok('context.findings: 会話を省いてもその会話で読める', (await call(agent('ask'), 'context.findings', {})).r.ok);

  // ---- git・作業場所・通知・Hooks・フォルダー
  const status = await call(agent('ask'), 'git.status', {});
  t.ok('git.status: 会話も場所も省くとその会話', status.deps.calls.find((c) => c[0] === 'git.status')?.[1].sessionId === 's1');
  const changes = await call(agent('ask'), 'git.changes', {});
  t.ok('git.changes: ファイルを区切り、出来事は新しい 20 件。分けた作業場所の片付け（sweep）は画面だけ', changes.r.result.changes.files.length === 30 && changes.r.result.changes.next && changes.r.result.timeline.length === 20
    && changes.r.result.timelineTotal === 30 && changes.deps.calls.find((c) => c[0] === 'git.panel')?.[2].sweep === false);
  const screenChanges = await call(human, 'git.changes', { sessionId: 's1' });
  t.ok('git.changes: 画面には全量と、開いたときの片付け', screenChanges.r.result.changes.files.length === 45 && screenChanges.deps.calls.find((c) => c[0] === 'git.panel')?.[2].sweep === true);
  const gdiff = (await call(agent('ask'), 'git.diff', { path: 'a.txt', maxChars: 200 })).r;
  t.ok('git.diff: AI には統一差分の文字列（秘密は伏せる）', gdiff.ok && gdiff.result.diff.patch.startsWith('@@ -1 +1 @@\n-old\n+new --token') && !has(gdiff), JSON.stringify(gdiff));
  t.ok('git.diff: AI は path が要る。画面は path が無くても diff: null（今までどおり）', (await call(agent('ask'), 'git.diff', {})).r.code === 'INVALID' && (await call(human, 'git.diff', { sessionId: 's1' })).r.result.diff === null);
  t.ok('patchText: ハンクの見出しと行をつなぐ', patchText([{ header: '@@', lines: [{ t: ' ', s: 'a' }, { t: '+', s: 'b' }] }]) === '@@\n a\n+b');
  const check = await call(agent('ask'), 'worktrees.check', {});
  t.ok('worktrees.check: 省くとその会話', check.deps.calls.find((c) => c[0] === 'worktrees.check')?.[1].sessionId === 's1' && check.r.result.canSplit === true);
  t.ok('worktrees.settings: 「自動で分ける」の値', (await call(agent('ask'), 'worktrees.settings', {})).r.result.always === true);
  const notify = (await call(agent('ask'), 'notify.status', {})).r.result;
  t.ok('notify.status: AI には端末を数だけ（一覧・id は返さない。リモートのペアリングは人だけ）', notify.devices.count === 2 && notify.devices.muted === 1 && notify.pc.reply === false && !JSON.stringify(notify).includes('dev-secret-id'));
  t.ok('notify.status: 画面には今までどおり端末の一覧', (await call(human, 'notify.status', {})).r.result.devices[0].id === 'dev-secret-id');
  const unify = await call(agent('ask'), 'hooks.unifyPreview', {});
  t.ok('hooks.unifyPreview: 省くとその会話の作業場所、コマンドは伏せる。cwd: null はユーザーの範囲', unify.deps.calls.find((c) => c[0] === 'unifyPreview')?.[1].cwd === 'C:/work' && !has(unify.r)
    && (await call(agent('ask'), 'hooks.unifyPreview', { cwd: null })).deps.calls.find((c) => c[0] === 'unifyPreview')?.[1].cwd === null);
  const dirs = await call(agent('ask'), 'files.listDirs', { files: true });
  t.ok('files.listDirs: 省くとその会話の作業場所。フォルダー・ファイルを並べて区切る', dirs.deps.calls.find((c) => c[0] === 'listDirs')?.[1] === 'C:/work' && dirs.r.result.total === 41 && dirs.r.result.entries.length === 30
    && dirs.r.result.entries[0].type === 'dir');
  const screenDirs = (await call(human, 'files.listDirs', { path: 'C:/x' })).r.result;
  t.ok('files.listDirs: 画面には今までの形（dirs の配列）', Array.isArray(screenDirs.dirs) && screenDirs.dirs.length === 40 && screenDirs.files === undefined);
}
