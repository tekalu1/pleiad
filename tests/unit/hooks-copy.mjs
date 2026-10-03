// Hooks を他のエージェントへ写す（ADR 0047）。LLM もエージェントも呼ばない。
//   - 変換: イベントの対応（代わりのイベントに読み替えない）・matcher のツール名・写せない handler
//   - アダプター: 各方向の stdin の実例 → 元の形、元の出力 → 写した先の形、exit code、壊れた出力・timeout を安全側へ（実際に node で動かす）
//   - 保存: 写し先のファイルに正しい形で書き、他のキーを壊さない。アダプターの書き出し・名前の衝突・node が無いとき
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyEvent, mapMatcher, convertHook, adapterCommand, parseAdapterCommand, safeAdapterPath, suggestName, scriptPaths } from '../../core/hooks-copy.mjs';
import { toSourceInput, readResult, toTargetOutput, adapt, argsFromAgy, argsToAgy } from '../../core/hook-adapter.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
export const name = 'hooks-copy';
export const title = 'Hooks を写す: イベント・matcher の変換、入出力のアダプター（各方向・失敗は安全側）、写し先への保存';

// 実機で観測した stdin（temporary/reports/hooks-lab-results.md。ID とホームは伏せたもの）
const AGY_PRE = { artifactDirectoryPath: 'C:/h/.gemini/antigravity-cli/brain/c1', conversationId: 'c1', modelName: 'gemini-3.8-flash-low', stepIdx: 2,
  toolCall: { args: { CommandLine: 'echo hi', Cwd: 'D:/work/p', IsDaemon: false, WaitMsBeforeAsync: 5000, toolAction: 'Running echo command', toolSummary: 'Echo hi' }, name: 'run_command' },
  transcriptPath: 'C:/h/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript_full.jsonl', workspacePaths: ['D:/work/p'] };
const CODEX_PRE = { session_id: 's1', turn_id: 't1', transcript_path: null, cwd: 'D:/work/p', hook_event_name: 'PreToolUse', model: 'gpt-6-luna',
  permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'u1' };
const CLAUDE_PRE = { session_id: 's1', transcript_path: 'C:/h/.claude/projects/p/s1.jsonl', cwd: 'D:\\work\\p', permission_mode: 'default', hook_event_name: 'PreToolUse',
  tool_name: 'Bash', tool_input: { command: 'echo hi', description: 'Echo' }, tool_use_id: 'toolu_1' };

