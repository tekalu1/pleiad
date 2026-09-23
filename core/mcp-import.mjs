// Claude / Codex の設定にある MCP 登録を、1 回の操作で Pleiad の登録（core/ply-mcp.mjs）として取り込む。
//
// 取り込むのは「どこへ・どうつなぐか」だけ: URL・コマンド・ヘッダー名・env のキー、Claude の `oauth`（clientId・callbackPort）、
// Codex の `scopes`・`oauth_resource`・`bearer_token_env_var`・`env_http_headers` など。
// 秘密の値（ヘッダーの値・env の値・bearer）は includeSecrets を選んだときだけ写す。選ばなければ「未入力」（null）で登録し、
// 値を入れるまでその MCP にはつながない。
//
// エージェントが持っている OAuth のトークン（Claude の資格情報・Codex の保存したトークン）は流用しない。
// 理由: 多くの認可サーバーはリフレッシュトークンをローテーションする（使うたびに新しいものに替え、古いものを無効にする）。
// Pleiad が同じリフレッシュトークンを使うと、次に元のエージェントがリフレッシュするときに invalid_grant になり、
// エージェント側のログインが壊れる。取り込んだ OAuth の登録は「未ログイン」から始まり、Pleiad でログインし直す。
// エージェントの設定ファイルは読むだけで書き換えない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FORBIDDEN_HEADERS } from './ply-mcp.mjs';
import { pathKey } from './context-settings.mjs';
import { t } from './i18n.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string');

/**
 * Claude の ${VAR} / ${VAR:-既定値} を展開する。見つからない変数があれば missing に名前を入れる
 */
function expand(text, env, missing) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name, fallback) => {
    if (env[name] !== undefined) return env[name];
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return all;
  });
}

/**
 * ネイティブの定義を Pleiad の登録の値に変える（ネットワークには出ない）。
 * 戻り値の auth が undefined なら、HTTP で認証の手がかりが無い（取り込む側で MCP に 1 回つないで決める）
 * @returns {{ value: object, notes: string[], authHint?: string }}
 */
