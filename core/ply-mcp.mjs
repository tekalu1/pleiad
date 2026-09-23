// Pleiad 自身が持つ外部 MCP の登録（担当が「Pleiad」のときに context-bridge が接続するもの）。
// 各エージェントの設定ファイル（~/.claude.json・config.toml など）は書き換えない。そちらからの読み込みは
// context-scan が今までどおり行い、同名があるときはここの登録を優先する。
//
// 置き場: <データ置き場>/mcp-servers.json（秘密を含まない定義。権限 0600）
//         <データ置き場>/mcp-secrets.json（bearer・ヘッダー値・env の値・clientSecret・OAuth の状態。core/secret-store.mjs）
// 画面・API に返すのは定義と「どの秘密があるか」だけで、秘密の値は伏せ字（••••）にする。
// 伏せ字のまま保存し直したものは「前の値を残す」と読む。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withFileLock } from './secret-store.mjs';

export const MASK = '••••';
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
const NAME = /^[a-zA-Z0-9_.-]{1,128}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype', 'host', 'ply', 'ply_context', 'ply_agents'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// 接続そのものを壊すか、Pleiad が決めるべきヘッダー。認証は auth の方で指定する
export const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'proxy-authorization', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'accept']);
export const AUTH_KINDS = ['none', 'bearer', 'headers', 'oauth'];
const maskQuery = url => typeof url === 'string' ? url.replace(/\?[^]*$/, `?${MASK}`) : url;
const secretKey = (name, part) => `mcp:${name}:${part}`;

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID' }); }
function plainValue(v, label) {
  if (typeof v !== 'string' || v.length > 8192 || /[\r\n\0]/.test(v)) throw invalid(`${label} は改行を含まない 8 KiB 以内の文字列で指定してください`);
  return v;
}
function stringMap(v, label, { keyPattern, max = 20, nullable = false } = {}) {
  if (v === undefined) return {};
  if (!record(v)) throw invalid(`${label} は文字列の値を持つオブジェクトで指定してください`);
  const entries = Object.entries(v);
  if (entries.length > max) throw invalid(`${label} は ${max} 件までです`);
  for (const [k, s] of entries) {
    if (keyPattern && !keyPattern.test(k)) throw invalid(`${label} の名前「${k.slice(0, 40)}」は使えません`);
    // null は「値はまだ入れていない」（ネイティブ登録を秘密なしで取り込んだもの）
    if (!(nullable && s === null)) plainValue(s, `${label}「${k}」の値`);
  }
  return Object.fromEntries(entries);
}
function seconds(v, label) {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || v <= 0 || v > 3600) throw invalid(`${label} は 1〜3600 の秒数で指定してください`);
  return v;
}
function names(v, label) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 500 || !v.every(s => typeof s === 'string' && s.length <= 256)) throw invalid(`${label} は文字列の配列で指定してください`);
  return v;
}

/**
 * 画面から来た値を、保存する定義（秘密なし）と秘密に分ける。
 * previous は編集前の { definition, secrets }。伏せ字の値と、伏せ字にした URL は前の値を残す。
 */
