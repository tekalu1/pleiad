// 「Pleiad がそろえる」のサーバー側（ADR 0048、docs/context-runtime.md「Hooks」）。
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
/**
 * ネイティブの 1 行を Pleiad の登録にできるか。raw はサーバーが読み直した { row, handler, matcher, groupKeys }（hooksConfig.raw）。
 * 戻り: { importable, reasons: [code], value（normalizeHook に渡す形） }
 */
export function importCandidate({ row, handler, matcher, groupKeys = [] }) {
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
  const value = { name: String(name).slice(0, 80), agent: row.agent, event: row.event, matcher: typeof matcher === 'string' ? matcher : '', command,
    ...(Number.isInteger(handler?.timeout) && handler.timeout >= 1 && handler.timeout <= 86400 ? { timeout: handler.timeout } : {}),
    ...(handler?.async === true && row.agent !== 'antigravity' ? { async: true } : {}),
    targets: [row.agent], enabled: true,
    importedFrom: { agent: row.agent, scope: row.scope, path: row.path, event: row.event, ...(row.plugin ? { plugin: row.plugin } : {}) } };
  return { importable: !reasons.length, reasons, value };
}

/** 記録・画面に出す行の要約（コマンドは伏せ字の要約のまま） */
export const rowSummary = r => ({ id: r.id, agent: r.agent, scope: r.scope, event: r.event, matcher: r.matcher ?? null, command: r.command ?? '', path: r.path,
  ...(r.name ? { name: r.name } : {}), ...(r.plugin ? { plugin: r.plugin } : {}), ...(r.scope === 'skill' ? { skill: r.skill ?? null, unverified: true } : {}),
  ...(r.adapter ? { adapter: r.adapter } : {}) });

/**
 * 切り替えの確認（ADR 0031 に倣う。モック ④ の「そろえる」）。report は hooksConfig.scan（と Codex の hooks/list を重ねたもの）、raws はその行の元の定義。
 * direction: 'ply'（そろえる）| 'native'（エージェントに任せるへ戻す）
 * 戻り: { direction, stops（止まる・戻すと再開する）, keeps（止め方の無い出どころ。動き続ける）, registry（Pleiad の登録ごとの、エージェントごとの渡し方） }
 */
export function unifyPreview({ report, raws = [], hooks = [], owner = null, direction = 'ply', platform = process.platform }) {
  const byId = new Map(raws.map(r => [r.row.id, r]));
  const stops = [], keeps = [];
  for (const row of report.entries) {
    const fate = nativeFate(row);
    const summary = rowSummary(row);
    if (fate === 'kept') { keeps.push(summary); continue; }
    const raw = byId.get(row.id);
    const c = raw ? importCandidate(raw) : { importable: false, reasons: ['unreadable'] };
    // 同じ定義が既に取り込まれていれば、もう一度取り込まない
    const already = raw && hooks.some(h => h.importedFrom && h.agent === row.agent && h.event === row.event && h.command === c.value.command);
    stops.push({ ...summary, importable: c.importable && !already, reasons: already ? ['already'] : c.reasons });
  }
  const here = new Set(owner?.disabled ?? []);
  const registry = hooks.map(h => ({ id: h.id, name: h.name, agent: h.agent, event: h.event, matcher: h.matcher, command: maskText(h.command), enabled: h.enabled,
    disabledHere: here.has(h.id),
    targets: Object.fromEntries(HOOK_AGENTS.map(a => { const d = deliverable(h, a, { platform }); return [a, d ? { status: d.status, reasons: d.reasons, event: d.event, matcher: d.matcher, adapter: d.adapter } : null]; })) }));
  return { direction, stops, keeps, registry, files: (report.files ?? []).filter(f => f.status === 'error').map(f => ({ agent: f.agent, path: f.path, error: f.error })) };
}

/**
 * 1 ターンの準備。担当がエージェントなら null。
 * 戻り: { record（会話の記録 contextSession.hooks）, runtime（バックエンドへ渡すもの。渡せないエージェントなら null） }
 *   ctx: { plyHooks, hooksConfig, dataDir, findNode, platform, now }
 */
