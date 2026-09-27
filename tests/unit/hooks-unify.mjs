// Hooks を Pleiad がそろえる（ADR 0048）。LLM もエージェントも呼ばない。
//   - 正本と担当の保存（<data>/hooks.json）: 検査・場所の上書きと継承・受け継ぐ値と同じ上書きを持たない・担当と取り込みを 1 回で保存
//   - 組み立て: エージェントごとの渡し方（Claude のコールバック・Codex の表と state・agy の hooks.json）、渡せないもの
//   - 実行: Claude のコールバックからコマンドを子プロセスで動かす（同じ形は exit 2 で止める、別の形はアダプター）。アダプターの同じ形・記録
//   - 切り替えの確認: 止まる・動き続ける・取り込める行
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlyHooks, normalizeHook } from '../../core/ply-hooks.mjs';
import { deliverable, planHooks, codexHooksTable, codexHooksState, agyHooksFile, claudeIdentityOutput } from '../../core/hooks-plan.mjs';
import { claudeHookCallbacks, importCandidate, unifyPreview, readAgyRuns, mergeCallbacks } from '../../core/hooks-unify.mjs';
import { claudeContextOptions } from '../../core/backends/context-options.mjs';
import { adapt, sameAgentOutput } from '../../core/hook-adapter.mjs';
import { codexHookRun } from '../../core/backends/codex.mjs';
import { createHooksConfig } from '../../core/hooks-config.mjs';
import { containsPath } from '../../core/context-settings.mjs';

export const name = 'hooks-unify';
export const title = 'Hooks を Pleiad がそろえる: 正本と担当の保存・エージェントごとの渡し方・コールバックとアダプター・切り替えの確認';

