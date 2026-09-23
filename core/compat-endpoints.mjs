// 互換の接続先（Claude Code の Anthropic 互換 / Codex の OpenAI Responses 互換）の保存・確認・解決。
//
// 設計は docs/design.md「互換の接続先」。要点:
//   - 接続先はエージェントごと（claude: anthropic-messages、codex: openai-responses）。会話ごとに選ぶ（sidecar の endpoint）。
//   - 置き場: <data>/compat-endpoints.json（一覧・役割のモデル・確認の結果。秘密は入れない）と
//             <data>/compat-endpoint-secrets.json（API キー。core/secret-store.mjs。Claude のアカウント・MCP と同じく safeStorage）。
//   - 保存できるのは「接続の確認」が通った値だけ（確認 → 受領証 receipt → 保存。URL・キー・認証を変えたら確かめ直し）。
//     確認は本物の 1 リクエスト（Claude: POST {URL}/v1/messages max_tokens 1、Codex: POST {URL}/responses）と、
//     モデル一覧（GET /v1/models か /models。取れなくても失敗にしない）。
//   - キーは画面・ログ・イベント・エラー文に出さない（list は hasKey だけ、エラー文は redactSecret を通す）。
//   - 安全策: http(s) だけ、URL に認証情報・クエリ・フラグメントを入れない、公開のアドレスへの http は断る（キーを平文で送らない）、
//     リダイレクトは追わない（キーを別の宛先へ送らない）、応答の大きさと待ち時間に上限。
//   - 会話が指す接続先が消えた・確認に失敗しているときは、黙って公式に戻さず EndpointError で止める（アカウントと同じ扱い）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { addressKind, isLoopbackHost } from './mcp-url-guard.mjs';
import { KIND, ROLE_KEYS, COMPAT_AGENTS } from '../web/compat-presets.mjs';

const SECRET_PREFIX = 'compat-endpoint:';
const ID = /^ep-[a-f0-9]{12}$/;
const MAX_NAME = 60;
const MAX_MODEL = 200;
const MAX_MODELS = 5000;
const MAX_DISPLAY = 120;
const MAX_BODY = 8 * 1024 * 1024;
export const CHECK_TIMEOUT_MS = Number(process.env.AGENT_HOST_COMPAT_CHECK_MS ?? 20_000);
const RECEIPT_MS = 15 * 60_000;
/** 鍵の無い接続先にも Authorization を入れる値。入れないとログイン中の claude.ai の OAuth が送られうる（research §1.1） */
export const NO_KEY = 'no-key';

/** 選んだ接続先を使えないとき。code: deleted / agent / failed / unreadable */
export class EndpointError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
/** 接続の確認に失敗した。message は利用者に見せる理由（キーは含めない） */
export class CheckError extends Error {
  constructor(message, { lines = [], code = 'failed' } = {}) { super(message); this.lines = lines; this.code = code; }
}

export function redactSecret(text, ...secrets) {
  let s = String(text ?? '');
  for (const v of secrets) if (v && String(v).length >= 4) s = s.split(String(v)).join('[キー]');
  return s;
}

export const isModelId = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_MODEL && !/[\x00-\x1f\x7f]/.test(v);

// ---- 入力の検査 -------------------------------------------------------------

/** URL を検査して正規化する（末尾の / を落とす）。名前解決はしない（checkUrlTarget でする） */
export function normalizeUrl(agent, value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new CheckError('URL を入力してください');
  if (/<[^>]+>/.test(raw)) throw new CheckError('URL の <リソース名> などを実際の値に置き換えてください');
  let u;
  try { u = new URL(raw); } catch { throw new CheckError('URL は http:// か https:// で始めてください'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new CheckError('URL は http:// か https:// で始めてください');
  if (u.username || u.password) throw new CheckError('URL にユーザー名やパスワードを入れないでください。キーは「API キー」の欄に入れます');
  if (u.search || u.hash) throw new CheckError('URL に ? や # 以降を入れないでください');
  const href = u.href.replace(/\/+$/, '');
  if (agent === 'claude' && /\/v1$/.test(u.pathname.replace(/\/+$/, ''))) throw new CheckError('URL の末尾の /v1 は要りません（Claude Code が /v1/messages を付けます）');
  if (agent === 'claude' && /\/v1\/messages$/.test(u.pathname.replace(/\/+$/, ''))) throw new CheckError('URL の末尾の /v1/messages は要りません（Claude Code が付けます）');
  if (agent === 'codex' && /\/(responses|chat\/completions)$/.test(u.pathname.replace(/\/+$/, ''))) throw new CheckError('URL の末尾の /responses などは要りません（Codex が /responses を付けます）');
  return href;
}

/**
 * http の宛先を確かめる。公開のアドレスへの http はキーと会話を平文で送るので断る（ループバック・社内のアドレスは許す）。
 * https は宛先を問わない（利用者が自分で入れた URL なので、社内の LiteLLM なども使える）
 */
export async function checkUrlTarget(url, { lookup = dns.lookup } = {}) {
  const u = new URL(url);
  if (u.protocol === 'https:') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host)) return;
  let addresses;
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = (await lookup(host, { all: true, verbatim: true })).map(a => typeof a === 'string' ? a : a.address); }
    catch { throw new CheckError(`${u.host} の名前を解決できません。URL とネットワークを確かめてください`); }
  }
  if (addresses.some(a => addressKind(a) === 'public')) {
    throw new CheckError('公開のアドレスには https で接続してください（http ではキーと会話が暗号化されずに送られます）');
  }
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new CheckError('名前を入力してください');
  if (name.length > MAX_NAME) throw new CheckError(`名前は ${MAX_NAME} 文字以内にしてください`);
  if (/[\x00-\x1f\x7f]/.test(name)) throw new CheckError('名前に改行などは使えません');
  return name;
}

