// Hooks を他のエージェントへ写すときの変換（docs/context-management.md「Hooks」の「他のエージェントへ写す」、ADR 0046）。
// 純粋な関数だけを置く（ファイルは読まない）。書き込みは core/hooks-config.mjs の copy。
//   イベント: Claude Code ↔ Codex は共通のイベントすべて、Antigravity とは PreToolUse・PostToolUse・Stop だけ。
//            対応が無いイベントは写さない（SessionStart を PreInvocation に読み替えるような代わりのイベントは使わない）
//   matcher: ツール名を対応表で置き換える。* と空は全件のまま。正規表現・知らない名前は自動で訳さず「確認が必要」
//   入出力: Antigravity との間と、Claude Code → Codex の PreToolUse は、入出力のアダプター（core/hook-adapter.mjs）を挟む。
//          ほかの Claude Code ↔ Codex は stdin の形がほぼ同じ（実機で確認。2026-09-27）なので、コマンドをそのまま写す
// 返す理由・警告はコード（画面が web/locales の hooks.copy.* で文にする）。
import { HOOK_EVENTS } from './hooks-config.mjs';

export const COPY_AGENTS = ['claude', 'codex', 'antigravity'];
const AGY_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
// 何も書かないときの timeout（秒）。Codex の SessionEnd は既定 1 秒
const DEFAULT_TIMEOUT = { claude: 600, codex: 600, antigravity: 30 };
export const defaultTimeout = (agent, event) => (agent === 'codex' && event === 'SessionEnd' ? 1 : DEFAULT_TIMEOUT[agent]);
// アダプターの外側の timeout に足す余裕（アダプターの起動と、元のコマンドを止めて答える分）
export const ADAPTER_MARGIN = 5;

/** 写した先のイベント。対応が無ければ null（代わりのイベントには読み替えない） */
export function copyEvent(from, to, event) {
  if (from === to || !HOOK_EVENTS[from]?.includes(event)) return null;
  if (from === 'antigravity' || to === 'antigravity') return AGY_EVENTS.includes(event) && HOOK_EVENTS[to].includes(event) ? event : null;
  return HOOK_EVENTS[to]?.includes(event) ? event : null;
}

/** 入出力のアダプターを挟むか。Antigravity との間はいつも。Claude Code → Codex は PreToolUse だけ（ask を Codex が扱えないため） */
export const needsAdapter = (from, to, event) => from === 'antigravity' || to === 'antigravity' || (from === 'claude' && to === 'codex' && event === 'PreToolUse');

// ツール名の対応。1 行が 1 つの意味。exact は名前と入力の意味が一致するもの（シェル）。ほかは近い意味なので警告を付ける。
// input: 入力（tool_input / toolCall.args）の形をアダプターで直せるか（Codex の apply_patch はパッチの本文なので Antigravity の引数と相互に直せない）
const TOOLS = [
  { id: 'shell', exact: true, claude: ['Bash'], codex: ['Bash'], antigravity: ['run_command'] },
  { id: 'write', claude: ['Write'], codex: ['apply_patch'], antigravity: ['write_to_file'] },
  { id: 'edit', claude: ['Edit'], codex: ['apply_patch'], antigravity: ['replace_file_content', 'multi_replace_file_content'] },
  { id: 'read', claude: ['Read'], codex: [], antigravity: ['view_file'] },
  { id: 'grep', claude: ['Grep'], codex: [], antigravity: ['grep_search'] },
  { id: 'glob', claude: ['Glob'], codex: [], antigravity: ['find_by_name'] },
  { id: 'fetch', claude: ['WebFetch'], codex: [], antigravity: ['read_url_content'] },
  { id: 'search', claude: ['WebSearch'], codex: [], antigravity: ['search_web'] },
];
// Codex は Edit / Write を apply_patch の別名として受ける
const CODEX_ALIASES = { Edit: 'apply_patch', Write: 'apply_patch' };
const PLAIN = /^[A-Za-z0-9_]+$/;
const MCP = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

/**
 * matcher の置き換え。返す status:
 *   all（* と空。全件のまま）/ mapped（名前を置き換えた）/ same（ツール以外のイベント。そのまま）/ none（Antigravity の非ツールのイベント。matcher を持たない）/
 *   review（正規表現・知らない名前・一部だけ対応が無い。利用者が写す先の matcher を確かめて入れる）/ blocked（どの名前にも対応が無い）
 * warnings はコード（toolMeaning・toolInput・mcpServer・allTools・subagentMatcher）
 */
