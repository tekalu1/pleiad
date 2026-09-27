// Hooks の探索と、各エージェントの元の設定ファイルへの書き込み（docs/context-management.md「Hooks」、ADR 0045）。
// hooks を実行するのは各エージェント。Pleiad は定義を読み、利用者が明示した編集だけを元のファイルへ書く。
// 抑止のために元のファイルを書き換えない。コマンドは実行しない。
//
// 形はエージェントごとに保つ（行に直すのは画面のためだけ。元の定義は丸ごと保持し、知らないキーも落とさない）:
//   Claude Code: settings.json の hooks → イベント → matcher group → handler
//   Codex:       hooks.json の hooks、config.toml の [hooks]（同じ形。TOML は [[hooks.<イベント>]]）
//   Antigravity: hooks.json（最上位が名前）・CLI の settings.json の hooks → 名前 → イベント →
//                ツールのイベントは matcher group、それ以外は handler を直接並べる。名前に enabled
// 書き込みは core/mcp-config.mjs に倣う: 読んだ本文の SHA-256（revision）で競合を見つける、JSON は他のキーを残す、
// TOML は hooks の表だけを置き換えて本文とコメントを残す（置き換えで意味が変わるなら書き直しの許可を求める）、一時ファイルから rename。
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import { parse as yaml } from 'yaml';
import { pathKey, scanDirectory, containsPath } from './context-settings.mjs';
import { FRONTMATTER } from './context-scan.mjs';
import { redactSecrets } from './redact.mjs';
import { renameRetry } from './atomic-file.mjs';
import { t } from './i18n.mjs';
import { convertHook, adapterCommand, parseAdapterCommand, suggestName, scriptPaths } from './hooks-copy.mjs';

export const HOOK_AGENTS = ['claude', 'codex', 'antigravity'];
// 各エージェントの公式のイベント（2026-09-27 時点。temporary/reports/hooks-agent-specs.md）
export const HOOK_EVENTS = {
  claude: ['SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
    'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop',
    'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
    'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd'],
  codex: ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit',
    'PreCompact', 'PostCompact', 'Stop', 'Interrupt'],
  antigravity: ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'],
};
// 一覧の並び（ライフサイクル順）。開始 → 入力 → ツール前 → 権限 → ツール後／失敗 → サブエージェント／圧縮 → 停止 → 終了、固有のものは後ろ
export const HOOK_ORDER = ['SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreInvocation', 'PreToolUse', 'PermissionRequest',
  'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PostInvocation', 'SubagentStart', 'SubagentStop', 'PreCompact',
  'PostCompact', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'Notification', 'MessageDisplay', 'TaskCreated', 'TaskCompleted', 'TeammateIdle',
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreModelSwitch',
  'PostModelSwitch', 'Elicitation', 'ElicitationResult'];
// Antigravity でツール名の matcher を持つイベント。ほかは matcher を無視し、handler を直接並べる
const AGY_TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
export const supportsEvent = (agent, event) => Boolean(HOOK_EVENTS[agent]?.includes(event));

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const LIMIT = 1024 * 1024;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const MASK = '••••';
const SECRET_KEYS = new Set(['env', 'headers']);

// コマンドの引数で渡す秘密（--token 値・--api-key 値）。= で書く形は core/redact.mjs が伏せる
const FLAG_NAME = '--?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth(?:orization)?)[\\w-]*';
// 前は行頭・空白・引用符（JSON の文字列の中の "--token 値" も）。値は引用符の手前まで
const FLAG_VALUE = new RegExp(`((?:^|[\\s"'])${FLAG_NAME}\\s+)(?!-)("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi');
const FLAG_ALONE = new RegExp(`^${FLAG_NAME}$`, 'i');
// キーの名前で分かる秘密（入れ子の record・知らないキーを含む）。値が文字列のものだけ伏せる
const SECRET_NAME = /(token|secret|password|passwd|api[_-]?key|authorization|cookie)/i;
// 値を丸ごと伏せる表（env・headers。Codex の MCP の http_headers なども）
const SECRET_TABLES = new Set(['env', 'headers', 'http_headers', 'env_http_headers']);
const maskPlain = s => redactSecrets(String(s)).replace(FLAG_VALUE, `$1${MASK}`);
// 写した定義（アダプター越し）のコマンドは、元のコマンドを base64url の引数で持つ（core/hooks-copy.mjs の adapterCommand）。
// そのままでは伏せ字をすり抜けるので、元のコマンドに伏せる値があれば引数ごと伏せる（JSON の \" の後ろも拾う）
const ADAPTER_ARG = /(hook-adapter-[0-9a-f]{8,}\.mjs(?:\\?["'])?\s+(?:claude|codex|antigravity)\s+(?:claude|codex|antigravity)\s+[A-Za-z]+\s+\d+\s+)([A-Za-z0-9_-]{4,})/g;
const maskAdapterArg = s => s.replace(ADAPTER_ARG, (all, head, b64) => {
  const inner = Buffer.from(b64, 'base64url').toString('utf8');
  return maskPlain(inner) === inner ? all : `${head}${MASK}`;
});
/** 文字列 1 つの伏せ字。形で分かる秘密だけ（伏せ漏れはありうる） */
export const maskText = s => maskAdapterArg(maskPlain(s));
/** 画面に出す形。env・headers の値、秘密らしい名前のキーの値、args の秘密のフラグの次の要素を伏せ、文字列は形で伏せる。元の値は変えない */
export function maskDefinition(value) {
  if (Array.isArray(value)) return value.map((v, i) => typeof v === 'string' && typeof value[i - 1] === 'string' && FLAG_ALONE.test(value[i - 1]) ? MASK : maskDefinition(v));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, SECRET_KEYS.has(k) && record(v) ? Object.fromEntries(Object.keys(v).map(n => [n, MASK])) : typeof v === 'string' && SECRET_NAME.test(k) ? MASK : maskDefinition(v)]));
  return typeof value === 'string' ? maskText(value) : value;
}
/**
 * 設定ファイルの本文の伏せ字（書く前の確認の差分用）。行を保ったまま、env・headers の表とインラインの表の値、
 * 秘密らしい名前のキーの文字列の値、形で分かる秘密（maskText）を伏せる。前後の本文に同じように通すので、変わらない行は同じになる
 */
export function maskFileText(text, format) {
  const lines = String(text ?? '').split(/(\r?\n)/);
  const quoted = '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\'';
  if (format === 'toml') {
    let table = [];
    return lines.map(part => {
      if (/^\r?\n$/.test(part) || /^\s*#/.test(part)) return part;
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/.exec(part);
      if (header) { table = header[1].split('.').map(s => s.trim().replace(/^["']|["']$/g, '')); return maskText(part); }
      const kv = new RegExp(`^(\\s*(${quoted}|[A-Za-z0-9_-]+)\\s*=\\s*)(.*)$`).exec(part);
      if (kv) {
        const key = kv[2].replace(/^["']|["']$/g, ''), value = kv[3].trim();
        if (SECRET_TABLES.has(table.at(-1)) || (SECRET_NAME.test(key) && /^["']/.test(value))) return `${kv[1]}"${MASK}"`;
        if (SECRET_TABLES.has(key) && value.startsWith('{')) return kv[1] + kv[3].replace(new RegExp(`(=\\s*)(${quoted})`, 'g'), `$1"${MASK}"`);
      }
      return maskText(part);
    }).join('');
  }
  let out = String(text ?? '').replace(new RegExp(`("(?:${[...SECRET_TABLES].join('|')})"\\s*:\\s*\\{)([^{}]*)(\\})`, 'g'),
    (m, head, body, tail) => head + body.replace(new RegExp(`(:\\s*)(${quoted})`, 'g'), `$1"${MASK}"`) + tail);
  out = out.replace(new RegExp(`("((?:\\\\.|[^"\\\\])*)"\\s*:\\s*)(${quoted})`, 'g'), (m, head, key) => SECRET_NAME.test(key) ? `${head}"${MASK}"` : m);
  return out.split(/(\r?\n)/).map(p => /\n/.test(p) ? p : maskText(p)).join('');
}
/** 読んだ本文の書式（改行・字下げ・BOM）。書くときに戻す */
function styleOf(text) {
  const src = String(text ?? '');
  const indent = /^([ \t]+)["[{]/m.exec(src.replace(/^﻿/, ''))?.[1];
  return { bom: src.startsWith('﻿') ? '﻿' : '', eol: /\r\n/.test(src) ? '\r\n' : '\n', indent: indent ? (indent.startsWith('\t') ? '\t' : indent.length) : 2 };
}
/**
 * JSON の書き直しで、元の本文の値が変わるか（有効桁を超える整数・重複したキー）。変わるなら書き直しの許可を求める。
 * 文字列の中は飛ばし、オブジェクトごとにキーを覚える簡単な走査
 */
export function jsonLossy(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const stack = [];
  let expectKey = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1, s = '';
      for (; j < src.length && src[j] !== '"'; j++) { if (src[j] === '\\') { s += src[j] + src[j + 1]; j++; } else s += src[j]; }
      const top = stack.at(-1);
      if (top && top.type === 'object' && expectKey) {
        const rest = /^\s*:/.test(src.slice(j + 1, j + 40));
        if (rest) { if (top.keys.has(s)) return true; top.keys.add(s); expectKey = false; }
      }
      i = j;
    } else if (c === '{') { stack.push({ type: 'object', keys: new Set() }); expectKey = true; }
    else if (c === '[') { stack.push({ type: 'array' }); }
    else if (c === '}' || c === ']') { stack.pop(); }
    else if (c === ',') { expectKey = stack.at(-1)?.type === 'object'; }
    else if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (m) { if (/^-?\d+$/.test(m[0]) && !Number.isSafeInteger(Number(m[0]))) return true; i += m[0].length - 1; }
    }
  }
  return false;
}
const handlerType = h => (typeof h?.type === 'string' ? h.type : 'command');
const commandOf = h => typeof h?.command === 'string' ? h.command : Array.isArray(h?.args) ? h.args.join(' ') : '';