function normalizeKey(value) {
  const key = String(value ?? '').trim();
  if (key.length > 16000 || /[\s\x00-\x1f\x7f]/.test(key)) throw new CheckError('API キーに空白や改行が含まれています。値だけを貼り付けてください');
  return key;
}

function normalizeAuthMode(agent, value) {
  const v = String(value ?? '');
  if (agent === 'claude') return ['auto', 'bearer', 'x-api-key'].includes(v) ? v : 'auto';
  return v === 'api-key' ? 'api-key' : 'bearer';
}

export function normalizeRoles(agent, roles, { required = true } = {}) {
  const out = {};
  for (const k of ROLE_KEYS[agent]) {
    const v = String(roles?.[k] ?? '').trim();
    if (v && !isModelId(v)) throw new CheckError('モデル ID の形式が正しくありません');
    out[k] = v;
  }
  if (required) {
    const labels = { main: agent === 'claude' ? 'メイン' : '既定のモデル', opus: 'Opus 相当', sonnet: 'Sonnet 相当', haiku: 'Haiku 相当' };
    const missing = ROLE_KEYS[agent].filter(k => !out[k]).map(k => labels[k]);
    // 空の役割があると、Claude Code は Claude のモデル名（claude-…）をそのまま送って失敗する
    if (missing.length) throw new CheckError(`${missing.join('・')} のモデルを入力してください`);
  }
  return out;
}

export function normalizeOptions(agent, options = {}) {
  const out = {};
  const ctx = String(options?.contextTokens ?? '').replace(/[,_\s]/g, '');
  if (ctx) {
    const n = Number(ctx);
    if (!Number.isInteger(n) || n < 1024 || n > 10_000_000) throw new CheckError('コンテキスト長は 1024 から 10,000,000 までの整数にしてください');
    out.contextTokens = n;
  }
  if (agent === 'claude' && options?.sendThinking) out.sendThinking = true;
  return out;
}

// ---- 確認（本物の 1 リクエスト） --------------------------------------------

async function readBody(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return '';
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw new Error('too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/** 応答のエラー文を短く取り出す（キーは伏せる） */
function errorText(body, key) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail ?? '';
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch { msg = String(body ?? '').replace(/\s+/g, ' '); }
  return redactSecret(msg, key).slice(0, 200);
}

async function send(fetchImpl, url, { method = 'POST', headers = {}, body, key, timeoutMs = CHECK_TIMEOUT_MS }) {
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new CheckError(timeout ? `接続先が ${Math.round(timeoutMs / 1000)} 秒以内に応答しませんでした。URL・ネットワークを確かめてください` : '接続できませんでした。URL・ネットワーク（ローカルの接続先なら起動しているか）を確かめてください',
      { lines: [redactSecret(String(e?.cause?.code ?? e?.message ?? ''), key).slice(0, 120)].filter(Boolean), code: 'network' });
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel?.().catch(() => {});
    throw new CheckError(`接続先が別の URL へリダイレクトしました（HTTP ${res.status}）。キーを転送しないため追いません。リダイレクト先の URL を直接入れてください`, { code: 'redirect' });
  }
  let text = '';
  try { text = await readBody(res); } catch { throw new CheckError('接続先の応答が大きすぎます', { code: 'format' }); }
  return { status: res.status, ok: res.ok, text, ms: Date.now() - started };
}

const authHeaders = (mode, key) => mode === 'x-api-key' ? { 'x-api-key': key || NO_KEY }
  : mode === 'api-key' ? { 'api-key': key || NO_KEY }
  : mode === 'none' ? {}
  : { authorization: `Bearer ${key || NO_KEY}` };