export function mapMatcher(from, to, event, matcher) {
  const m = typeof matcher === 'string' ? matcher.trim() : '';
  const warnings = [];
  if (to === 'antigravity' && !['PreToolUse', 'PostToolUse'].includes(event)) return { status: 'none', matcher: null, warnings };
  if (!TOOL_EVENTS.has(event)) {
    if (from === 'antigravity') return { status: 'same', matcher: '', warnings };
    if (m && ['SubagentStart', 'SubagentStop'].includes(event)) warnings.push({ code: 'subagentMatcher' });
    return { status: 'same', matcher: m, warnings };
  }
  if (!m || m === '*') {
    if (needsAdapter(from, to, event)) warnings.push({ code: 'allTools' });
    return { status: 'all', matcher: m || (to === 'antigravity' ? '*' : ''), warnings };
  }
  // Claude Code は | と , で区切った英数字の名前を完全一致の選択肢として扱う。ほかの記号があれば正規表現
  const parts = m.split(from === 'claude' ? /[|,]/ : /\|/).map(s => s.trim());
  if (parts.some(p => !PLAIN.test(p) && !MCP.test(p))) return { status: 'review', matcher: '', warnings, reason: { code: 'matcherRegex', params: { matcher: m } } };
  const out = [], missing = [], unknown = [];
  const loose = new Set(), inputs = new Set();
  for (const raw of parts) {
    if (MCP.test(raw)) {
      if (to === 'antigravity' || from === 'antigravity') { missing.push(raw); continue; }
      out.push(raw); if (!warnings.some(w => w.code === 'mcpServer')) warnings.push({ code: 'mcpServer' });
      continue;
    }
    const name = from === 'codex' ? CODEX_ALIASES[raw] ?? raw : raw;
    const rows = TOOLS.filter(r => r[from].includes(name));
    if (!rows.length) { unknown.push(raw); continue; }
    const names = [...new Set(rows.flatMap(r => r[to]))];
    if (!names.length) { missing.push(raw); continue; }
    out.push(...names);
    for (const r of rows) {
      if (!r.exact) loose.add(`${raw} → ${names.join('|')}`);
      // Codex の apply_patch はパッチの本文を渡す。Claude Code の Edit / Write とは入力の形が違い、Antigravity の引数からは作れない
      if ((r.id === 'write' || r.id === 'edit') && (from === 'codex' || to === 'codex')) inputs.add(raw);
    }
  }
  const matcherOut = [...new Set(out)].join('|');
  if (loose.size) warnings.push({ code: 'toolMeaning', params: { pairs: [...loose].join(', ') } });
  if (inputs.size && (from === 'antigravity' || to === 'antigravity')) return { status: 'blocked', matcher: '', warnings, reason: { code: 'patchInput' } };
  if (inputs.size) warnings.push({ code: 'toolInput', params: { tools: [...inputs].join(', ') } });
  if (unknown.length) return { status: 'review', matcher: matcherOut, warnings, reason: { code: 'matcherUnknown', params: { tools: unknown.join(', ') } } };
  if (missing.length && !out.length) return { status: 'blocked', matcher: '', warnings, reason: { code: 'noTool', params: { tools: missing.join(', ') } } };
  if (missing.length) return { status: 'review', matcher: matcherOut, warnings, reason: { code: 'partialTools', params: { tools: missing.join(', ') } } };
  return { status: 'mapped', matcher: matcherOut, warnings };
}

// handler のキー。写せるもの・落とすもの（警告）・写せないもの
const HANDLER_KEYS = { claude: ['type', 'command', 'timeout', 'async', 'statusMessage'], codex: ['type', 'command', 'timeout', 'async', 'statusMessage'],
  antigravity: ['type', 'command', 'timeout'] };
// 実行の条件や止め方を変えるキー。落とすと実行の範囲・意味が変わるので写さない
const CONTROL_KEYS = ['if', 'asyncRewake', 'once', 'commandWindows', 'command_windows', 'args', 'shell'];

/**
 * 1 つの handler を写す先の形に直す（純粋）。
 * source: { agent, event, matcher, handler（元の値。伏せ字でない）, groupKeys?, name? }、to: 写す先、options: { platform, matcher?（利用者が入れた写す先の matcher） }
 * 返す: { status: ready|review|blocked, reasons: [{ code, params }], warnings, event, matcher, matcherStatus, adapter（挟むか）,
 *         command（元のコマンド）, timeout（写す先に書く値。undefined は書かない）, innerTimeout（アダプターが元のコマンドに使う秒）, async, statusMessage }
 */