export function splitRegistration(value, previous = null) {
  if (!record(value)) throw invalid('MCP の定義を JSON オブジェクトで指定してください');
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw invalid('MCP の定義は 64 KiB 以内にしてください');
  const allowed = ['transport', 'url', 'command', 'args', 'cwd', 'env', 'auth', 'bearerToken', 'headers', 'oauth', 'enabled', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools'];
  const unknown = Object.keys(value).filter(k => !allowed.includes(k));
  if (unknown.length) throw invalid(`未対応の項目：${unknown.join(', ')}`);
  const before = previous?.definition, oldSecrets = previous?.secrets ?? {};
  // 秘密の値の読み方: 文字列 = その値、伏せ字 = 前の値を残す、null = まだ入れていない（未入力のまま保存し、接続はしない）
  const pending = [];
  const LOST = Symbol('lost');
  const secretValue = (key, v, old) => {
    if (v === null) { pending.push(key); return undefined; }
    if (v === MASK) {
      if (old !== undefined) return old;
      if (before?.pending?.includes(key)) { pending.push(key); return undefined; }
      return LOST;
    }
    return v;
  };
  const collect = (entries, key, old, label) => {
    const out = {}, lost = [];
    for (const [k, v] of entries) { const r = secretValue(key(k), v, old?.[k]); if (r === LOST) lost.push(k); else if (r !== undefined) out[k] = r; }
    if (lost.length) throw invalid(`${label}「${lost.join(', ')}」の前の値がありません。値を入力してください`);
    return out;
  };
  const transport = value.transport ?? (typeof value.command === 'string' ? 'stdio' : 'http');
  if (!['http', 'sse', 'stdio'].includes(transport)) throw invalid('transport は http・sse・stdio のどれかです');
  const auth = value.auth ?? 'none';
  if (!AUTH_KINDS.includes(auth)) throw invalid(`auth は ${AUTH_KINDS.join('・')} のどれかです`);
  const definition = { transport, auth, enabled: value.enabled !== false };
  const secrets = {};
  if (transport === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim() || own(value, 'url')) throw invalid('stdio は command を指定し、url は指定しません');
    if (auth !== 'none') throw invalid('stdio の MCP の認証は env で渡してください（auth は none）');
    definition.command = plainValue(value.command, 'command');
    if (own(value, 'args')) {
      if (!Array.isArray(value.args) || value.args.length > 200 || !value.args.every(a => typeof a === 'string')) throw invalid('args は文字列の配列で指定してください');
      definition.args = value.args;
    }
    if (own(value, 'cwd')) definition.cwd = plainValue(value.cwd, 'cwd');
    const env = stringMap(value.env, 'env', { keyPattern: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/, max: 64, nullable: true });
    if (Object.keys(env).length) {
      definition.envKeys = Object.keys(env);
      const values = collect(Object.entries(env), k => `env:${k}`, oldSecrets.env, 'env');
      if (Object.keys(values).length) secrets.env = values;
    }
  } else {
    if (own(value, 'command') || own(value, 'args') || own(value, 'env')) throw invalid('HTTP の MCP には command・args・env を指定しません');
    let url = value.url;
    if (before && url === maskQuery(before.url)) url = before.url;
    if (typeof url !== 'string' || url.length > 4096) throw invalid('url を指定してください');
    let parsed;
    try { parsed = new URL(url); } catch { throw invalid('url が不正です'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw invalid('url は認証情報を含まない http(s) で指定してください');
    definition.url = url;
    if (auth === 'bearer') {
      const token = secretValue('bearer', value.bearerToken === undefined ? MASK : value.bearerToken, oldSecrets.bearer);
      if (token === LOST || token === '') throw invalid('bearer の場合は bearerToken を指定してください');
      if (token !== undefined) secrets.bearer = plainValue(token, 'bearerToken');
    } else if (own(value, 'bearerToken')) throw invalid('bearerToken は auth が bearer のときだけ指定します');
    if (auth === 'headers') {
      const headers = stringMap(value.headers, 'headers', { keyPattern: HEADER_NAME, nullable: true });
      if (!Object.keys(headers).length) throw invalid('headers の場合は 1 つ以上のヘッダーを指定してください');
      const bad = Object.keys(headers).filter(k => FORBIDDEN_HEADERS.has(k.toLowerCase()));
      if (bad.length) throw invalid(`このヘッダーは指定できません：${bad.join(', ')}`);
      const values = collect(Object.entries(headers), k => `header:${k}`, oldSecrets.headers, 'ヘッダー');
      if (Object.keys(values).length) secrets.headers = values;
      if (Buffer.byteLength(JSON.stringify(secrets.headers ?? {})) > 16384) throw invalid('ヘッダーの合計は 16 KiB 以内にしてください');
      definition.headerNames = Object.keys(headers);
    } else if (own(value, 'headers')) throw invalid('headers は auth が headers のときだけ指定します');
    if (auth === 'oauth') {
      const o = value.oauth ?? {};
      if (!record(o)) throw invalid('oauth はオブジェクトで指定してください');
      const extra = Object.keys(o).filter(k => !['clientId', 'clientSecret', 'scope', 'callbackPort', 'resource'].includes(k));
      if (extra.length) throw invalid(`oauth の未対応の項目：${extra.join(', ')}`);
      definition.oauth = {};
      if (o.clientId !== undefined && o.clientId !== '') definition.oauth.clientId = plainValue(o.clientId, 'oauth.clientId');
      if (o.scope !== undefined && o.scope !== '') definition.oauth.scope = plainValue(o.scope, 'oauth.scope');
      if (o.callbackPort !== undefined && o.callbackPort !== null) {
        if (!Number.isInteger(o.callbackPort) || o.callbackPort < 1024 || o.callbackPort > 65535) throw invalid('oauth.callbackPort は 1024〜65535 の整数です');
        definition.oauth.callbackPort = o.callbackPort;
      }
      // RFC 8707 の resource を固定する（Codex の oauth_resource を取り込んだもの）。無ければ MCP の URL・保護リソースメタデータから決める
      if (o.resource !== undefined && o.resource !== '') {
        let r;
        try { r = new URL(plainValue(o.resource, 'oauth.resource')); } catch { throw invalid('oauth.resource は URL で指定してください'); }
        if (!['http:', 'https:'].includes(r.protocol) || r.hash) throw invalid('oauth.resource は # を含まない http(s) の URL で指定してください');
        definition.oauth.resource = o.resource;
      }
      const secret = o.clientSecret === MASK ? oldSecrets.clientSecret : o.clientSecret;
      if (secret) {
        if (!definition.oauth.clientId) throw invalid('clientSecret は clientId と一緒に指定してください');
        secrets.clientSecret = plainValue(secret, 'oauth.clientSecret');
        definition.oauth.clientSecret = true;
      }
    } else if (own(value, 'oauth')) throw invalid('oauth は auth が oauth のときだけ指定します');
  }
  for (const key of ['startup_timeout_sec', 'tool_timeout_sec']) { const v = seconds(value[key], key); if (v !== undefined) definition[key] = v; }
  for (const key of ['enabled_tools', 'disabled_tools']) { const v = names(value[key], key); if (v !== undefined) definition[key] = v; }
  if (pending.length) definition.pending = pending;
  // 名前を変えた登録はリフレッシュのロック名を引き継いでいる。編集では変えない
  if (before?.lockId) definition.lockId = before.lockId;
  return { definition, secrets };
}

/** OAuth の状態を作り直す必要がある変更か（接続先・方式・クライアントが変わった） */
export function oauthIdentityChanged(before, after) {
  if (!before) return true;
  return before.url !== after.url || before.auth !== after.auth || before.oauth?.clientId !== after.oauth?.clientId
    || before.oauth?.callbackPort !== after.oauth?.callbackPort || Boolean(before.oauth?.clientSecret) !== Boolean(after.oauth?.clientSecret)
    || before.oauth?.resource !== after.oauth?.resource;
}

/** 画面に返す形。秘密の値は含めない */
export function publicRegistration(name, definition) {
  const { lockId, ...rest } = definition;
  return { name, ...rest, ...(definition.url ? { url: maskQuery(definition.url) } : {}) };
}

/** 編集欄に出す形。秘密は伏せ字で入れておき、そのまま保存すれば前の値が残る */
export function editableRegistration(name, definition) {
  const { transport, url, command, args, cwd, auth, enabled, envKeys, headerNames, oauth, updatedAt, pending, lockId, ...rest } = definition;
  // 未入力の秘密は null で出す（そのまま保存すれば未入力のまま、値を入れれば埋まる）
  const shown = key => pending?.includes(key) ? null : MASK;
  return { name, value: {
    transport, ...(url ? { url: maskQuery(url) } : {}), ...(command ? { command } : {}), ...(args ? { args } : {}), ...(cwd ? { cwd } : {}),
    ...(envKeys ? { env: Object.fromEntries(envKeys.map(k => [k, shown(`env:${k}`)])) } : {}), auth,
    ...(auth === 'bearer' ? { bearerToken: shown('bearer') } : {}),
    ...(headerNames ? { headers: Object.fromEntries(headerNames.map(k => [k, shown(`header:${k}`)])) } : {}),
    ...(oauth ? { oauth: { ...(oauth.clientId ? { clientId: oauth.clientId } : {}), ...(oauth.clientSecret ? { clientSecret: MASK } : {}), ...(oauth.scope ? { scope: oauth.scope } : {}), ...(oauth.callbackPort ? { callbackPort: oauth.callbackPort } : {}), ...(oauth.resource ? { resource: oauth.resource } : {}) } } : {}),
    ...(enabled === false ? { enabled: false } : {}), ...rest,
  } };
}

export function createPlyMcp({ dataDir, secrets }) {
  const file = path.join(dataDir, 'mcp-servers.json');
  let writes = Promise.resolve();
  async function read() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.version !== 1 || !record(raw.servers)) throw new Error('bad');
      return raw;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, servers: {} };
      throw new Error('Pleiad の MCP 登録ファイルを読み込めません。形式が壊れています');
    }
  }
  async function write(data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  const revision = data => crypto.createHash('sha256').update(JSON.stringify(data.servers)).digest('hex').slice(0, 16);
  function serial(fn) { const run = writes.catch(() => {}).then(() => withFileLock(`${file}.lock`, fn)); writes = run; return run; }
  async function registration(name) {
    const data = await read();
    if (typeof name !== 'string' || !own(data.servers, name)) throw invalid('その名前の MCP は Pleiad に登録されていません');
    return data.servers[name];
  }
  return {
    file,
    async list() {
      await writes.catch(() => {});
      const data = await read();
      return { file, revision: revision(data), servers: Object.keys(data.servers).sort().map(n => publicRegistration(n, data.servers[n])) };
    },
    async read(name) {
      await writes.catch(() => {});
      const data = await read();
      if (!own(data.servers, name)) throw invalid('その名前の MCP は Pleiad に登録されていません');
      return { ...editableRegistration(name, data.servers[name]), revision: revision(data) };
    },
    registration,
    /** 追加・編集。戻り値の oauthReset は OAuth の状態（トークン・登録済みクライアント）を捨てたか */
    save({ name, value, mode, revision: expected } = {}) {
      return serial(async () => {
        if (typeof name !== 'string' || !NAME.test(name) || RESERVED.includes(name)) throw invalid('名前は英数字・_・.・- の128文字以内で指定してください（host・ply などは予約名です）');
        if (!['add', 'edit'].includes(mode)) throw invalid('追加または編集を指定してください');
        const data = await read();
        if (expected !== undefined && expected !== revision(data)) throw invalid('登録が変更されています。一覧を再読込してから編集してください');
        if (own(data.servers, name) !== (mode === 'edit')) throw invalid(mode === 'add' ? '同名の MCP が登録済みです。編集から開いてください' : '編集する MCP が見つかりません');
        const before = data.servers[name];
        const oldSecrets = before ? await secrets.get(secretKey(name, 'static')) ?? {} : {};
        const { definition, secrets: next } = splitRegistration(value, before ? { definition: before, secrets: oldSecrets } : null);
        const oauthReset = Boolean(before) && oauthIdentityChanged(before, definition);
        // 秘密を先に書く。定義だけ先に入ると、秘密の無い登録が一瞬見える
        if (Object.keys(next).length) await secrets.set(secretKey(name, 'static'), next);
        else await secrets.delete(secretKey(name, 'static'));
        if (oauthReset || definition.auth !== 'oauth') await secrets.delete(secretKey(name, 'oauth'));
        data.servers[name] = { ...definition, updatedAt: new Date().toISOString() };
        await write(data);
        return { name, oauthReset, revision: revision(data), registration: publicRegistration(name, data.servers[name]) };
      });
    },
    /**
     * 登録名を変える。定義・秘密（静的な秘密と OAuth の状態）をそのまま移し、リフレッシュのロック名（lockId）も引き継ぐ。
     * guard は「秘密を移す間、リフレッシュのロックを持つ」ためのもの（core/mcp-oauth.mjs の rename）。
     * 秘密は復号せずに移すので、この起動で復号できない暗号化済みの値も失わない
     */
    rename(name, to, { guard = (definition, fn) => fn() } = {}) {
      return serial(async () => {
        if (typeof to !== 'string' || !NAME.test(to) || RESERVED.includes(to)) throw invalid('名前は英数字・_・.・- の128文字以内で指定してください（host・ply などは予約名です）');
        const data = await read();
        if (typeof name !== 'string' || !own(data.servers, name)) throw invalid('その名前の MCP は Pleiad に登録されていません');
        if (name === to) throw invalid('同じ名前です');
        if (own(data.servers, to)) throw invalid('その名前の MCP は登録済みです');
        const before = data.servers[name];
        const definition = { ...before, lockId: before.lockId ?? name, updatedAt: new Date().toISOString() };
        await guard(before, async () => {
          await secrets.move(`mcp:${name}:`, `mcp:${to}:`);
          delete data.servers[name];
          data.servers[to] = definition;
          await write(data);
        });
        return { name: to, from: name, revision: revision(data), registration: publicRegistration(to, definition) };
      });
    },
    /** Pleiad の MCP 全体の設定。clientMetadataUrl は Client ID Metadata Document の URL（既定は無し） */
    async settings() {
      await writes.catch(() => {});
      const data = await read();
      return { clientMetadataUrl: data.settings?.clientMetadataUrl ?? null };
    },
    setSettings(value = {}) {
      return serial(async () => {
        if (!record(value)) throw invalid('設定はオブジェクトで指定してください');
        const unknown = Object.keys(value).filter(k => k !== 'clientMetadataUrl');
        if (unknown.length) throw invalid(`未対応の項目：${unknown.join(', ')}`);
        const data = await read();
        const settings = { ...(data.settings ?? {}) };
        if (own(value, 'clientMetadataUrl')) {
          const v = value.clientMetadataUrl;
          if (v === null || v === '') delete settings.clientMetadataUrl;
          else {
            let u;
            try { u = new URL(plainValue(v, 'clientMetadataUrl')); } catch { throw invalid('clientMetadataUrl は URL で指定してください'); }
            // draft-ietf-oauth-client-id-metadata-document: client_id は https で、パスを持つ URL（フラグメント・認証情報なし）
            if (u.protocol !== 'https:' || u.pathname === '/' || u.hash || u.username || u.password) throw invalid('clientMetadataUrl は、パスを持つ https の URL で指定してください（例: https://example.com/ply/oauth-client.json）');
            settings.clientMetadataUrl = u.href;
          }
        }
        if (Object.keys(settings).length) data.settings = settings; else delete data.settings;
        await write(data);
        return { clientMetadataUrl: settings.clientMetadataUrl ?? null };
      });
    },
    remove(name) {
      return serial(async () => {
        const data = await read();
        if (!own(data.servers, name)) throw invalid('その名前の MCP は Pleiad に登録されていません');
        delete data.servers[name];
        await write(data);
        await secrets.deletePrefix(`mcp:${name}:`);
        return { name, revision: revision(data) };
      });
    },
    /** 探索（context-scan）に渡す形。定義には秘密を含まない */
    async scanInput() {
      const data = await read().catch(() => ({ servers: {} }));
      return { file, servers: Object.entries(data.servers).map(([name, { lockId, ...definition }]) => ({ name, definition: { ...definition, ply: true } })) };
    },
    /**
     * 接続に使う形（context-bridge が使う）。ここで初めて秘密を読む。
     * OAuth のトークンはここでは付けない（core/mcp-oauth.mjs の authFetch が付ける）
     */
    async connection(name, cwd) {
      const definition = await registration(name);
      // 秘密なしで取り込んだ登録は、値を入れるまでつながない（空の値で送ると、認証の失敗が接続先に記録される）
      if (definition.pending?.length) throw Object.assign(new Error(`未入力の値があります（${definition.pending.join(', ')}）。設定 › コンテキストの外部 MCP で登録を編集して入力してください`), { code: 'MCP_AUTH_REQUIRED' });
      const stored = await secrets.get(secretKey(name, 'static')) ?? {};
      const timeout = Math.min(60000, (definition.startup_timeout_sec ?? 20) * 1000);
      if (definition.transport === 'stdio') {
        return { type: 'stdio', command: definition.command, args: definition.args ?? [], cwd: definition.cwd ? path.resolve(cwd, definition.cwd) : cwd,
          env: { ...getDefaultEnvironment(), ...(stored.env ?? {}) }, timeout, definition };
      }
      const headers = { ...(definition.auth === 'headers' ? stored.headers ?? {} : {}) };
      if (definition.auth === 'bearer') {
        if (!stored.bearer) throw Object.assign(new Error('bearer トークンが保存されていません。MCP の登録を編集して入力してください'), { code: 'MCP_AUTH_REQUIRED' });
        headers.Authorization = `Bearer ${stored.bearer}`;
      }
      return { type: definition.transport, url: definition.url, headers, timeout, definition,
        ...(definition.auth === 'oauth' ? { oauth: { clientSecret: stored.clientSecret } } : {}) };
    },
  };
}