/**
 * モデル一覧（OpenAI 形式と Anthropic 形式のどちらも data[].id）。取れなければ null。
 * 返すのは { ids, info }。info は取れた分だけの { [id]: { name?, context? } }
 * （Anthropic 形式は display_name・max_input_tokens、OpenAI 形式（OpenRouter など）は name・context_length）
 */
async function fetchModels(fetchImpl, url, headers, key) {
  try {
    const r = await send(fetchImpl, url, { method: 'GET', headers, key, timeoutMs: Math.min(CHECK_TIMEOUT_MS, 15_000) });
    if (!r.ok) return null;
    const body = JSON.parse(r.text);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : null;
    if (!list) return null;
    return normalizeModels(list);
  } catch { return null; }
}

/** コンテキスト長として受け取る値（正の整数） */
const tokensOf = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined;
const CONTROL = /[\x00-\x1f\x7f]/g;

/**
 * 一覧の要素（文字列か { id, display_name?, name?, max_input_tokens?, context_length? }）を { ids, info } にそろえる。
 * 保存済みの models（旧形式は文字列の配列。modelInfo は無い）の読み込みにも使う。prevInfo は保存済みの modelInfo
 */
export function normalizeModels(list, prevInfo = {}) {
  const ids = [];
  const info = {};
  const seen = new Set();
  for (const m of Array.isArray(list) ? list : []) {
    if (ids.length >= MAX_MODELS) break;
    const id = typeof m === 'string' ? m : m?.id ?? m?.name;
    if (!isModelId(id) || seen.has(id)) continue;
    seen.add(id); ids.push(id);
    const raw = m && typeof m === 'object' ? m : {};
    const nameRaw = raw.display_name ?? (raw.id ? raw.name : undefined);
    const name = typeof nameRaw === 'string' ? nameRaw.replace(CONTROL, '').trim().slice(0, MAX_DISPLAY) : '';
    const context = tokensOf(raw.max_input_tokens ?? raw.context_length ?? raw.context_window ?? raw.top_provider?.context_length);
    const prev = prevInfo && typeof prevInfo === 'object' ? prevInfo[id] : null;
    const one = {};
    if (name && name !== id) one.name = name; else if (typeof prev?.name === 'string' && prev.name) one.name = prev.name.slice(0, MAX_DISPLAY);
    if (context) one.context = context; else if (tokensOf(prev?.context)) one.context = tokensOf(prev.context);
    if (one.name || one.context) info[id] = one;
  }
  return { ids, info };
}

/** 保存済みの接続先の models・modelInfo を読む（旧形式: models が文字列の配列で modelInfo が無い） */
function storedModels(e) {
  const { ids, info } = normalizeModels(Array.isArray(e?.models) ? e.models : [], e?.modelInfo);
  return { models: ids, modelInfo: info };
}

const looksLikeModelError = text => /model/i.test(text);

/**
 * 接続を確かめる。成功は { auth, latencyMs, models, lines }、失敗は CheckError。
 * probeModel は確認のリクエストに入れるモデル（無ければ仮の名前。モデルが無いというエラーでも URL とキーは確かめられる）
 */
