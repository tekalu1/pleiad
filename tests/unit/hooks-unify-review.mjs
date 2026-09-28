// Hooks を Pleiad がそろえる（ADR 0049）のレビューの指摘ごとの確かめ（関数の単位。LLM もエージェントも呼ばない）。
// 番号は temporary/reports/hooks-stage3-review.md の必須 1〜9・推奨 10〜17・任意。入力 → 期待する結果の形で並べる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlyHooks, parseConfig } from '../../core/ply-hooks.mjs';
import { agyHooksFile, codexListProblem, classifyNativeRun, planHooks } from '../../core/hooks-plan.mjs';
import { prepareHooksTurn, importCandidate, unifyPreview, claudeHookCallbacks, readAgyRuns, rotateAgyRuns, definitionDigest } from '../../core/hooks-unify.mjs';
import { codexHooksConfig, probeHookHashes } from '../../core/backends/codex.mjs';
import { createHooksConfig, findNodeOnPath } from '../../core/hooks-config.mjs';
import { runCommand } from '../../core/hook-adapter.mjs';
import { writeAtomic } from '../../core/atomic-file.mjs';
import { initialOverrides, sheetMatchers, resetPlan, pickChange } from '../../web/hooks-unify-ui.mjs';
import { containsPath } from '../../core/context-settings.mjs';

export const name = 'hooks-unify-review';
export const title = 'Hooks を Pleiad がそろえる: レビューの指摘（漏れ・ガードの消失・確認の迂回）の確かめ';

