// 「Pleiad がそろえる」のサーバー側（ADR 0049、docs/context-runtime.md「Hooks」）。
//   - 切り替えの確認（unifyPreview）: 止まるネイティブの hooks・動き続けるもの・Pleiad の登録として動くもの・エージェントごとに渡せないもの
//   - 取り込み（importCandidate）: ネイティブの定義を Pleiad の登録の形にする（サーバーがファイルから読み直した元の定義だけを使う）
//   - ターンの準備（prepareHooksTurn）: その会話のエージェントへ渡す形（Claude のコールバック・Codex の表・agy の hooks.json）と会話の記録
//   - Claude のコールバック（claudeHookCallbacks）: 登録のコマンドを子プロセスで動かし、答えをコールバックの戻り値にする
// エージェントの設定ファイルは書き換えない。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { maskText } from './hooks-config.mjs';
import { t } from './i18n.mjs';
import { adapt, runCommand } from './hook-adapter.mjs';
import { CLAUDE_CALLBACK_UNSUPPORTED, planHooks, deliverable, codexHooksTable, agyHooksFile, suppliedSummary, unsupportedSummary, claudeIdentityOutput, nativeFate, HOOK_AGENTS } from './hooks-plan.mjs';
import { safeAdapterPath } from './hooks-copy.mjs';

const ADAPTER_FILE = fileURLToPath(new URL('./hook-adapter.mjs', import.meta.url));
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
let adapterCache = null;
/** アダプターの中身と名前（第 2 段と同じく、名前に中身の hash を入れる） */
export async function adapterSource() {
  adapterCache ??= fs.readFile(ADAPTER_FILE, 'utf8').then(text => ({ text, name: `hook-adapter-${digest(text.replace(/\r\n/g, '\n')).slice(0, 12)}.mjs` }));
  return adapterCache;
}
/** アダプターを置き場に書く（同じ名前で中身が同じならそのまま） */
export async function writeAdapterTo(dir, adapter) {
  const file = path.join(dir, adapter.name);
  await fs.mkdir(dir, { recursive: true });
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current?.replace(/\r\n/g, '\n') !== adapter.text.replace(/\r\n/g, '\n')) await fs.writeFile(file, adapter.text, { encoding: 'utf8', mode: 0o600 });
  return file;
}

// 取り込めない handler のキー（Pleiad が同じ意味で動かせないもの）
const IMPORT_KEYS = { claude: ['type', 'command', 'timeout', 'async', 'statusMessage'], codex: ['type', 'command', 'timeout', 'async', 'statusMessage'], antigravity: ['type', 'command', 'timeout'] };
const PLUGIN_ROOT = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g;
/** 元の定義の hash（確認票と「取り込み済み」の照合）。出どころ・イベント・matcher・handler 全体・group のほかのキーを含む */
export const definitionDigest = ({ row, handler, matcher, groupKeys = [] }) =>
  digest(JSON.stringify([row.agent, row.scope, row.path, row.event, row.name ?? null, matcher ?? null, handler ?? null, groupKeys])).slice(0, 24);

/**
 * ネイティブの 1 行を Pleiad の登録にできるか。raw はサーバーが読み直した { row, handler, matcher, groupKeys }（hooksConfig.raw）。
 * 戻り: { importable, reasons: [code], value（normalizeHook に渡す形）, digest（元の定義の hash）, wasOff }
 * 元の設定で動いていない定義（nativeFate が inactive）はオフの登録として取り込む（取り込むだけで動き出さないように）
 */