export async function checkEndpoint({ agent, baseUrl, authMode, key, probeModel }, { fetchImpl = fetch, lookup } = {}) {
  await checkUrlTarget(baseUrl, { lookup });
  const lines = [];
  if (agent === 'claude') {
    const model = probeModel || 'claude-haiku-4-5';
    const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    const common = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    const modes = !key ? ['none'] : authMode === 'auto' ? ['bearer', 'x-api-key'] : [authMode];
    const tried = [];
    for (const mode of modes) {
      const r = await send(fetchImpl, `${baseUrl}/v1/messages`, { headers: { ...common, ...authHeaders(mode === 'none' ? 'bearer' : mode, key) }, body, key });
      tried.push({ mode, r });
      if (r.status === 401 || r.status === 403) continue;
      if (r.status === 404 || r.status === 405) {
        throw new CheckError(`POST ${baseUrl}/v1/messages が ${r.status} を返しました。Anthropic 互換（/v1/messages）の URL か確かめてください`, { code: 'not-found',
          lines: ['URL には /v1 を付けずに入れます（Claude Code が /v1/messages を付けます）。'] });
      }
      if (r.status >= 500) throw new CheckError(`接続先がエラーを返しました（HTTP ${r.status}）`, { lines: [errorText(r.text, key)].filter(Boolean), code: 'server' });
      if (!r.ok) {
        const why = errorText(r.text, key);
        lines.push(looksLikeModelError(why) && r.status !== 429
          ? `確認に使ったモデル ${model} は受け付けられませんでした（HTTP ${r.status}${why ? ': ' + why : ''}）。URL とキーは通っています。モデルは次で割り当てます。`
          : `確認のリクエストは HTTP ${r.status} でした${why ? `（${why}）` : ''}。URL とキーは通っています。`);
      }
      const auth = mode;
      const models = await fetchModels(fetchImpl, `${baseUrl}/v1/models?limit=1000`, { 'anthropic-version': '2023-06-01', ...authHeaders(auth === 'none' ? 'bearer' : auth, key) }, key);
      if (!models?.ids.length) lines.push('モデルの一覧は取れませんでした。ID を入力してください。');
      return { auth, latencyMs: r.ms, models: models?.ids ?? [], modelInfo: models?.info ?? {}, lines };
    }
    const statuses = [...new Set(tried.map(t => t.r.status))].join('・');
    throw new CheckError('キーが違います', { code: 'auth', lines: [
      tried.length > 1 ? `Bearer と x-api-key の両方で試し、どちらも ${statuses} でした。キーを確かめてください。` : `${statuses}（認証に失敗）が返りました。${key ? 'キー' : 'この接続先はキーが要ります。キー'}を確かめてください。`,
      'URL には届いています。'] });
  }
  // Codex: Responses API
  const model = probeModel || 'gpt-probe';
  const auth = !key ? 'none' : authMode;
  const headers = { 'content-type': 'application/json', ...authHeaders(auth, key) };
  const r = await send(fetchImpl, `${baseUrl}/responses`, { headers, body: { model, input: 'ping', max_output_tokens: 16, stream: false, store: false }, key });
  if (r.status === 401 || r.status === 403) {
    throw new CheckError('キーが違います', { code: 'auth', lines: [`${r.status}（認証に失敗）が返りました。${key ? 'キーと送り方（Bearer / api-key）' : 'この接続先はキーが要ります。キー'}を確かめてください。`, 'URL には届いています。'] });
  }
  if (r.status === 404 || r.status === 405) {
    // Chat Completions だけの先か見分ける。本文の無い要求なので生成はしない（400 が返れば道はある）
    const chat = await send(fetchImpl, `${baseUrl}/chat/completions`, { headers, body: {}, key }).catch(() => null);
    if (chat && chat.status !== 404 && chat.status !== 405) {
      throw new CheckError('この接続先は Chat Completions にしか対応していないため Codex では使えません', { code: 'chat-only', lines: [
        `POST ${baseUrl}/responses が ${r.status} を返しました（/chat/completions は応答します）。`,
        'LiteLLM などで Responses API に変換すると使えます。'] });
    }
    throw new CheckError(`POST ${baseUrl}/responses が ${r.status} を返しました。Responses API（/responses）に対応した URL か確かめてください`, { code: 'not-found',
      lines: ['多くの接続先では URL の末尾が /v1 です（Codex が /responses を付けます）。'] });
  }
  if (r.status >= 500) throw new CheckError(`接続先がエラーを返しました（HTTP ${r.status}）`, { lines: [errorText(r.text, key)].filter(Boolean), code: 'server' });
  if (!r.ok) {
    const why = errorText(r.text, key);
    lines.push(looksLikeModelError(why) && r.status !== 429
      ? `確認に使ったモデル ${model} は受け付けられませんでした（HTTP ${r.status}${why ? ': ' + why : ''}）。URL とキーは通っています。モデルは次で決めます。`
      : `確認のリクエストは HTTP ${r.status} でした${why ? `（${why}）` : ''}。URL とキーは通っています。`);
  }
  const models = await fetchModels(fetchImpl, `${baseUrl}/models`, authHeaders(auth, key), key);
  if (!models?.ids.length) lines.push('モデルの一覧は取れませんでした。ID を入力してください。');
  return { auth, latencyMs: r.ms, models: models?.ids ?? [], modelInfo: models?.info ?? {}, lines };
}

// ---- 置き場 ------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {ReturnType<import('./secret-store.mjs').createSecretStore>} o.secrets
 * @param {typeof fetch} [o.fetchImpl]
 * @param {Function} [o.lookup]  名前解決（テストで差し替える）
 */