export function convertNative(format, native, { includeSecrets = false, env = process.env } = {}) {
  if (!record(native)) throw new Error(t('mcp.import.invalid'));
  const notes = [];
  const value = {};
  const secret = (label, raw) => {
    // 値を写さないときは null（未入力）。写すときは Claude の ${VAR} を展開し、足りなければ未入力にする
    if (!includeSecrets) return null;
    if (typeof raw !== 'string') return null;
    if (format !== 'claude') return raw;
    const missing = [];
    const out = expand(raw, env, missing);
    if (missing.length) { notes.push(t('mcp.import.secretMissing', { label, names: missing.join(', ') })); return null; }
    return out;
  };
  const fromEnv = (label, variable) => {
    if (!includeSecrets) return null;
    if (env[variable] === undefined) { notes.push(t('mcp.import.secretMissing', { label, names: variable })); return null; }
    return env[variable];
  };
  const plain = (label, raw) => {
    if (format !== 'claude' || typeof raw !== 'string') return raw;
    const missing = [];
    const out = expand(raw, env, missing);
    if (missing.length) throw new Error(t('mcp.import.envMissing', { label, names: missing.join(', ') }));
    return out;
  };
  const known = new Set();
  const take = (...keys) => keys.forEach(k => known.add(k));

  const stdio = typeof native.command === 'string';
  if (format === 'claude') {
    take('type', 'command', 'args', 'env', 'url', 'headers', 'oauth');
    const type = native.type ?? (stdio ? 'stdio' : 'http');
    if (!['stdio', 'http', 'sse'].includes(type)) throw new Error(t('mcp.import.transport', { type }));
    value.transport = type;
  } else if (format === 'codex') {
    take('command', 'args', 'env', 'env_vars', 'cwd', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'scopes', 'oauth_resource',
      'enabled', 'startup_timeout_sec', 'startup_timeout_ms', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools');
    value.transport = stdio ? 'stdio' : 'http';
  } else throw new Error(t('mcp.import.format'));

  if (value.transport === 'stdio') {
    value.command = plain('command', native.command);
    if (native.args !== undefined) { if (!strings(native.args)) throw new Error(t('mcp.import.args')); value.args = native.args.map(a => plain('args', a)); }
    if (typeof native.cwd === 'string') value.cwd = native.cwd;
    const envOut = {};
    if (record(native.env)) for (const [k, v] of Object.entries(native.env)) envOut[k] = secret(t('mcp.import.labelEnv', { name: k }), String(v));
    // Codex の env_vars は「親の環境からそのまま渡す変数名」。値は Pleiad を動かしている環境から写す
    if (format === 'codex' && strings(native.env_vars)) for (const k of native.env_vars) envOut[k] ??= fromEnv(t('mcp.import.labelEnv', { name: k }), k);
    if (Object.keys(envOut).length) value.env = envOut;
    value.auth = 'none';
  } else {
    if (typeof native.url !== 'string') throw new Error(t('mcp.import.noUrl'));
    value.url = plain('url', native.url);
    const headers = {};
    const addHeader = (name, v) => {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) { notes.push(t('mcp.import.forbiddenHeader', { name })); return; }
      headers[name] = v;
    };
    if (record(native.headers)) for (const [k, v] of Object.entries(native.headers)) addHeader(k, secret(t('mcp.import.labelHeader', { name: k }), String(v)));
    if (format === 'codex') {
      if (record(native.http_headers)) for (const [k, v] of Object.entries(native.http_headers)) addHeader(k, secret(t('mcp.import.labelHeader', { name: k }), String(v)));
      if (record(native.env_http_headers)) for (const [k, variable] of Object.entries(native.env_http_headers)) addHeader(k, fromEnv(t('mcp.import.labelHeader', { name: k }), String(variable)));
    }
    const bearerVar = format === 'codex' && typeof native.bearer_token_env_var === 'string' ? native.bearer_token_env_var : null;
    const oauthHint = format === 'claude' ? record(native.oauth) : (native.scopes !== undefined || native.oauth_resource !== undefined);
    if (oauthHint) {
      value.auth = 'oauth';
      const o = {};
      if (format === 'claude') {
        for (const [k, v] of Object.entries(native.oauth)) {
          if (k === 'clientId' && typeof v === 'string' && v) o.clientId = v;
          else if (k === 'callbackPort' && Number.isInteger(v)) o.callbackPort = v;
          else if (k === 'scope' && typeof v === 'string' && v) o.scope = v;
          else notes.push(t('mcp.import.oauthField', { key: k }));
        }
        // Claude のクライアントシークレットは設定ファイルではなく資格情報の保管庫にある
        if (o.clientId) notes.push(t('mcp.import.clientSecret'));
      } else {
        if (strings(native.scopes) && native.scopes.length) o.scope = native.scopes.join(' ');
        if (typeof native.oauth_resource === 'string' && native.oauth_resource) o.resource = native.oauth_resource;
      }
      if (Object.keys(o).length) value.oauth = o;
      if (Object.keys(headers).length || bearerVar) notes.push(t('mcp.import.oauthHeaders'));
    } else if (bearerVar && !Object.keys(headers).length) {
      value.auth = 'bearer';
      value.bearerToken = fromEnv('bearer', bearerVar);
    } else if (bearerVar || Object.keys(headers).length) {
      // bearer とほかのヘッダーの併用は、Authorization ヘッダーとしてまとめる
      if (bearerVar) { const token = fromEnv('bearer', bearerVar); headers.Authorization = token === null ? null : `Bearer ${token}`; }
      value.auth = 'headers';
      value.headers = headers;
    }
  }
  if (format === 'codex') {
    if (native.enabled === false) value.enabled = false;
    const startup = Number.isFinite(native.startup_timeout_sec) ? native.startup_timeout_sec : Number.isFinite(native.startup_timeout_ms) ? native.startup_timeout_ms / 1000 : undefined;
    if (startup !== undefined) value.startup_timeout_sec = Math.min(3600, Math.max(1, startup));
    if (Number.isFinite(native.tool_timeout_sec)) value.tool_timeout_sec = Math.min(3600, Math.max(1, native.tool_timeout_sec));
    if (strings(native.enabled_tools)) value.enabled_tools = native.enabled_tools;
    if (strings(native.disabled_tools)) value.disabled_tools = native.disabled_tools;
  }
  const ignored = Object.keys(native).filter(k => !known.has(k));
  if (ignored.length) notes.push(t('mcp.import.ignored', { keys: ignored.join(', ') }));
  return { value, notes };
}