/**
 * 設定ファイルの置き場所。scope: user（home）/ project（base の下）/ local（Claude だけ。base/.claude/settings.local.json）。
 * kind はファイルの形: claude / codex-json / codex-toml / agy-file（最上位が名前）/ agy-settings（hooks の下が名前）
 */
export function hookFiles({ home, codexHome, claudeHome, geminiHome }, agent, scope, base) {
  if (agent === 'claude') {
    if (scope === 'user') return [{ path: path.join(claudeHome, 'settings.json'), kind: 'claude', format: 'json' }];
    if (scope === 'project') return [{ path: path.join(base, '.claude', 'settings.json'), kind: 'claude', format: 'json' }];
    if (scope === 'local') return [{ path: path.join(base, '.claude', 'settings.local.json'), kind: 'claude', format: 'json' }];
  }
  if (agent === 'codex' && ['user', 'project'].includes(scope)) {
    const dir = scope === 'user' ? codexHome : path.join(base, '.codex');
    return [{ path: path.join(dir, 'hooks.json'), kind: 'codex-json', format: 'json' }, { path: path.join(dir, 'config.toml'), kind: 'codex-toml', format: 'toml' }];
  }
  if (agent === 'antigravity') {
    if (scope === 'user') return [{ path: path.join(geminiHome, 'config', 'hooks.json'), kind: 'agy-file', format: 'json' },
      { path: path.join(geminiHome, 'antigravity-cli', 'settings.json'), kind: 'agy-settings', format: 'json' }];
    if (scope === 'project') return [{ path: path.join(base, '.agents', 'hooks.json'), kind: 'agy-file', format: 'json' }];
  }
  return [];
}
/** ファイルの中の hooks の置き場（無ければ undefined。形が違えば null） */
function hooksMap(kind, config) {
  if (!record(config)) return null;
  if (kind === 'agy-file') return config;
  if (!own(config, 'hooks')) return undefined;
  return record(config.hooks) ? config.hooks : null;
}
function withHooks(kind, config, map) {
  if (kind === 'agy-file') return map;
  const next = { ...config };
  if (Object.keys(map).length || kind !== 'codex-toml') next.hooks = map;
  else delete next.hooks;
  return next;
}