export function createCompatEndpoints({ dataDir, secrets, fetchImpl = fetch, lookup, now = Date.now } = {}) {
  const file = path.join(dataDir, 'compat-endpoints.json');
  const receipts = new Map();
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const secretKey = id => SECRET_PREFIX + id;

  async function read() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.version !== 1 || !Array.isArray(raw.endpoints)) throw new Error('bad');
      return {
        version: 1,
        endpoints: raw.endpoints.filter(e => ID.test(e?.id ?? '') && COMPAT_AGENTS.includes(e.agent) && typeof e.name === 'string' && typeof e.baseUrl === 'string'),
        defaults: { claude: typeof raw.defaults?.claude === 'string' ? raw.defaults.claude : '', codex: typeof raw.defaults?.codex === 'string' ? raw.defaults.codex : '' },
      };
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, endpoints: [], defaults: { claude: '', codex: '' } };
      throw new Error('互換の接続先の一覧を読み込めません。形式が壊れています');
    }
  }
  async function write(data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, file); break; }
        catch (e) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
        }
      }
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  const update = fn => serial(async () => { const data = await read(); const out = await fn(data); await write(data); return out; });

  const fingerprint = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const keyHash = key => key ? crypto.createHash('sha256').update('compat:' + key).digest('hex') : '';

  /** 画面へ出す形（キーは返さない） */
  function row(e, stored, defaults) {
    return {
      id: e.id, agent: e.agent, kind: KIND[e.agent], name: e.name, preset: e.preset ?? 'custom', baseUrl: e.baseUrl,
      authMode: e.authMode ?? (e.agent === 'claude' ? 'auto' : 'bearer'), auth: e.auth ?? 'bearer', hasKey: stored.has(secretKey(e.id)),
      roles: { ...e.roles }, ...storedModels(e), options: { ...(e.options ?? {}) },
      verifiedAt: e.verifiedAt ?? null, lastCheck: e.lastCheck ?? null, isDefault: defaults[e.agent] === e.id,
      ready: e.lastCheck?.ok !== false,
    };
  }

  /** 確認に使う値をそろえる（id があれば保存済みのキーを流用できる） */
  async function connectionOf(input, id) {
    const agent = COMPAT_AGENTS.includes(input?.agent) ? input.agent : null;
    if (!agent) throw new CheckError('エージェントを選んでください');
    let existing = null;
    if (id) {
      existing = (await read()).endpoints.find(e => e.id === id);
      if (!existing) throw new CheckError('接続先が見つかりません。一覧を開き直してください');
      if (existing.agent !== agent) throw new CheckError('接続先のエージェントは変えられません');
    }
    const baseUrl = normalizeUrl(agent, input?.baseUrl);
    const authMode = normalizeAuthMode(agent, input?.authMode);
    let key = normalizeKey(input?.key);
    let keySource = key ? 'input' : 'none';
    // 編集でキー欄が空なら保存済みのキーを使う（keepKey: false でキーを消す）
    if (!key && existing && input?.keepKey !== false) {
      const saved = await secrets.get(secretKey(existing.id)).catch(e => { throw new CheckError(e.code === 'SECRET_LOCKED' ? e.message : '保存済みのキーを読めません'); });
      if (saved?.key) { key = saved.key; keySource = 'saved'; }
    }
    return { agent, baseUrl, authMode, key, keySource, existing };
  }

  return {
    file,
    async list(agent) {
      const [data, keys, storage] = await Promise.all([read(), secrets.keys(SECRET_PREFIX).catch(() => []), secrets.status().catch(() => null)]);
      const stored = new Set(keys);
      return {
        endpoints: data.endpoints.filter(e => !agent || e.agent === agent).map(e => row(e, stored, data.defaults)),
        defaults: { ...data.defaults },
        storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
      };
    },
    async get(id) {
      const data = await read();
      const e = data.endpoints.find(x => x.id === id);
      if (!e) return null;
      const stored = new Set(await secrets.keys(SECRET_PREFIX).catch(() => []));
      return row(e, stored, data.defaults);
    },
    async has(id, agent) {
      return (await read()).endpoints.some(e => e.id === id && (!agent || e.agent === agent));
    },
    /**
     * 接続を確かめる（保存前）。返り値の receipt を save に渡す。
     * input: { agent, baseUrl, authMode, key, keepKey?, probeModel? }、id: 編集中の接続先
     */
    async check(input, { id = null } = {}) {
      const c = await connectionOf(input, id);
      const probeModel = isModelId(String(input?.probeModel ?? '').trim()) ? String(input.probeModel).trim() : c.existing?.roles?.main || '';
      try {
        const result = await checkEndpoint({ agent: c.agent, baseUrl: c.baseUrl, authMode: c.authMode, key: c.key, probeModel }, { fetchImpl, lookup });
        const receipt = crypto.randomUUID();
        for (const [k, v] of receipts) if (v.until < now()) receipts.delete(k);
        if (receipts.size > 100) receipts.delete(receipts.keys().next().value);
        receipts.set(receipt, { hash: fingerprint({ agent: c.agent, baseUrl: c.baseUrl, authMode: c.authMode, key: keyHash(c.key), keySource: c.keySource, id: id ?? null }),
          until: now() + RECEIPT_MS, auth: result.auth, models: result.models, modelInfo: result.modelInfo ?? {}, latencyMs: result.latencyMs });
        return { ok: true, receipt, auth: result.auth, latencyMs: result.latencyMs, models: result.models, modelInfo: result.modelInfo ?? {}, lines: result.lines };
      } catch (e) {
        if (e instanceof CheckError) throw new CheckError(redactSecret(e.message, c.key), { lines: e.lines.map(l => redactSecret(l, c.key)), code: e.code });
        throw new CheckError(redactSecret(e?.message ?? e, c.key));
      }
    },
    /**
     * 保存（追加か編集）。確認の受領証が今の接続情報と合わなければ断る。
     * input: { agent, name, preset, baseUrl, authMode, key, keepKey?, roles, options }
     */
    async save(input, receipt, { id = null } = {}) {
      const c = await connectionOf(input, id);
      const proof = receipts.get(String(receipt ?? ''));
      if (!proof || proof.until < now() || proof.hash !== fingerprint({ agent: c.agent, baseUrl: c.baseUrl, authMode: c.authMode, key: keyHash(c.key), keySource: c.keySource, id: id ?? null })) {
        throw new CheckError('接続情報が変わったか、確認から時間が経ちました。もう一度「接続を確認」を押してください');
      }
      const name = normalizeName(input?.name);
      const roles = normalizeRoles(c.agent, input?.roles);
      const options = normalizeOptions(c.agent, input?.options);
      const preset = /^[a-z0-9-]{1,32}$/.test(String(input?.preset ?? '')) ? String(input.preset) : 'custom';
      const at = new Date(now()).toISOString();
      const created = id || 'ep-' + crypto.randomBytes(6).toString('hex');
      // 秘密を先に書く。一覧に出た時点でキーがそろっているように
      if (c.keySource === 'input') await secrets.set(secretKey(created), { key: c.key });
      else if (!c.key) await secrets.delete(secretKey(created)).catch(() => {});
      try {
        await update(data => {
          const entry = { id: created, agent: c.agent, name, preset, baseUrl: c.baseUrl, authMode: c.authMode, auth: proof.auth, roles, options,
            models: proof.models, modelInfo: proof.modelInfo ?? {}, verifiedAt: at, lastCheck: { ok: true, at, latencyMs: proof.latencyMs, modelCount: proof.models.length } };
          const i = data.endpoints.findIndex(e => e.id === created);
          if (id && i < 0) throw new CheckError('接続先が見つかりません。一覧を開き直してください');
          if (i >= 0) data.endpoints[i] = { ...data.endpoints[i], ...entry }; else data.endpoints.push({ ...entry, createdAt: at });
        });
      } catch (e) {
        if (!id && c.keySource === 'input') await secrets.delete(secretKey(created)).catch(() => {});
        throw e;
      }
      receipts.delete(String(receipt));
      return { id: created };
    },
    /** 保存済みの接続先を確かめ直す（一覧の「接続を確認」）。結果を記録し、モデルの一覧を取り直す */
    async recheck(id) {
      const data = await read();
      const e = data.endpoints.find(x => x.id === id);
      if (!e) throw new CheckError('接続先が見つかりません。一覧を開き直してください');
      let result, failure = null;
      try { result = await this.check({ agent: e.agent, baseUrl: e.baseUrl, authMode: e.authMode, probeModel: e.roles?.main }, { id }); }
      catch (err) { failure = err; }
      const at = new Date(now()).toISOString();
      await update(d => {
        const x = d.endpoints.find(y => y.id === id);
        if (!x) return;
        if (failure) x.lastCheck = { ok: false, at, error: String(failure.message).slice(0, 300), ...(failure.code ? { code: failure.code } : {}) };
        else {
          x.lastCheck = { ok: true, at, latencyMs: result.latencyMs, modelCount: result.models.length };
          x.verifiedAt = at; x.auth = result.auth;
          if (result.models.length) { x.models = result.models; x.modelInfo = result.modelInfo ?? {}; }
        }
      });
      if (result) receipts.delete(result.receipt);
      return failure ? { ok: false, error: failure.message, lines: failure.lines ?? [] } : { ok: true, lines: result.lines, auth: result.auth, models: result.models, modelInfo: result.modelInfo ?? {} };
    },
    remove(id) {
      return serial(async () => {
        const data = await read();
        const next = data.endpoints.filter(e => e.id !== id);
        if (next.length === data.endpoints.length) throw new Error('その接続先は登録されていません');
        for (const a of COMPAT_AGENTS) if (data.defaults[a] === id) data.defaults[a] = '';
        await write({ ...data, endpoints: next });
        await secrets.delete(secretKey(id)).catch(() => {});
      });
    },
    /** 新しい会話の既定（'' = 公式）。設定で明示的に「既定にする」を押したときだけ呼ぶ */
    async setDefault(agent, id) {
      if (!COMPAT_AGENTS.includes(agent)) throw new Error('エージェントが正しくありません');
      const target = String(id ?? '');
      await update(data => {
        if (target && !data.endpoints.some(e => e.id === target && e.agent === agent)) throw new Error('その接続先は登録されていません');
        data.defaults[agent] = target;
      });
    },
    async defaultFor(agent) {
      // 一覧のファイルが読めなくても、新しい会話とエージェントの切り替えは公式で続けられるようにする（resolve は今どおり止める）
      const data = await read().catch(() => null);
      if (!data) return '';
      const id = data.defaults[agent] ?? '';
      return id && data.endpoints.some(e => e.id === id && e.agent === agent) ? id : '';
    },
    /**
     * 会話で使う接続先を引く。'' / 未指定は公式（null）。
     * 削除済み・エージェント違い・確認に失敗している・キーを読めないときは EndpointError（黙って公式へ落とさない）
     */
    async resolve(id, agent) {
      if (!id) return null;
      const data = await read();
      const e = data.endpoints.find(x => x.id === id);
      if (!e) throw new EndpointError('この会話の接続先は削除されています。入力欄のモデルの面で接続先を選び直してください', 'deleted');
      if (agent && e.agent !== agent) throw new EndpointError(`この会話の接続先「${e.name}」は ${e.agent === 'claude' ? 'Claude Code' : 'Codex'} 用です。接続先を選び直してください`, 'agent');
      if (e.lastCheck && e.lastCheck.ok === false) throw new EndpointError(`接続先「${e.name}」は前回の確認に失敗しています。設定 › エージェント設定の「接続先」で確認し直すか、接続先を選び直してください`, 'failed');
      let key = '';
      try { key = (await secrets.get(secretKey(e.id)))?.key ?? ''; }
      catch (err) { throw new EndpointError(err.code === 'SECRET_LOCKED' ? err.message : `接続先「${e.name}」のキーを読めません`, 'unreadable'); }
      return { id: e.id, agent: e.agent, kind: KIND[e.agent], name: e.name, baseUrl: e.baseUrl, auth: e.auth ?? (key ? 'bearer' : 'none'), key,
        roles: { ...e.roles }, models: storedModels(e).models, options: { ...(e.options ?? {}) } };
    },
  };
}

