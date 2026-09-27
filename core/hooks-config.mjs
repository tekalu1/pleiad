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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import { parse as yaml } from 'yaml';
import { pathKey, scanDirectory } from './context-settings.mjs';
import { FRONTMATTER } from './context-scan.mjs';
import { redactSecrets } from './redact.mjs';
import { renameRetry } from './atomic-file.mjs';
import { t } from './i18n.mjs';

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
const FLAG_VALUE = /((?:^|\s)--?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth(?:orization)?)[\w-]*\s+)(?!-)("[^"]*"|'[^']*'|\S+)/gi;
/** 文字列 1 つの伏せ字。形で分かる秘密だけ（伏せ漏れはありうる） */
export const maskText = s => redactSecrets(String(s)).replace(FLAG_VALUE, `$1${MASK}`);
/** 画面に出す形。env・headers の値は伏せ、文字列は形で秘密を伏せる。元の値は変えない */
export function maskDefinition(value) {
  if (Array.isArray(value)) return value.map(maskDefinition);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, SECRET_KEYS.has(k) && record(v) ? Object.fromEntries(Object.keys(v).map(n => [n, MASK])) : maskDefinition(v)]));
  return typeof value === 'string' ? maskText(value) : value;
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

/** 1 つの handler の要約（行に出す分）。値は伏せてから切る */
function summary(h) {
  const text = maskText(commandOf(h));
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
      definition: maskDefinition(h), unknownKeys: Object.keys(h).filter(k => !['type', 'command', 'timeout', 'async'].includes(k)), ...extra });
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