export async function prepareHooksTurn({ agent, cwd, ctx }) {
  const { plyHooks, hooksConfig, dataDir, findNode, platform = process.platform, now = new Date() } = ctx;
  const owner = await plyHooks.resolve(cwd);
  if (owner.owner !== 'ply') return null;
  const record = { owner: 'ply', at: now.toISOString(), agent, from: owner.from, revision: owner.revision, supplied: [], unsupported: [], skipped: [], stopped: [], kept: [], leaks: [] };
  if (!HOOK_AGENTS.includes(agent)) { record.unsupportedAgent = true; return { record, runtime: null }; }
  const plan = planHooks({ hooks: owner.hooks, owner, agent, platform });
  record.skipped = plan.skipped.map(({ hook, reason }) => ({ id: hook.id, name: hook.name, reason }));
  record.unsupported = plan.unsupported.map(unsupportedSummary);
  const report = await hooksConfig.scan({ cwd, agents: [agent] });
  const needsAdapter = plan.supplied.some(s => s.d.adapter);
  const adapter = needsAdapter || agent === 'antigravity' ? await adapterSource() : null;
  let supplied = plan.supplied;
  if (agent === 'claude') {
    // disableAllHooks は設定ファイル・プラグインの hooks をまとめて止める。Skill の hooks は止まる見込み（未確認）
    for (const r of report.entries) (nativeFate(r) === 'stopped' ? record.stopped : record.kept).push(rowSummary(r));
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
    // 止めるもの（ユーザー・プロジェクトの key）は Codex の hooks/list で、ターンの直前に作り直す（codex.mjs）
    return { record, runtime: { agent, cwd, supplied, table, index, record } };
  }
  // Antigravity: 名前で止める。ユーザー（~/.gemini）と作業場所（.agents/hooks.json）の名前。プラグインの名前は読まないので入れない
  const names = [...new Set(report.entries.filter(r => ['user', 'project'].includes(r.scope) && r.name).map(r => r.name))];
  for (const r of report.entries) (nativeFate(r) === 'stopped' ? record.stopped : record.kept).push(rowSummary(r));
  const file = agyHooksFile({ supplied, nativeNames: names, adapterName: adapter.name });
  record.supplied = supplied.map(s => ({ ...suppliedSummary(s), via: 'agyFile', name: `pleiad-${s.hook.id}` }));
  return { record, runtime: { agent, cwd, supplied, file, adapter, names, shape: digest(JSON.stringify(file)).slice(0, 16), record } };
}

/**
 * Claude Code の query() の hooks（コールバック）。同じ形のコマンドは子プロセスで動かしてコマンドの hook の約束どおりに答え、
 * 別のエージェントの形のコマンドは第 2 段のアダプターの処理（adapt）を同じプロセスで通す（コマンドは子プロセス）。
 * onRun は発火の記録（{ phase, hookId, name, event, outcome?, exitCode?, pleiad: true, id }）。コールバックは Pleiad の中で走るので、自分で記録する
 */
export function claudeHookCallbacks(runtime, { onRun = () => {}, run = runCommand } = {}) {
  const out = {};
  for (const { hook, d } of runtime?.supplied ?? []) {
    const timeout = d.adapter ? d.timeout : (hook.timeout ?? 600);
    const callback = async (input, _toolUseId, { signal } = {}) => {
      const hookId = crypto.randomUUID(), at = Date.now();
      onRun({ phase: 'started', hookId, name: hook.name, event: d.event, pleiad: true, id: hook.id });
      const job = (async () => {
        if (d.adapter) {
          const r = await adapt({ argv: [hook.agent, 'claude', d.event, String(d.innerTimeout), Buffer.from(hook.command, 'utf8').toString('base64url')],
            stdin: JSON.stringify(input), processCwd: runtime.cwd, selfPath: ADAPTER_FILE, run });
          let value = {};
          try { value = JSON.parse(r.stdout || '{}'); } catch {}
          return { value, outcome: 'success', exitCode: r.code };
        }
        const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : runtime.cwd;
        const result = await run(hook.command, { input, cwd, env: { __pleiadFrom: 'claude', CLAUDE_PROJECT_DIR: runtime.cwd }, timeoutMs: timeout * 1000 });
        return { value: claudeIdentityOutput(d.event, result), outcome: result.timedOut ? 'cancelled' : result.startError || (result.code ?? 0) !== 0 && result.code !== 2 ? 'error' : 'success',
          exitCode: Number.isInteger(result.code) ? result.code : null };
      })();
      const done = r => onRun({ phase: 'response', hookId, name: hook.name, event: d.event, pleiad: true, id: hook.id, outcome: r.outcome,
        ...(Number.isInteger(r.exitCode) ? { exitCode: r.exitCode } : {}), ms: Date.now() - at });
      // async の登録は待たない（ネイティブの async と同じく、答えは使わない）
      if (d.async) { job.then(done, () => done({ outcome: 'error' })); return {}; }
      if (signal?.aborted) return {};
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

/** agy のアダプターが書いた runs.jsonl を offset から読む。戻り: { runs, offset } */
export async function readAgyRuns(file, offset = 0) {
  let text;
  try { const buf = await fs.readFile(file); text = buf.subarray(offset).toString('utf8'); offset = buf.length; }
  catch { return { runs: [], offset }; }
  const runs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (v && typeof v.runId === 'string') runs.push(v); } catch {}
  }
  return { runs, offset };
}