/** 他のエージェントから写した定義（アダプター越し）なら、元のエージェント・イベント・元のコマンド（伏せ字）。一覧と詳細で元のコマンドを見せる */
function adapterOf(h) {
  const via = typeof h?.command === 'string' ? parseAdapterCommand(h.command) : null;
  return via ? { adapter: { from: via.from, event: via.event, timeout: via.timeout, command: maskText(via.command) } } : {};
}
/** 1 つの handler の要約（行に出す分）。値は伏せてから切る */
function summary(h) {
  // 写した定義（アダプター越し）は元のコマンドを見せる（どこから写したかは adapter で行に付ける）
  const via = typeof h?.command === 'string' ? parseAdapterCommand(h.command) : null;
  const text = maskText(via ? via.command : commandOf(h));
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * hooks の置き場 1 つを行に直す。group / handler は元の並びの番号（編集の指し先）。
 * agy の非ツールのイベントは handler を直接並べるので group は -1、handler がその番号
 */
function rowsOf(agent, map, base) {
  const rows = [], problems = [];
  const handlerRow = (event, group, handler, h, extra) => {
    if (!record(h)) { problems.push('handler'); return; }
    const type = handlerType(h);
    rows.push({ ...base, event, group, handler, type, command: summary(h),
      timeout: Number.isFinite(h.timeout) ? h.timeout : null, async: h.async === true,
      editable: !base.readOnly && type === 'command' && typeof h.command === 'string',
      definition: maskDefinition(h), unknownKeys: Object.keys(h).filter(k => !['type', 'command', 'timeout', 'async'].includes(k)), ...adapterOf(h), ...extra });
  };
  const groups = (event, list, extra = {}) => {
    // イベントでないキー（説明など）は行にしない。イベントなのに並びでないものは壊れた定義として知らせる
    if (!Array.isArray(list)) { if (HOOK_ORDER.includes(event)) problems.push('event'); return; }
    list.forEach((g, gi) => {
      if (!record(g)) { problems.push('group'); return; }
      if (agent === 'antigravity' && !AGY_TOOL_EVENTS.has(event) && !Array.isArray(g.hooks)) { handlerRow(event, -1, gi, g, { matcher: null, ...extra }); return; }
      if (!Array.isArray(g.hooks)) { problems.push('group'); return; }
      const matcher = typeof g.matcher === 'string' ? g.matcher : null;
      const groupKeys = Object.keys(g).filter(k => !['matcher', 'hooks'].includes(k));
      g.hooks.forEach((h, hi) => handlerRow(event, gi, hi, h, { matcher, groupKeys, ...extra }));
    });
  };
  if (agent === 'antigravity') {
    for (const [name, spec] of Object.entries(map)) {
      if (!record(spec)) { problems.push('name'); continue; }
      const enabled = spec.enabled !== false;
      for (const [event, list] of Object.entries(spec)) if (event !== 'enabled') groups(event, list, { name, enabled });
    }
  } else for (const [event, list] of Object.entries(map)) groups(event, list);
  return { rows, problems };
}

/**
 * プロジェクトの置き場所（.claude・.codex・.agents）がリンクで base の外を指していないか。
 * 無いファイルでも、一番近くの有る親の実体で確かめる（リンクのフォルダーの下に新しく作ると外へ書くため）
 */
async function insideBase(file, base) {
  let dir = file;
  for (;;) {
    const real = await fs.realpath(dir).catch(e => (['ENOENT', 'ENOTDIR'].includes(e.code) ? null : ''));
    if (real === '') return false;
    if (real) return containsPath(await fs.realpath(base).catch(() => base), real);
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** PATH の node（写した hook のアダプターを動かす）。見つからなければ null。結果は 30 秒覚える */
let nodeCache = null;
export function findNodeOnPath() {
  if (nodeCache && Date.now() - nodeCache.at < 30_000) return nodeCache.value;
  const value = new Promise(resolve => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['node'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      const first = String(stdout ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
      resolve(error || !first ? null : first);
    });
  });
  nodeCache = { at: Date.now(), value };
  return value;
}
/** 写す先に書き出すアダプター（core/hook-adapter.mjs をそのまま）。名前に中身の hash を入れ、版が変わっても前の写しを壊さない */
let adapterCache = null;
async function adapterSource() {
  adapterCache ??= fs.readFile(new URL('./hook-adapter.mjs', import.meta.url), 'utf8').then(text => ({ text, name: `hook-adapter-${digest(text).slice(0, 12)}.mjs` }));
  return adapterCache;
}

export function createHooksConfig({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
  claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), geminiHome = path.join(home, '.gemini'),
  findNode = findNodeOnPath, platform = process.platform } = {}) {
  const places = { home, codexHome, claudeHome, geminiHome };
  let writes = Promise.resolve();

  /** ファイルを読む。無ければ exists: false。読めない・形が違うときは error（原文の中身は出さない）。base があれば、その外の実体は読まない */
  async function load(file, base = null) {
    let text = '', real = file.path, mode = 0o600, exists = false;
    if (base && !await insideBase(file.path, base)) return { ...file, real, exists: true, error: t('hooks.file.outside') };
    try {
      real = await fs.realpath(file.path);
      const handle = await fs.open(real, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > LIMIT) return { ...file, real, exists: true, error: t('hooks.file.unreadable') };
        const buffer = Buffer.alloc(LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > LIMIT) return { ...file, real, exists: true, error: t('hooks.file.unreadable') };
        text = buffer.subarray(0, bytesRead).toString('utf8'); mode = stat.mode & 0o777; exists = true;
      } finally { await handle.close(); }
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes(e.code)) return { ...file, real, exists: true, error: t('hooks.file.unreadable') };
      const link = await fs.lstat(file.path).catch(() => null);
      if (link) return { ...file, real, exists: true, error: t('hooks.file.link') };
    }
    const revision = exists ? digest(text) : 'missing';
    let config = {};
    if (exists && text.trim()) {
      try { config = file.format === 'toml' ? tomlParse(text.replace(/^﻿/, '')) : JSON.parse(text.replace(/^﻿/, '')); }
      catch { return { ...file, real, text, mode, exists, revision, error: t('hooks.file.syntax') }; }
    }
    const map = hooksMap(file.kind, config);
    if (map === null) return { ...file, real, text, mode, exists, revision, config, error: t('hooks.file.format') };
    return { ...file, real, text, mode, exists, revision, config, map: map ?? {}, declared: map !== undefined };
  }

  // ---------------------------------------------------------------- 探索
  /**
   * scopes: user（home）と directory（Git のルートから cwd まで）。設定の画面のユーザーの段は ['user'] だけ。
   * 返す files はファイルごとの状態（missing / none = 登録 0 件 / ok / error）。登録 0 件と読み取り失敗を分けるため
   */
  async function scan({ cwd = null, scopes = ['user', 'directory'], agents = HOOK_AGENTS } = {}) {
    const files = [], entries = [], diagnostics = [];
    let root = cwd;
    const ancestors = [];
    if (cwd && scopes.includes('directory')) {
      for (let dir = cwd; ; dir = path.dirname(dir)) {
        ancestors.unshift(dir);
        if (await fs.stat(path.join(dir, '.git')).then(() => true, () => false)) { root = dir; break; }
        if (path.dirname(dir) === dir) { ancestors.splice(0, ancestors.length, cwd); root = cwd; break; }
      }
    }
    const visit = async (agent, scope, base) => {
      for (const file of hookFiles(places, agent, scope, base)) {
        const data = await load(file, scope === 'user' ? null : base);
        const info = { agent, scope, base: base ?? null, path: file.path, format: file.format, kind: file.kind, exists: data.exists, revision: data.revision ?? null };
        if (data.error) { files.push({ ...info, status: 'error', error: data.error, count: 0 }); continue; }
        // 全体の停止（Claude の disableAllHooks・Codex の [features] hooks = false）は行ごとの状態ではないので、ファイルに付ける
        const off = (file.kind === 'claude' && data.config?.disableAllHooks === true) || (file.kind === 'codex-toml' && data.config?.features?.hooks === false);
        const { rows, problems } = rowsOf(agent, data.map, { agent, scope, base: base ?? null, path: file.path, format: file.format, kind: file.kind,
          readOnly: false, stop: agent === 'claude' ? 'none' : agent === 'codex' ? 'codex' : 'name' });
        if (problems.length) diagnostics.push({ path: file.path, message: t('hooks.file.partial') });
        files.push({ ...info, status: !data.exists ? 'missing' : rows.length ? 'ok' : 'none', count: rows.length, declared: data.declared, ...(off ? { allOff: true } : {}),
          ...(problems.length ? { partial: true } : {}) });
        entries.push(...rows);
      }
    };
    for (const agent of agents) {
      if (scopes.includes('user')) await visit(agent, 'user', null);
      for (const base of ancestors) {
        await visit(agent, 'project', base);
        if (agent === 'claude') await visit(agent, 'local', base);
      }
    }
    // Claude の Skill の frontmatter の hooks（Skill を呼んだ後だけ効く）。読むだけ
    if (agents.includes('claude')) {
      const skillDirs = [...(scopes.includes('user') ? [[path.join(claudeHome, 'skills'), 'user', null]] : []), ...ancestors.map(b => [path.join(b, '.claude', 'skills'), 'project', b])];
      for (const [dir, scope, base] of skillDirs) {
        let list = [];
        try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of list.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const file = path.join(dir, entry.name, 'SKILL.md');
          let text;
          try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 256 * 1024) continue; text = await fs.readFile(file, 'utf8'); } catch { continue; }
          const match = FRONTMATTER.exec(text.replace(/^﻿/, ''));
          let meta;
          try { meta = match ? yaml(match[1] ?? '', { maxAliasCount: 20, logLevel: 'silent' }) : null; } catch { meta = null; }
          if (!record(meta?.hooks)) continue;
          const name = typeof meta.name === 'string' ? meta.name : entry.name;
          const { rows } = rowsOf('claude', meta.hooks, { agent: 'claude', scope: 'skill', skillScope: scope, skill: name, base, path: file, format: 'yaml', kind: 'skill', readOnly: true, stop: 'none' });
          entries.push(...rows);
        }
      }
    }
    // agy の enabled: false は、ユーザーと作業場所にある同じ名前の定義をまとめて止める（実機で確認。2026-09-27）
    const offNames = new Set(entries.filter(e => e.agent === 'antigravity' && e.enabled === false).map(e => e.name));
    for (const e of entries) if (e.agent === 'antigravity' && e.enabled && offNames.has(e.name)) e.stoppedBySameName = true;
    for (const e of entries) e.id = digest([e.agent, pathKey(e.path), e.name ?? '', e.event, e.group, e.handler].join('\0')).slice(0, 24);
    return { cwd, root, home, scopes, files, entries, diagnostics, events: HOOK_EVENTS, order: HOOK_ORDER };
  }

  // ---------------------------------------------------------------- 書き込み
  async function resolveBase(scope, base) {
    if (scope === 'user') return null;
    if (!['project', 'local'].includes(scope)) throw new Error(t('hooks.write.target'));
    return scanDirectory(base);
  }
  /** 書き先のファイル。file を指せば、その agent・scope・base の置き場所のどれかに限る（任意のパスには書かない） */
  async function target({ agent, scope, base, file }) {
    if (!HOOK_AGENTS.includes(agent)) throw new Error(t('hooks.write.target'));
    const dir = await resolveBase(scope, base);
    const list = hookFiles(places, agent, scope, dir);
    if (!list.length) throw new Error(t('hooks.write.target'));
    // プロジェクトのスコープで、置き場所がリンクで作業場所の外を指していれば書かない（見えているのと別のファイルへ書くため）。
    // ユーザーのスコープのリンク（dotfiles の管理）は正当な使い方なので確かめない
    const chosen = async f => {
      if (dir && !await insideBase(f.path, dir)) throw new Error(t('hooks.file.outside'));
      return { ...f, base: dir };
    };
    if (file) {
      const hit = list.find(f => pathKey(f.path) === pathKey(file));
      if (!hit) throw new Error(t('hooks.write.target'));
      return chosen(hit);
    }
    // 追加の既定の書き先。すでに定義を置いているファイルがあればそちら（Codex の TOML、agy の CLI の settings.json）。二重に登録しない
    if (list.length > 1) {
      for (const f of list.slice(1)) {
        const data = await load(f, dir);
        if (!data.error && data.declared && Object.keys(data.map).length) return chosen(f);
      }
    }
    return chosen(list[0]);
  }
  /** 追加・編集の前に書き先を見せる（シートの「書き先」） */
  async function targets({ scope, base, agents = HOOK_AGENTS }) {
    const out = {};
    for (const agent of agents) {
      if (agent !== 'claude' && scope === 'local') continue;
      try { const f = await target({ agent, scope, base }); out[agent] = { path: f.path, format: f.format }; } catch (e) { out[agent] = { error: e.message }; }
    }
    return out;
  }

  const validName = n => typeof n === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(n) && !RESERVED.has(n) && n !== 'enabled';
  function cleanHandler(input, agent, previous = {}) {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command || command.length > 4000) throw new Error(t('hooks.write.command'));
    const out = { ...previous, type: 'command', command };
    // type を省いた定義（agy は省略で command）には type を足さない
    if (!own(previous, 'type') && Object.keys(previous).length) delete out.type;
    // keepTimeout: 元の timeout がシートの欄で扱えない値（文字列・小数）のとき、欄を空のまま保存すれば元の値を残す
    if (input.keepTimeout === true) { if (own(previous, 'timeout')) out.timeout = previous.timeout; }
    else if (input.timeout === null || input.timeout === undefined || input.timeout === '') delete out.timeout;
    else {
      const n = Number(input.timeout);
      if (!Number.isInteger(n) || n < 1 || n > 86400) throw new Error(t('hooks.write.timeout'));
      out.timeout = n;
    }
    if (input.async === true) {
      if (agent === 'antigravity') throw new Error(t('hooks.write.asyncAgy'));
      out.async = true;
    } else if (own(out, 'async')) { if (own(previous, 'async')) out.async = false; else delete out.async; }
    return out;
  }
  const cleanMatcher = m => {
    if (m === null || m === undefined) return '';
    if (typeof m !== 'string' || m.length > 500) throw new Error(t('hooks.write.matcher'));
    return m.trim();
  };

  /** 指し先の handler。無い・command でないときは例外（別の人が変えた・読み取りのみ）。自分のキーだけを引く（__proto__ などで prototype を触らない） */
  function locate(agent, map, loc) {
    if (!Number.isInteger(loc.handler) || !(loc.group === -1 || Number.isInteger(loc.group))) throw new Error(t('hooks.write.notFound'));
    const holder = agent === 'antigravity' ? (typeof loc.name === 'string' && own(map, loc.name) ? map[loc.name] : null) : map;
    if (!record(holder)) throw new Error(t('hooks.write.notFound'));
    const list = typeof loc.event === 'string' && own(holder, loc.event) ? holder[loc.event] : null;
    if (!Array.isArray(list)) throw new Error(t('hooks.write.notFound'));
    if (loc.group === -1) {
      const h = list[loc.handler];
      if (!record(h)) throw new Error(t('hooks.write.notFound'));
      return { holder, list, handler: h, group: null };
    }
    const g = list[loc.group];
    const h = record(g) && Array.isArray(g.hooks) ? g.hooks[loc.handler] : null;
    if (!record(h)) throw new Error(t('hooks.write.notFound'));
    return { holder, list, group: g, handler: h };
  }
  function removeAt(agent, map, loc) {
    const found = locate(agent, map, loc);
    if (found.group) {
      found.group.hooks.splice(loc.handler, 1);
      if (!found.group.hooks.length) found.list.splice(loc.group, 1);
    } else found.list.splice(loc.handler, 1);
    if (!found.list.length) delete found.holder[loc.event];
    return found;
  }
  /** 足す。足した group（TOML の末尾に 1 ブロックだけ足すときに使う。agy の非ツールのイベントは handler） */
  function insert(agent, map, { name, event, matcher }, handler) {
    let holder = map;
    if (agent === 'antigravity') {
      if (!validName(name)) throw new Error(t('hooks.write.name'));
      if (own(map, name) && !record(map[name])) throw new Error(t('hooks.write.format'));
      if (!own(map, name)) map[name] = {};
      holder = map[name];
    }
    if (own(holder, event) && !Array.isArray(holder[event])) throw new Error(t('hooks.write.format'));
    if (!own(holder, event)) holder[event] = [];
    const list = holder[event];
    const entry = agent === 'antigravity' && !AGY_TOOL_EVENTS.has(event) ? handler
      : { ...(matcher || (agent === 'antigravity') ? { matcher: matcher || '*' } : {}), hooks: [handler] };
    list.push(entry);
    return entry;
  }

  /**
   * 1 件の変更を組み立てる（書かない）。op: add / edit / delete / enable。
   * 返すのは書き込む本文と、書く前の確認に使う前後の本文（伏せ字）
   */
  async function plan(item, { handler: given = null } = {}) {
    const op = item?.op;
    if (!['add', 'edit', 'delete', 'enable'].includes(op)) throw new Error(t('hooks.write.operation'));
    const loc = record(item.loc) ? item.loc : {};
    // 予約の名前（__proto__ など）は、どの経路でもキーとして使わない
    if ([loc.name, loc.event, item.name, item.event].some(k => typeof k === 'string' && RESERVED.has(k))) throw new Error(t('hooks.write.operation'));
    const file = await target({ agent: item.agent, scope: item.scope, base: item.base, file: op === 'add' ? item.file : item.file ?? '\0' });
    const data = await load(file, file.base);
    if (data.error) throw new Error(data.error);
    if (op !== 'add' && item.revision !== data.revision) throw new Error(t('hooks.write.changed'));
    if (op === 'add' && item.revision !== undefined && item.revision !== data.revision) throw new Error(t('hooks.write.changed'));
    const agent = item.agent;
    const map = structuredClone(data.map);
    let added = null;
    if (op === 'enable') {
      if (agent !== 'antigravity' || !validName(loc.name) || !own(map, loc.name) || !record(map[loc.name])) throw new Error(t('hooks.write.notFound'));
      map[loc.name].enabled = item.enabled !== false;
    } else if (op === 'delete') {
      const { handler } = locate(agent, map, loc);
      if (handlerType(handler) !== 'command') throw new Error(t('hooks.write.readOnly'));
      removeAt(agent, map, loc);
      if (agent === 'antigravity' && record(map[loc.name]) && !Object.keys(map[loc.name]).some(k => k !== 'enabled')) delete map[loc.name];
    } else {
      const event = item.event;
      if (!supportsEvent(agent, event)) throw new Error(t('hooks.write.event'));
      const matcher = cleanMatcher(item.matcher);
      const name = agent === 'antigravity' ? item.name : undefined;
      // given: 写すとき（copy）にサーバーが組み立てた handler。画面から来た値は cleanHandler を通す
      if (op === 'add') added = insert(agent, map, { name, event, matcher }, given ?? cleanHandler(item, agent));
      else {
        const found = locate(agent, map, loc);
        if (handlerType(found.handler) !== 'command' || typeof found.handler.command !== 'string') throw new Error(t('hooks.write.readOnly'));
        const next = cleanHandler(item, agent, found.handler);
        const sameMatcher = found.group ? (found.group.matcher ?? '') === matcher : true;
        if (event === loc.event && (name ?? loc.name) === loc.name && sameMatcher) {
          if (found.group) found.group.hooks[loc.handler] = next; else found.list[loc.handler] = next;
        } else if (event === loc.event && (name ?? loc.name) === loc.name && found.group && found.group.hooks.length === 1) {
          // 1 件だけの group は matcher を書き換える（group の他のキーは残す）
          if (matcher || agent === 'antigravity') found.group.matcher = matcher || '*'; else delete found.group.matcher;
          found.group.hooks[0] = next;
        } else {
          // イベント・名前が変わった、または他の handler と group を共有している: 取り出して新しい group に入れる。
          // agy の改名は enabled（名前単位の停止）を引き継ぐ。移し先の名前が別の enabled を持っていれば断る（黙って止めたり動かしたりしない）
          const renamed = agent === 'antigravity' && name !== loc.name;
          const wasOff = renamed && map[loc.name].enabled === false;
          if (renamed && own(map, name) && record(map[name]) && (map[name].enabled === false) !== wasOff) throw new Error(t('hooks.write.renameEnabled'));
          removeAt(agent, map, loc);
          if (renamed && record(map[loc.name]) && !Object.keys(map[loc.name]).some(k => k !== 'enabled')) delete map[loc.name];
          insert(agent, map, { name: name ?? loc.name, event, matcher }, next);
          if (wasOff) map[name].enabled = false;
        }
      }
    }
    const config = withHooks(file.kind, data.config ?? {}, map);
    const style = styleOf(data.text);
    let rendered;
    if (file.format === 'toml') rendered = renderToml(data.text, config, added && op === 'add' ? { op, event: item.event, entry: added } : null);
    else {
      const body = JSON.stringify(config, null, style.indent).replace(/\n/g, style.eol) + style.eol;
      // 読み直して値が変わる（有効桁を超える整数・重複したキー）なら、書き直しの許可を求める
      const lossy = data.exists && jsonLossy(data.text);
      rendered = { text: style.bom + body, reformatsFile: lossy, ...(lossy ? { reason: 'jsonValues' } : {}) };
    }
    if (Buffer.byteLength(rendered.text) > LIMIT) throw new Error(t('hooks.write.tooLarge'));
    const before = maskFileText(data.text.replace(/^﻿/, ''), file.format), after = maskFileText(rendered.text.replace(/^﻿/, ''), file.format);
    return { file, data, text: rendered.text, reformatsFile: rendered.reformatsFile, reason: rendered.reason ?? null, lostComments: rendered.lostComments ?? 0,
      before, after, hiddenChange: before === after && data.text !== rendered.text };
  }
  /**
   * 変更をまとめて受ける。dryRun なら書かずに書き先・前後の本文（伏せ字）・書き直しの要否だけ返す。
   * 複数の書き先は 1 件ずつ書き、失敗しても書けた先はそのまま結果に残す（部分成功を明示する）
   */
  function save({ items, dryRun = false, allowReformat = false } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 12) return Promise.reject(new Error(t('hooks.write.operation')));
    const run = writes.catch(() => {}).then(async () => {
      const results = [];
      for (const item of items) {
        try {
          const p = await plan(item);
          const base = { agent: item.agent, op: item.op, path: p.file.path, format: p.file.format, reformatsFile: p.reformatsFile, reason: p.reason,
            lostComments: p.lostComments, hiddenChange: p.hiddenChange, before: p.before, after: p.after, revision: p.data.revision };
          if (dryRun) { results.push({ ...base, ok: true }); continue; }
          if (p.reformatsFile && !allowReformat) throw new Error(t('hooks.write.reformat'));
          await commit(p, item);
          results.push({ ...base, ok: true, revision: digest(p.text) });
        } catch (e) { results.push({ agent: item?.agent, op: item?.op, ok: false, error: e.message }); }
      }
      return { dryRun, results };
    });
    writes = run;
    return run;
  }
  async function commit(p, item) {
    await fs.mkdir(path.dirname(p.data.real), { recursive: true });
    const tmp = `${p.data.real}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, p.text, { encoding: 'utf8', mode: p.data.mode, flag: 'wx' });
      const current = await load(p.file, p.file.base);
      if (current.revision !== p.data.revision || pathKey(current.real) !== pathKey(p.data.real)) throw new Error(t('hooks.write.changedReload'));
      await renameRetry(tmp, p.data.real);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  // ---------------------------------------------------------------- 他のエージェントへ写す（ADR 0047）
  /** Antigravity の名前（ユーザーの 2 つのファイルと、作業場所の .agents/hooks.json）。同じ名前はスコープをまたいで止まり、両方有効なら両方走る */
  async function agyNames(base) {
    const out = new Map();
    const files = [...hookFiles(places, 'antigravity', 'user', null).map(f => [f, null]), ...(base ? hookFiles(places, 'antigravity', 'project', base).map(f => [f, base]) : [])];
    for (const [f, b] of files) {
      const data = await load(f, b);
      if (data.error || !data.map) continue;
      for (const n of Object.keys(data.map)) if (!out.has(n)) out.set(n, f.path);
    }
    return out;
  }
  async function readAdapter(file, base) {
    if (base && !await insideBase(file, base)) return { error: true };
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > LIMIT) return { error: true };
      return { exists: true, text: await fs.readFile(file, 'utf8') };
    } catch (e) { return ['ENOENT', 'ENOTDIR'].includes(e.code) ? { exists: false } : { error: true }; }
  }
  /** アダプターを書き出す。既にあれば中身が同じときだけそのまま使う（別の内容なら上書きしない） */
  async function writeAdapter(file, text, base) {
    if (base && !await insideBase(file, base)) throw new Error(t('hooks.file.outside'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await fs.readFile(file, 'utf8') !== text) throw new Error(t('hooks.copy.adapterConflict'));
    }
  }
  /** 1 つのファイルの、あるイベントの handler のコマンド（agy は全部の名前から） */
  function commandsOf(agent, map, event) {
    const out = [];
    const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (record(v)) { if (typeof v.command === 'string') out.push(v.command); if (Array.isArray(v.hooks)) walk(v.hooks); } };
    if (agent === 'antigravity') for (const def of Object.values(map)) { if (record(def)) walk(def[event]); }
    else walk(map[event]);
    return out;
  }
  /** 1 つの写し先。dryRun なら書かずに、変換の結果・書き先・前後の本文を返す */
  async function copyOne(src, want, adapterFile, { dryRun, allowReformat }) {
    const to = want?.agent;
    if (!HOOK_AGENTS.includes(to)) throw new Error(t('hooks.write.target'));
    const scope = want.scope === 'local' && to !== 'claude' ? 'project' : want.scope;
    const conv = convertHook(src, to, { platform, matcher: typeof want.matcher === 'string' ? want.matcher : undefined });
    const reasons = [...conv.reasons], warnings = [...conv.warnings];
    const out = { agent: to, scope, event: conv.event, matcher: conv.matcher, matcherStatus: conv.matcherStatus, adapter: null, name: null,
      timeout: conv.timeout ?? null, innerTimeout: conv.innerTimeout, command: maskText(conv.command) };
    const status = () => (reasons.some(r => r.blocks) ? 'blocked' : reasons.some(r => r.review) ? 'review' : 'ready');
    const finish = extra => ({ ...out, status: status(), reasons, warnings, ...extra });
    if (status() === 'blocked') return finish({ ok: false });
    const file = await target({ agent: to, scope, base: want.base });
    Object.assign(out, { path: file.path, format: file.format });
    let command = conv.command;
    if (conv.adapter) {
      // 写した先の設定ファイルの隣（<設定のフォルダー>/pleiad-hooks/）。Pleiad の置き場所・起動状態に頼らずに動く
      const adapterPath = path.join(path.dirname(file.path), 'pleiad-hooks', adapterFile.name);
      const current = await readAdapter(adapterPath, file.base);
      out.adapter = { path: adapterPath, exists: Boolean(current.exists) };
      if (current.error || (current.exists && current.text !== adapterFile.text)) reasons.push({ code: 'adapterConflict', params: { path: adapterPath }, blocks: true });
      const node = await findNode();
      out.node = node;
      if (!node) reasons.push({ code: 'noNode', blocks: true });
      command = adapterCommand({ adapterPath, from: src.agent, to, event: conv.event, innerTimeout: conv.innerTimeout, command: conv.command });
    }
    // 同じイベントに同じコマンドが既にあれば写さない（前に写したもの。Codex・agy は同じ定義を重ねると 2 回走る）
    const existing = await load(file, file.base);
    if (!existing.error && existing.map && commandsOf(to, existing.map, conv.event).includes(command)) reasons.push({ code: 'duplicate', params: { path: file.path }, blocks: true });
    // スクリプト本体は写さない。指す先が無い・相対パスで基準の場所が変わるときは知らせる（同じ場所なら写した先でも同じファイルを指す）
    const sameBase = src.scope === 'user' || (scope !== 'user' && file.base && src.base && path.resolve(file.base) === path.resolve(src.base));
    for (const s of scriptPaths(conv.command)) {
      if (s.relative) { if (!sameBase) warnings.push({ code: 'scriptRelative', params: { path: maskText(s.path) } }); continue; }
      const abs = /^~[\\/]/.test(s.path) ? path.join(home, s.path.slice(2)) : s.path;
      if (!await fs.stat(abs).then(st => st.isFile(), () => false)) warnings.push({ code: 'scriptMissing', params: { path: maskText(s.path) } });
    }
    let name;
    if (to === 'antigravity') {
      name = typeof want.name === 'string' && want.name.trim() ? want.name.trim() : suggestName(src);
      out.name = name;
      warnings.push({ code: 'agyNameScope' });
      if (!validName(name)) reasons.push({ code: 'nameInvalid', params: { name }, review: 'name' });
      else {
        const taken = (await agyNames(file.base)).get(name);
        if (taken) reasons.push({ code: 'nameTaken', params: { name, path: taken }, review: 'name' });
      }
    }
    if (status() === 'blocked' || (name !== undefined && !validName(name))) return finish({ ok: false });
    const handler = { type: 'command', command, ...(conv.timeout !== undefined ? { timeout: conv.timeout } : {}), ...(conv.async ? { async: true } : {}),
      ...(conv.statusMessage !== undefined ? { statusMessage: conv.statusMessage } : {}) };
    const item = { op: 'add', agent: to, scope, base: file.base ?? undefined, file: file.path, name, event: conv.event, matcher: conv.matcher ?? '', revision: want.revision };
    const p = await plan(item, { handler });
    Object.assign(out, { before: p.before, after: p.after, reformatsFile: p.reformatsFile, reason: p.reason, lostComments: p.lostComments,
      hiddenChange: p.hiddenChange, revision: p.data.revision, written: maskText(command) });
    if (dryRun) return finish({ ok: true });
    if (status() !== 'ready') throw new Error(t('hooks.copy.notReady'));
    if (want.revision === undefined) throw new Error(t('hooks.write.changed'));
    if (p.reformatsFile && !allowReformat) throw new Error(t('hooks.write.reformat'));
    if (out.adapter && !out.adapter.exists) await writeAdapter(out.adapter.path, adapterFile.text, file.base);
    await commit(p, item);
    return finish({ ok: true, written: true, revision: digest(p.text) });
  }
  /**
   * 1 つの定義を他のエージェントへ写す。source: { agent, scope, base?, file, loc, revision? }、targets: [{ agent, scope, base?, name?, matcher?, revision? }]。
   * 元の定義はファイルから読み直す（画面から来たコマンドは使わない）。dryRun なら書かない。
   * 書くときは写す先ごとに、確認画面で見た revision と今の revision が同じで、写せる（ready）ものだけを書く。書けた先は戻さない
   */
  function copy({ source, targets, dryRun = false, allowReformat = false } = {}) {
    if (!record(source) || !Array.isArray(targets) || !targets.length || targets.length > 6) return Promise.reject(new Error(t('hooks.write.operation')));
    const loc = record(source.loc) ? source.loc : {};
    if ([loc.name, loc.event].some(k => typeof k === 'string' && RESERVED.has(k))) return Promise.reject(new Error(t('hooks.write.notFound')));
    const run = writes.catch(() => {}).then(async () => {
      const f = await target({ agent: source.agent, scope: source.scope, base: source.base, file: source.file ?? '\0' });
      const data = await load(f, f.base);
      if (data.error) throw new Error(data.error);
      if (source.revision !== undefined && source.revision !== data.revision) throw new Error(t('hooks.write.changed'));
      const found = locate(source.agent, data.map, loc);
      const groupKeys = found.group ? Object.keys(found.group).filter(k => !['matcher', 'hooks'].includes(k)) : [];
      const src = { agent: source.agent, scope: source.scope, base: f.base ?? null, event: loc.event, matcher: found.group?.matcher ?? null, handler: found.handler, groupKeys, name: loc.name ?? null };
      const adapterFile = await adapterSource();
      const results = [];
      for (const want of targets) {
        try { results.push(await copyOne(src, want, adapterFile, { dryRun, allowReformat })); }
        catch (e) { results.push({ agent: want?.agent, status: 'blocked', ok: false, error: e.message, reasons: [], warnings: [] }); }
      }
      const via = typeof found.handler.command === 'string' ? parseAdapterCommand(found.handler.command) : null;
      return { dryRun, source: { agent: source.agent, event: loc.event, matcher: src.matcher, revision: data.revision, path: f.path,
        command: maskText(via?.command ?? found.handler.command ?? ''), timeout: found.handler.timeout ?? null }, results };
    });
    writes = run;
    return run;
  }

  /**
   * 編集のシートを開くときだけ、指した handler の command・timeout・async とキーの名前を返す。
   * env・headers などほかの値は返さない（保存は元のファイルの handler を土台にするので要らない）
   */
  async function read({ agent, scope, base, file, loc }) {
    await writes.catch(() => {});
    const where = record(loc) ? loc : {};
    if ([where.name, where.event].some(k => typeof k === 'string' && RESERVED.has(k))) throw new Error(t('hooks.write.notFound'));
    const f = await target({ agent, scope, base, file: file ?? '\0' });
    const data = await load(f, f.base);
    if (data.error) throw new Error(data.error);
    const found = locate(agent, data.map, where);
    const h = found.handler;
    return { agent, scope, path: f.path, revision: data.revision, event: where.event, name: where.name ?? null, matcher: found.group?.matcher ?? null,
      command: typeof h.command === 'string' ? h.command : null, timeout: own(h, 'timeout') ? h.timeout : null, async: h.async === true, keys: Object.keys(h),
      editable: handlerType(h) === 'command' && typeof h.command === 'string',
      ...(agent === 'antigravity' ? { enabled: data.map[where.name]?.enabled !== false } : {}) };
  }
  return { scan, save, read, targets, copy, places };
}

// 1 つの会話に残す hooks の発火の記録の上限（core/server.mjs）
export const HOOK_RUNS_MAX = 60;
/** 発火の記録を上限まで減らす。古いほうから、開始と応答の組ごとに捨てる（片方だけ残さない）。新しいほうを残す */
export function trimHookRuns(list, max = HOOK_RUNS_MAX) {
  while (list.length > max) {
    const first = list.shift();
    if (first?.phase === 'started' && first.hookId) {
      const i = list.findIndex(r => r.phase === 'response' && r.hookId === first.hookId);
      if (i >= 0) list.splice(i, 1);
    }
  }
  return list;
}

const CODEX_READ_ONLY = { plugin: 'plugin', system: 'managed', mdm: 'managed', cloudRequirements: 'managed', cloudManagedConfig: 'managed',
  legacyManagedConfigFile: 'managed', legacyManagedConfigMdm: 'managed', sessionFlags: 'managed' };
/**
 * Codex の hooks/list（app-server）の結果を探索の行に重ねる。key は `<sourcePath>:<event の snake_case>:<group>:<handler>`。
 * 行には trust: { status, enabled, hash } を付ける。取れなかったとき（data が null）は trust: null と trustError。
 * ユーザー・プロジェクト以外（プラグイン・管理）の hooks は読み取りのみの行として足す
 */
export function applyCodexHooks(report, data, error = null) {
  const codexRows = report.entries.filter(e => e.agent === 'codex');
  if (!Array.isArray(data)) { for (const e of codexRows) { e.trust = null; e.trustError = error ?? true; } return report; }
  const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const seen = new Set();
  for (const entry of data) for (const h of entry?.hooks ?? []) {
    if (!h?.key || seen.has(h.key)) continue;
    seen.add(h.key);
    const m = /:([a-z_]+):(\d+):(\d+)$/.exec(h.key);
    const event = h.eventName ? h.eventName[0].toUpperCase() + h.eventName.slice(1) : m ? camel(m[1]).replace(/^./, c => c.toUpperCase()) : null;
    const trust = { status: typeof h.trustStatus === 'string' ? h.trustStatus : null, enabled: h.enabled !== false, hash: h.currentHash ?? null };
    const row = m && codexRows.find(e => pathKey(e.path) === pathKey(h.sourcePath ?? '') && e.event === event && e.group === Number(m[2]) && e.handler === Number(m[3]));
    if (row) { row.trust = trust; continue; }
    const scope = CODEX_READ_ONLY[h.source] ?? (h.isManaged ? 'managed' : null);
    if (!scope || !event) continue;
    const definition = maskDefinition({ type: h.handlerType ?? 'command', ...(h.command ? { command: h.command } : {}), ...(h.server ? { server: h.server, tool: h.tool } : {}),
      ...(h.timeoutSec ? { timeout: h.timeoutSec } : {}), ...(h.async ? { async: true } : {}) });
    report.entries.push({ id: digest(['codex', h.key].join('\0')).slice(0, 24), agent: 'codex', scope, base: null, path: h.sourcePath ?? '', format: null, kind: 'codex-list',
      readOnly: true, stop: 'codex', event, group: m ? Number(m[2]) : 0, handler: m ? Number(m[3]) : 0, type: h.handlerType === 'mcpTool' ? 'mcp_tool' : h.handlerType ?? 'command',
      command: h.command ? maskText(h.command) : '', matcher: typeof h.matcher === 'string' ? h.matcher : null, timeout: h.timeoutSec ?? null, async: h.async === true,
      editable: false, definition, unknownKeys: [], trust, ...(h.pluginId ? { plugin: h.pluginId } : {}) });
  }
  for (const e of codexRows) if (!('trust' in e)) e.trust = null;
  return report;
}

/** 1 行が TOML のコメントを持つか（行全体のコメントと、文字列の外の行末のコメント） */
const hasComment = line => /#/.test(line.replace(/"""[^]*?"""|'''[^]*?'''|"(?:\\.|[^"\\])*"|'[^']*'/g, ''));
/** hooks の表の見出しか（[hooks] / [hooks.X] / [[hooks.X]] / [[hooks.X.hooks]]） */
function hooksHeader(text, index, header) {
  try {
    tomlParse(text.slice(0, index)); // 複数行の文字列の中の見かけの見出しは除く
    return own(tomlParse(header), 'hooks');
  } catch {
    // 見出しだけで読めないもの。hooks の表の形なら抜く対象にする（抜いた結果は下で読み直して確かめる）
    return /^\s*\[\[?\s*hooks\s*[.\]]/.test(header);
  }
}

/**
 * Codex の config.toml へ書く本文を作る。hooks 以外の本文・コメント・改行コード・BOM はそのまま残す。
 *  - add（hint あり）: 既存の表に触らず、末尾に [[hooks.<イベント>]] の 1 ブロックだけ足す（TOML の配列の表は離れた位置で続けて書ける）
 *  - それ以外・足すだけでは合わないとき: hooks の表（見出しから次の見出しの手前まで。末尾のコメント行と空行は残す）を抜き、
 *    最初の hooks の表の位置に書き直す。抜く範囲にコメントがあれば消える行数を lostComments に数え、reformatsFile にする（画面で許可を取る）
 * どちらも読み直した結果が期待どおりのときだけ使う。インライン・ドットの定義などで合わなければ、全体の書き直し（reformatsFile）
 */
export function renderToml(source, config, hint = null) {
  const src = String(source ?? '');
  const bom = src.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = src.replace(/^\uFEFF/, '');
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const toEol = s => s.replace(/\r?\n/g, eol);
  const same = body => { try { return isDeepStrictEqual(tomlParse(body), config); } catch { return false; } };
  const out = (body, extra) => ({ text: bom + body, ...extra });
  if (hint?.op === 'add' && hint.entry) {
    const block = toEol(tomlStringify({ hooks: { [hint.event]: [hint.entry] } })).replace(/\s*$/, '');
    const body = `${text.trim() ? `${text.replace(/\s*$/, '')}${eol}${eol}` : ''}${block}${eol}`;
    if (same(body)) return out(body, { reformatsFile: false, lostComments: 0 });
  }
  const heads = [];
  for (const match of text.matchAll(/^[ \t]*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/gm)) heads.push({ start: match.index, target: hooksHeader(text, match.index, match[0]) });
  const cuts = [];
  let lost = 0;
  heads.forEach((h, i) => {
    if (!h.target) return;
    const end = heads[i + 1]?.start ?? text.length;
    const lines = text.slice(h.start, end).split(/(?<=\n)/);
    // 末尾のコメント行と空行は次の表の側に返す（次の表の説明のことが多い。コメントで止めた定義もここに来る）
    let keep = lines.length;
    while (keep > 1 && /^\s*(#.*)?(\r?\n)?$/.test(lines[keep - 1])) keep--;
    // 次も hooks の表で、間が空行だけなら、その空行も抜く（書き直した表の間に空行がたまらないように）
    if (heads[i + 1]?.target && !lines.slice(keep).some(l => l.includes('#'))) keep = lines.length;
    const cut = lines.slice(0, keep);
    lost += cut.filter(hasComment).length;
    cuts.push({ start: h.start, end: h.start + cut.join('').length });
  });
  const hooks = config.hooks;
  const block = hooks && Object.keys(hooks).length ? toEol(tomlStringify({ hooks })).replace(/\s*$/, '') + eol : '';
  let body;
  if (cuts.length) {
    const head = text.slice(0, cuts[0].start);
    let rest = '', pos = cuts[0].end;
    for (let i = 1; i < cuts.length; i++) { rest += text.slice(pos, cuts[i].start); pos = cuts[i].end; }
    rest += text.slice(pos);
    // 書き直した表の後ろに空行を 1 つ置く（次の表・コメントとくっつかないように）
    body = head + block + (block && rest && !/^\r?\n/.test(rest) ? eol : '') + rest;
  } else body = block ? `${text.trim() ? `${text.replace(/\s*$/, '')}${eol}${eol}` : ''}${block}` : text;
  if (!body.endsWith('\n')) body += eol;
  if (same(body)) return out(body, { reformatsFile: lost > 0, lostComments: lost, ...(lost ? { reason: 'comments' } : {}) });
  return out(toEol(tomlStringify(config)), { reformatsFile: true, lostComments: text.split(/\n/).filter(hasComment).length, reason: 'rewrite' });
}
