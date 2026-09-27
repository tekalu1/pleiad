// 「Pleiad がそろえる」の組み立て（ADR 0049、docs/context-runtime.md「Hooks」）。純粋な関数だけを置く（ファイルもプロセスも触らない）。
//   Claude Code: query() の hooks コールバックで Pleiad の登録を渡し、ネイティブはフラグ設定の disableAllHooks で止める
//   Codex:       thread/start・thread/resume の config に hooks（登録）と hooks.state（自分の定義に trusted_hash、ユーザー・プロジェクトの key に enabled:false）
//   Antigravity: Pleiad の一時の置き場（--add-dir）の .agents/hooks.json に、登録（pleiad-<id>、アダプター越し）と、ネイティブの名前ごとの { enabled: false }
// 変換（イベント・matcher・入出力）は第 2 段の core/hooks-copy.mjs と core/hook-adapter.mjs をそのまま使う。
import { HOOK_AGENTS, HOOK_EVENTS } from './hooks-config.mjs';
import { convertHook, ADAPTER_MARGIN, adapterCommand, defaultTimeout } from './hooks-copy.mjs';

// Claude の SDK のコールバックで渡せないイベント。SessionStart はコールバックが呼ばれない（実機で確認。2026-09-28、Agent SDK 0.3.258）。
// Setup は CLI の --init / --maintenance のときだけで、Pleiad の会話では起きない
export const CLAUDE_CALLBACK_UNSUPPORTED = ['SessionStart', 'Setup'];
// Antigravity のツールのイベント（matcher group を持つ）
const AGY_TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// Codex の hooks の state で止める出どころ（hooks/list の source）。プラグイン・管理者の定義は止めない（ADR 0045）
export const CODEX_STOP_SOURCES = new Set(['user', 'project']);
export const AGY_NAME_PREFIX = 'pleiad-';

/**
 * 1 件の登録を、あるエージェントへ渡せる形にする（純粋）。登録が対象にしていなければ null。
 * 返す: { status: ok|blocked, reasons: [{ code, params }], warnings, event, matcher, adapter（入出力のアダプターを挟むか）, innerTimeout, timeout, async }
 *   同じエージェントの形のコマンド（hook.agent === to）はそのまま。ただし Antigravity はいつもアダプター越し（作業フォルダーを直し、発火を記録するため）
 */
export function deliverable(hook, to, { platform = process.platform } = {}) {
  if (!hook?.targets?.includes(to)) return null;
  const reasons = [];
  const chosen = hook.matchers?.[to];
  let d;
  if (hook.agent === to) {
    if (!HOOK_EVENTS[to].includes(hook.event)) reasons.push({ code: 'event', params: { event: hook.event } });
    const own = hook.timeout ?? defaultTimeout(to, hook.event);
    const adapter = to === 'antigravity';
    const inner = adapter ? Math.min(own, 86400 - ADAPTER_MARGIN) : null;
    d = { event: hook.event, matcher: to === 'antigravity' && !AGY_TOOL_EVENTS.has(hook.event) ? null : (chosen ?? hook.matcher ?? ''),
      adapter, innerTimeout: inner, timeout: adapter ? inner + ADAPTER_MARGIN : hook.timeout, async: hook.async === true && to !== 'antigravity', warnings: [] };
    if (hook.async && to === 'antigravity') reasons.push({ code: 'asyncAgy' });
  } else {
    const conv = convertHook({ agent: hook.agent, event: hook.event, matcher: hook.matcher, handler: { type: 'command', command: hook.command,
      ...(hook.timeout ? { timeout: hook.timeout } : {}), ...(hook.async ? { async: true } : {}) } }, to, { platform, matcher: chosen });
    for (const r of conv.reasons) reasons.push({ code: r.code, params: r.params });
    // Antigravity へはいつもアダプター（第 2 段と同じ）。Claude Code ↔ Codex は第 2 段の規則どおり PreToolUse だけ
    d = { event: conv.event, matcher: conv.matcher, adapter: conv.adapter, innerTimeout: conv.innerTimeout, timeout: conv.timeout, async: conv.async === true, warnings: conv.warnings };
  }
  if (to === 'claude' && CLAUDE_CALLBACK_UNSUPPORTED.includes(d.event)) reasons.push({ code: 'claudeCallback', params: { event: d.event } });
  return { status: reasons.length ? 'blocked' : 'ok', reasons, ...d };
}