const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
const script = async (dir, file, body) => { const p = path.join(dir, file); await fs.writeFile(p, body); return p.replace(/\\/g, '/'); };

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-unify-')));
  try {
    // ---------------------------------------------------------------- 正本と担当の保存
    const data = path.join(tmp, 'data');
    const place = path.join(tmp, 'repo'), child = path.join(place, 'sub');
    await fs.mkdir(child, { recursive: true });
    const store = createPlyHooks(data);
    const empty = await store.view(null);
    t.ok('何も保存していなければ担当はエージェント任せ・登録なし', empty.defaults.value.owner === 'native' && empty.hooks.length === 0);
    let threw = null;
    try { normalizeHook({ name: 'x', agent: 'antigravity', event: 'SessionStart', command: 'node a.mjs' }); } catch (e) { threw = e; }
    t.ok('そのエージェントの形に無いイベントは登録しない（agy に SessionStart は無い）', threw?.code === 'INVALID');
    const saved = await store.save({ name: 'guard', agent: 'claude', event: 'PreToolUse', matcher: 'Bash', command: 'node guard.mjs --token SECRET-X', targets: ['claude', 'codex', 'antigravity'] });
    t.ok('登録を保存し、一覧のコマンドは伏せ字', saved.hooks.length === 1 && saved.hooks[0].id === saved.id && !JSON.stringify(saved).includes('SECRET-X') && saved.hooks[0].masked);
    t.ok('編集のシート用には元のコマンドを返す', (await store.readHook(saved.id)).command.includes('SECRET-X'));
    const onDisk = JSON.parse(await fs.readFile(store.file, 'utf8'));
    t.ok('置き場は <data>/hooks.json（形式 1）。context-scans.json には書かない', onDisk.version === 1 && onDisk.hooks[0].targets.length === 3
      && !(await fs.stat(path.join(data, 'context-scans.json')).then(() => true, () => false)));
    await store.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    const inherit = await store.resolve(child);
    t.ok('場所の上書きが無ければ既定の担当', inherit.owner === 'ply' && inherit.from === null);
    await store.setOwner({ place, value: { owner: 'ply', disabled: [saved.id] } });
    const here = await store.resolve(child);
    t.ok('この場所だけ変える: 一番近い上書き（子の場所にも効く）', here.owner === 'ply' && here.disabled[0] === saved.id && here.from.toLowerCase() === place.toLowerCase());
    await store.setOwner({ place, value: { owner: 'ply', disabled: [] } });
    const pruned = JSON.parse(await fs.readFile(store.file, 'utf8'));
    t.ok('受け継ぐ値と同じ上書きは持たない（全体の設定どおりに戻る）', Object.keys(pruned.places).length === 0);
    const before = await fs.readFile(store.file, 'utf8');
    let failed = null;
    try { await store.setOwner({ place: null, value: { owner: 'native' }, add: [{ name: 'bad', agent: 'codex', event: 'Nope', command: 'x' }] }); } catch (e) { failed = e; }
    t.ok('取り込みに失敗したら担当も変えない（全部書くか何も書かない）', failed && (await fs.readFile(store.file, 'utf8')) === before);
    const both = await store.setOwner({ place: null, value: { owner: 'ply', disabled: [] }, add: [{ name: 'imported', agent: 'codex', event: 'Stop', command: 'echo stop', targets: ['codex'],
      importedFrom: { agent: 'codex', scope: 'user', path: '/x/hooks.json', event: 'Stop' } }] });
    t.ok('担当と取り込みを 1 回で保存する', both.added.length === 1 && both.hooks.some(h => h.name === 'imported' && h.importedFrom?.scope === 'user'));
    await store.setOwner({ place, value: { owner: 'ply', disabled: [both.added[0]] } });
    await store.remove(both.added[0]);
    const cleaned = JSON.parse(await fs.readFile(store.file, 'utf8'));
    t.ok('登録を消すと場所の「渡さない」からも外れる', !JSON.stringify(cleaned).includes(both.added[0]));
    await fs.writeFile(path.join(tmp, 'broken.json'), '{');
    const broken = createPlyHooks(tmp);
    await fs.rename(path.join(tmp, 'broken.json'), broken.file);
    let unreadable = null;
    try { await broken.view(); } catch (e) { unreadable = e; }
    t.ok('壊れたファイルは読めないとして止まり、ファイルは変えない', unreadable && (await fs.readFile(broken.file, 'utf8')) === '{');
    await fs.rm(broken.file);

    // ---------------------------------------------------------------- 組み立て（純粋）
    const hook = { id: 'h-000000000001', name: 'guard', agent: 'claude', event: 'PreToolUse', matcher: 'Bash', command: 'node guard.mjs', targets: ['claude', 'codex', 'antigravity'], enabled: true };
    const toClaude = deliverable(hook, 'claude'), toCodex = deliverable(hook, 'codex'), toAgy = deliverable(hook, 'antigravity');
    t.ok('同じ形（Claude → Claude）はそのまま・アダプター無し', toClaude.status === 'ok' && !toClaude.adapter && toClaude.matcher === 'Bash');
    t.ok('Claude → Codex の PreToolUse はアダプター越し（第 2 段の規則）', toCodex.status === 'ok' && toCodex.adapter && toCodex.matcher === 'Bash');
    t.ok('Antigravity へはアダプター越し・matcher は run_command', toAgy.status === 'ok' && toAgy.adapter && toAgy.matcher === 'run_command');
    const session = deliverable({ ...hook, event: 'SessionStart', matcher: '' }, 'claude');
    t.ok('Claude の SessionStart はコールバックで渡せない（理由付き）', session.status === 'blocked' && session.reasons.some(r => r.code === 'claudeCallback'));
    const agySelf = deliverable({ ...hook, agent: 'antigravity', event: 'PreToolUse', matcher: 'run_command' }, 'antigravity');
    t.ok('agy の形の登録も agy へはアダプター越し（作業フォルダーと記録のため）', agySelf.status === 'ok' && agySelf.adapter && agySelf.innerTimeout === 30);
    const plan = planHooks({ hooks: [hook, { ...hook, id: 'h-000000000002', enabled: false }, { ...hook, id: 'h-000000000003' }, { ...hook, id: 'h-000000000004', event: 'SessionStart', matcher: '' }],
      owner: { owner: 'ply', disabled: ['h-000000000003'] }, agent: 'claude' });
    t.ok('オフ・この場所では渡さない・渡せないを分ける', plan.supplied.length === 1 && plan.skipped.map(s => s.reason).join() === 'off,disabledHere' && plan.unsupported.length === 1);

    const codexPlan = planHooks({ hooks: [hook, { ...hook, id: 'h-000000000005', agent: 'codex', event: 'Stop', matcher: '', command: 'echo stop' }], owner: { owner: 'ply' }, agent: 'codex' });
    const { table } = codexHooksTable(codexPlan.supplied, { adapterPath: 'C:/data/hooks-runtime/hook-adapter-abc.mjs', node: 'C:/node/node.exe' });
    t.ok('Codex の表: アダプター越しのコマンドと、同じ形はそのまま', /hook-adapter-abc\.mjs" claude codex PreToolUse 600 /.test(table.PreToolUse[0].hooks[0].command) && table.PreToolUse[0].matcher === 'Bash'
      && table.Stop[0].hooks[0].command === 'echo stop' && table.PreToolUse[0].hooks[0].timeout === 605, JSON.stringify(table));
    const probe = [{ hooks: [{ key: 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0', source: 'sessionFlags', currentHash: 'sha256:aa' }, { key: 'C:\\<session-flags>\\config.toml:stop:0:0', source: 'sessionFlags', currentHash: 'sha256:bb' }] }];
    const list = [{ hooks: [{ key: 'U:pre_tool_use:0:0', source: 'user' }, { key: 'P:stop:0:0', source: 'project' }, { key: 'X:stop:0:0', source: 'plugin' }, { key: 'M:stop:0:0', source: 'mdm' }] }];
    const st = codexHooksState({ table, probe, list });
    t.ok('Codex の state: 自分の定義に trusted_hash、ユーザー・プロジェクトは enabled:false、プラグイン・管理者は止めない',
      st.state['C:\\<session-flags>\\config.toml:pre_tool_use:0:0'].trusted_hash === 'sha256:aa' && st.state['U:pre_tool_use:0:0'].enabled === false && st.state['P:stop:0:0'].enabled === false
      && !st.state['X:stop:0:0'] && !st.state['M:stop:0:0'] && st.kept.length === 2 && st.untrusted === 0, JSON.stringify(st.state));
    t.ok('hash を取れなければ数える（その定義は Codex が動かさない）', codexHooksState({ table, probe: [], list }).untrusted === 2);

    const agyPlan = planHooks({ hooks: [hook], owner: { owner: 'ply' }, agent: 'antigravity' });
    const file = agyHooksFile({ supplied: agyPlan.supplied, nativeNames: ['user_probe', 'ws_probe'], adapterName: 'hook-adapter-abc.mjs' });
    const mine = file['pleiad-h-000000000001'];
    t.ok('agy の hooks.json: 登録は pleiad-<id>・相対パスのアダプター（引用なし）・記録の id', mine?.PreToolUse?.[0]?.matcher === 'run_command'
      && /^node pleiad-hooks\/hook-adapter-abc\.mjs claude antigravity PreToolUse 600 \S+ h-000000000001$/.test(mine.PreToolUse[0].hooks[0].command), JSON.stringify(file));
    t.ok('agy の hooks.json: ネイティブの名前ごとに { enabled: false }', file.user_probe?.enabled === false && file.ws_probe?.enabled === false && Object.keys(file.ws_probe).length === 1);

    // ---------------------------------------------------------------- Claude のフラグ設定
    t.ok('Hooks を Pleiad がそろえる Claude の会話はフラグ設定に disableAllHooks', claudeContextOptions(null, { hooks: true }).settings?.disableAllHooks === true
      && claudeContextOptions(null).settings === undefined);
    const merged = claudeContextOptions({ owners: { instruction: 'ply', skill: 'native', mcp: 'native' } }, { hooks: true });
    t.ok('指示の担当の設定と同じフラグ設定に入る', merged.settings.disableAllHooks === true && merged.settings.autoMemoryEnabled === false);

    // ---------------------------------------------------------------- Claude のコールバック（実際に node を子プロセスで動かす）
    const deny2 = await script(tmp, 'deny2.mjs', "process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('blocked by pleiad\\n'); process.exit(2); });");
    const agyDeny = await script(tmp, 'agy-deny.mjs', "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => { const i = JSON.parse(s); process.stdout.write(JSON.stringify({ decision: i.toolCall?.name === 'run_command' ? 'deny' : 'allow', reason: 'agy form deny' })); });");
    const runs = [];
    const callbacks = claudeHookCallbacks({ cwd: tmp, supplied: [
      { hook: { id: 'h-00000000000a', name: 'exit2', agent: 'claude', command: `${node} ${deny2}` }, d: { event: 'PreToolUse', matcher: 'Bash', adapter: false } },
      { hook: { id: 'h-00000000000b', name: 'agy', agent: 'antigravity', command: `${node} ${agyDeny}` }, d: { event: 'PreToolUse', matcher: 'Bash', adapter: true, innerTimeout: 20, timeout: 25 } },
    ] }, { onRun: r => runs.push(r) });
    const input = { session_id: 's1', cwd: tmp, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'u1' };
    const out1 = await callbacks.PreToolUse[0].hooks[0](input, 'u1', { signal: new AbortController().signal });
    t.ok('同じ形のコマンド: exit 2 はツールを止める（理由は stderr）', out1.hookSpecificOutput?.permissionDecision === 'deny' && out1.hookSpecificOutput.permissionDecisionReason === 'blocked by pleiad', JSON.stringify(out1));
    const out2 = await callbacks.PreToolUse[1].hooks[0](input, 'u1', { signal: new AbortController().signal });
    t.ok('別の形のコマンド（agy）: アダプターで Claude の deny に直す', out2.hookSpecificOutput?.permissionDecision === 'deny' && /agy form deny/.test(out2.hookSpecificOutput.permissionDecisionReason), JSON.stringify(out2));
    t.ok('コールバックの発火を自分で記録する（開始と応答、Pleiad の印）', runs.length === 4 && runs.every(r => r.pleiad && r.id) && runs[1].phase === 'response' && runs[1].exitCode === 2);
    t.ok('matcher と timeout をコールバックの表に載せる', callbacks.PreToolUse[0].matcher === 'Bash' && callbacks.PreToolUse[1].timeout === 25);
    t.ok('Pleiad 自身のコールバック（PreCompact）と合わせる', mergeCallbacks({ PreCompact: [1] }, callbacks).PreCompact.length === 1 && mergeCallbacks({ PreCompact: [1] }, callbacks).PreToolUse.length === 2);
    t.ok('同じ形の約束: exit 0 の JSON はそのまま・exit 1 は止めない・timeout は止めない', claudeIdentityOutput('PreToolUse', { code: 0, stdout: '{"a":1}' }).a === 1
      && Object.keys(claudeIdentityOutput('PreToolUse', { code: 1, stderr: 'x' })).length === 0 && Object.keys(claudeIdentityOutput('PreToolUse', { timedOut: true })).length === 0
      && claudeIdentityOutput('Stop', { code: 2, stderr: 'more' }).decision === 'block');

    // ---------------------------------------------------------------- Claude のバックエンドが query() に渡すもの（SDK は身代わり）
    {
      const { backend: claude, setClaudeSdkForTest } = await import('../../core/backends/claude.mjs');
      let options = null;
      const q = { interrupt: async () => ({}), close() {}, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', num_turns: 1 }; } };
      const restore = setClaudeSdkForTest({ query: ({ prompt, options: o }) => { options = o; (async () => { for await (const _ of prompt) break; })(); return q; }, executable: () => 'claude-fake' });
      try {
        await claude.runTurn({ prompt: 'x', sessionId: null, cwd: tmp, mode: 'default', emit: () => {}, askPermission: async () => ({ allow: true }), signal: new AbortController(), control: {},
          hooksRuntime: { cwd: tmp, supplied: [{ hook: { id: 'h-00000000000f', name: 'g', agent: 'claude', command: 'echo' }, d: { event: 'PreToolUse', matcher: 'Bash', adapter: false } }] } }).catch(() => {});
      } finally { restore(); }
      t.ok('Claude: query() のフラグ設定に disableAllHooks、hooks に登録のコールバックと Pleiad 自身の PreCompact', options?.settings?.disableAllHooks === true
        && options.hooks.PreToolUse?.[0]?.matcher === 'Bash' && typeof options.hooks.PreToolUse[0].hooks[0] === 'function' && options.hooks.PreCompact?.length === 1 && options.settingSources.includes('user'));
    }

    // ---------------------------------------------------------------- アダプター（同じ形・記録）
    const silent = await script(tmp, 'silent.mjs', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'));");
    const self = path.join(tmp, 'pleiad-hooks', 'hook-adapter.mjs');
    await fs.mkdir(path.dirname(self), { recursive: true });
    const agyInput = JSON.stringify({ conversationId: 'c1', workspacePaths: [tmp.replace(/\\/g, '/')], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } });
    const allow = await adapt({ argv: ['antigravity', 'antigravity', 'PreToolUse', '10', Buffer.from(`${node} ${silent}`).toString('base64url'), 'h-00000000000c'], stdin: agyInput, selfPath: self });
    t.ok('agy の形のまま: 何も言わない PreToolUse は allow にする（agy は {} を deny にするため）', JSON.parse(allow.stdout).decision === 'allow' && allow.code === 0, allow.stdout);
    const recorded = await readAgyRuns(path.join(path.dirname(self), 'runs.jsonl'));
    t.ok('6 番目の引数があれば runs.jsonl に開始と応答を記録する（入出力は書かない）', recorded.runs.length === 2 && recorded.runs[0].id === 'h-00000000000c' && recorded.runs[1].outcome === 'success'
      && !JSON.stringify(recorded.runs).includes('echo hi') && recorded.offset > 0);
    t.ok('同じ形の exit 2 はそのまま返す（Codex・Claude の約束）', sameAgentOutput({ to: 'codex', event: 'PreToolUse', result: { code: 2, stderr: 'no' } }).code === 2);

    // ---------------------------------------------------------------- Codex の発火の通知
    const rt = { supplied: [{ hook: { id: 'h-00000000000d', name: 'guard' }, d: { event: 'PreToolUse' } }] };
    const r1 = codexHookRun('hook/started', { run: { id: 'r1', eventName: 'preToolUse', source: 'sessionFlags' } }, rt);
    const r2 = codexHookRun('hook/completed', { run: { id: 'r2', eventName: 'stop', source: 'user', status: 'completed', durationMs: 3 } }, rt);
    t.ok('Codex: sessionFlags は Pleiad が渡した定義（同じイベントが 1 件なら登録の名前）', r1.pleiad && r1.id === 'h-00000000000d' && r1.name === 'guard' && r1.event === 'PreToolUse');
    t.ok('Codex: そろえた会話でユーザー・プロジェクトの定義が走ったら漏れ', r2.leak === true && r2.outcome === 'success' && r2.ms === 3 && !codexHookRun('hook/started', { run: { source: 'user' } }, null).leak);

    // ---------------------------------------------------------------- 取り込みと切り替えの確認
    const home = path.join(tmp, 'home');
    const claudeHome = path.join(home, '.claude'), pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'm', 'p1', '1.0.0');
    const w = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v)); };
    await w(path.join(claudeHome, 'settings.json'), { enabledPlugins: { 'p1@m': true, 'p2@m': false }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node user-stop.mjs' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node cond.mjs', if: 'Bash(git *)' }] }] } });
    await w(path.join(claudeHome, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'p1@m': [{ scope: 'user', installPath: pluginRoot }], 'p2@m': [{ scope: 'user', installPath: path.join(home, 'p2') }] } });
    await w(path.join(pluginRoot, 'hooks', 'hooks.json'), { hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/fmt.mjs' }] }] } });
    await w(path.join(home, 'p2', 'hooks', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node off.mjs' }] }] } });
    await w(path.join(home, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo codex' }] }] } });
    const cfg = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome, geminiHome: path.join(home, '.gemini') });
    const report = await cfg.scan({ scopes: ['user'] });
    const plugin = report.entries.find(e => e.scope === 'plugin');
    t.ok('有効にした Claude のプラグインの hooks を読み取りのみの行で出す（無効のものは出さない）', plugin?.plugin === 'p1@m' && plugin.readOnly && !report.entries.some(e => /off\.mjs/.test(e.command)));
    report.entries.push({ id: 'cx-plugin', agent: 'codex', scope: 'plugin', kind: 'codex-list', readOnly: true, event: 'Stop', command: 'node plug.js', path: 'C:/plugins/x' });
    const raws = await cfg.raw({ ids: report.entries.map(e => e.id) });
    const preview = unifyPreview({ report, raws, hooks: [], owner: { owner: 'native' } });
    const pl = preview.stops.find(s => s.scope === 'plugin');
    t.ok('確認: Claude のプラグインの hooks も止まる行に並び、取り込める', pl?.importable === true, JSON.stringify(pl));
    t.ok('確認: Codex のプラグインの hooks は止めない（動き続ける）', preview.keeps.some(k => k.id === 'cx-plugin') && !preview.stops.some(s => s.id === 'cx-plugin'));
    const cond = preview.stops.find(s => s.event === 'PreToolUse');
    t.ok('確認: 実行の条件（if）を持つ定義は取り込めない（理由付き）', cond && !cond.importable && cond.reasons.includes('controlKeys'));
    const candidate = importCandidate(raws.find(r => r.row.scope === 'plugin'));
    t.ok('取り込み: プラグインの置き場所の変数は実際のパスに置き換える', candidate.importable && candidate.value.command === `node ${pluginRoot.replace(/\\/g, '/')}/fmt.mjs` && candidate.value.importedFrom.plugin === 'p1@m');
    const ssRow = importCandidate({ row: { agent: 'claude', scope: 'user', event: 'SessionStart', path: '/x/settings.json' }, handler: { type: 'command', command: 'node ctx.mjs' }, matcher: '' });
    t.ok('取り込み: Claude の SessionStart はコールバックで渡せないので取り込めない', !ssRow.importable && ssRow.reasons.includes('claudeCallback'));
    const again = unifyPreview({ report, raws, hooks: [{ ...candidate.value, id: 'h-00000000000e', importedFrom: candidate.value.importedFrom }] });
    t.ok('取り込み済みの定義はもう一度取り込まない', again.stops.find(s => s.scope === 'plugin').reasons.includes('already'));
    t.ok('確認: Pleiad の登録ごとの、エージェントごとの渡し方', unifyPreview({ report, raws, hooks: [hook] }).registry[0].targets.antigravity.adapter === true);
  } finally {
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-hooks-unify-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