// ---- 引き継ぎの規則 ------------------------------------------------------------

/**
 * 委譲（ply_delegate）した子の接続先（決定 3）。同じエージェントへの委譲なら親の会話の接続先を継ぎ、
 * 違うエージェントへは公式（''）に戻す（Anthropic 互換と Responses 互換は形式が合わない）
 */
export function delegatedEndpoint(parentBackendId, childBackendId, parentEndpoint) {
  return parentEndpoint && parentBackendId && parentBackendId === childBackendId ? parentEndpoint : '';
}

// ---- エージェントへの注入 -----------------------------------------------------

/** 親から来ると互換の接続先と混ざる変数（毎回消すか上書きする。research §5-3） */
const CLAUDE_STRIP = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_SKIP_[A-Z_]+_AUTH$|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SUBAGENT_MODEL$|CLAUDE_CODE_MAX_CONTEXT_TOKENS$|CLAUDE_CODE_EFFORT_LEVEL$|CLAUDE_CODE_DISABLE_THINKING$|CLAUDE_CODE_API_KEY_HELPER_TTL_MS$)/;

/**
 * Claude Code に渡す変数（互換の接続先の会話）。
 * vars は options.env に足し、同じものを「フラグ設定」の env にも書く（ユーザーの settings.json の env に勝たせるため。
 * docs/design.md「互換の接続先」のスパイク b）。
 */