/**
 * その会話（エージェント agent・場所の担当 owner）に渡す登録を分ける。
 * 戻り: { supplied: [{ hook, d }], unsupported: [{ hook, reasons }], skipped: [{ hook, reason: off|disabledHere }] }。対象でない登録は入れない
 */
export function planHooks({ hooks = [], owner, agent, platform = process.platform }) {
  const out = { supplied: [], unsupported: [], skipped: [] };
  const here = new Set(owner?.disabled ?? []);
  for (const hook of hooks) {
    const d = deliverable(hook, agent, { platform });
    if (!d) continue;
    if (!hook.enabled) { out.skipped.push({ hook, reason: 'off' }); continue; }
    if (here.has(hook.id)) { out.skipped.push({ hook, reason: 'disabledHere' }); continue; }
    if (d.status !== 'ok') { out.unsupported.push({ hook, reasons: d.reasons }); continue; }
    out.supplied.push({ hook, d });
  }
  return out;
}

/** 渡すコマンド（Codex・Antigravity）。アダプターを挟むなら node <アダプター> <元> <先> <イベント> <秒> <base64url> [<登録の id>] */
export function suppliedCommand({ hook, d }, to, { adapterPath, node = 'node', unquoted = false, recordId = false }) {
  if (!d.adapter) return hook.command;
  const cmd = adapterCommand({ adapterPath, from: hook.agent, to, event: d.event, innerTimeout: d.innerTimeout, command: hook.command, node, unquoted });
  return recordId ? `${cmd} ${hook.id}` : cmd;
}

/** Codex の hooks の表（hooks.json と同じ形）。登録 1 件を 1 つの group にする。index は group の位置 → 登録の id */
export function codexHooksTable(supplied, { adapterPath, node }) {
  const table = {}, index = [];
  for (const s of supplied) {
    const list = table[s.d.event] ??= [];
    index.push({ event: s.d.event, group: list.length, id: s.hook.id });
    list.push({ ...(s.d.matcher ? { matcher: s.d.matcher } : {}), hooks: [{ type: 'command', command: suppliedCommand(s, 'codex', { adapterPath, node }),
      ...(s.d.timeout ? { timeout: s.d.timeout } : {}), ...(s.d.async ? { async: true } : {}) }] });
  }
  return { table, index };
}

const snake = e => e.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
/**
 * Codex の hooks.state。probe は同じ表を起動の -c で渡した app-server の hooks/list（source: sessionFlags の定義の currentHash）、
 * list はその会話の app-server の hooks/list（ネイティブの定義）。
 * 戻り: { state, stopped（止めるネイティブ）, kept（止めない出どころ: プラグイン・管理者）, untrusted（hash が取れなかった自分の定義の数） }
 */
export function codexHooksState({ table, probe = [], list = [] }) {
  const state = {};
  const flags = probe.flatMap(d => d?.hooks ?? []).filter(h => h?.source === 'sessionFlags' && h.key && h.currentHash);
  let expected = 0;
  for (const [event, groups] of Object.entries(table)) groups.forEach((g, gi) => g.hooks.forEach((_, hi) => {
    expected++;
    const hit = flags.find(h => new RegExp(`:${snake(event)}:${gi}:${hi}$`).test(h.key));
    if (hit) state[hit.key] = { trusted_hash: hit.currentHash };
  }));
  const stopped = [], kept = [];
  for (const h of list.flatMap(d => d?.hooks ?? [])) {
    if (!h?.key || h.source === 'sessionFlags') continue;
    if (CODEX_STOP_SOURCES.has(h.source)) { state[h.key] = { ...(state[h.key] ?? {}), enabled: false }; stopped.push(h); }
    else kept.push(h);
  }
  return { state, stopped, kept, untrusted: expected - Object.values(state).filter(s => s.trusted_hash).length };
}