export function convertHook(source, to, { platform = process.platform, matcher: chosen } = {}) {
  const from = source.agent, h = source.handler ?? {};
  const reasons = [], warnings = [];
  const block = (code, params) => reasons.push({ code, params, blocks: true });
  const event = copyEvent(from, to, source.event);
  if (from === to) block('sameAgent');
  if (!event) block('event', { event: source.event });
  const type = typeof h.type === 'string' ? h.type : 'command';
  if (type !== 'command') block('type', { type });
  if (typeof h.command !== 'string' || !h.command.trim()) block(Array.isArray(h.args) ? 'execForm' : 'noCommand');
  const control = CONTROL_KEYS.filter(k => Object.hasOwn(h, k) && !(k === 'args' && typeof h.command === 'string'));
  if (control.length) block('controlKeys', { keys: control.join(', ') });
  const known = new Set([...HANDLER_KEYS[from] ?? [], ...CONTROL_KEYS]);
  const unknown = Object.keys(h).filter(k => !known.has(k));
  if (unknown.length) block('unknownKeys', { keys: unknown.join(', ') });
  if (source.groupKeys?.length) block('groupKeys', { keys: source.groupKeys.join(', ') });
  const adapter = event ? needsAdapter(from, to, event) : false;
  if (h.async === true && to === 'antigravity') block('asyncAgy');
  const command = typeof h.command === 'string' ? h.command.trim() : '';
  // 写した定義（アダプター越し）をもう一度写すと、アダプターを重ねることになる。元の定義から写す
  if (parseAdapterCommand(command)) block('alreadyCopy');
  // コマンドが元のエージェントの環境変数を使う。写す先では設定されない（アダプターも Claude Code の CLAUDE_PROJECT_DIR しか用意しない）
  if (/CLAUDE_PLUGIN_(ROOT|DATA)|\bPLUGIN_(ROOT|DATA)\b|CLAUDE_ENV_FILE/.test(command)) block('pluginEnv');
  else if (/CLAUDE_PROJECT_DIR/.test(command) && from === 'claude' && !adapter) block('claudeEnv');
  // アダプターは元のコマンドを OS の既定のシェル（Windows は cmd.exe）で動かす。$VAR・~・単引用符は解釈が違う
  if (adapter && platform === 'win32' && /[$~`']/.test(command)) warnings.push({ code: 'shellSyntax' });
  if (!adapter && from !== 'antigravity' && platform === 'win32' && /[$~]/.test(command)) warnings.push({ code: 'shellSyntaxDirect' });

  // matcher
  let m = { status: 'same', matcher: source.matcher ?? '', warnings: [] };
  if (event) m = mapMatcher(from, to, event, source.matcher);
  warnings.push(...m.warnings);
  let matcher = m.matcher, matcherStatus = m.status;
  if (m.status === 'blocked') block(m.reason.code, m.reason.params);
  else if (m.status === 'review') {
    // 写す先の matcher を利用者が入れたら、それを使う（確かめた扱い）。入れるまでは選べない
    if (typeof chosen === 'string' && chosen.trim()) { matcher = chosen.trim(); matcherStatus = 'chosen'; warnings.push({ code: 'matcherChosen', params: m.reason.params }); }
    else reasons.push({ code: m.reason.code, params: m.reason.params, review: 'matcher' });
  }

  // timeout: 元のエージェントで効いていた秒数を保つ。アダプターを挟むなら、外側はその秒数に余裕を足す
  const srcDefault = event ? defaultTimeout(from, source.event) : DEFAULT_TIMEOUT[from];
  const explicit = Number.isInteger(h.timeout) && h.timeout >= 1 ? h.timeout : null;
  if (Object.hasOwn(h, 'timeout') && explicit === null) warnings.push({ code: 'timeoutOdd', params: { value: JSON.stringify(h.timeout) } });
  const effective = explicit ?? srcDefault;
  let timeout, innerTimeout = null;
  if (adapter) { innerTimeout = effective; timeout = Math.min(86400, effective + ADAPTER_MARGIN); }
  else timeout = explicit ?? (event && defaultTimeout(to, event) !== srcDefault ? srcDefault : undefined);
  if (event && to === 'codex' && event === 'SessionEnd' && effective > 3) warnings.push({ code: 'codexSessionEnd' });

  // 落とすキー
  const statusMessage = typeof h.statusMessage === 'string' && to !== 'antigravity' ? h.statusMessage : undefined;
  if (typeof h.statusMessage === 'string' && to === 'antigravity') warnings.push({ code: 'dropKey', params: { keys: 'statusMessage' } });

  // イベントごとの意味の違い（入力・出力・exit code）
  if (event) warnings.push(...meaningWarnings(from, to, event, adapter));
  const status = reasons.some(r => r.blocks) ? 'blocked' : reasons.some(r => r.review) ? 'review' : 'ready';
  return { status, reasons, warnings, event: event ?? source.event, matcher, matcherStatus, adapter, command, timeout, innerTimeout,
    async: h.async === true && to !== 'antigravity' ? true : undefined, statusMessage };
}

/** イベントと方向ごとの、意味の違いの警告（すべて表示用のコード。報告の対応表と同じ） */
function meaningWarnings(from, to, event, adapter) {
  const out = [];
  const w = code => out.push({ code });
  if (adapter) w('adapter');
  if (event === 'PreToolUse') {
    if (from === 'claude' && to === 'codex') w('askToDeny');
    if (from === 'claude' && to === 'antigravity') { w('allowToAgy'); w('updatedInputDeny'); }
    if (from === 'codex' && to === 'antigravity') w('allowToAgy');
    if (from === 'antigravity' && to === 'claude') w('agyAskToClaude');
    if (from === 'antigravity' && to === 'codex') w('agyAskToCodex');
    if (adapter) w(from === 'antigravity' ? 'failAgy' : 'failGate');
  }
  if (event === 'PostToolUse') {
    if (to === 'antigravity') { w('postToAgy'); if (from === 'claude') w('postSkipFailure'); }
    if (from === 'antigravity') w('postFromAgy');
    if ((from === 'claude' && to === 'codex') || (from === 'codex' && to === 'claude')) w('postFailureCodex');
  }
  if (event === 'Stop' && (from === 'antigravity' || to === 'antigravity')) { w('stopMeaning'); w('stopInput'); }
  if (event === 'PermissionRequest') w('permissionRequest');
  if (adapter && (from === 'antigravity' || to === 'antigravity') && event !== 'Stop') w('inputShape');
  return out;
}

// ---------------------------------------------------------------- アダプターのコマンド
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64url');
/**
 * 写した先の設定に書くコマンド。アダプターのパスはスラッシュ区切り（Antigravity は引用符付きのバックスラッシュのパスを解決できない）。
 * 元のコマンドは base64url で 1 つの引数にする（どのシェルでも引用符を気にせず渡せ、写した定義の中に収まるので Codex の信頼の hash にも入る）
 */
export function adapterCommand({ adapterPath, from, to, event, innerTimeout, command, node = 'node' }) {
  const p = String(adapterPath).replace(/\\/g, '/');
  const q = /\s/.test(p) ? `"${p}"` : p;
  return `${node} ${q} ${from} ${to} ${event} ${innerTimeout} ${b64(command)}`;
}
const ADAPTER_RE = /(?:^|[\s"'/\\])hook-adapter-[0-9a-f]{8,}\.mjs["']?\s+(claude|codex|antigravity)\s+(claude|codex|antigravity)\s+([A-Za-z]+)\s+(\d+)\s+([A-Za-z0-9_-]+)\s*$/;
/** アダプター越しのコマンドを読む（一覧・詳細で元のコマンドを見せる）。違えば null */
export function parseAdapterCommand(command) {
  const m = ADAPTER_RE.exec(String(command ?? ''));
  if (!m) return null;
  const text = Buffer.from(m[5], 'base64url').toString('utf8');
  if (!text.trim()) return null;
  return { from: m[1], to: m[2], event: m[3], timeout: Number(m[4]), command: text };
}

/** Antigravity の名前の候補（元のコマンドのスクリプト名から）。validName に合う形 */
export function suggestName(source) {
  const cmd = String(source.handler?.command ?? '');
  const script = cmd.split(/\s+/).map(s => s.replace(/^["']|["']$/g, '')).find(s => /\.[A-Za-z0-9]{1,5}$/.test(s) && /[\\/]|^\w/.test(s));
  const base = script ? script.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '') : source.event;
  const slug = String(base).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'hook';
  return `${source.agent === 'claude' ? 'claude' : 'codex'}-${slug}`.slice(0, 64);
}