export function claudeCompatVars(endpoint) {
  const r = endpoint.roles ?? {};
  const main = r.main || r.sonnet || r.opus || '';
  const vars = {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    // 使わない方の資格情報は空にする（OpenRouter などは ANTHROPIC_API_KEY="" を明示する必要がある）
    ANTHROPIC_AUTH_TOKEN: endpoint.auth === 'x-api-key' ? '' : (endpoint.key || NO_KEY),
    ANTHROPIC_API_KEY: endpoint.auth === 'x-api-key' ? (endpoint.key || NO_KEY) : '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: r.opus || main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: r.sonnet || main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: r.haiku || main,
    ANTHROPIC_DEFAULT_FABLE_MODEL: r.opus || main,
    ANTHROPIC_SMALL_FAST_MODEL: r.haiku || main,
    // 利用者・プロジェクトの settings.json の env から効く、資格情報を載せたり別の宛先へ送ったりする値は空で打ち消す
    // （社内ゲートウェイの認証ヘッダーなどを第三者の接続先へ送らない）
    ANTHROPIC_CUSTOM_HEADERS: '',
    ANTHROPIC_BETAS: '',
    ANTHROPIC_BEDROCK_BASE_URL: '', ANTHROPIC_VERTEX_BASE_URL: '', ANTHROPIC_FOUNDRY_BASE_URL: '', ANTHROPIC_FOUNDRY_API_KEY: '', ANTHROPIC_FOUNDRY_AUTH_TOKEN: '',
    ANTHROPIC_AWS_BASE_URL: '', ANTHROPIC_AWS_API_KEY: '',
    CLAUDE_CODE_SUBAGENT_MODEL: '',
    // 非 Anthropic の先で 400 になりやすい beta・余計な通信・帰属ブロックを止める（research §5-8）
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', CLAUDE_CODE_USE_MANTLE: '',
    CLAUDE_CODE_USE_ANTHROPIC_AWS: '', CLAUDE_CODE_USE_GATEWAY: '',
  };
  if (endpoint.options?.contextTokens) vars.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(endpoint.options.contextTokens);
  // 決定 4: 思考とエフォートは「思考を送る」をオンにした接続先にだけ送る。
  // オプションを渡さなくても CLI は既定で thinking と output_config.effort を送るので、変数で止める（スパイク b）
  if (!endpoint.options?.sendThinking) { vars.CLAUDE_CODE_DISABLE_THINKING = '1'; vars.CLAUDE_CODE_EFFORT_LEVEL = 'unset'; }
  else { vars.CLAUDE_CODE_DISABLE_THINKING = ''; vars.CLAUDE_CODE_EFFORT_LEVEL = ''; }
  return vars;
}