export default async function(t) {
  // ---------------------------------------------------------------- イベント
  t.ok('Claude ↔ Codex は共通のイベントを写せる', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStop', 'PreCompact', 'Stop', 'SessionEnd']
    .every(e => copyEvent('claude', 'codex', e) === e && copyEvent('codex', 'claude', e) === e));
  t.ok('Antigravity とは PreToolUse・PostToolUse・Stop だけ', ['PreToolUse', 'PostToolUse', 'Stop'].every(e => copyEvent('claude', 'antigravity', e) === e && copyEvent('antigravity', 'codex', e) === e)
    && copyEvent('claude', 'antigravity', 'SessionStart') === null && copyEvent('antigravity', 'claude', 'PreInvocation') === null);
  t.ok('片方にしか無いイベントは写さない（Codex の Interrupt・Claude の Notification）', copyEvent('codex', 'claude', 'Interrupt') === null && copyEvent('claude', 'codex', 'Notification') === null);
  const ss = convertHook({ agent: 'claude', event: 'SessionStart', matcher: 'startup', handler: { type: 'command', command: 'node ctx.mjs' } }, 'antigravity');
  t.ok('SessionStart → Antigravity は写せない（PreInvocation に読み替えない）', ss.status === 'blocked' && ss.reasons.some(r => r.code === 'event') && ss.event === 'SessionStart');

  // ---------------------------------------------------------------- matcher
  const mm = (f, to, e, m) => mapMatcher(f, to, e, m);
  t.ok('Bash ↔ Bash ↔ run_command は意味が一致（警告なし）', mm('claude', 'antigravity', 'PreToolUse', 'Bash').matcher === 'run_command' && mm('claude', 'antigravity', 'PreToolUse', 'Bash').warnings.length === 0
    && mm('antigravity', 'codex', 'PreToolUse', 'run_command').matcher === 'Bash' && mm('codex', 'claude', 'PreToolUse', 'Bash').matcher === 'Bash');
  const edit = mm('claude', 'antigravity', 'PreToolUse', 'Edit|Write');
  t.ok('Edit|Write → write_to_file / replace_file_content は警告付き', edit.status === 'mapped' && edit.matcher === 'replace_file_content|multi_replace_file_content|write_to_file'
    && edit.warnings.some(w => w.code === 'toolMeaning'), JSON.stringify(edit));
  const patch = mm('claude', 'codex', 'PostToolUse', 'Edit');
  t.ok('Edit → apply_patch は意味と入力の形の違いを警告', patch.matcher === 'apply_patch' && patch.warnings.some(w => w.code === 'toolInput') && patch.warnings.some(w => w.code === 'toolMeaning'));
  t.ok('Codex の apply_patch → Claude は Write|Edit', mm('codex', 'claude', 'PreToolUse', 'apply_patch').matcher === 'Write|Edit');
  t.ok('apply_patch ↔ Antigravity の書き込みは入力を直せないので写せない', mm('codex', 'antigravity', 'PreToolUse', 'apply_patch').status === 'blocked' && mm('antigravity', 'codex', 'PreToolUse', 'write_to_file').status === 'blocked');
  t.ok('* と空は全件のまま', mm('claude', 'antigravity', 'PreToolUse', '*').status === 'all' && mm('claude', 'antigravity', 'PreToolUse', '*').matcher === '*'
    && mm('claude', 'codex', 'PostToolUse', '').matcher === '' && mm('antigravity', 'claude', 'PreToolUse', '').status === 'all');
  const rx = mm('claude', 'antigravity', 'PreToolUse', 'mcp__.*');
  t.ok('正規表現は自動で訳さず「確認が必要」', rx.status === 'review' && rx.reason.code === 'matcherRegex');
  t.ok('知らない名前も確認が必要（写せた分だけ候補に残す）', mm('claude', 'antigravity', 'PreToolUse', 'Bash|NotebookEdit').status === 'review' && mm('claude', 'antigravity', 'PreToolUse', 'Bash|NotebookEdit').matcher === 'run_command');
  t.ok('対応するツールが無ければ写せない（Read → Codex）', mm('claude', 'codex', 'PreToolUse', 'Read').status === 'blocked' && mm('claude', 'codex', 'PreToolUse', 'Read').reason.code === 'noTool');
  t.ok('一部だけ対応が無ければ確認が必要（Bash|Read → Codex）', mm('claude', 'codex', 'PreToolUse', 'Bash|Read').status === 'review' && mm('claude', 'codex', 'PreToolUse', 'Bash|Read').reason.code === 'partialTools');
  t.ok('Claude の , 区切りも選択肢', mm('claude', 'antigravity', 'PreToolUse', 'Bash,Read').matcher === 'run_command|view_file');
  t.ok('MCP のツール名は Claude ↔ Codex でそのまま（サーバー名の警告）、Antigravity へは写せない', mm('claude', 'codex', 'PreToolUse', 'mcp__gh__create_issue').matcher === 'mcp__gh__create_issue'
    && mm('claude', 'codex', 'PreToolUse', 'mcp__gh__create_issue').warnings.some(w => w.code === 'mcpServer') && mm('claude', 'antigravity', 'PreToolUse', 'mcp__gh__x').status === 'blocked');
  t.ok('Antigravity の Stop は matcher を持たない', mm('claude', 'antigravity', 'Stop', '').status === 'none' && mm('claude', 'antigravity', 'Stop', '').matcher === null);
  t.ok('ツール以外のイベントの matcher は Claude ↔ Codex でそのまま', mm('claude', 'codex', 'SessionStart', 'startup|resume').matcher === 'startup|resume');

  // ---------------------------------------------------------------- handler
  const conv = (h, to, extra = {}) => convertHook({ agent: 'claude', event: 'PreToolUse', matcher: 'Bash', handler: { type: 'command', command: 'node guard.mjs', ...h }, ...extra }, to, { platform: 'linux' });
  const c1 = conv({ timeout: 10 }, 'antigravity');
  t.ok('Claude → Antigravity の PreToolUse はアダプター越し・timeout は元の秒数＋余裕', c1.status === 'ready' && c1.adapter && c1.innerTimeout === 10 && c1.timeout === 15);
  t.ok('timeout を書いていなければ元の既定（Claude 600 秒）を保つ', conv({}, 'antigravity').innerTimeout === 600
    && convertHook({ agent: 'antigravity', event: 'Stop', handler: { command: 'x' } }, 'claude', { platform: 'linux' }).innerTimeout === 30);
  const direct = convertHook({ agent: 'codex', event: 'PreToolUse', matcher: 'Bash', handler: { type: 'command', command: 'python g.py', statusMessage: 'checking' } }, 'claude', { platform: 'linux' });
  t.ok('Codex → Claude の PreToolUse もアダプターを挟み、statusMessage を保つ', direct.adapter && direct.command === 'python g.py' && direct.statusMessage === 'checking' && direct.innerTimeout === 600);
  t.ok('Claude → Codex は PreToolUse だけアダプター（ask を止める）', conv({}, 'codex').adapter && conv({}, 'codex').warnings.some(w => w.code === 'askToDeny')
    && !convertHook({ agent: 'claude', event: 'Stop', handler: { type: 'command', command: 'x' } }, 'codex').adapter);
  t.ok('command 以外の型は写せない', conv({ type: 'http', url: 'https://x' }, 'codex').reasons.some(r => r.code === 'type'));
  t.ok('exec form（args だけ）は写せない', convertHook({ agent: 'claude', event: 'PreToolUse', handler: { type: 'command', args: ['node', 'x'] } }, 'codex').reasons.some(r => r.code === 'execForm'));
  t.ok('if・asyncRewake など実行の条件を変えるキーは写せない', conv({ if: 'Bash(git *)' }, 'codex').status === 'blocked' && conv({ asyncRewake: true }, 'codex').status === 'blocked');
  t.ok('知らないキーは写せない', conv({ env: { A: '1' } }, 'codex').reasons.some(r => r.code === 'unknownKeys'));
  t.ok('matcher group の他のキーがあれば写せない', conv({}, 'codex', { groupKeys: ['description'] }).reasons.some(r => r.code === 'groupKeys'));
  t.ok('async は Antigravity へ写せない', conv({ async: true }, 'antigravity').reasons.some(r => r.code === 'asyncAgy') && conv({ async: true }, 'codex').async === true);
  t.ok('statusMessage は Antigravity では落とす（警告）', conv({ statusMessage: 's' }, 'antigravity').warnings.some(w => w.code === 'dropKey') && conv({ statusMessage: 's' }, 'antigravity').statusMessage === undefined);
  t.ok('CLAUDE_PROJECT_DIR を使うコマンドはアダプター無しでは写せない', convertHook({ agent: 'claude', event: 'Stop', handler: { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/x.sh' } }, 'codex').reasons.some(r => r.code === 'claudeEnv'));
  t.ok('プラグインの環境変数を使うコマンドは写せない', conv({ command: '${CLAUDE_PLUGIN_ROOT}/x' }, 'antigravity').reasons.some(r => r.code === 'pluginEnv'));
  t.ok('Windows の Claude のコマンドは元と同じシェルで動かす', !convertHook({ agent: 'claude', event: 'PreToolUse', matcher: 'Bash', handler: { type: 'command', command: 'node ~/x.mjs' } }, 'antigravity', { platform: 'win32' }).warnings.some(w => w.code === 'shellSyntax'));
  t.ok('アダプターのパスは日本語を受け、シェルの特殊文字を拒む', safeAdapterPath('C:/日本語/with space/x.mjs') && !safeAdapterPath('C:/R&D/x.mjs') && !safeAdapterPath("C:/O'Brien/x.mjs"));
  t.ok('引用しないアダプターパスにシェルの制御文字を入れない', ['"', "'", '%', '!', '^', '&', '|', '<', '>', '(', ')', '$', '`', ';', '=']
    .every(ch => !safeAdapterPath(`C:/hook${ch}dir/x.mjs`)));
  const rev = convertHook({ agent: 'claude', event: 'PreToolUse', matcher: 'Bash|Notebook.*', handler: { type: 'command', command: 'x' } }, 'antigravity', { platform: 'linux' });
  const chosen = convertHook({ agent: 'claude', event: 'PreToolUse', matcher: 'Bash|Notebook.*', handler: { type: 'command', command: 'x' } }, 'antigravity', { platform: 'linux', matcher: 'run_command' });
  t.ok('確認が必要な matcher は、写す先の matcher を入れると写せる', rev.status === 'review' && chosen.status === 'ready' && chosen.matcher === 'run_command' && chosen.matcherStatus === 'chosen');
  const cmd = adapterCommand({ adapterPath: 'C:\\Users\\a b\\.claude\\pleiad-hooks\\hook-adapter-0123456789ab.mjs', from: 'antigravity', to: 'claude', event: 'PreToolUse', innerTimeout: 30, command: 'node "D:/x y/a.mjs" --v \'q\'' });
  const agyCmd = adapterCommand({ adapterPath: 'pleiad-hooks/hook-adapter-0123456789ab.mjs', from: 'claude', to: 'antigravity', event: 'PreToolUse', innerTimeout: 30, command: 'echo hi', unquoted: true });
  t.ok('Windows の agy のコマンドは node と相対アダプターパスを引用しない', agyCmd.startsWith('node pleiad-hooks/hook-adapter-0123456789ab.mjs claude antigravity')
    && parseAdapterCommand(agyCmd)?.command === 'echo hi');
  t.ok('アダプターのコマンドはスラッシュ区切り・空白は引用符、元のコマンドは 1 つの引数', cmd.startsWith('node "C:/Users/a b/.claude/pleiad-hooks/hook-adapter-0123456789ab.mjs" antigravity claude PreToolUse 30 ') && !cmd.includes('\\'));
  t.ok('アダプターのコマンドから元のコマンドを読める', parseAdapterCommand(cmd)?.command === 'node "D:/x y/a.mjs" --v \'q\'' && parseAdapterCommand('node x.mjs') === null);
  t.ok('写した定義をもう一度写すことはしない', convertHook({ agent: 'antigravity', event: 'PreToolUse', matcher: 'run_command', handler: { command: cmd } }, 'codex').reasons.some(r => r.code === 'alreadyCopy'));
  t.ok('スクリプトらしいパスを拾う（相対・~・引用符付き。URL・変数は拾わない）', JSON.stringify(scriptPaths('node "D:/a b/x.mjs" --v && python scripts/y.py ~/z.sh https://e.com/a.js $HOME/q.sh'))
    === JSON.stringify([{ path: 'D:/a b/x.mjs', relative: false }, { path: 'scripts/y.py', relative: true }, { path: '~/z.sh', relative: false }]));
  t.ok('Claude ↔ Codex の PostToolUse は block の意味の違いを警告', convertHook({ agent: 'claude', event: 'PostToolUse', matcher: 'Bash', handler: { type: 'command', command: 'x' } }, 'codex').warnings.some(w => w.code === 'postBlock'));
  t.ok('Antigravity の名前の候補はスクリプト名から', suggestName({ agent: 'claude', event: 'Stop', handler: { command: 'node D:/hooks/audit-shell.cjs --x' } }) === 'claude-audit-shell');

  // ---------------------------------------------------------------- アダプター: 入力
  const a1 = toSourceInput({ from: 'claude', to: 'antigravity', event: 'PreToolUse', input: AGY_PRE, exists: () => false });
  t.ok('agy の stdin → Claude の形（tool_name / tool_input.command / session_id / cwd）', a1.input.tool_name === 'Bash' && a1.input.tool_input.command === 'echo hi'
    && a1.input.session_id === 'c1' && a1.input.cwd === 'D:/work/p' && a1.input.hook_event_name === 'PreToolUse' && a1.cwd === 'D:/work/p' && a1.env.CLAUDE_PROJECT_DIR === 'D:/work/p', JSON.stringify(a1));
  const a2 = toSourceInput({ from: 'antigravity', to: 'claude', event: 'PreToolUse', input: CLAUDE_PRE, exists: p => p.endsWith('.agents') });
  t.ok('Claude の stdin → agy の形（toolCall.name / args.CommandLine / conversationId / スラッシュのパス）', a2.input.toolCall.name === 'run_command' && a2.input.toolCall.args.CommandLine === 'echo hi'
    && a2.input.conversationId === 's1' && a2.input.workspacePaths[0] === 'D:/work/p' && a2.input.toolCall.args.Cwd === 'D:/work/p' && a2.env.ANTIGRAVITY_CONVERSATION_ID === 's1', JSON.stringify(a2));
  t.ok('agy の元のコマンドは .agents で動かす（agy と同じ）', /\.agents$/.test(a2.cwd));
  const a3 = toSourceInput({ from: 'antigravity', to: 'codex', event: 'PreToolUse', input: CODEX_PRE, exists: () => false });
  t.ok('Codex の stdin → agy の形', a3.input.toolCall.name === 'run_command' && a3.input.modelName === 'gpt-6-luna');
  const a4 = toSourceInput({ from: 'codex', to: 'antigravity', event: 'PreToolUse', input: AGY_PRE, exists: () => false });
  t.ok('agy の stdin → Codex の形（model・turn_id を持つ）', a4.input.tool_name === 'Bash' && a4.input.model === 'gemini-3.8-flash-low' && 'turn_id' in a4.input);
  t.ok('Claude → Codex の入力はそのまま（形がほぼ同じ）', toSourceInput({ from: 'claude', to: 'codex', event: 'PreToolUse', input: CODEX_PRE }).input === CODEX_PRE);
  t.ok('ファイル操作の引数も近い形に直す', argsFromAgy('replace_file_content', { TargetFile: 'a', TargetContent: 'x', ReplacementContent: 'y' }).old_string === 'x'
    && argsToAgy('Write', { file_path: 'a', content: 'c' }, '/w').CodeContent === 'c' && argsFromAgy('view_file', { AbsolutePath: 'f', StartLine: 3, EndLine: 9 }).limit === 6);
  const stopIn = toSourceInput({ from: 'claude', to: 'antigravity', event: 'Stop', input: { conversationId: 'c', workspacePaths: ['D:/p'], executionNum: 1, terminationReason: 'NO_TOOL_CALL', fullyIdle: true } });
  t.ok('agy の Stop → Claude の stop_hook_active（2 回目以降）', stopIn.input.stop_hook_active === true && stopIn.input.hook_event_name === 'Stop');
  t.ok('Claude の PostToolUse は成功だけ: agy の失敗したツールでは元のコマンドを動かさない',
    toSourceInput({ from: 'claude', to: 'antigravity', event: 'PostToolUse', input: { ...AGY_PRE, error: 'exit status 1' } }).skip === true
    && toSourceInput({ from: 'codex', to: 'antigravity', event: 'PostToolUse', input: { ...AGY_PRE, error: 'exit status 1' } }).skip === false);

  // ---------------------------------------------------------------- アダプター: 出力と exit code
  const out = (from, to, event, result) => toTargetOutput({ from, to, event, decision: readResult({ from, event, result }) });
  const claudeSays = d => ({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: 'r' } }) });
  t.ok('Claude の deny → agy の decision: deny', out('claude', 'antigravity', 'PreToolUse', claudeSays('deny')).decision === 'deny');
  t.ok('Claude の ask / defer → agy の ask', out('claude', 'antigravity', 'PreToolUse', claudeSays('ask')).decision === 'ask' && out('claude', 'antigravity', 'PreToolUse', claudeSays('defer')).decision === 'ask');
  t.ok('Claude の出力なし・allow → agy の allow（agy の allow は権限確認を代わらない）', out('claude', 'antigravity', 'PreToolUse', { code: 0, stdout: '' }).decision === 'allow'
    && out('claude', 'antigravity', 'PreToolUse', claudeSays('allow')).decision === 'allow');
  t.ok('Claude の古い decision: block → deny', out('claude', 'antigravity', 'PreToolUse', { code: 0, stdout: '{"decision":"block","reason":"no"}' }).decision === 'deny');
  t.ok('Claude の updatedInput は agy で使えないので deny（書き換えない入力で動かさない）', out('claude', 'antigravity', 'PreToolUse',
    { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'echo safe' } } }) }).decision === 'deny');
  t.ok('Claude の continue: false → agy の deny', out('claude', 'antigravity', 'PreToolUse', { code: 0, stdout: '{"continue":false,"stopReason":"s"}' }).decision === 'deny');
  t.ok('Claude の exit 2 → agy の deny（理由は stderr）', out('claude', 'antigravity', 'PreToolUse', { code: 2, stderr: 'blocked!\n' }).reason === 'blocked!');
  t.ok('Claude の exit 1 は Claude では止めない失敗 → agy でも allow（元の意味を保つ）', out('claude', 'antigravity', 'PreToolUse', { code: 1, stderr: 'oops' }).decision === 'allow');
  t.ok('Claude の文字だけの出力は決定ではない → allow', out('claude', 'antigravity', 'PreToolUse', { code: 0, stdout: 'logged' }).decision === 'allow');
  t.ok('timeout・起動できない → deny（安全側）', out('claude', 'antigravity', 'PreToolUse', { timedOut: true }).decision === 'deny'
    && out('claude', 'codex', 'PreToolUse', { startError: 'ENOENT' }).hookSpecificOutput.permissionDecision === 'deny');
  const cx = d => out('claude', 'codex', 'PreToolUse', claudeSays(d));
  t.ok('Claude → Codex: ask / defer は Codex が扱えないので deny', cx('ask').hookSpecificOutput.permissionDecision === 'deny' && cx('defer').hookSpecificOutput.permissionDecision === 'deny');
  t.ok('Claude → Codex: allow・deny はそのまま、updatedInput も渡す', cx('allow').hookSpecificOutput.permissionDecision === 'allow' && cx('deny').hookSpecificOutput.permissionDecision === 'deny'
    && out('claude', 'codex', 'PreToolUse', { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'x' } } }) }).hookSpecificOutput.updatedInput.command === 'x');
  const agySays = (o, code = 0) => ({ code, stdout: typeof o === 'string' ? o : JSON.stringify(o) });
  const toClaude = r => out('antigravity', 'claude', 'PreToolUse', r).hookSpecificOutput?.permissionDecision ?? 'pass';
  t.ok('agy の deny → Claude の deny', toClaude(agySays({ decision: 'deny', reason: 'r' })) === 'deny');
  t.ok('agy の allow → Claude では何も言わない（権限確認は Claude のまま）', toClaude(agySays({ decision: 'allow' })) === 'pass');
  t.ok('agy の ask / force_ask → Claude の ask、deny_unless_prior_grant → deny', toClaude(agySays({ decision: 'ask' })) === 'ask' && toClaude(agySays({ decision: 'force_ask' })) === 'ask'
    && toClaude(agySays({ decision: 'deny_unless_prior_grant' })) === 'deny');
  t.ok('agy の ask → Codex は deny', out('antigravity', 'codex', 'PreToolUse', agySays({ decision: 'ask' })).hookSpecificOutput.permissionDecision === 'deny');
  t.ok('agy の壊れた JSON・exit 1・exit 2・decision なし → deny（agy と同じく止める）', ['{broken', ''].every(s => toClaude(agySays(s)) === 'deny')
    && toClaude(agySays({ decision: 'allow' }, 1)) === 'deny' && toClaude(agySays({}, 2)) === 'deny' && toClaude(agySays({})) === 'deny');
  t.ok('agy の Stop continue → Claude / Codex の decision: block', out('antigravity', 'claude', 'Stop', agySays({ decision: 'continue', reason: 'more' })).decision === 'block'
    && out('antigravity', 'codex', 'Stop', agySays({ decision: 'continue', reason: 'more' })).reason === 'more');
  t.ok('agy の Stop が壊れたら止まらせる（続けない）', JSON.stringify(out('antigravity', 'claude', 'Stop', agySays('{x'))) === '{}');
  t.ok('Claude の Stop block / exit 2 → agy の continue、それ以外は stop', out('claude', 'antigravity', 'Stop', { code: 0, stdout: '{"decision":"block","reason":"go on"}' }).decision === 'continue'
    && out('claude', 'antigravity', 'Stop', { code: 2, stderr: 'again' }).reason === 'again' && out('claude', 'antigravity', 'Stop', { code: 0, stdout: '' }).decision === 'stop'
    && out('claude', 'antigravity', 'Stop', { timedOut: true }).decision === 'stop');
  t.ok('PostToolUse は agy へ何も返さない', JSON.stringify(out('claude', 'antigravity', 'PostToolUse', { code: 0, stdout: '{"decision":"block"}' })) === '{}');

  // ---------------------------------------------------------------- アダプター: 実際に node で動かす（元のコマンドは node のスクリプト）
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-copy-')));
  const originalGitBashPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const adapterFile = fileURLToPath(new URL('../../core/hook-adapter.mjs', import.meta.url));
  const script = async (name, body) => { const p = path.join(tmp, name); await fs.writeFile(p, body); return p.replace(/\\/g, '/'); };
  const runAdapter = (args, stdin) => new Promise(resolve => {
    const p = spawn(process.execPath, [adapterFile, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp } });
    let o = '', e = '';
    p.stdout.on('data', b => { o += b; }); p.stderr.on('data', b => { e += b; });
    p.on('close', code => resolve({ code, stdout: o, stderr: e }));
    p.stdin.end(stdin);
  });
  const b64 = s => Buffer.from(s).toString('base64url');
  try {
    const guard = await script('guard.mjs', `let r='';for await (const c of process.stdin) r+=c;const i=JSON.parse(r);
process.stderr.write(JSON.stringify({tool:i.tool_name,cmd:i.tool_input?.command,cwd:process.cwd(),pd:process.env.CLAUDE_PROJECT_DIR}));
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:/rm/.test(i.tool_input?.command)?'deny':'ask',permissionDecisionReason:'guard'}}));`);
    const agyIn = JSON.stringify({ ...AGY_PRE, workspacePaths: [tmp.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf x' } } });
    const r1 = await runAdapter(['claude', 'antigravity', 'PreToolUse', '10', b64(`node ${guard}`)], agyIn);
    const seen = JSON.parse(r1.stderr);
    t.ok('実行: agy から呼ばれ、Claude の形で元のスクリプトへ渡し、deny を agy の形で返す', r1.code === 0 && JSON.parse(r1.stdout).decision === 'deny'
      && seen.tool === 'Bash' && seen.cmd === 'rm -rf x' && seen.pd, `${r1.stdout} ${r1.stderr}`);
    const r2 = await runAdapter(['claude', 'antigravity', 'PreToolUse', '10', b64(`node ${guard}`)], agyIn.replace('rm -rf x', 'echo hi'));
    t.ok('実行: ask は agy の ask', JSON.parse(r2.stdout).decision === 'ask');
    const slow = await script('slow.mjs', 'setTimeout(() => process.stdout.write("{}"), 5000);');
    const started = Date.now();
    const r3 = await runAdapter(['claude', 'antigravity', 'PreToolUse', '1', b64(`node ${slow}`)], agyIn);
    t.ok('実行: timeout（1 秒）で元のコマンドを止めて deny', JSON.parse(r3.stdout).decision === 'deny' && Date.now() - started < 4500, `${Date.now() - started}ms ${r3.stdout}`);
    const r4 = await runAdapter(['claude', 'antigravity', 'PreToolUse', '10', b64('this-command-does-not-exist-xyz')], agyIn);
    t.ok('実行: 見つからないコマンド（シェルの exit 1 など）でも答えを返す', r4.code === 0 && ['deny', 'allow'].includes(JSON.parse(r4.stdout).decision), r4.stdout);
    const r5 = await runAdapter(['claude', 'antigravity', 'PreToolUse', '10', b64(`node ${guard}`)], 'not json');
    t.ok('実行: エージェントの入力が JSON でなければ deny', JSON.parse(r5.stdout).decision === 'deny');
    const r6 = await runAdapter(['claude', 'nobody', 'PreToolUse', '10', 'x'], agyIn);
    t.ok('実行: 引数が壊れていても JSON を返す（exit 0）', r6.code === 0 && JSON.parse(r6.stdout) !== null);
    const tampered = path.join(tmp, 'hook-adapter-000000000000.mjs');
    await fs.copyFile(adapterFile, tampered);
    const hashFailure = await adapt({ argv: ['claude', 'codex', 'PreToolUse', '10', b64('echo hi')], stdin: JSON.stringify(CODEX_PRE), selfPath: tampered });
    t.ok('アダプターの中身の hash がファイル名と違えば deny', JSON.parse(hashFailure.stdout).hookSpecificOutput.permissionDecision === 'deny');
    const agyScript = await script('agy.mjs', `let r='';for await (const c of process.stdin) r+=c;const i=JSON.parse(r);
process.stdout.write(JSON.stringify(i.toolCall?.args?.CommandLine==='echo hi'?{decision:'deny',reason:'no hi'}:{decision:'allow'}));`);
    await fs.mkdir(path.join(tmp, '.agents'), { recursive: true });
    if (process.platform === 'win32') {
      const shellProbe = await script('shell-probe.mjs', 'process.stderr.write(JSON.stringify(process.argv.slice(2)));');
      // CI の Windows では PowerShell の起動が 10 秒を超えることがある。
      const codexShell = await runAdapter(['codex', 'claude', 'PreToolUse', '30', b64(`node ${shellProbe} $PWD`)], JSON.stringify({ ...CODEX_PRE, cwd: tmp }));
      const agyShell = await runAdapter(['antigravity', 'claude', 'PreToolUse', '30', b64(`node ${shellProbe} %CD%`)], JSON.stringify({ ...CLAUDE_PRE, cwd: tmp }));
      const argsOf = result => { try { return JSON.parse(result.stderr); } catch { return []; } };
      t.ok('Windows の元コマンドは Codex で PowerShell、agy で cmd の変数が展開される',
        codexShell.code === 0 && agyShell.code === 0 && argsOf(codexShell)[0]?.toLowerCase() === tmp.toLowerCase()
        && argsOf(agyShell)[0]?.toLowerCase() === path.join(tmp, '.agents').toLowerCase(),
        JSON.stringify({ codexShell, agyShell }));
    }
    const r7 = await runAdapter(['antigravity', 'claude', 'PreToolUse', '10', b64(`node ${agyScript}`)], JSON.stringify({ ...CLAUDE_PRE, cwd: tmp }));
    t.ok('実行: Claude から呼ばれ、agy の形で渡し、deny を Claude の形で返す', JSON.parse(r7.stdout).hookSpecificOutput?.permissionDecision === 'deny', r7.stdout);
    const stopper = await script('stop.mjs', 'process.stdout.write(JSON.stringify({decision:"continue",reason:"not yet"}));');
    const r8 = await runAdapter(['antigravity', 'codex', 'Stop', '10', b64(`node ${stopper}`)], JSON.stringify({ session_id: 's', cwd: tmp, hook_event_name: 'Stop', stop_hook_active: false }));
    t.ok('実行: agy の Stop continue → Codex の decision: block', JSON.parse(r8.stdout).decision === 'block' && JSON.parse(r8.stdout).reason === 'not yet');
    const repeats = [];
    for (let n = 0; n < 5; n++) repeats.push(await runAdapter(['antigravity', 'codex', 'Stop', '10', b64(`node ${stopper}`)], JSON.stringify({ session_id: 's', cwd: tmp, hook_event_name: 'Stop', stop_hook_active: true })));
    t.ok('Stop の連続した続けは 5 回で止まる', repeats.slice(0, 4).every(r => JSON.parse(r.stdout).decision === 'block') && JSON.stringify(JSON.parse(repeats[4].stdout)) === '{}');
    const nums = [];
    for (let n = 0; n < 3; n++) await adapt({ argv: ['antigravity', 'claude', 'Stop', '10', b64('echo stop-count')], stdin: JSON.stringify({ session_id: 'numbered', cwd: tmp }),
      stateDir: tmp, run: async (_, options) => { nums.push(options.input.executionNum); return { code: 0, stdout: '{"decision":"continue"}' }; } });
    t.ok('agy に渡す executionNum は会話ごとの連続回数', JSON.stringify(nums) === '[0,1,2]');
    t.ok('コマンドが見つからない終了と出力超過は PreToolUse で deny', out('claude', 'codex', 'PreToolUse', { code: 127 }).hookSpecificOutput.permissionDecision === 'deny'
      && out('claude', 'codex', 'PreToolUse', { code: 1, stderr: '認識されていません' }).hookSpecificOutput.permissionDecision === 'deny'
      && out('claude', 'codex', 'PreToolUse', { overflow: true }).hookSpecificOutput.permissionDecision === 'deny');
    const skip = await runAdapter(['claude', 'antigravity', 'PostToolUse', '10', b64(`node ${slow}`)], JSON.stringify({ ...AGY_PRE, error: 'exit status 1' }));
    t.ok('実行: Claude の PostToolUse は失敗したツールでは元のコマンドを動かさない', skip.stdout === '{}');

    // ---------------------------------------------------------------- 保存（写し先のファイル）
    const home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo');
    const write = async (file, v) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await write(path.join(home, '.claude', 'settings.json'), { model: 'keep', env: { API_KEY: 'SECRET-ENV' }, hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${guard} --token SECRET-TOKEN-1`, timeout: 10 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'node ctx.mjs' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'http', url: 'https://x' }] }] } });
    const codexToml = '# mine\nmodel = "gpt"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo s" # keep\n\n[projects."x"]\ntrust_level = "trusted"\n';
    await write(path.join(home, '.codex', 'config.toml'), codexToml);
    await write(path.join(home, '.gemini', 'config', 'hooks.json'), { keep: { Stop: [{ command: 'node s.mjs' }] }, 'claude-guard': { enabled: false, Stop: [{ command: 'x' }] } });
    let nodeFound = process.execPath;
    const svc = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(home, '.gemini'), findNode: async () => nodeFound, platform: 'linux' });
    const scan = await svc.scan({ scopes: ['user'] });
    const pre = scan.entries.find(e => e.agent === 'claude' && e.event === 'PreToolUse');
    const rev = scan.files.find(f => f.path === pre.path).revision;
    const source = { agent: 'claude', scope: 'user', file: pre.path, loc: { event: 'PreToolUse', group: pre.group, handler: pre.handler }, revision: rev };
    nodeFound = 'node';
    const relativeNode = (await svc.copy({ source, targets: [{ agent: 'codex', scope: 'user' }], dryRun: true })).results[0];
    t.ok('Codex のユーザー設定へ写す Node は絶対パスが必要', !relativeNode.ok && relativeNode.status === 'blocked'
      && relativeNode.reasons.some(r => r.code === 'adapterPath'), JSON.stringify(relativeNode.reasons));
    nodeFound = process.execPath;
    const dry = await svc.copy({ source, targets: [{ agent: 'codex', scope: 'user' }, { agent: 'antigravity', scope: 'user' }], dryRun: true });
    const [dc, da] = dry.results;
    t.ok('dryRun: 書かずに前後の本文（伏せ字）と書き先を返す', dc.ok && dc.path.endsWith('config.toml') && dc.format === 'toml' && dc.after.includes('[[hooks.PreToolUse]]')
      && !JSON.stringify(dry).includes('SECRET-TOKEN-1') && !(await fs.stat(path.join(home, '.codex', 'pleiad-hooks')).catch(() => null)), JSON.stringify(dc.reasons));
    t.ok('dryRun: 元のコマンドも伏せ字', dry.source.command.includes('••••') && !dry.source.command.includes('SECRET'));
    // アダプター越しのコマンドは元のコマンドを base64url で持つ。秘密を含むなら、その引数も伏せる（デコードして漏れない）
    const leaked = s => [...String(s).matchAll(/[A-Za-z0-9_-]{16,}/g)].some(m => Buffer.from(m[0], 'base64url').toString('utf8').includes('SECRET-TOKEN-1'));
    t.ok('dryRun: 差分・書くコマンドの base64 の中の秘密も伏せる', !leaked(JSON.stringify(dry)) && /PreToolUse 10 ••••/.test(dc.after), dc.after);
    t.ok('agy の名前が既にあれば「確認が必要」（同じ名前には写さない）', da.status === 'review' && da.reasons.some(r => r.code === 'nameTaken' && r.params.name === 'claude-guard'), JSON.stringify(da.reasons));
    const da2 = (await svc.copy({ source, targets: [{ agent: 'antigravity', scope: 'user', name: 'guard2' }], dryRun: true })).results[0];
    t.ok('別の名前なら写せる', da2.status === 'ready', JSON.stringify(da2.reasons));
    const bad = await svc.copy({ source, targets: [{ agent: 'antigravity', scope: 'user', name: 'claude-guard', revision: da.revision }] });
    t.ok('確認が必要なまま書こうとしても書かない', !bad.results[0].ok && !(await fs.readFile(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8')).includes('run_command'));
    const done = await svc.copy({ source, targets: [{ agent: 'codex', scope: 'user', revision: dc.revision }, { agent: 'antigravity', scope: 'user', name: 'guard2', revision: da2.revision }] });
    t.ok('書き込み: 2 つの写し先に書けた', done.results.every(r => r.ok && r.written), JSON.stringify(done.results.map(({ agent, status, reasons, error }) => ({ agent, status, reasons, error }))));
    const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
    t.ok('Codex: 既存の TOML の本文とコメントを残して末尾に足す', toml.startsWith(codexToml) && /\[\[hooks\.PreToolUse\]\]\nmatcher = "Bash"/.test(toml), toml);
    const agy = JSON.parse(await fs.readFile(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8'));
    const h = agy.guard2?.PreToolUse?.[0];
    t.ok('agy: 名前 → PreToolUse → matcher run_command → アダプター越しのコマンド・timeout 15', h?.matcher === 'run_command' && /hook-adapter-[0-9a-f]{12}\.mjs" claude antigravity PreToolUse 10 /.test(h.hooks[0].command)
      && h.hooks[0].timeout === 15 && !h.hooks[0].command.includes('\\'), JSON.stringify(agy));
    t.ok('agy: 他の名前（enabled: false を含む）はそのまま', agy.keep?.Stop?.[0]?.command === 'node s.mjs' && agy['claude-guard']?.enabled === false);
    t.ok('写したコマンドから元のコマンドを読める（秘密も含めて元のまま）', parseAdapterCommand(h.hooks[0].command)?.command.includes('SECRET-TOKEN-1'));
    const adapters = await fs.readdir(path.join(home, '.gemini', 'config', 'pleiad-hooks'));
    const shipped = await fs.readFile(adapterFile, 'utf8');
    t.ok('アダプターを写し先の設定の隣に書き出す（中身は core/hook-adapter.mjs と同じ）', adapters.length === 1
      && await fs.readFile(path.join(home, '.gemini', 'config', 'pleiad-hooks', adapters[0]), 'utf8') === shipped
      && (await fs.readdir(path.join(home, '.codex', 'pleiad-hooks'))).length === 1);
    const claudeAfter = JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
    t.ok('元の定義は変えない', claudeAfter.hooks.PreToolUse[0].hooks[0].command.includes('SECRET-TOKEN-1') && claudeAfter.env.API_KEY === 'SECRET-ENV');
    const rescan = await svc.scan({ scopes: ['user'] });
    const copied = rescan.entries.find(e => e.agent === 'antigravity' && e.name === 'guard2');
    t.ok('一覧は写した定義に元のエージェントと元のコマンド（伏せ字）を付ける', copied?.adapter?.from === 'claude' && copied.adapter.command.includes('••••') && !copied.adapter.command.includes('SECRET'));
    t.ok('一覧の写した定義: 行は元のコマンド（伏せ字）、定義の base64 の中の秘密も出さない', !leaked(JSON.stringify(rescan)) && /guard\.mjs --token ••••/.test(copied.command)
      && /PreToolUse 10 ••••/.test(copied.definition.command), JSON.stringify({ c: copied.command, d: copied.definition }));

    // 既にあるアダプターは中身が同じなら使い回す。違えば上書きしない
    const again = await svc.copy({ source: { ...source, revision: undefined }, targets: [{ agent: 'antigravity', scope: 'user', name: 'guard3' }], dryRun: true });
    t.ok('同じ中身のアダプターは使い回す', again.results[0].adapter.exists === true && !again.results[0].reasons.some(r => r.code === 'adapterConflict'));
    t.ok('同じコマンドが写す先の同じイベントに既にあれば写さない（agy は別の名前でも 2 回走る）', again.results[0].status === 'blocked' && again.results[0].reasons.some(r => r.code === 'duplicate'));
    const againCodex = await svc.copy({ source: { ...source, revision: undefined }, targets: [{ agent: 'codex', scope: 'user' }], dryRun: true });
    t.ok('Codex へもう一度写すのも重ねない', againCodex.results[0].reasons.some(r => r.code === 'duplicate'));
    await fs.writeFile(path.join(home, '.gemini', 'config', 'pleiad-hooks', adapters[0]), '// changed');
    const conflict = await svc.copy({ source, targets: [{ agent: 'antigravity', scope: 'user', name: 'guard3' }], dryRun: true });
    t.ok('別の内容のアダプターがあれば写せない', conflict.results[0].status === 'blocked' && conflict.results[0].reasons.some(r => r.code === 'adapterConflict'));

    // node が見つからない: アダプターが要る写し先は選べない。要らない写し先（Claude → Codex の Stop）は写せる
    nodeFound = null;
    const ss2 = scan.entries.find(e => e.agent === 'claude' && e.event === 'SessionStart');
    const noNode = await svc.copy({ source: { agent: 'claude', scope: 'user', file: pre.path, loc: { event: 'PreToolUse', group: pre.group, handler: pre.handler } },
      targets: [{ agent: 'codex', scope: 'user' }], dryRun: true });
    t.ok('node が見つからなければアダプターの写し先は写せない', noNode.results[0].status === 'blocked' && noNode.results[0].reasons.some(r => r.code === 'noNode'));
    const ssCopy = await svc.copy({ source: { agent: 'claude', scope: 'user', file: pre.path, loc: { event: 'SessionStart', group: ss2.group, handler: ss2.handler } },
      targets: [{ agent: 'codex', scope: 'user' }, { agent: 'antigravity', scope: 'user' }], dryRun: true });
    t.ok('アダプターが要らない写し先は node が無くても写せる、SessionStart → agy は写せない', ssCopy.results[0].status === 'ready' && !ssCopy.results[0].adapter
      && ssCopy.results[1].status === 'blocked', JSON.stringify(ssCopy.results.map(r => [r.status, r.reasons])));
    const http = scan.entries.find(e => e.type === 'http');
    const httpCopy = await svc.copy({ source: { agent: 'claude', scope: 'user', file: pre.path, loc: { event: 'PostToolUse', group: http.group, handler: http.handler } },
      targets: [{ agent: 'codex', scope: 'user' }], dryRun: true });
    t.ok('http の定義は写せない', httpCopy.results[0].status === 'blocked' && httpCopy.results[0].reasons.some(r => r.code === 'type'));
    nodeFound = 'node';

    // 元のファイルが変わっていたら書かない
    const stale = await svc.copy({ source: { ...source, revision: 'old' }, targets: [{ agent: 'codex', scope: 'user' }], dryRun: true }).catch(e => e);
    t.ok('元のファイルが確認の後に変わったら断る', stale instanceof Error);

    // プロジェクトのスコープ: 作業場所の .claude/settings.json → .agents/hooks.json
    await write(path.join(repo, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.mjs' }] }] } });
    const ps = await svc.copy({ source: { agent: 'claude', scope: 'project', base: repo, file: path.join(repo, '.claude', 'settings.json'), loc: { event: 'Stop', group: 0, handler: 0 } },
      targets: [{ agent: 'antigravity', scope: 'project', base: repo, name: 'stopper' }], dryRun: true });
    const pr = ps.results[0];
    t.ok('プロジェクト: Stop → agy の .agents/hooks.json（handler を直接並べる）', pr.status === 'ready' && pr.path === path.join(repo, '.agents', 'hooks.json')
      && pr.adapter.path === path.join(repo, '.agents', 'pleiad-hooks', pr.adapter.path.split(/[\\/]/).pop()) && /"Stop": \[\s*\{\s*"type": "command"/.test(pr.after), pr.after);
    const pw = await svc.copy({ source: { agent: 'claude', scope: 'project', base: repo, file: path.join(repo, '.claude', 'settings.json'), loc: { event: 'Stop', group: 0, handler: 0 } },
      targets: [{ agent: 'antigravity', scope: 'project', base: repo, name: 'stopper', revision: pr.revision }] });
    t.ok('プロジェクト: 書けた', pw.results[0].ok && JSON.parse(await fs.readFile(path.join(repo, '.agents', 'hooks.json'), 'utf8')).stopper.Stop[0].timeout === 605);
    const clash = await svc.copy({ source: { agent: 'claude', scope: 'user', file: pre.path, loc: { event: 'PreToolUse', group: pre.group, handler: pre.handler } },
      targets: [{ agent: 'antigravity', scope: 'user', name: 'stopper' }], dryRun: true });
    await svc.scan({ cwd: repo });
    t.ok('ユーザーへ写すときは、作業場所の名前との衝突は分からない（警告だけ）', clash.results[0].warnings.some(w => w.code === 'agyNameScope'));
    const clash2 = await svc.copy({ source: { agent: 'claude', scope: 'user', file: pre.path, loc: { event: 'PreToolUse', group: pre.group, handler: pre.handler } },
      targets: [{ agent: 'antigravity', scope: 'project', base: repo, name: 'guard2' }], dryRun: true });
    t.ok('作業場所へ写すときは、ユーザーの同じ名前とも衝突を示す', clash2.results[0].reasons.some(r => r.code === 'nameTaken'));

    // スクリプト本体は写さないので、指す先を確かめる
    t.ok('同じ作業場所へ写すなら相対パスは警告しない', !pr.warnings.some(w => w.code === 'scriptRelative'));
    const toUser = await svc.copy({ source: { agent: 'claude', scope: 'project', base: repo, file: path.join(repo, '.claude', 'settings.json'), loc: { event: 'Stop', group: 0, handler: 0 } },
      targets: [{ agent: 'codex', scope: 'user' }], dryRun: true });
    t.ok('作業場所の相対パスをユーザーへ写すと、基準の場所が変わることを警告', toUser.results[0].warnings.some(w => w.code === 'scriptRelative' && w.params.path === 'stop.mjs'), JSON.stringify(toUser.results[0].warnings));
    const missing = `${tmp.replace(/\\/g, '/')}/no-such-hook.mjs`;
    await write(path.join(repo, '.codex', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${missing}` }] }] } });
    const miss = await svc.copy({ source: { agent: 'codex', scope: 'project', base: repo, file: path.join(repo, '.codex', 'hooks.json'), loc: { event: 'PreToolUse', group: 0, handler: 0 } },
      targets: [{ agent: 'claude', scope: 'project', base: repo }], dryRun: true });
    t.ok('指すスクリプトが無ければ警告（写しても動かない）', miss.results[0].status === 'ready' && miss.results[0].warnings.some(w => w.code === 'scriptMissing'), JSON.stringify(miss.results[0].warnings));
    t.ok('Claude のプロジェクトには移動しても動く変数のパスを書く', miss.results[0].written.includes('"$CLAUDE_PROJECT_DIR/.claude/pleiad-hooks/'));
    // These copy previews only check that the source shell exists; they never execute it.
    const gitBashPath = path.join(tmp, 'git-bash.exe');
    process.env.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
    const win = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(tmp, 'win-home', '.gemini'),
      findNode: async () => 'C:/Program Files/nodejs/node.exe', platform: 'win32' });
    const noShell = (await win.copy({ source, targets: [{ agent: 'antigravity', scope: 'user', name: 'win-unquoted' }], dryRun: true })).results[0];
    t.ok('Windows の元のシェルが無ければ写さない', !noShell.ok && noShell.status === 'blocked'
      && noShell.reasons.some(r => r.code === 'sourceShell'), JSON.stringify(noShell.reasons));
    await fs.writeFile(gitBashPath, '');
    const wa = await win.copy({ source, targets: [{ agent: 'antigravity', scope: 'user', name: 'win-unquoted' }], dryRun: true });
    t.ok('Windows の agy ユーザーへは空白の無い絶対パスと PATH の node で写せる', wa.results[0].status === 'ready'
      && /^node [^"\s]+\/pleiad-hooks\/hook-adapter-[0-9a-f]{12}\.mjs claude antigravity /.test(wa.results[0].written),
      JSON.stringify({ status: wa.results[0].status, reasons: wa.results[0].reasons, written: wa.results[0].written?.match(/node [^"\s]+hook-adapter-[0-9a-f]{12}\.mjs claude antigravity /)?.[0] }));
    const spacedWin = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'),
      geminiHome: path.join(tmp, 'space home', '.gemini'), findNode: async () => 'C:/Program Files/nodejs/node.exe', platform: 'win32' });
    const spaced = await spacedWin.copy({ source, targets: [{ agent: 'antigravity', scope: 'user', name: 'win-spaced' }], dryRun: true });
    t.ok('Windows の agy ユーザーへは空白を含むアダプターパスを写さない', spaced.results[0].reasons.some(r => r.code === 'adapterPath'));
    await write(path.join(repo, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } });
    const wp = await win.copy({ source: { agent: 'claude', scope: 'project', base: repo, file: path.join(repo, '.claude', 'settings.json'), loc: { event: 'PreToolUse', group: 0, handler: 0 } },
      targets: [{ agent: 'antigravity', scope: 'project', base: repo, name: 'win-project' }], dryRun: true });
    t.ok('Windows の agy プロジェクトへは .agents からの引用符なし相対パスで写せる', wp.results[0].status === 'ready'
      && wp.results[0].written.includes('node pleiad-hooks/hook-adapter-') && !wp.results[0].written.includes('node "pleiad-hooks/'));
    const wc = await win.copy({ source: { agent: 'claude', scope: 'project', base: repo, file: path.join(repo, '.claude', 'settings.json'), loc: { event: 'PreToolUse', group: 0, handler: 0 } },
      targets: [{ agent: 'codex', scope: 'project', base: repo }], dryRun: true });
    t.ok('Codex のプロジェクトへはアダプターの基準フォルダーが不明で写さない', wc.results[0].reasons.some(r => r.code === 'adapterProjectCodex'));
  } finally {
    if (originalGitBashPath === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    else process.env.CLAUDE_CODE_GIT_BASH_PATH = originalGitBashPath;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