export function importCandidate(raw) {
  const { row, handler, matcher, groupKeys = [] } = raw;
  const reasons = [];
  if (row.scope === 'skill') reasons.push('skill');
  if (row.scope === 'managed' || row.kind === 'codex-list') reasons.push('readOnly');
  if ((typeof handler?.type === 'string' ? handler.type : 'command') !== 'command' || typeof handler?.command !== 'string' || !handler.command.trim()) reasons.push('notCommand');
  const extra = Object.keys(handler ?? {}).filter(k => !IMPORT_KEYS[row.agent]?.includes(k));
  if (extra.length) reasons.push('controlKeys');
  if (groupKeys.length) reasons.push('groupKeys');
  // 取り込んでも元のエージェント（Claude）へは渡せない（SessionStart・Setup はコールバックで渡せない）
  if (row.agent === 'claude' && CLAUDE_CALLBACK_UNSUPPORTED.includes(row.event)) reasons.push('claudeCallback');
  let command = typeof handler?.command === 'string' ? handler.command.trim() : '';
  if (row.scope === 'plugin') {
    // Pleiad が自分で動かすので、プラグインの置き場所の環境変数は取り込むときに実際のパスへ置き換える。データの置き場は用意できない
    if (/CLAUDE_PLUGIN_DATA/.test(command)) reasons.push('pluginData');
    command = command.replace(PLUGIN_ROOT, String(row.pluginRoot ?? '').replace(/\\/g, '/'));
  }
  if (command.length > 4000 || /[\r\n]/.test(command)) reasons.push('commandShape');
  const script = command.split(/\s+/).map(s => s.replace(/^["']|["']$/g, '')).find(s => /\.[A-Za-z0-9]{1,5}$/.test(s));
  const name = row.name ?? (script ? `${script.replace(/\\/g, '/').split('/').pop()}` : row.event);
  const wasOff = nativeFate(row) === 'inactive';
  const hash = definitionDigest(raw);
  const value = { name: String(name).slice(0, 80), agent: row.agent, event: row.event, matcher: typeof matcher === 'string' ? matcher : '', command,
    ...(Number.isInteger(handler?.timeout) && handler.timeout >= 1 && handler.timeout <= 86400 ? { timeout: handler.timeout } : {}),
    ...(handler?.async === true && row.agent !== 'antigravity' ? { async: true } : {}),
    targets: [row.agent], enabled: !wasOff,
    importedFrom: { agent: row.agent, scope: row.scope, path: row.path, event: row.event, digest: hash, ...(row.plugin ? { plugin: row.plugin } : {}) } };
  return { importable: !reasons.length, reasons, value, digest: hash, wasOff };
}

/** 記録・画面に出す行の要約（コマンドは伏せ字の要約のまま）。元の設定での状態（無効・同じ名前で停止・信頼状態）も落とさない */
export const rowSummary = r => ({ id: r.id, agent: r.agent, scope: r.scope, event: r.event, matcher: r.matcher ?? null, command: r.command ?? '', path: r.path,
  ...(r.name ? { name: r.name } : {}), ...(r.plugin ? { plugin: r.plugin } : {}), ...(r.scope === 'skill' ? { skill: r.skill ?? null, unverified: true } : {}),
  ...(r.adapter ? { adapter: r.adapter } : {}), ...(r.enabled === false ? { enabled: false } : {}), ...(r.stoppedBySameName ? { stoppedBySameName: true } : {}),
  ...(r.trust ? { trust: { status: r.trust.status ?? null, enabled: r.trust.enabled !== false } } : {}) });

/**
 * 切り替えの確認（ADR 0031 に倣う。モック ④ の「そろえる」）。report は hooksConfig.scan（と Codex の hooks/list を重ねたもの）、raws はその行の元の定義。
 * direction: 'ply'（そろえる）| 'native'（エージェントに任せるへ戻す）
 * 戻り: { direction, stops（止まる・戻すと再開する）, inactive（元の設定で動いていない。止めても戻しても変わらない）, keeps（止め方の無い出どころ）,
 *         registry（Pleiad の登録ごとの、エージェントごとの渡し方）, files（読めなかったファイル）, incomplete（止める一覧を作れないエージェント） }
 * stops・inactive の行の digest は確認票（保存の直前にサーバーがファイルから読み直して照合する）
 */
export function unifyPreview({ report, raws = [], hooks = [], owner = null, direction = 'ply', platform = process.platform }) {
  const byId = new Map(raws.map(r => [r.row.id, r]));
  const stops = [], inactive = [], keeps = [];
  for (const row of report.entries) {
    const fate = nativeFate(row);
    const summary = rowSummary(row);
    if (fate === 'kept') { keeps.push(summary); continue; }
    const raw = byId.get(row.id);
    const c = raw ? importCandidate(raw) : { importable: false, reasons: ['unreadable'] };
    // 同じ出どころ・同じ定義（matcher・handler 全体を含む）を取り込み済みなら、その登録を使う（オフ・この場所で外しているならそう知らせる）
    const here = new Set(owner?.disabled ?? []);
    const existing = raw ? hooks.find(h => h.importedFrom?.digest === c.digest && h.importedFrom.path === row.path) : null;
    const reasons = existing ? [existing.enabled && !here.has(existing.id) ? 'already' : 'alreadyOff'] : c.reasons;
    const item = { ...summary, importable: c.importable && !existing, reasons, ...(c.digest ? { digest: c.digest } : {}), ...(c.wasOff ? { wasOff: true } : {}) };
    (fate === 'inactive' ? inactive : stops).push(item);
  }
  const here = new Set(owner?.disabled ?? []);
  const registry = hooks.map(h => ({ id: h.id, name: h.name, agent: h.agent, event: h.event, matcher: h.matcher, command: maskText(h.command), enabled: h.enabled,
    disabledHere: here.has(h.id),
    targets: Object.fromEntries(HOOK_AGENTS.map(a => { const d = deliverable(h, a, { platform }); return [a, d ? { status: d.status, reasons: d.reasons, event: d.event, matcher: d.matcher, adapter: d.adapter } : null]; })) }));
  const incomplete = [...new Set((report.files ?? []).filter(f => f.agent === 'antigravity' && (f.status === 'error' || f.partial)).map(f => f.agent))];
  return { direction, stops, inactive, keeps, registry, incomplete,
    files: (report.files ?? []).filter(f => f.status === 'error' || f.partial).map(f => ({ agent: f.agent, path: f.path, error: f.error ?? null, partial: Boolean(f.partial) })) };
}

/** ターンを始めない理由（Hooks を Pleiad がそろえる会話だけ）。画面・記録に出す文を持つ */
// i18n-dynamic: hooksUnify.
const refuse = (key, params = {}) => Object.assign(new Error(t(key, params)), { code: 'HOOKS_REFUSED' });

/**
 * 1 ターンの準備。担当がエージェントなら null（hooks.json が無い・エージェント任せなら、ここで何も読まない・止めない）。
 * 戻り: { record（会話の記録 contextSession.hooks）, runtime（バックエンドへ渡すもの。渡せないエージェントなら null） }
 * 次のときは投げる（ターンを始めない。止めるはずのネイティブが漏れる、または Pleiad のガードが消えるため）:
 *   担当が確かに分からない・担当が Pleiad なのに登録に壊れた部分がある（ply-hooks の resolveForTurn）、
 *   agy で止める一覧を作るファイルを読めない、agy でカスタムエージェント（Skills も Pleiad 担当）が hooks を止めてしまう、
 *   agy の名前が Pleiad の登録の名前とぶつかる
 *   ctx: { plyHooks, hooksConfig, dataDir, findNode, platform, now, context: { owners, delivered }（このターンのコンテキストの担当と、Pleiad が渡すか） }
 */
export async function prepareHooksTurn({ agent, cwd, ctx }) {
  const { plyHooks, hooksConfig, dataDir, findNode, platform = process.platform, now = new Date(), context = null } = ctx;
  // hooks を受け取れないエージェント（fake など）: 担当を読めなくても会話は止めない（渡すものが無い）。記録だけ残す
  if (!HOOK_AGENTS.includes(agent)) {
    const owner = await plyHooks.resolve(cwd).catch(() => null);
    if (owner?.owner !== 'ply') return null;
    return { record: { owner: 'ply', at: now.toISOString(), agent, from: owner.from, revision: owner.revision, unsupportedAgent: true, supplied: [], unsupported: [], skipped: [], stopped: [], kept: [], leaks: [] }, runtime: null };
  }
  const owner = await plyHooks.resolveForTurn(cwd);
  if (owner.owner !== 'ply') return null;
  const record = { owner: 'ply', at: now.toISOString(), agent, from: owner.from, revision: owner.revision, supplied: [], unsupported: [], skipped: [], stopped: [], kept: [], leaks: [], unknownNative: [] };
  // agy のカスタムエージェントは、Skills を Pleiad が担当すると inheritCustomizations: false になり、--add-dir の hooks まで止める
  // （実現性の報告 §3-2）。Pleiad の登録が動かないまま「渡した」ことになるので、この組み合わせは始めない
  if (agent === 'antigravity' && context?.delivered && context.owners?.skill === 'ply') throw refuse('hooksUnify.agySkillsConflict');
  const plan = planHooks({ hooks: owner.hooks, owner, agent, platform });
  record.skipped = plan.skipped.map(({ hook, reason }) => ({ id: hook.id, name: hook.name, reason }));
  record.unsupported = plan.unsupported.map(unsupportedSummary);
  const report = await hooksConfig.scan({ cwd, agents: [agent] });
  const needsAdapter = plan.supplied.some(s => s.d.adapter);
  const adapter = needsAdapter || agent === 'antigravity' ? await adapterSource() : null;
  let supplied = plan.supplied;
  const sort = r => (nativeFate(r) === 'kept' ? record.kept : record.stopped).push(rowSummary(r));
  if (agent === 'claude') {
    // disableAllHooks は設定ファイル・プラグインの hooks をまとめて止める（一覧に頼らない）。Skill の hooks は止まる見込み（未確認）
    for (const r of report.entries) sort(r);
    record.supplied = supplied.map(s => ({ ...suppliedSummary(s), via: 'callback' }));
    return { record, runtime: { agent, cwd, supplied, record } };
  }
  if (agent === 'codex') {
    // Codex が動かすコマンド。アダプターは Pleiad の置き場（<data>/hooks-runtime/）に置く。node は PATH のもの
    // （Codex は Pleiad と同じ PATH を引き継ぐ。Windows の Codex は PowerShell で動かすので、引用付きの実行ファイルを先頭に置けない）
    let adapterPath = null;
    const node = 'node';
    if (needsAdapter) {
      const found = await findNode();
      adapterPath = await writeAdapterTo(path.join(dataDir, 'hooks-runtime'), adapter);
      if (!found || !safeAdapterPath(adapterPath)) {
        const drop = supplied.filter(s => s.d.adapter);
        record.unsupported.push(...drop.map(s => unsupportedSummary({ hook: s.hook, reasons: [{ code: found ? 'adapterPath' : 'noNode' }] })));
        supplied = supplied.filter(s => !s.d.adapter);
      }
    }
    const { table, index } = codexHooksTable(supplied, { adapterPath, node });
    record.supplied = supplied.map(s => ({ ...suppliedSummary(s), via: 'threadConfig' }));
    // 止めるもの（ユーザー・プロジェクトの key）は Codex の hooks/list で、ターンの直前に作り直す（codex.mjs。一覧が欠けていれば始めない）
    return { record, runtime: { agent, cwd, supplied, table, index, record } };
  }
  // Antigravity: 名前で止める。ユーザー（~/.gemini）と作業場所（.agents/hooks.json）の名前。プラグインの名前は読まないので入れない。
  // 一覧を作るファイルを Pleiad が読めない（壊れている・作業場所の外を指すリンク・一部を読み飛ばした）と、agy だけが読める名前が止まらない
  const bad = (report.files ?? []).filter(f => f.agent === 'antigravity' && (f.status === 'error' || f.partial));
  if (bad.length) throw refuse('hooksUnify.agyStopListIncomplete', { path: bad[0].path, error: bad[0].error ?? '' });
  const names = [...new Set(report.entries.filter(r => ['user', 'project'].includes(r.scope) && typeof r.name === 'string').map(r => r.name))];
  for (const r of report.entries) sort(r);
  let file;
  try { file = agyHooksFile({ supplied, nativeNames: names, adapterName: adapter.name }); }
  catch (e) { if (e.code === 'AGY_NAME_COLLISION') throw refuse('hooksUnify.agyNameCollision', { name: e.name }); throw e; }
  record.supplied = supplied.map(s => ({ ...suppliedSummary(s), via: 'agyFile', name: `pleiad-${s.hook.id}` }));
  return { record, runtime: { agent, cwd, supplied, file, adapter, names, shape: digest(JSON.stringify(file)).slice(0, 16), record } };
}

/**
 * Claude Code の query() の hooks（コールバック）。同じ形のコマンドは子プロセスで動かしてコマンドの hook の約束どおりに答え、
 * 別のエージェントの形のコマンドは第 2 段のアダプターの処理（adapt）を同じプロセスで通す（コマンドは子プロセス）。
 * onRun は発火の記録（{ phase, hookId, name, event, outcome?, exitCode?, pleiad: true, id }）。コールバックは Pleiad の中で走るので、自分で記録する。
 * SDK の signal（会話の中断）は子プロセスへ伝え、中断済みなら起動しない（記録は cancelled で閉じる）。async の登録は答えを待たず、中断では止めない
 */
export function claudeHookCallbacks(runtime, { onRun = () => {}, run = runCommand } = {}) {
  const out = {};
  for (const { hook, d } of runtime?.supplied ?? []) {
    const timeout = d.adapter ? d.timeout : (hook.timeout ?? 600);
    const callback = async (input, _toolUseId, { signal } = {}) => {
      const hookId = crypto.randomUUID(), at = Date.now();
      onRun({ phase: 'started', hookId, name: hook.name, event: d.event, pleiad: true, id: hook.id });
      const done = r => onRun({ phase: 'response', hookId, name: hook.name, event: d.event, pleiad: true, id: hook.id, outcome: r.outcome,
        ...(Number.isInteger(r.exitCode) ? { exitCode: r.exitCode } : {}), ms: Date.now() - at });
      if (signal?.aborted && !d.async) { done({ outcome: 'cancelled' }); return {}; }
      const pass = d.async ? undefined : signal;
      const job = (async () => {
        if (d.adapter) {
          const r = await adapt({ argv: [hook.agent, 'claude', d.event, String(d.innerTimeout), Buffer.from(hook.command, 'utf8').toString('base64url')],
            stdin: JSON.stringify(input), processCwd: runtime.cwd, selfPath: ADAPTER_FILE, run, signal: pass });
          if (pass?.aborted) return { value: {}, outcome: 'cancelled' };
          let value = {};
          try { value = JSON.parse(r.stdout || '{}'); } catch {}
          return { value, outcome: 'success', exitCode: r.code };
        }
        const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : runtime.cwd;
        const result = await run(hook.command, { input, cwd, env: { __pleiadFrom: 'claude', CLAUDE_PROJECT_DIR: runtime.cwd }, timeoutMs: timeout * 1000, signal: pass });
        if (result.aborted) return { value: {}, outcome: 'cancelled' };
        return { value: claudeIdentityOutput(d.event, result), outcome: result.timedOut ? 'cancelled' : result.startError || (result.code ?? 0) !== 0 && result.code !== 2 ? 'error' : 'success',
          exitCode: Number.isInteger(result.code) ? result.code : null };
      })();
      // async の登録は待たない（ネイティブの async と同じく、答えは使わない）
      if (d.async) { job.then(done, () => done({ outcome: 'error' })); return {}; }
      try { const r = await job; done(r); return r.value; }
      catch { done({ outcome: 'error' }); return {}; }
    };
    (out[d.event] ??= []).push({ ...(d.matcher ? { matcher: d.matcher } : {}), timeout, hooks: [callback] });
  }
  return out;
}

/** 2 つの hooks（コールバック）の表を合わせる（Pleiad 自身の PreCompact / PostCompact と、登録の分） */
export function mergeCallbacks(a = {}, b = {}) {
  const out = { ...a };
  for (const [event, list] of Object.entries(b)) out[event] = [...(out[event] ?? []), ...list];
  return out;
}

const RUNS_CHUNK = 256 * 1024;
/**
 * agy のアダプターが書いた runs.jsonl を offset から読む（上限 RUNS_CHUNK。最後の改行までだけ読み進め、書きかけの行は次に回す）。
 * 戻り: { runs, offset, more（まだ読み残しがある） }
 */
export async function readAgyRuns(file, offset = 0, { chunk = RUNS_CHUNK } = {}) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch { return { runs: [], offset, more: false }; }
  try {
    const size = (await handle.stat()).size;
    if (size < offset) offset = 0;   // 入れ替えられた（rotateAgyRuns）。頭から読む
    const want = Math.min(chunk, size - offset);
    if (want <= 0) return { runs: [], offset, more: false };
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, offset);
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { runs: [], offset: bytesRead === chunk ? offset + bytesRead : offset, more: bytesRead === chunk };  // 1 行が上限より長いものは捨てる
    const runs = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const v = JSON.parse(line); if (v && typeof v.runId === 'string') runs.push(v); } catch {}
    }
    const next = offset + end + 1;
    return { runs, offset: next, more: next < size };
  } finally { await handle.close(); }
}
/**
 * 読み終えた runs.jsonl が大きくなったら入れ替える（runs.jsonl → runs.jsonl.1。前の .1 は捨てる）。入れ替えの間に書かれた行は .1 に残るので、
 * 呼ぶ側は次に .1 の続き（old の offset から）を読んでから新しいファイルを頭から読む。rename が一時的にできなければ何もしない
 */
export async function rotateAgyRuns(file, offset, { limit = 1024 * 1024 } = {}) {
  if (offset < limit) return null;
  try { await fs.rename(file, `${file}.1`); return { old: `${file}.1`, oldOffset: offset }; }
  catch { return null; }
}