/** 互換の接続先の会話の env。base から混ざる変数を消してから vars を足す（base は書き換えない） */
export function claudeCompatEnv(base, endpoint, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base ?? {})) if (!CLAUDE_STRIP.test(k)) env[k] = v;
  return { ...env, ...extra, ...claudeCompatVars(endpoint) };
}

/**
 * フラグ設定（--settings）のファイルを書く。オブジェクトで渡すと argv に JSON のまま載ってキーがプロセス一覧に出るので、
 * データ置き場の下に 0600 で書き、パスだけを渡す。dispose() で消す（ターンの終わり）。
 * extra はほかのフラグ設定（Pleiad が担当するときの claudeMdExcludes など）。同じファイルに入れる（settings は 1 つしか渡せない）。
 */
export async function writeClaudeFlagSettings(dataDir, endpoint, extra = {}) {
  const dir = path.join(dataDir, 'run');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `claude-compat-${crypto.randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify({ ...(extra ?? {}), env: { ...(extra?.env ?? {}), ...claudeCompatVars(endpoint) } }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.chmod(file, 0o600).catch(() => {});
  let gone = false;
  return { file, dispose: async () => { if (gone) return; gone = true; await fs.rm(file, { force: true }).catch(() => {}); } };
}

/** 前の起動で消し損ねたフラグ設定のファイルを片付ける（起動時） */
export async function sweepClaudeFlagSettings(dataDir, { olderThanMs = 0 } = {}) {
  const dir = path.join(dataDir, 'run');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!/^claude-compat-[0-9a-f-]+\.json$/.test(name)) continue;
    const f = path.join(dir, name);
    const st = await fs.stat(f).catch(() => null);
    if (!st || (olderThanMs > 0 && Date.now() - st.mtimeMs < olderThanMs)) continue;
    await fs.rm(f, { force: true }).catch(() => {}); n++;
  }
  return n;
}

/** Codex の model_providers の id（予約 id と重ならない。接続情報が変われば別の id になる＝ロード済みのスレッドを入れ替える合図） */
export function codexProviderId(endpoint) {
  const h = crypto.createHash('sha256').update(JSON.stringify([endpoint.baseUrl, endpoint.auth, endpoint.key ? crypto.createHash('sha256').update(endpoint.key).digest('hex') : ''])).digest('hex').slice(0, 8);
  return `ply_${endpoint.id.replace(/[^A-Za-z0-9]/g, '_')}_${h}`;
}

/**
 * Codex の thread/start・thread/resume に足す上書き（互換の接続先の会話）。
 * 鍵は experimental_bearer_token（JSON-RPC の stdin で渡る。argv・環境に出ない）か http_headers の api-key（Azure）。
 */
export function codexCompatThread(endpoint) {
  const id = codexProviderId(endpoint);
  const provider = {
    name: endpoint.name,
    base_url: endpoint.baseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    supports_websockets: false,
    ...(endpoint.auth === 'api-key' ? { http_headers: { 'api-key': endpoint.key || NO_KEY } }
      : endpoint.auth === 'none' || !endpoint.key ? {} : { experimental_bearer_token: endpoint.key }),
  };
  return {
    modelProvider: id,
    config: {
      [`model_providers.${id}`]: provider,
      // 互換の先は Responses のネイティブ web_search を持たないことが多い（送ると 400 になる先がある）
      web_search: 'disabled',
      ...(endpoint.options?.contextTokens ? { model_context_window: endpoint.options.contextTokens } : {}),
    },
  };
}
