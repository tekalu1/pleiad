// API キーの置き場（ADR 0154。設定 › API キー、docs/design.md「API キー」）。
//
// 外部サービスのキーはここ 1 か所に登録し、使う側（互換の接続先・通話・委譲の判定器）は「どのキーを使うか」を選ぶだけにする。
//   <data>/api-keys.json         秘密でない台帳: { keys: [{ id, provider, label, createdAt, lastCheck }], uses, guide, migration }
//   <data>/api-key-secrets.json  キーの値（core/secret-store.mjs。エントリ key:<id>。Claude のアカウント・MCP と同じ暗号化）
//   接続先の割り当ては compat-endpoints.json の各行の keyRef（値を持たない。書くのは compatEndpointSave・このモジュールの削除・まとめ）。
//   通話・判定器の割り当ては uses（voice・judge:jev・judge:cerebras）。prefs の voice は AI も書ける設定なので、割り当てはそこに置かない。
// 登録しただけでは、どの機能も外部に送らない。送るのは「使うキー」を人が選んだときから（ADR 0022・0150 の「キーの登録＝同意」を選ぶ操作へ移した）。
// キーの値は返り値・ログ・エラー文に出さない（list は値を持たず、使っている所の名前だけを返す）。
//
// 古い置き場（compat-endpoint-secrets.json の compat-endpoint:<id>・delegation-routing:<service>、voice-secrets.json の openrouter）は
// 移行で消さず、キーを差し替える・割り当てを変える・消すたびに古い方にも同じ状態を書く（開発版と配布版が同じ置き場を使うことがあり、
// 古い版は古い置き場だけを読む。消すのは別のリリース）。
//
// 移行（起動時・冪等）: 古い置き場を読み、(プロバイダー, 値の sha256) が同じものは 1 件、違う値は元の場所が分かる名前の別の件にする。
// 通話・判定器は、今キーを登録済みの所だけそのキーを選んだ状態で引き継ぐ（接続先にしかキーが無い人は「使わない」のまま）。
// 値の違う同じプロバイダーのキーができたときだけ guide（まとめの案内）を一度だけ出す。
// 暗号化された古いキーを読めない起動（SECRET_LOCKED）・古い置き場が壊れていて読めない起動では保留し、古い置き場を読み続ける。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from './atomic-file.mjs';
import { SECRET_PREFIX as JUDGE_PREFIX, JUDGE_SERVICE } from './delegation-judges.mjs';
import { voiceBaseUrl } from './voice/openrouter.mjs';
import { USE_PROVIDER, FIXED_HOST_PROVIDERS, providerName, providerOfEndpoint, hostOf, keyFitsEndpoint } from '../web/api-keys-model.mjs';
import { t } from './i18n.mjs';

export { providerOfEndpoint };

export const SECRET_PREFIX = 'key:';
/** 古い置き場（互換の接続先のキー）の項目名 */
export const LEGACY_ENDPOINT_PREFIX = 'compat-endpoint:';
const LEGACY_VOICE_KEY = 'openrouter';

/** キーを割り当てる先（接続先は keyRef で、ここには入らない） */
export const USES = Object.freeze(['voice', 'judge:jev', 'judge:cerebras']);
const USE_JUDGE = Object.freeze({ 'judge:jev': 'jev', 'judge:cerebras': 'cerebras' });
const SERVICE_OF_USE = Object.freeze({ 'judge:jev': JUDGE_SERVICE.jev, 'judge:cerebras': JUDGE_SERVICE.cerebras });

export const MAX_KEYS = 200;
export const MAX_LABEL = 60;
const ID = /^key-[a-f0-9]{12}$/;
const PROVIDER = /^[a-z0-9-]{1,32}$/;
const CHECK_TIMEOUT_MS = 5000;
/** キーそのものだけを確かめられるプロバイダー（そうでないものは接続先の確認で確かめる） */
const CHECKABLE = new Set(['openrouter', 'cerebras']);
const CEREBRAS_API = () => (process.env.AGENT_HOST_CEREBRAS_API || 'https://api.cerebras.ai').replace(/\/+$/, '');