/**
 * Antigravity の一時の置き場の .agents/hooks.json。登録は pleiad-<id> の名前で、コマンドは置き場の .agents からの相対パスのアダプター越し
 * （置き場の hook は <置き場>/.agents で動く。アダプターが stdin の workspacePaths から利用者の作業場所に直す）。
 * nativeNames はユーザー・作業場所の定義の名前（止める）。プラグインの名前は入れない
 */
export function agyHooksFile({ supplied, nativeNames = [], adapterName }) {
  const out = {};
  const rel = `pleiad-hooks/${adapterName}`;
  for (const s of supplied) {
    const handler = { type: 'command', command: suppliedCommand(s, 'antigravity', { adapterPath: rel, unquoted: true, recordId: true }), timeout: s.d.timeout };
    const name = `${AGY_NAME_PREFIX}${s.hook.id}`;
    const spec = out[name] ??= {};
    spec[s.d.event] = AGY_TOOL_EVENTS.has(s.d.event) ? [{ matcher: s.d.matcher || '*', hooks: [handler] }] : [handler];
  }
  for (const n of nativeNames) if (!Object.hasOwn(out, n)) out[n] = { enabled: false };
  return out;
}

/** 一覧・記録に残す形（登録の要約。コマンドは呼ぶ側で伏せる） */
export const suppliedSummary = ({ hook, d }) => ({ id: hook.id, name: hook.name, from: hook.agent, event: d.event, matcher: d.matcher, adapter: d.adapter });
export const unsupportedSummary = ({ hook, reasons }) => ({ id: hook.id, name: hook.name, from: hook.agent, event: hook.event, reasons });

/**
 * Claude Code に同じ形のコマンド（hook.agent === 'claude'）をコールバックから動かしたときの答え。コマンドの hook の約束をそのまま再現する:
 * exit 0 は stdout の JSON（JSON でなければ、UserPromptSubmit・SessionStart では会話に足す文、ほかは何もしない）、
 * exit 2 は止める（理由は stderr）、ほかの exit・timeout・起動できないは止めない失敗（何もしない）
 */
export function claudeIdentityOutput(event, result) {
  const { code = 0, stdout = '', stderr = '', timedOut = false, startError = null, overflow = false } = result ?? {};
  if (timedOut || startError || overflow) return {};
  const reason = String(stderr).trim().split(/\r?\n/)[0]?.slice(0, 500) || 'Blocked by hook';
  if (code === 2) {
    if (event === 'PreToolUse') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    if (['PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PostToolBatch'].includes(event)) return { decision: 'block', reason };
    return {};
  }
  if (code !== 0) return {};
  const text = String(stdout).trim();
  if (!text) return {};
  try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  if (event === 'UserPromptSubmit') return { hookSpecificOutput: { hookEventName: event, additionalContext: text.slice(0, 10000) } };
  return {};
}

/** 担当の切り替えで止まる・動き続けるネイティブの行の区分（ADR 0049）。止め方の無い出どころは「動き続ける」 */
export function nativeFate(row) {
  if (row.agent === 'claude') return row.scope === 'managed' ? 'kept' : 'stopped';
  if (row.agent === 'codex') return ['user', 'project'].includes(row.scope) ? 'stopped' : 'kept';
  if (row.agent === 'antigravity') return ['user', 'project'].includes(row.scope) ? 'stopped' : 'kept';
  return 'kept';
}
export { HOOK_AGENTS };