const thrown = async fn => { try { await fn(); return null; } catch (e) { return e; } };
const w = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v)); };
const HOOK = { name: 'guard', agent: 'claude', event: 'PreToolUse', matcher: 'Bash', command: 'node guard.mjs', targets: ['claude', 'codex', 'antigravity'] };

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-review-')));
  try {
    const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo');
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    const hooksConfig = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(home, '.gemini') });
    const setup = async (dir, owner = 'ply') => {
      const store = createPlyHooks(path.join(tmp, dir));
      await store.save(HOOK);
      await store.setOwner({ place: null, value: { owner, disabled: [] } });
      return store;
    };
    const ctx = (store, extra = {}) => ({ plyHooks: store, hooksConfig, dataDir: path.join(tmp, 'rt'), findNode: findNodeOnPath, ...extra });
    const ply = await setup('d1');

    // ---- 必須 1: agy で Skills も Pleiad 担当（カスタムエージェントが inheritCustomizations:false で hooks も止める）→ 始めない
    const agyConflict = await thrown(() => prepareHooksTurn({ agent: 'antigravity', cwd, ctx: ctx(ply, { context: { owners: { instruction: 'ply', skill: 'ply', mcp: 'native' }, delivered: true } }) }));
    t.ok('1: agy・Skills も Pleiad 担当 → ターンを始めない（理由付き）', agyConflict?.code === 'HOOKS_REFUSED' && /Skills/.test(agyConflict.message), agyConflict?.message);
    const agyOk = await prepareHooksTurn({ agent: 'antigravity', cwd, ctx: ctx(ply, { context: { owners: { instruction: 'ply', skill: 'native', mcp: 'native' }, delivered: true } }) });
    t.ok('1: Skills がエージェント任せなら（カスタムエージェントは inheritCustomizations: true）始める', Boolean(agyOk?.runtime?.file));
    const codexSame = await prepareHooksTurn({ agent: 'codex', cwd, ctx: ctx(ply, { context: { owners: { instruction: 'ply', skill: 'ply', mcp: 'native' }, delivered: true } }) });
    t.ok('1: Codex・Claude は同じ組み合わせでも始める（カスタムエージェントを使わない）', Boolean(codexSame?.runtime));

    // ---- 必須 3: trusted_hash を取れない → 始めない（ネイティブだけ止めて続けない）
    const codexRt = (await prepareHooksTurn({ agent: 'codex', cwd, ctx: ctx(ply) })).runtime;
    const list = [{ cwd, hooks: [{ key: 'U:pre_tool_use:0:0', source: 'user' }], errors: [] }];
    const rpc = data => ({ request: async () => ({ data }) });
    const probeFail = await thrown(() => codexHooksConfig(codexRt, rpc(list), cwd, { probe: async () => { throw new Error('spawn failed'); } }));
    t.ok('3: プローブが失敗 → 投げる（ターンを始めない）', probeFail && /hash/.test(probeFail.message), probeFail?.message);
    const noHash = await thrown(() => codexHooksConfig(codexRt, rpc(list), cwd, { probe: async () => [] }));
    t.ok('3: 渡す登録の hash がそろわない → 投げる', Boolean(noHash));
    const good = await codexHooksConfig(codexRt, rpc(list), cwd, { probe: async () => [{ hooks: [{ key: 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0', source: 'sessionFlags', currentHash: 'sha256:1' }] }] });
    t.ok('3: hash がそろえば、自分の定義に trusted_hash・ネイティブに enabled:false', good.config.state['C:\\<session-flags>\\config.toml:pre_tool_use:0:0'].trusted_hash === 'sha256:1' && good.config.state['U:pre_tool_use:0:0'].enabled === false);
    const noReg = await codexHooksConfig({ ...codexRt, table: {}, record: {} }, rpc(list), cwd, { probe: async () => { throw new Error('must not probe'); } });
    t.ok('3: 渡す登録が無ければプローブを起こさず、ネイティブだけ止める（担当が Pleiad なので止める必要はある）', noReg.config.state['U:pre_tool_use:0:0'].enabled === false);

    // ---- 必須 4: 止める一覧が不完全 → 始めない
    t.ok('4: Codex の一覧: cwd ごとの errors・hooks が並びでない・cwd の分が無い → 不足', Boolean(codexListProblem([{ cwd, hooks: [], errors: [{ message: 'bad toml' }] }], cwd))
      && Boolean(codexListProblem([{ cwd, hooks: null, errors: [] }], cwd)) && Boolean(codexListProblem({ data: 1 }, cwd))
      && Boolean(codexListProblem([{ cwd: 'X', hooks: [] }, { cwd: 'Y', hooks: [] }], cwd)) && codexListProblem([{ cwd, hooks: [], errors: [] }], cwd) === null);
    const partial = await thrown(() => codexHooksConfig(codexRt, rpc([{ cwd, hooks: [], errors: [{ message: 'x' }] }]), cwd, { probe: async () => [] }));
    t.ok('4: Codex: 一覧が不完全なら config を作らずに投げる', partial && /hooks\/list/.test(partial.message), partial?.message);
    await w(path.join(cwd, '.agents', 'hooks.json'), '{ broken');
    const agyBroken = await thrown(() => prepareHooksTurn({ agent: 'antigravity', cwd, ctx: ctx(ply) }));
    t.ok('4: agy: 作業場所の hooks.json を読めない → 始めない', agyBroken?.code === 'HOOKS_REFUSED' && /hooks\.json/.test(agyBroken.message), agyBroken?.message);
    await fs.rm(path.join(cwd, '.agents'), { recursive: true, force: true });
    const outside = path.join(tmp, 'outside-agents');
    await w(path.join(outside, 'hooks.json'), { outsideNative: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo x' }] }] } });
    await fs.symlink(outside, path.join(cwd, '.agents'), 'junction');
    const agyLink = await thrown(() => prepareHooksTurn({ agent: 'antigravity', cwd, ctx: ctx(ply) }));
    t.ok('4: agy: .agents が作業場所の外を指す（Pleiad は読まないが agy は読む）→ 始めない', agyLink?.code === 'HOOKS_REFUSED', agyLink?.message);
    await fs.rm(path.join(cwd, '.agents'), { force: true, recursive: false }).catch(async () => fs.rmdir(path.join(cwd, '.agents')));

    // ---- 必須 6: 壊れた登録・担当を黙って落とさない
    const dataBad = path.join(tmp, 'd6');
    await w(path.join(dataBad, 'hooks.json'), { version: 1, defaults: { owner: 'ply' }, hooks: [{ id: 'h-000000000001', name: 'guard', agent: 'claude', event: 'PreToolUse', matcher: 'Bash', command: '', targets: ['claude'] }] });
    const bad = createPlyHooks(dataBad);
    const brokenGuard = await thrown(() => prepareHooksTurn({ agent: 'claude', cwd, ctx: ctx(bad) }));
    t.ok('6: 担当が Pleiad で登録が壊れている（command が空）→ 始めない（ガードを黙って落とさない）', brokenGuard?.code === 'BROKEN', brokenGuard?.message);
    const view6 = await bad.view(cwd);
    t.ok('6: 壊れた部分は画面に出す（読めた部分は残る）', view6.problems.some(p => p.kind === 'hook'));
    const saveBroken = await thrown(() => bad.save({ ...HOOK, name: 'x' }));
    t.ok('6: 壊れた部分があるファイルには上書き保存しない', saveBroken?.code === 'BROKEN');
    await w(path.join(dataBad, 'hooks.json'), { version: 1, defaults: { owner: 'maybe' }, hooks: [] });
    const unknownOwner = await thrown(() => prepareHooksTurn({ agent: 'codex', cwd, ctx: ctx(createPlyHooks(dataBad)) }));
    t.ok('6: 既定の担当が壊れている → 担当が分からないので始めない（エージェント任せと決め打ちしない）', unknownOwner?.code === 'OWNER_UNKNOWN', unknownOwner?.message);
    await w(path.join(dataBad, 'hooks.json'), { version: 1, defaults: { owner: 'native' }, places: { [cwd]: { owner: 'x' } }, hooks: [] });
    t.ok('6: 効くはずの場所の担当が壊れている → 始めない', (await thrown(() => prepareHooksTurn({ agent: 'codex', cwd, ctx: ctx(createPlyHooks(dataBad)) })))?.code === 'OWNER_UNKNOWN');
    await w(path.join(dataBad, 'hooks.json'), { version: 1, defaults: { owner: 'native' }, places: { [path.join(tmp, 'elsewhere')]: { owner: 'x' } }, hooks: [] });
    t.ok('6: 関係の無い場所の担当が壊れていても、エージェント任せと確かに分かれば始める', await prepareHooksTurn({ agent: 'codex', cwd, ctx: ctx(createPlyHooks(dataBad)) }) === null);
    const dup = parseConfig({ version: 1, hooks: [{ ...HOOK, id: 'h-000000000002' }, { ...HOOK, id: 'h-000000000002' }] });
    t.ok('6: 重複した id は壊れた部分として数える', dup.problems.some(p => p.kind === 'duplicate') && dup.hooks.length === 1);
    await w(path.join(dataBad, 'hooks.json'), { version: 1, defaults: { owner: 'ply' }, hooks: [{ ...HOOK, id: 'h-000000000003', targets: ['claude'] }, { id: 'h-000000000004', name: '', agent: 'claude' }] });
    const repaired = await createPlyHooks(dataBad).repair();
    const backups = (await fs.readdir(dataBad)).filter(n => n.startsWith('hooks.broken-'));
    t.ok('6: 直す操作: 元のファイルを退避し、読めた登録は残して書き直す', backups.length === 1 && repaired.hooks.length === 1 && repaired.problems.length === 0 && repaired.defaults.value.owner === 'ply');

    // ---- 推奨 11: Hooks を使っていない会話・hooks を受け取れないエージェントに読み取り障害を波及させない
    const fresh = createPlyHooks(path.join(tmp, 'd11'));
    t.ok('11: hooks.json が無い（初期状態）ならエージェント任せで進む', await prepareHooksTurn({ agent: 'claude', cwd, ctx: ctx(fresh) }) === null);
    await w(path.join(tmp, 'd11b', 'hooks.json'), { version: 1, defaults: { owner: 'native' }, hooks: [{ id: 'h-000000000005', name: '', agent: 'claude' }] });
    t.ok('11: 担当がエージェント任せなら、壊れた登録があっても始める', await prepareHooksTurn({ agent: 'claude', cwd, ctx: ctx(createPlyHooks(path.join(tmp, 'd11b'))) }) === null);
    const staleStore = createPlyHooks(path.join(tmp, 'd11c'));
    await staleStore.setOwner({ place: null, value: { owner: 'native', disabled: [] } });
    await staleStore.view();
    await fs.writeFile(staleStore.file, '{ broken');
    t.ok('11: 丸ごと読めなくなっても、最後に読めた内容で確かにエージェント任せなら始める', await prepareHooksTurn({ agent: 'claude', cwd, ctx: ctx(staleStore) }) === null);
    const staleNoMemory = await thrown(() => prepareHooksTurn({ agent: 'claude', cwd, ctx: ctx(createPlyHooks(path.join(tmp, 'd11c'))) }));
    t.ok('11: 読めず、最後に読めた内容も無い → 担当が分からないので始めない', staleNoMemory?.code === 'UNREADABLE');
    t.ok('11: hooks を受け取れないエージェント（fake）は読めなくても止めない', await prepareHooksTurn({ agent: 'fake', cwd, ctx: ctx(createPlyHooks(path.join(tmp, 'd11c'))) }) === null);
    const stalePly = createPlyHooks(path.join(tmp, 'd11d'));
    await stalePly.setOwner({ place: null, value: { owner: 'ply', disabled: [] } });
    await fs.writeFile(stalePly.file, '{ broken');
    t.ok('11: 最後に読めた内容が Pleiad 担当なら、読めない間は始めない', (await thrown(() => prepareHooksTurn({ agent: 'claude', cwd, ctx: ctx(stalePly) })))?.code === 'UNREADABLE');

    // ---- 必須 7: agy の `__proto__` という名前も止める・Pleiad の名前との衝突は断る
    const agyPlan = planHooks({ hooks: [{ ...HOOK, id: 'h-000000000006', enabled: true }], owner: { owner: 'ply' }, agent: 'antigravity' });
    const file = agyHooksFile({ supplied: agyPlan.supplied, nativeNames: ['__proto__', 'ordinary'], adapterName: 'hook-adapter-x.mjs' });
    const json = JSON.parse(JSON.stringify(file));
    t.ok('7: `__proto__` も own property として { enabled: false } を書く', Object.hasOwn(json, '__proto__') && json.__proto__?.enabled === false && json.ordinary.enabled === false, JSON.stringify(file));
    const collide = await thrown(() => agyHooksFile({ supplied: agyPlan.supplied, nativeNames: ['pleiad-h-000000000006'], adapterName: 'x.mjs' }));
    t.ok('7: ネイティブの名前が pleiad-<id> とぶつかる → 断る（止められないため）', collide?.code === 'AGY_NAME_COLLISION');

    // ---- 必須 8: 登録の編集で、保存済みのエージェント別 matcher を消さない
    const saved = { matchers: { codex: 'shell_command' } };
    t.ok('8: 何も変えずに保存すると保存済みの matcher が残る', JSON.stringify(sheetMatchers({ overrides: initialOverrides(saved), agent: 'claude', targets: ['claude', 'codex'] })) === '{"codex":"shell_command"}');
    t.ok('8: 渡さない先にした分・コマンドの形と同じエージェントの分だけ外す', JSON.stringify(sheetMatchers({ overrides: initialOverrides(saved), agent: 'claude', targets: ['claude'] })) === '{}'
      && JSON.stringify(sheetMatchers({ overrides: initialOverrides(saved), agent: 'codex', targets: ['codex'] })) === '{}');

    // ---- 必須 9: 「Hooks を全体の設定に戻す」で担当が変わるなら確認を通す
    t.ok('9: 全体は native・この場所は ply → 戻すと native になるので確認（戻す向き）', resetPlan({ defaults: { value: { owner: 'native' } }, place: { value: { owner: 'ply' }, override: true, inherited: null } }).confirm === 'native');
    t.ok('9: 全体は ply・この場所は native → 確認（そろえる向き）', resetPlan({ defaults: { value: { owner: 'ply' } }, place: { value: { owner: 'native' }, override: true, inherited: { value: { owner: 'ply' } } } }).confirm === 'ply');
    t.ok('9: 担当が変わらなければそのまま戻す', resetPlan({ defaults: { value: { owner: 'ply' } }, place: { value: { owner: 'ply', disabled: ['h-000000000001'] }, override: true, inherited: { value: { owner: 'ply' } } } }).direct === true);
    const inherited = await createPlyHooks(path.join(tmp, 'd9'));
    await inherited.setOwner({ place: null, value: { owner: 'native', disabled: [] } });
    await inherited.setOwner({ place: cwd, value: { owner: 'ply', disabled: [] } });
    const v9 = await inherited.view(cwd);
    t.ok('9: 画面の形に「上書きを外したときの担当」（inherited）を載せる', v9.place.override && v9.place.inherited?.value.owner === 'native');

    // ---- 必須 5 ・推奨 10: 確認票（元の定義の hash）と、取り込み済みの同一判定
    const row = { id: 'r1', agent: 'claude', scope: 'user', event: 'PreToolUse', path: '/u/settings.json' };
    const a = importCandidate({ row, handler: { type: 'command', command: 'echo reviewed' }, matcher: 'Bash' });
    const b = importCandidate({ row, handler: { type: 'command', command: 'echo unreviewed' }, matcher: 'Bash' });
    t.ok('5: 元の定義が変われば確認票の digest も変わる（保存の直前に照合する材料）', a.digest !== b.digest && a.value.importedFrom.digest === a.digest);
    const writeRow = { ...row, id: 'r2', matcher: 'Write' };
    const bash = importCandidate({ row: { ...row, matcher: 'Bash' }, handler: { type: 'command', command: 'node guard.mjs' }, matcher: 'Bash' });
    const preview10 = unifyPreview({ report: { entries: [{ ...row, matcher: 'Bash' }, writeRow], files: [] },
      raws: [{ row: { ...row, matcher: 'Bash' }, handler: { type: 'command', command: 'node guard.mjs' }, matcher: 'Bash' }, { row: writeRow, handler: { type: 'command', command: 'node guard.mjs' }, matcher: 'Write' }],
      hooks: [{ ...bash.value, id: 'h-000000000007' }] });
    t.ok('10: 同じコマンドでも matcher の違う定義は「取り込み済み」にしない', preview10.stops.find(s => s.id === 'r1').reasons.includes('already') && preview10.stops.find(s => s.id === 'r2').importable);
    const off10 = unifyPreview({ report: { entries: [{ ...row, matcher: 'Bash' }], files: [] }, raws: [{ row: { ...row, matcher: 'Bash' }, handler: { type: 'command', command: 'node guard.mjs' }, matcher: 'Bash' }],
      hooks: [{ ...bash.value, id: 'h-000000000007', enabled: false }] });
    t.ok('10: 取り込み済みの登録がオフなら、そう知らせる（再利用と区別）', off10.stops[0].reasons.includes('alreadyOff'));
    const dedupe = createPlyHooks(path.join(tmp, 'd10'));
    const once = await dedupe.setOwner({ place: null, value: { owner: 'ply', disabled: [] }, add: [bash.value, bash.value] });
    const again = await dedupe.setOwner({ place: null, value: { owner: 'ply', disabled: [] }, add: [bash.value] });
    t.ok('10: 同じ出どころ・同じ定義は、重ねて送っても再送しても 1 件だけ', once.added.length === 1 && again.added.length === 0 && again.hooks.length === 1);
    const stale5 = await thrown(() => dedupe.setOwner({ place: null, value: { owner: 'native', disabled: [] }, expect: 'old-revision' }));
    t.ok('5: 確認した版（revision）と今の版が違えば保存しない', stale5?.code === 'CHANGED');

    // ---- 推奨 12: 一時ファイルを作るときから 0600
    const calls = [];
    const spyIo = { writeFile: async (p, d, o) => { calls.push(o); return fs.writeFile(p, d, o); }, rename: fs.rename, rm: fs.rm };
    await writeAtomic(path.join(tmp, 'mode.json'), '{}', { io: spyIo, mode: 0o600 });
    t.ok('12: writeAtomic は一時ファイルを mode 付きで作る', calls[0]?.mode === 0o600 && calls[0]?.flag === 'wx');
    if (process.platform !== 'win32') t.ok('12: 保存した hooks.json は 0600', ((await fs.stat(dedupe.file)).mode & 0o777) === 0o600);

    // ---- 推奨 13: runs.jsonl は最後の改行までだけ読み進め、上限ずつ読む・入れ替える
    const runs = path.join(tmp, 'runs.jsonl');
    await fs.writeFile(runs, '{"runId":"r1","phase":"started"}\n{"runId":"r2","phase":');
    const r1 = await readAgyRuns(runs, 0);
    await fs.appendFile(runs, '"started"}\n');
    const r2 = await readAgyRuns(runs, r1.offset);
    t.ok('13: 書きかけの行は読み進めず、続きが書かれてから読む（行を失わない）', r1.runs.length === 1 && r2.runs.length === 1 && r2.runs[0].runId === 'r2');
    const small = await readAgyRuns(runs, 0, { chunk: 40 });
    t.ok('13: 一度に読むのは上限まで（残りは more）', small.runs.length === 1 && small.more === true);
    const rot = await rotateAgyRuns(runs, 10_000_000, { limit: 1024 });
    t.ok('13: 読み終えた分が大きくなったら入れ替える', rot?.old === `${runs}.1` && !(await fs.stat(runs).then(() => true, () => false)));

    // ---- 推奨 14: 中断済みならコマンドを起動しない・途中の中断を子へ伝える
    let started = 0;
    const cb = claudeHookCallbacks({ cwd: tmp, supplied: [{ hook: { id: 'h-000000000008', name: 'g', agent: 'claude', command: 'x' }, d: { event: 'PreToolUse', matcher: 'Bash', adapter: false } }] },
      { onRun: r => recs.push(r), run: async () => { started++; return { code: 0 }; } });
    const recs = [];
    const aborted = new AbortController(); aborted.abort();
    await cb.PreToolUse[0].hooks[0]({ cwd: tmp }, 'u', { signal: aborted.signal });
    t.ok('14: 中断済みならコマンドを起動せず、記録は cancelled で閉じる', started === 0 && recs.at(-1)?.phase === 'response' && recs.at(-1).outcome === 'cancelled');
    const ac = new AbortController();
    const t0 = Date.now();
    const slow = runCommand(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, { input: {}, cwd: tmp, env: {}, timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const res14 = await slow;
    t.ok('14: 途中で中断すると子プロセスを止めて返る（timeout まで待たない）', res14.aborted === true && Date.now() - t0 < 10_000, `${Date.now() - t0}ms`);

    // ---- 推奨 15: 元の設定で動いていない定義は「止まる」に並べず、取り込むならオフ
    const offRow = { id: 'a1', agent: 'antigravity', scope: 'user', event: 'PreToolUse', path: '/g/hooks.json', name: 'audit', enabled: false };
    const untrusted = { id: 'c1', agent: 'codex', scope: 'user', event: 'Stop', path: '/c/hooks.json', trust: { status: 'untrusted', enabled: true } };
    const p15 = unifyPreview({ report: { entries: [offRow, untrusted], files: [] },
      raws: [{ row: offRow, handler: { type: 'command', command: 'node a.mjs' }, matcher: 'run_command' }, { row: untrusted, handler: { type: 'command', command: 'echo s' }, matcher: null }] });
    t.ok('15: agy の enabled:false・Codex の未審査は「元の設定で動いていないもの」', p15.stops.length === 0 && p15.inactive.length === 2 && p15.inactive.every(s => s.wasOff && s.importable)
      && p15.inactive.find(s => s.id === 'c1').trust.status === 'untrusted');
    t.ok('15: 取り込むとオフの登録になる', importCandidate({ row: offRow, handler: { type: 'command', command: 'node a.mjs' }, matcher: 'run_command' }).value.enabled === false);

    // ---- 推奨 16: プローブは同じ表を分け合い、失敗を短く覚え、新しく使った順に残す
    let spawns = 0, fail = false, now = 1000;
    const spawn = () => ({ request: async () => { spawns++; await new Promise(r => setTimeout(r, 20)); if (fail) throw new Error('down'); return { data: [{ hooks: [] }] }; }, stop() {} });
    const table = { PreToolUse: [{ hooks: [{ type: 'command', command: `echo ${Math.random()}` }] }] };
    await Promise.all([probeHookHashes(table, cwd, { spawn, now: () => now }), probeHookHashes(table, cwd, { spawn, now: () => now })]);
    t.ok('16: 同じ表の同時の要求は 1 本のプローブを分け合う', spawns === 1);
    fail = true;
    const table2 = { Stop: [{ hooks: [{ type: 'command', command: `echo ${Math.random()}` }] }] };
    await probeHookHashes(table2, cwd, { spawn, now: () => now }).catch(() => {});
    await probeHookHashes(table2, cwd, { spawn, now: () => now }).catch(() => {});
    const afterFail = spawns;
    now += 31_000;
    await probeHookHashes(table2, cwd, { spawn, now: () => now }).catch(() => {});
    t.ok('16: 失敗は 30 秒のあいだ覚えて起こし直さず、過ぎたらもう一度試す', afterFail === 2 && spawns === 3);

    // ---- 推奨 17: 取り込む行を変えたら確認のチェックを戻す
    const s0 = { picked: new Map(), ack: true };
    const s1 = pickChange(s0, { id: 'x', digest: 'd' });
    t.ok('17: 取り込みを足すと確認のチェックが外れる（digest も持つ）', s1.ack === false && s1.picked.get('x') === 'd' && pickChange({ ...s1, ack: true }, { id: 'x' }).ack === false);

    // ---- 任意: Claude の出どころの分からないネイティブの発火を漏れと断定しない
    const record = { owner: 'ply', stopped: [{ event: 'PreToolUse', matcher: 'Bash' }] };
    t.ok('任意: 止めた定義と同じイベント・matcher の Claude の発火は漏れ', classifyNativeRun({ record, backend: 'claude', name: 'PreToolUse:Bash', event: 'PreToolUse' }).leak === true);
    const managed = classifyNativeRun({ record, backend: 'claude', name: 'Stop', event: 'Stop' });
    t.ok('任意: 結べない Claude の発火（管理者の hooks など）は出どころ未確認', managed.leak === false && managed.unknownNative === true);
    t.ok('任意: Codex は source の leak のまま・Pleiad の分は漏れではない', classifyNativeRun({ record, backend: 'codex', leak: true }).leak === true
      && classifyNativeRun({ record, backend: 'claude', pleiad: true, name: 'PreToolUse:Bash', event: 'PreToolUse' }).leak === false);
    t.ok('（確認票の hash は出どころ・matcher・handler 全体で決まる）', definitionDigest({ row, handler: { command: 'a' }, matcher: 'Bash' }) !== definitionDigest({ row, handler: { command: 'a' }, matcher: 'Write' }));
  } finally {
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-hooks-review-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