export function createHooksConfig({ home = os.homedir(), codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex'),
  claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), geminiHome = path.join(home, '.gemini') } = {}) {
  const places = { home, codexHome, claudeHome, geminiHome };
  let writes = Promise.resolve();

  /** ファイルを読む。無ければ exists: false。読めない・形が違うときは error（原文の中身は出さない） */
  async function load(file) {
    let text = '', real = file.path, mode = 0o600, exists = false;
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
        const data = await load(file);
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
    if (file) {
      const hit = list.find(f => pathKey(f.path) === pathKey(file));
      if (!hit) throw new Error(t('hooks.write.target'));
      return { ...hit, base: dir };
    }
    // 追加の既定の書き先。すでに定義を置いているファイルがあればそちら（Codex の TOML、agy の CLI の settings.json）。二重に登録しない
    if (list.length > 1) {
      for (const f of list.slice(1)) {
        const data = await load(f);
        if (!data.error && data.declared && Object.keys(data.map).length) return { ...f, base: dir };
      }
    }
    return { ...list[0], base: dir };
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
    if (input.timeout === null || input.timeout === undefined || input.timeout === '') delete out.timeout;
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

  /** 指し先の handler。無い・command でないときは例外（別の人が変えた・読み取りのみ） */
  function locate(agent, map, loc) {
    const holder = agent === 'antigravity' ? map[loc.name] : map;
    if (!record(holder)) throw new Error(t('hooks.write.notFound'));
    const list = holder[loc.event];
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
  function insert(agent, map, { name, event, matcher }, handler) {
    let holder = map;
    if (agent === 'antigravity') {
      if (!validName(name)) throw new Error(t('hooks.write.name'));
      if (own(map, name) && !record(map[name])) throw new Error(t('hooks.write.format'));
      holder = map[name] ??= {};
    }
    if (own(holder, event) && !Array.isArray(holder[event])) throw new Error(t('hooks.write.format'));
    const list = holder[event] ??= [];
    if (agent === 'antigravity' && !AGY_TOOL_EVENTS.has(event)) list.push(handler);
    else list.push({ ...(matcher || (agent === 'antigravity') ? { matcher: matcher || '*' } : {}), hooks: [handler] });
  }

  /**
   * 1 件の変更を組み立てる（書かない）。op: add / edit / delete / enable。
   * 返すのは書き込む本文と、画面の差分に使う前後の hooks（そのイベント・名前だけ。伏せ字）
   */
  async function plan(item) {
    const op = item?.op;
    if (!['add', 'edit', 'delete', 'enable'].includes(op)) throw new Error(t('hooks.write.operation'));
    const file = await target({ agent: item.agent, scope: item.scope, base: item.base, file: op === 'add' ? item.file : item.file ?? '\0' });
    const data = await load(file);
    if (data.error) throw new Error(data.error);
    if (op !== 'add' && item.revision !== data.revision) throw new Error(t('hooks.write.changed'));
    if (op === 'add' && item.revision !== undefined && item.revision !== data.revision) throw new Error(t('hooks.write.changed'));
    const agent = item.agent;
    const map = structuredClone(data.map);
    const before = structuredClone(data.map);
    const loc = item.loc ?? {};
    if (op === 'enable') {
      if (agent !== 'antigravity' || !record(map[loc.name])) throw new Error(t('hooks.write.notFound'));
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
      if (op === 'add') insert(agent, map, { name, event, matcher }, cleanHandler(item, agent));
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
          // イベント・名前が変わった、または他の handler と group を共有している: 取り出して新しい group に入れる
          removeAt(agent, map, loc);
          if (agent === 'antigravity' && name !== loc.name && record(map[loc.name]) && !Object.keys(map[loc.name]).some(k => k !== 'enabled')) delete map[loc.name];
          insert(agent, map, { name: name ?? loc.name, event, matcher }, next);
        }
      }
    }
    const config = withHooks(file.kind, data.config ?? {}, map);
    const rendered = file.format === 'toml' ? renderToml(data.text, config) : { text: JSON.stringify(config, null, 2) + '\n', reformatsFile: false };
    if (Buffer.byteLength(rendered.text) > LIMIT) throw new Error(t('hooks.write.tooLarge'));
    const pick = m => {
      const keys = agent === 'antigravity' ? [...new Set([loc.name, item.name].filter(Boolean))] : [...new Set([loc.event, item.event].filter(Boolean))];
      return maskDefinition(Object.fromEntries(keys.filter(k => own(m, k)).map(k => [k, m[k]])));
    };
    return { file, data, text: rendered.text, reformatsFile: rendered.reformatsFile, before: pick(before), after: pick(map) };
  }
  /**
   * 変更をまとめて受ける。dryRun なら書かずに書き先・前後の差分・書き直しの要否だけ返す。
   * 複数の書き先は 1 件ずつ書き、失敗しても書けた先はそのまま結果に残す（部分成功を明示する）
   */
  function save({ items, dryRun = false, allowReformat = false } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 12) return Promise.reject(new Error(t('hooks.write.operation')));
    const run = writes.catch(() => {}).then(async () => {
      const results = [];
      for (const item of items) {
        try {
          const p = await plan(item);
          const base = { agent: item.agent, op: item.op, path: p.file.path, format: p.file.format, reformatsFile: p.reformatsFile, before: p.before, after: p.after, revision: p.data.revision };
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
      const current = await load(p.file);
      if (current.revision !== p.data.revision || pathKey(current.real) !== pathKey(p.data.real)) throw new Error(t('hooks.write.changedReload'));
      await renameRetry(tmp, p.data.real);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  /** 編集のシートを開くときだけ、指した handler の元の値を返す（一覧は伏せ字だけ） */
  async function read({ agent, scope, base, file, loc }) {
    await writes.catch(() => {});
    const f = await target({ agent, scope, base, file: file ?? '\0' });
    const data = await load(f);
    if (data.error) throw new Error(data.error);
    const found = locate(agent, data.map, loc ?? {});
    return { agent, scope, path: f.path, revision: data.revision, event: loc.event, name: loc.name ?? null, matcher: found.group?.matcher ?? null,
      handler: found.handler, editable: handlerType(found.handler) === 'command' && typeof found.handler.command === 'string',
      ...(agent === 'antigravity' ? { enabled: data.map[loc.name]?.enabled !== false } : {}) };
  }
  return { scan, save, read, targets, places };
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

/**
 * Codex の config.toml の hooks だけを置き換える。[hooks…] の表（[[hooks.X]] を含む）を抜いて末尾に書き直し、
 * 読み直した結果が期待どおりのときだけ使う。インライン・ドットの定義など、局所的に置き換えられなければ全体の書き直しを返す
 */
export function renderToml(text, config) {
  const blocks = [];
  for (const match of String(text ?? '').matchAll(/^\s*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/gm)) {
    try {
      tomlParse(text.slice(0, match.index)); // 複数行の文字列の中の見かけの見出しは除く
      const header = tomlParse(match[0]);
      blocks.push({ start: match.index, target: own(header, 'hooks') });
    } catch {
      // 見出しだけで読めないもの。hooks の表の形なら抜く対象にする（抜いた結果は下で読み直して確かめる）
      blocks.push({ start: match.index, target: /^\s*\[\[?\s*hooks\s*[.\]]/.test(match[0]) });
    }
  }
  let next = '', offset = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].target) continue;
    next += text.slice(offset, blocks[i].start);
    offset = blocks[i + 1]?.start ?? text.length;
  }
  next += text.slice(offset);
  const hooks = config.hooks;
  next = hooks && Object.keys(hooks).length ? `${next.trimEnd()}\n\n${tomlStringify({ hooks })}`.trimStart() : next;
  if (!next.endsWith('\n')) next += '\n';
  try { if (isDeepStrictEqual(tomlParse(next), config)) return { text: next, reformatsFile: false }; } catch {}
  return { text: tomlStringify(config), reformatsFile: true };
}