/** code: INVALID_KEY / NOT_FOUND / PROVIDER_MISMATCH / MIGRATION_PENDING / TOO_MANY / UNKNOWN_USE / FILE_BROKEN */
export class ApiKeyError extends Error {
  // i18n-dynamic: apiKeys.errors.
  constructor(code, params) { super(t(`apiKeys.errors.${code}`, params)); this.code = code; }
}

/** キーの形。空・空白や制御文字を含む・長すぎるものは断る（中身は確かめない） */
export function normalizeApiKey(value) {
  const key = String(value ?? '').trim();
  if (!key || key.length > 16000 || /[\s\x00-\x1f\x7f]/.test(key)) return null;
  return key;
}

const normalizeProvider = value => PROVIDER.test(String(value ?? '')) ? String(value) : 'custom';

const sha = value => crypto.createHash('sha256').update('apikey:' + value).digest('hex');
const iso = ms => new Date(ms).toISOString();
const emptyState = () => ({ version: 1, migration: null, keys: [], uses: Object.fromEntries(USES.map(u => [u, null])), guide: null });

/** キーを結び付けるホスト。ホストの決まったプロバイダー（OpenRouter・Cerebras）のキーは持たない（null） */
function normalizeHost(provider, host) {
  const h = String(host ?? '').trim().toLowerCase();
  return !FIXED_HOST_PROVIDERS.has(provider) && /^[a-z0-9.:\-\[\]]{1,253}$/.test(h) ? h : null;
}