/** Claude の「このディレクトリだけ」の登録（~/.claude.json の projects[cwd].mcpServers） */
async function claudeLocal(home, cwd, name) {
  let config;
  try { config = JSON.parse((await fs.readFile(path.join(home, '.claude.json'), 'utf8')).replace(/^﻿/, '')); }
  catch { throw new Error(t('mcp.import.claudeJson')); }
  const project = Object.entries(config?.projects ?? {}).find(([p]) => pathKey(p) === pathKey(cwd))?.[1];
  const value = project?.mcpServers?.[name];
  if (!record(value)) throw new Error(t('mcp.import.notFound'));
  return value;
}

/**
 * まとめて取り込む。1 件失敗しても残りは続ける。
 * @param {object} o
 * @param {Array<{ format: 'claude'|'codex', scope: 'user'|'directory'|'local', cwd?: string, name: string, as?: string, auth?: string }>} o.items
 * @param {boolean} [o.includeSecrets] ヘッダーの値・env の値・bearer を写すか（既定は写さない）
 * @param {ReturnType<import('./mcp-config.mjs').createMcpConfig>} o.mcpConfig
 * @param {ReturnType<import('./ply-mcp.mjs').createPlyMcp>} o.plyMcp
 * @param {(definition: object) => Promise<{ oauth: boolean }>} [o.detect] 認証の手がかりが無い HTTP の MCP に 1 回つないで OAuth か見る
 */
export async function importNativeMcp({ items, includeSecrets = false, mcpConfig, plyMcp, detect, env = process.env, home = os.homedir() }) {
  if (!Array.isArray(items) || !items.length || items.length > 64) throw Object.assign(new Error(t('mcp.import.count')), { code: 'INVALID' });
  const results = [];
  for (const item of items) {
    const from = { format: item?.format, scope: item?.scope, name: item?.name };
    const name = typeof item?.as === 'string' && item.as ? item.as : item?.name;
    try {
      const cwd = item.cwd ?? process.cwd();
      const native = item.format === 'claude' && item.scope === 'local' ? await claudeLocal(home, cwd, item.name)
        : (await mcpConfig.get({ cwd, format: item.format, scope: item.scope, name: item.name })).value;
      const { value, notes } = convertNative(item.format, native, { includeSecrets, env });
      if (item.auth !== undefined) {
        if (!['none', 'oauth'].includes(item.auth) || value.transport === 'stdio' || (value.auth && value.auth !== 'none' && value.auth !== item.auth)) throw new Error(t('mcp.import.auth'));
        value.auth = item.auth;
      } else if (!value.auth) {
        // 手がかりが無い HTTP の MCP。Claude はつないでみて 401 なら OAuth に進むので、同じく 1 回つないで決める
        const found = detect ? await detect({ transport: value.transport, url: value.url }).catch(() => ({ oauth: false })) : { oauth: false };
        value.auth = found.oauth ? 'oauth' : 'none';
        notes.push(found.oauth ? t('mcp.import.detectedOauth') : t('mcp.import.detectedNone'));
      }
      const saved = await plyMcp.save({ name, mode: 'add', value });
      results.push({ ok: true, name, from, auth: value.auth, pending: saved.registration.pending ?? [], notes,
        // OAuth は取り込んだ直後は未ログイン。トークンはエージェントのものを流用しない（ファイル先頭のコメント）
        ...(value.auth === 'oauth' ? { needsLogin: true } : {}) });
    } catch (e) {
      results.push({ ok: false, name, from, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return { results, imported: results.filter(r => r.ok).length };
}