function clean(raw) {
  if (raw?.version !== 1 || !Array.isArray(raw.keys)) throw new Error('bad');
  const keys = raw.keys.filter(k => ID.test(k?.id ?? '') && PROVIDER.test(k.provider ?? '') && typeof k.label === 'string')
    .map(k => ({ id: k.id, provider: k.provider, label: k.label.slice(0, MAX_LABEL), createdAt: typeof k.createdAt === 'string' ? k.createdAt : null,
      host: normalizeHost(k.provider, k.host), lastCheck: k.lastCheck && typeof k.lastCheck === 'object' ? k.lastCheck : null }));
  const ids = new Set(keys.map(k => k.id));
  const uses = Object.fromEntries(USES.map(u => [u, ids.has(raw.uses?.[u]) ? raw.uses[u] : null]));
  return { version: 1, migration: raw.migration?.done ? { done: true, at: String(raw.migration.at ?? '') } : null, keys, uses,
    guide: raw.guide === 'pending' || raw.guide === 'done' ? raw.guide : null };
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {ReturnType<import('./secret-store.mjs').createSecretStore>} o.secrets  api-key-secrets.json
 * @param {{ compat?: object, voice?: object }} [o.legacy]  古い置き場（compat-endpoint-secrets.json・voice-secrets.json の秘密ストア）
 * @param {() => object|null} [o.endpoints]  createCompatEndpoints の結果（接続先の割り当て。遅れて結ぶ）
 * @param {(change: object) => void} [o.onChange]  キー・割り当てが変わったとき（画面への配信・通話のキーの捨て直し）
 */
export function createApiKeys({ dataDir, secrets, legacy = {}, endpoints = () => null, fetchImpl, env = process.env, now = Date.now, log = () => {}, onChange = () => {} }) {
  const file = path.join(dataDir, 'api-keys.json');
  let state = emptyState();
  let deferred = null;     // 移行を保留している理由（locked / broken / write-failed）。null なら移行済み
  let initPromise = null;
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const migrated = () => state.migration?.done === true;
  const eps = () => endpoints?.() ?? null;
  const emit = change => { try { onChange(change); } catch (e) { log('apikeys.on_change_failed', { code: String(e?.code ?? '') }); } };

  async function load() {
    try { return clean(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (e) {
      if (e.code === 'ENOENT') return emptyState();
      // 壊れた台帳を黙って空で上書きしない（キーを失うより、止まって古い置き場を読み続ける）
      throw new ApiKeyError('FILE_BROKEN');
    }
  }
  async function save() {
    await writeAtomic(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  }
  /** 状態を変えて書く。書けなかったら状態を戻す */
  const mutate = fn => serial(async () => {
    const before = structuredClone(state);
    try { const out = await fn(state); await save(); return out; }
    catch (e) { state = before; throw e; }
  });

  // ---- 古い置き場への書き込み（古い版がそちらだけを読むので、同じ状態にそろえる）
  async function mirror(store, key, value) {
    if (!store) return;
    try { if (value) await store.set(key, { key: value }); else await store.delete(key); }
    catch (e) { log('apikeys.legacy_write_failed', { target: key.split(':')[0], code: String(e?.code ?? '') }); }
  }
  async function mirrorUse(use) {
    const id = state.uses[use];
    const value = id ? await keyValue(id).catch(() => null) : null;
    if (use === 'voice') await mirror(legacy.voice, LEGACY_VOICE_KEY, value);
    else await mirror(legacy.compat, JUDGE_PREFIX + SERVICE_OF_USE[use], value);
  }
  /** 接続先の古い置き場の項目を、割り当てたキーの値にそろえる（keyId が null なら消す） */
  async function mirrorEndpoint(endpointId, keyId) {
    const value = keyId ? await keyValue(keyId).catch(() => null) : null;
    await mirror(legacy.compat, LEGACY_ENDPOINT_PREFIX + endpointId, value);
  }

  // ---- 値
  const known = id => state.keys.find(k => k.id === id);
  async function keyValue(id) {
    if (!known(id)) return null;
    return (await secrets.get(SECRET_PREFIX + id))?.key ?? null;
  }
  async function legacyUse(use) {
    const entry = use === 'voice' ? await legacy.voice?.get(LEGACY_VOICE_KEY) : await legacy.compat?.get(JUDGE_PREFIX + SERVICE_OF_USE[use]);
    return normalizeApiKey(entry?.key);
  }

  // ---- 移行
  function sourceLabelParts(sources) {
    const first = sources.find(s => s.kind === 'endpoint') ?? sources.find(s => s.kind === 'judge') ?? sources[0];
    if (first.kind === 'endpoint') return t('apiKeys.origin.endpoint', { agent: first.row.agent === 'codex' ? 'Codex' : 'Claude Code' });
    if (first.kind === 'voice') return t('apiKeys.origin.voice');
    return t('apiKeys.origin.judge');
  }

  async function migrate() {
    const rows = eps()?.rows ? await eps().rows().catch(() => null) : [];
    if (!rows) return 'broken';
    const sources = [];   // { kind: endpoint|judge|voice, value, provider, ... }
    let blocked = null;
    const read = async fn => {
      try { return await fn(); }
      catch (e) {
        // ファイルそのものが解析できない（壊れている）ときだけ、その置き場を飛ばす（ファイルには触れない）。
        // それ以外（暗号化を読めない・暗号器が答えない・復号に失敗する）は、キーがあるのに読めないだけなので、
        // 空のまま「移行済み」にせず保留する（次の起動でやり直す）
        if (e?.code === 'SECRET_FILE_BROKEN') log('apikeys.legacy_unreadable', { code: e.code });
        else blocked = e?.code === 'SECRET_LOCKED' ? 'locked' : 'unreadable';
        return null;
      }
    };
    if (legacy.compat) {
      const stored = new Set(await read(() => legacy.compat.keys(LEGACY_ENDPOINT_PREFIX)) ?? []);
      for (const row of rows) {
        if (!stored.has(LEGACY_ENDPOINT_PREFIX + row.id)) continue;
        const value = normalizeApiKey((await read(() => legacy.compat.get(LEGACY_ENDPOINT_PREFIX + row.id)))?.key);
        if (value) sources.push({ kind: 'endpoint', value, provider: providerOfEndpoint(row), row });
      }
      for (const use of ['judge:jev', 'judge:cerebras']) {
        const value = normalizeApiKey((await read(() => legacy.compat.get(JUDGE_PREFIX + SERVICE_OF_USE[use])))?.key);
        if (value) sources.push({ kind: 'judge', use, value, provider: USE_PROVIDER[use] });
      }
    }
    if (legacy.voice) {
      const value = normalizeApiKey((await read(() => legacy.voice.get(LEGACY_VOICE_KEY)))?.key);
      if (value) sources.push({ kind: 'voice', use: 'voice', value, provider: 'openrouter' });
    }
    if (blocked) return blocked;

    // (プロバイダー, 値) ごとに 1 件。ホストの決まっていないプロバイダー（カスタムなど）は、使っている接続先のホストも分ける
    // （同じ値でも別のホストなら別の件。キーを別のホストへ送らない）。id は値から決める（途中で止まっても、やり直しで同じ id になる）
    const groups = new Map();
    for (const s of sources) {
      const host = normalizeHost(s.provider, s.row ? hostOf(s.row.baseUrl) : '');
      const g = `${s.provider}:${host ?? ''}:${sha(s.value)}`;
      if (!groups.has(g)) groups.set(g, { id: 'key-' + crypto.createHash('sha256').update(g).digest('hex').slice(0, 12), provider: s.provider, host, value: s.value, sources: [] });
      groups.get(g).sources.push(s);
    }
    const list = [...groups.values()];
    const perProvider = new Map();
    for (const g of list) perProvider.set(g.provider, (perProvider.get(g.provider) ?? 0) + 1);
    const used = new Set();
    const keys = list.slice(0, MAX_KEYS).map(g => {
      const named = providerName(g.provider);
      const first = g.sources.find(s => s.kind === 'endpoint');
      let label = named
        ? (perProvider.get(g.provider) > 1 ? t('apiKeys.origin.labeled', { name: named, origin: sourceLabelParts(g.sources) }) : named)
        : (first?.row.name ?? t('apiKeys.origin.unnamed'));
      label = label.slice(0, MAX_LABEL);
      let unique = label, n = 2;
      while (used.has(unique)) unique = `${label.slice(0, MAX_LABEL - 4)} (${n++})`;
      used.add(unique);
      return { id: g.id, provider: g.provider, host: g.host, label: unique, createdAt: iso(now()), lastCheck: null, value: g.value, sources: g.sources };
    });

    // 書く順: 値 → 接続先の割り当て → 台帳（移行済みの印）。台帳が最後なので、途中で止まっても次の起動でやり直せる
    for (const k of keys) await secrets.set(SECRET_PREFIX + k.id, { key: k.value });
    const refs = {};
    const uses = Object.fromEntries(USES.map(u => [u, null]));
    for (const k of keys) for (const s of k.sources) {
      if (s.kind === 'endpoint') refs[s.row.id] = k.id;
      else uses[s.use] = k.id;
    }
    // 接続先の割り当ては移行の結果をそのまま書く（以前の途中の移行や古い方法で残った keyRef は、ここに無ければ消える）
    if (eps()?.setKeyRefs) await eps().setKeyRefs(refs);
    const providersWithMany = [...perProvider].filter(([p, n]) => n > 1 && p !== 'custom');
    state = { version: 1, migration: { done: true, at: iso(now()) }, keys: keys.map(({ id, provider, host, label, createdAt, lastCheck }) => ({ id, provider, host, label, createdAt, lastCheck })),
      uses, guide: providersWithMany.length ? 'pending' : null };
    await save();
    return null;
  }

  /** 台帳に無いキーを指す接続先の keyRef を外す（削除の途中で止まった・台帳だけ戻った起動）。外した接続先は削除と同じ扱い（確認に失敗・選び直し） */
  async function pruneDangling() {
    try {
      const gone = await eps()?.pruneKeyRefs?.(new Set(state.keys.map(k => k.id)), { error: t('apiKeys.endpointKeyDeleted') }) ?? [];
      for (const epId of gone) await mirrorEndpoint(epId, null);
    } catch (e) { log('apikeys.prune_failed', { code: String(e?.code ?? '') }); }
  }

  async function init() {
    try { state = await load(); } catch (e) { state = emptyState(); deferred = 'broken'; log('apikeys.state_unreadable', { code: e.code }); return; }
    if (migrated()) { await pruneDangling(); return; }
    try { deferred = await migrate(); }
    catch (e) { deferred = 'write-failed'; log('apikeys.migrate_failed', { code: String(e?.code ?? '') }); }
    if (deferred) { state = emptyState(); log('apikeys.migrate_deferred', { reason: deferred }); }
  }
  const ensure = () => (initPromise ??= init());

  /** 書く操作の前に。移行が済んでいなければ断る（古い置き場を読み続けている間は、ここへ書かない） */
  async function writable() {
    await ensure();
    if (!migrated()) throw new ApiKeyError('MIGRATION_PENDING');
  }

  // ---- 使っている所
  async function usersOf(id) {
    const out = [];
    for (const e of (await eps()?.keyUsers?.()) ?? []) if (e.keyRef === id) out.push({ kind: 'endpoint', id: e.id, agent: e.agent, name: e.name });
    if (state.uses.voice === id) out.push({ kind: 'voice' });
    for (const u of ['judge:jev', 'judge:cerebras']) if (state.uses[u] === id) out.push({ kind: 'judge', judge: USE_JUDGE[u] });
    return out;
  }

  function guideOf() {
    if (state.guide !== 'pending') return null;
    const by = new Map();
    for (const k of state.keys) if (k.provider !== 'custom') by.set(k.provider, [...(by.get(k.provider) ?? []), k.id]);
    const found = [...by].find(([, ids]) => ids.length > 1);
    return found ? { provider: found[0], keyIds: found[1] } : null;
  }

  // ---- 確認（キーそのものだけ。料金のかからない軽い GET）
  async function probe(provider, value) {
    const doFetch = fetchImpl ?? fetch;
    const url = provider === 'openrouter' ? `${voiceBaseUrl(env)}/key` : `${CEREBRAS_API()}/v1/models`;
    try {
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${value}`, 'X-Title': 'Pleiad' }, redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true };
      return { ok: false, code: res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable', status: res.status };
    } catch { return { ok: false, code: 'unreachable' }; }
  }

  const api = {
    file,
    init: ensure,
    /** 移行が済んでいるか。済んでいなければ、読む側は古い置き場を読む */
    async migrated() { await ensure(); return migrated(); },
    async status() { await ensure(); return { migrated: migrated(), deferred }; },

    /** 設定 › API キーに出す一覧。値は持たない */
    async list() {
      await ensure();
      const storage = await secrets.status().catch(() => null);
      const keys = [];
      for (const k of state.keys) keys.push({ ...k, checkable: CHECKABLE.has(k.provider), uses: await usersOf(k.id) });
      return {
        migration: migrated() ? { state: 'done' } : { state: 'deferred', reason: deferred ?? 'broken' },
        storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
        keys, uses: { ...state.uses }, guide: guideOf(),
      };
    },
    /** 値（無ければ null）。接続先の送信・確認が使う。暗号化された値を読めない起動は SECRET_LOCKED を投げる */
    async keyValue(id) { await ensure(); return keyValue(String(id ?? '')); },
    /** 使う側（通話・判定器）が送るときのキー。「使わない」・未登録は null（何も送らない） */
    async useKey(use) {
      await ensure();
      if (!USES.includes(use)) return null;
      if (!migrated()) return legacyUse(use);
      const id = state.uses[use];
      return id ? keyValue(id) : null;
    },
    /** 使うキーが選ばれているか（値は読まない）。保留中は古い置き場に値があるか */
    async hasUse(use) {
      await ensure();
      if (!USES.includes(use)) return false;
      if (migrated()) return Boolean(state.uses[use]) && (await secrets.keys(SECRET_PREFIX).catch(() => [])).includes(SECRET_PREFIX + state.uses[use]);
      const names = use === 'voice' ? await legacy.voice?.keys(LEGACY_VOICE_KEY).catch(() => []) : await legacy.compat?.keys(JUDGE_PREFIX + SERVICE_OF_USE[use]).catch(() => []);
      return (names ?? []).length > 0;
    },
    usesState() { return { ...state.uses }; },

    async add({ provider, label, key, host }) {
      await writable();
      const value = normalizeApiKey(key);
      if (!value) throw new ApiKeyError('INVALID_KEY');
      if (state.keys.length >= MAX_KEYS) throw new ApiKeyError('TOO_MANY', { max: MAX_KEYS });
      const p = normalizeProvider(provider);
      const name = String(label ?? '').trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_LABEL) || providerName(p) || t('apiKeys.origin.unnamed');
      const id = 'key-' + crypto.randomBytes(6).toString('hex');
      await secrets.set(SECRET_PREFIX + id, { key: value });
      try { await mutate(s => { s.keys.push({ id, provider: p, label: name, createdAt: iso(now()), host: normalizeHost(p, host), lastCheck: null }); }); }
      catch (e) { await secrets.delete(SECRET_PREFIX + id).catch(() => {}); throw e; }
      emit({ keys: true });
      return { id };
    },
    /** 値を差し替える。確認の結果は消え、古い置き場の同じ割り当ても新しい値にそろえる */
    async replace(id, key) {
      await writable();
      if (!known(id)) throw new ApiKeyError('NOT_FOUND');
      const value = normalizeApiKey(key);
      if (!value) throw new ApiKeyError('INVALID_KEY');
      await secrets.set(SECRET_PREFIX + id, { key: value });
      await mutate(() => { known(id).lastCheck = null; });
      for (const u of USES) if (state.uses[u] === id) await mirrorUse(u);
      for (const e of (await eps()?.keyUsers?.()) ?? []) if (e.keyRef === id) await mirrorEndpoint(e.id, id);
      emit({ keys: true, uses: USES.filter(u => state.uses[u] === id), endpoints: true });
      return { id, uses: await usersOf(id) };
    },
    /** 消す。使っていた通話・判定器は「使わない」に、接続先はキー無し（確認に失敗した扱い。黙って公式に戻らない）になる */
    async remove(id) {
      await writable();
      const key = known(id);
      if (!key) throw new ApiKeyError('NOT_FOUND');
      const affected = await usersOf(id);
      const usesBefore = USES.filter(u => state.uses[u] === id);
      // 台帳を先に保存する（保存に失敗したら何も変わらない）。接続先の keyRef を外すのはその後で、途中で止まっても、台帳に無いキーを指す参照は
      // 使うとき（keyValue が null）にも次の起動（pruneDangling）にも、黙って送らずに止まる
      await mutate(s => { s.keys = s.keys.filter(k => k.id !== id); for (const u of USES) if (s.uses[u] === id) s.uses[u] = null; });
      let detached = [];
      try { detached = await eps()?.detachKey?.(id, { error: t('apiKeys.endpointKeyDeleted') }) ?? []; }
      catch (e) { log('apikeys.detach_failed', { code: String(e?.code ?? '') }); }
      for (const u of usesBefore) await mirrorUse(u);
      for (const epId of detached) await mirrorEndpoint(epId, null);
      await secrets.delete(SECRET_PREFIX + id).catch(() => {});
      emit({ keys: true, uses: usesBefore, endpoints: detached.length > 0 });
      return { id, affected };
    },
    /** 通話・判定器に使うキーを選ぶ（id が null なら使わない）。選んだときから外部へ送り始める */
    async setUse(use, id) {
      await writable();
      if (!USES.includes(use)) throw new ApiKeyError('UNKNOWN_USE', { use: String(use) });
      if (id !== null && id !== undefined) {
        const key = known(String(id));
        if (!key) throw new ApiKeyError('NOT_FOUND');
        if (key.provider !== USE_PROVIDER[use]) throw new ApiKeyError('PROVIDER_MISMATCH', { provider: providerName(USE_PROVIDER[use]) || USE_PROVIDER[use] });
      }
      await mutate(s => { s.uses[use] = id ? String(id) : null; });
      await mirrorUse(use);
      emit({ uses: [use] });
      return { use, id: state.uses[use] };
    },
    /** 古い置き場の項目を揃える（互換の接続先を保存したとき） */
    mirrorEndpoint,
    /** 移行の案内。keep のキーに残して他の同じプロバイダーのキーをまとめる。keep が null なら「このままにする」（どちらでも案内は二度と出ない） */
    async resolveGuide(keep) {
      await writable();
      if (state.guide !== 'pending') return { merged: [] };
      if (keep === null || keep === undefined) { await mutate(s => { s.guide = 'done'; }); emit({ keys: true }); return { merged: [] }; }
      const target = known(String(keep));
      if (!target) throw new ApiKeyError('NOT_FOUND');
      const drop = state.keys.filter(k => k.provider === target.provider && k.id !== target.id).map(k => k.id);
      const dropSet = new Set(drop);
      const movedUses = USES.filter(u => dropSet.has(state.uses[u]));
      const movedEndpoints = ((await eps()?.keyUsers?.()) ?? []).filter(e => dropSet.has(e.keyRef)).map(e => e.id);
      if (movedEndpoints.length) await eps().retargetKey(drop, target.id);
      await mutate(s => {
        for (const u of USES) if (dropSet.has(s.uses[u])) s.uses[u] = target.id;
        s.keys = s.keys.filter(k => !dropSet.has(k.id));
        known(target.id).label = providerName(target.provider) || target.label;
        known(target.id).lastCheck = null;
        s.guide = 'done';
      });
      for (const u of movedUses) await mirrorUse(u);
      for (const epId of movedEndpoints) await mirrorEndpoint(epId, target.id);
      for (const id of drop) await secrets.delete(SECRET_PREFIX + id).catch(() => {});
      emit({ keys: true, uses: movedUses, endpoints: movedEndpoints.length > 0 });
      return { merged: drop, keep: target.id };
    },
    /** キーそのものを確かめる。結果は台帳に記録する。プロバイダーが確かめ方を持たなければ { ok: null, code: 'unsupported' } */
    async check(id) {
      await ensure();
      if (!migrated()) throw new ApiKeyError('MIGRATION_PENDING');
      const key = known(String(id ?? ''));
      if (!key) throw new ApiKeyError('NOT_FOUND');
      if (!CHECKABLE.has(key.provider)) return { id: key.id, ok: null, code: 'unsupported' };
      const value = await keyValue(key.id);
      if (!value) throw new ApiKeyError('NOT_FOUND');
      const result = await probe(key.provider, value);
      const at = iso(now());
      await mutate(() => { const k = known(key.id); if (k) k.lastCheck = { ok: result.ok, at, ...(result.code ? { code: result.code } : {}), ...(result.status ? { status: result.status } : {}) }; }).catch(() => {});
      emit({ keys: true });
      return { id: key.id, ...result, at };
    },
    /** 接続先を保存するとき、新しく入れたキーの登録を取り消す（保存に失敗したとき） */
    async discard(id) {
      await serial(async () => {
        if (!known(id) || (await usersOf(id)).length) return;
        const before = structuredClone(state);
        try { state.keys = state.keys.filter(k => k.id !== id); await save(); } catch { state = before; return; }
        await secrets.delete(SECRET_PREFIX + id).catch(() => {});
      });
    },
    /** 値が同じキーがあるか（テスト用ではなく、接続先の「別のキーを入れる」で同じ値を重ねて登録しないため） */
    async findByValue(provider, key, host) {
      await ensure();
      const value = normalizeApiKey(key);
      if (!value || !migrated()) return null;
      const want = normalizeHost(provider, host);
      for (const k of state.keys) {
        if (k.provider !== provider) continue;
        // ホストの決まっていないプロバイダーは、同じホストのキー（まだ結び付いていないキーはそのホストに結び付ける）だけ再利用する
        if (!FIXED_HOST_PROVIDERS.has(provider) && k.host && k.host !== want) continue;
        if ((await keyValue(k.id).catch(() => null)) === value) { if (!k.host && want) await mutate(() => { known(k.id).host = want; }); return k.id; }
      }
      return null;
    },
    /** キーをその接続先（{ preset, baseUrl }）で選んでよいか（プロバイダーとホストが合うか）。値は読まない */
    async fits(id, endpoint) {
      await ensure();
      return keyFitsEndpoint(known(String(id ?? '')), endpoint);
    },
    /** ホストの決まっていないプロバイダーのキーを、初めて選んだ接続先のホストに結び付ける（後は同じホストの接続先でだけ選べる） */
    async bindHost(id, baseUrl) {
      await ensure();
      const key = known(String(id ?? ''));
      const host = key ? normalizeHost(key.provider, hostOf(baseUrl)) : null;
      if (!key || key.host || !host) return;
      await mutate(() => { key.host = host; });
    },
  };
  return api;
}
