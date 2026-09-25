// Claude のアカウントの切り替え（会話ごと）。
//
// アカウントごとに `claude setup-token` で発行した長期 OAuth トークンを登録しておき、
// その会話の query() の env にだけ CLAUDE_CODE_OAUTH_TOKEN を入れる。process.env は書き換えない
// （書き換えると Pleiad から起動するすべての会話がそのアカウントになる）。
// CLAUDE_CONFIG_DIR は切り替えないので、transcript・CLAUDE.md・skills・MCP は両方のアカウントで共有され、
// 会話の途中でアカウントを変えても resume で続きから話せる。
//
// 何も選んでいない会話（'' = ログイン中のアカウント）は env に何も足さない＝今までと同じ動き。
// ANTHROPIC_API_KEY（や ANTHROPIC_AUTH_TOKEN）が process.env にあれば、CLI の優先順位どおりそちらが勝つ。ここでは消さない。
//
// 置き場:
//   <data>/claude-accounts.json          一覧（id と表示名、トークンの持ち主の確認結果 tokenOrg / tokenCheckedAt。秘密は入れない）
//   <data>/claude-account-secrets.json   トークン（core/secret-store.mjs。MCP の秘密と同じく safeStorage で暗号化、
//                                        使えない起動では 0600 の平文）
//   <data>/claude-usage/<id>/            使用量を読むためだけの設定フォルダ（CLAUDE_CONFIG_DIR）。Pleiad がここで `claude auth login` を回す
//                                        （core/claude-login.mjs）。setup-token のトークンは scope が user:inference だけで使用量を読めないため。
//                                        会話はここを使わない（共有の設定フォルダ＋トークンのまま）。認可が済むと ply-usage-login.json を置く
// トークンはクライアントへ返さない（hasToken だけ）。ログ・エラーメッセージにも出さない（redactToken）。
//
// トークンの持ち主の確認: `claude setup-token` はブラウザーでログイン中の claude.ai アカウントで黙って発行されるので、
// 使用量の認可（claude-usage/<id>）とは別のアカウントのトークンが登録されうる（2026-09-23 に実際に起きた）。
// トークンで GET /v1/models?limit=1 を送ると（推論は消費しない）応答ヘッダー anthropic-organization-id に組織が出る。
// トークンを保存したとき（この確認より前に保存したトークンは、一覧を引いたときに裏で 1 度）それを tokenOrg として記録し、
// 使用量の設定フォルダの .claude.json の oauthAccount.organizationUuid と比べる（list() の tokenCheck）。
// 組織の id・メールアドレスは秘密ではないが、ログには出さない。確認に失敗しても保存は止めない（未確認のまま残し、数分おいて確かめ直す）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n.mjs';

export const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const SECRET_PREFIX = 'claude-account:';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 60;
const USAGE_MARKER = 'ply-usage-login.json';
export const ANTHROPIC_API = 'https://api.anthropic.com';
export const TOKEN_CHECK_TIMEOUT_MS = 10_000;
/** 確認に失敗したアカウントを、一覧を引いたときに裏で確かめ直すまでの間（失敗のたびに叩き続けない） */
export const TOKEN_CHECK_RETRY_MS = 5 * 60_000;
const ORG = /^[A-Za-z0-9-]{8,64}$/;

/**
 * query() に渡す env を組み立てる。base は広げて写すだけで、書き換えない。
 * token が無ければ base + extra のまま（CLAUDE_CODE_OAUTH_TOKEN を足しも消しもしない）。
 */
export function claudeEnv(base = process.env, { token, extra = {} } = {}) {
  const env = { ...base, ...extra };
  if (token) env[TOKEN_ENV] = token;
  return env;
}

/** 文字列の中のトークンを伏せる。エラーメッセージ・stderr の記録に使う */
export function redactToken(text, token) {
  const s = String(text ?? '');
  return token ? s.split(token).join(t('claude.redacted.token')) : s;
}

export function normalizeToken(value) {
  const token = String(value ?? '').trim();
  // setup-token が出すのは sk-ant-oat01-… の 1 行。空白や改行が混じるのは貼り間違い
  if (!/^[\x21-\x7e]{20,4096}$/.test(token)) {
    throw new Error(t('claude.accounts.badToken'));
  }
  return token;
}

export function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error(t('claude.accounts.nameRequired'));
  if (name.length > MAX_NAME) throw new Error(t('claude.accounts.nameTooLong', { max: MAX_NAME }));
  return name;
}

/**
 * トークンが発行された組織（応答ヘッダー anthropic-organization-id）を引く。GET /v1/models?limit=1 は推論を消費しない（2026-09-23 確認）。
 * 失敗は例外（メッセージにトークンを含めない）。/api/oauth/profile は scope が user:inference だけのトークンでは読めない
 */
export async function fetchTokenOrg(token, { fetch = globalThis.fetch, baseUrl = ANTHROPIC_API, timeoutMs = TOKEN_CHECK_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/v1/models?limit=1`, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { throw new Error(t('claude.accounts.ownerUnknown', { message: redactToken(e?.message ?? e, token) })); }
  const org = res.headers?.get?.('anthropic-organization-id') ?? '';
  try { await res.body?.cancel?.(); } catch {}
  if (!res.ok) throw new Error(t('claude.accounts.ownerHttp', { status: res.status }));
  if (!ORG.test(org)) throw new Error(t('claude.accounts.ownerNoOrg'));
  return org;
}

/** Claude Code の設定（.claude.json）でログインしているアカウント。{ org, email } か null */
export async function readOauthAccount(file) {
  try {
    const account = JSON.parse((await fs.readFile(file, 'utf8')).trimStart())?.oauthAccount;
    const org = typeof account?.organizationUuid === 'string' && ORG.test(account.organizationUuid) ? account.organizationUuid : null;
    if (!org) return null;
    return { org, email: typeof account.emailAddress === 'string' && account.emailAddress ? account.emailAddress : null };
  } catch { return null; }
}

/** CLI（共有の設定フォルダ）の .claude.json。CLAUDE_CONFIG_DIR があればその中、無ければホームの直下 */
export function cliConfigFile(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
}

/**
 * 各アカウントのトークンの照合結果を組み立てる（純粋関数）。
 *   rows: { id, name, hasToken, tokenOrg, usage: { org, email } | null }[]
 *   cli:  ログイン中のアカウント { org, email } | null
 * 返すのは id → { status, expectedEmail?, ownerName?, ownerLoggedIn?, ownerEmail?, sameTokenAs? }
 *   ok        トークンの組織 = そのアカウントの使用量の認可の組織
 *   mismatch  違う。使用量の認可が無くても、別の登録アカウントの使用量の組織と同じなら、そのアカウントのトークン
 *             持ち主は、別の登録アカウント（ownerName）→ ログイン中のアカウント（ownerLoggedIn）の順に探す
 *   unknown   未確認・確認に失敗・使用量の認可が無くて比べられない
 * expectedEmail は使用量の認可のアカウント（本来の持ち主）。
 * sameTokenAs は同じ組織のトークンを持つ別の登録（同じアカウントを 2 つ登録している）。mismatch の説明で足りるときは付けない
 */
export function tokenChecks(rows, cli = null) {
  const result = new Map();
  for (const a of rows) {
    const out = { status: 'unknown' };
    if (a.hasToken && a.tokenOrg) {
      if (a.usage?.org) {
        out.status = a.tokenOrg === a.usage.org ? 'ok' : 'mismatch';
        if (a.usage.email) out.expectedEmail = a.usage.email;
      }
      if (out.status !== 'ok') {
        const owner = rows.find(b => b.id !== a.id && b.usage?.org === a.tokenOrg);
        if (owner) { out.status = 'mismatch'; out.ownerName = owner.name; if (owner.usage.email) out.ownerEmail = owner.usage.email; }
        else if (out.status === 'mismatch' && cli?.org === a.tokenOrg) { out.ownerLoggedIn = true; if (cli.email) out.ownerEmail = cli.email; }
      }
    }
    result.set(a.id, out);
  }
  for (const a of rows) {
    const out = result.get(a.id);
    if (!a.hasToken || !a.tokenOrg || out.status === 'mismatch') continue;
    // ok 同士（同じアカウントを 2 つ登録し、どちらも照合が合う）か、比べられないもの同士。
    // 相手が mismatch なら間違っているのは相手なので、こちらには付けない
    const same = rows.filter(b => b.id !== a.id && b.hasToken && b.tokenOrg === a.tokenOrg && result.get(b.id).status !== 'mismatch'
      && (out.status !== 'ok' || result.get(b.id).status === 'ok'));
    if (same.length) out.sameTokenAs = same.map(b => b.name);
  }
  return result;
}

/** 選んだアカウントを使えないときのエラー。code で見分ける（deleted / missing-token / unreadable） */
export class AccountError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {ReturnType<import('./secret-store.mjs').createSecretStore>} o.secrets
 * @param {((token: string) => Promise<string>) | null} [o.checkOrg]  トークンの組織を引く（fetchTokenOrg）。null なら確かめない
 * @param {() => void} [o.onChecked]  裏での確認（保存より前のトークン）の結果を記録したとき。一覧が変わったことを知らせる
 * @param {string} [o.cliConfig]      ログイン中のアカウントの .claude.json（既定は cliConfigFile()）
 */
export function createClaudeAccounts({ dataDir, secrets, checkOrg = null, onChecked = () => {}, cliConfig = cliConfigFile(),
  retryMs = TOKEN_CHECK_RETRY_MS, now = Date.now } = {}) {
  const file = path.join(dataDir, 'claude-accounts.json');
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };

  async function read() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.version !== 1 || !Array.isArray(raw.accounts)) throw new Error('bad');
      return { version: 1, accounts: raw.accounts.filter(a => ID.test(a?.id ?? '') && typeof a.name === 'string') };
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, accounts: [] };
      throw new Error(t('claude.accounts.listBroken'));
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
  const key = id => SECRET_PREFIX + id;
  const usageRoot = path.join(dataDir, 'claude-usage');
  const usageDir = id => {
    if (!ID.test(id ?? '')) throw new Error(t('claude.accounts.badId'));
    return path.join(usageRoot, id);
  };
  const usageMarker = id => path.join(usageDir(id), USAGE_MARKER);
  const hasUsageLogin = id => fs.access(usageMarker(id)).then(() => true, () => false);
  const usageAccount = id => readOauthAccount(path.join(usageDir(id), '.claude.json'));

  // ---- トークンの持ち主の確認
  // generation はトークンを差し替えるたびに進める。確認の途中で差し替わったら、古いトークンの結果は記録しない
  const generation = new Map();
  const inflight = new Map();   // id → { gen, promise }。同じアカウントの確認は 1 本にまとめる
  const attempted = new Map();  // id → 最後に確認を始めた時刻。失敗したあと一覧のたびに叩き続けない
  const bump = id => { generation.set(id, (generation.get(id) ?? 0) + 1); attempted.delete(id); };
  /** トークンの組織を確かめて記録する。{ changed } を返す（失敗しても例外にしない。未確認のまま残る） */
  function checkToken(id) {
    if (!checkOrg) return Promise.resolve({ changed: false });
    const gen = generation.get(id) ?? 0;
    const running = inflight.get(id);
    if (running?.gen === gen) return running.promise;
    attempted.set(id, now());
    const promise = (async () => {
      let org;
      try {
        const value = await secrets.get(key(id));
        if (!value?.token) return { changed: false };
        org = String(await checkOrg(value.token) ?? '');
      } catch { return { changed: false }; }
      if (!ORG.test(org)) return { changed: false };
      return serial(async () => {
        if ((generation.get(id) ?? 0) !== gen) return { changed: false };
        const data = await read();
        const entry = data.accounts.find(a => a.id === id);
        if (!entry) return { changed: false };
        entry.tokenOrg = org; entry.tokenCheckedAt = new Date(now()).toISOString();
        await write(data);
        return { changed: true };
      }).catch(() => ({ changed: false }));
    })().finally(() => { if (inflight.get(id)?.promise === promise) inflight.delete(id); });
    inflight.set(id, { gen, promise });
    return promise;
  }
  /** この確認より前に保存したトークン（記録が無い）を裏で確かめる。list() は待たせない */
  function backfill(entries, stored) {
    if (!checkOrg) return;
    for (const a of entries) {
      if (!stored.has(key(a.id)) || a.tokenCheckedAt || inflight.has(a.id)) continue;
      const last = attempted.get(a.id);
      if (last !== undefined && now() - last < retryMs) continue;
      checkToken(a.id).then(({ changed }) => { if (changed) onChecked(); }, () => {});
    }
  }

  /** 一覧のファイルへの追加・変更。トークンを書いたら tokenChanged */
  function saveEntry({ id, name, token } = {}) {
    return serial(async () => {
      const data = await read();
      const label = normalizeName(name);
      if (id !== undefined && id !== null && id !== '') {
        const entry = data.accounts.find(a => a.id === id);
        if (!entry) throw new Error(t('claude.accounts.notRegistered'));
        let tokenChanged = false;
        if (token !== undefined && token !== null && String(token).trim() !== '') {
          await secrets.set(key(id), { token: normalizeToken(token) });
          // 差し替えたトークンの持ち主はまだ分からない
          delete entry.tokenOrg; delete entry.tokenCheckedAt;
          bump(id); tokenChanged = true;
        }
        entry.name = label;
        await write(data);
        return { id, tokenChanged };
      }
      const secret = normalizeToken(token);
      const created = 'acct-' + crypto.randomBytes(6).toString('hex');
      // 秘密を先に書く。一覧に出た時点でトークンが揃っているように
      await secrets.set(key(created), { token: secret });
      data.accounts.push({ id: created, name: label, createdAt: new Date().toISOString() });
      try { await write(data); } catch (e) { await secrets.delete(key(created)).catch(() => {}); throw e; }
      bump(created);
      return { id: created, tokenChanged: true };
    });
  }

  return {
    file,
    /**
     * 一覧。トークンは返さず、登録済みかどうか（hasToken）だけ。
     * tokenCheck はトークンの持ち主の照合（tokenChecks）。未確認のトークンがあれば裏で確かめ、記録できたら onChecked
     */
    async list() {
      const [{ accounts }, keys, storage, cli] = await Promise.all([read(), secrets.keys(SECRET_PREFIX).catch(() => []),
        secrets.status().catch(() => null), readOauthAccount(cliConfig)]);
      const stored = new Set(keys);
      backfill(accounts, stored);
      const rows = await Promise.all(accounts.map(async a => {
        const usageLogin = await hasUsageLogin(a.id);
        return { id: a.id, name: a.name, hasToken: stored.has(key(a.id)), usageLogin,
          tokenOrg: typeof a.tokenOrg === 'string' ? a.tokenOrg : null, usage: usageLogin ? await usageAccount(a.id) : null };
      }));
      const checks = tokenChecks(rows, cli);
      return {
        accounts: rows.map(a => ({ id: a.id, name: a.name, hasToken: a.hasToken, usageLogin: a.usageLogin, tokenCheck: checks.get(a.id) })),
        storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
      };
    },
    async has(id) {
      return (await read()).accounts.some(a => a.id === id);
    },
    /**
     * 追加（id 無し）か、名前の変更・トークンの差し替え（id 有り。token を省けば今のトークンを残す）。
     * トークンを書いたら持ち主を確かめて記録してから返す（確かめられなくても保存はそのまま。未確認で残る）
     */
    async save(args = {}) {
      const saved = await saveEntry(args);
      if (saved.tokenChanged) await checkToken(saved.id);
      return { id: saved.id };
    },
    /** トークンの持ち主を確かめ直す。{ changed } */
    checkToken,
    remove(id) {
      return serial(async () => {
        const data = await read();
        const next = data.accounts.filter(a => a.id !== id);
        if (next.length === data.accounts.length) throw new Error(t('claude.accounts.notRegistered'));
        await write({ ...data, accounts: next });
        bump(id);
        // 消すだけなら復号は要らない（復号できない起動でも消せる）
        await secrets.delete(key(id)).catch(() => {});
        // 使用量の認可（CLI の資格情報）も消す
        await fs.rm(usageDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      });
    },
    /** 使用量を読むための設定フォルダ（CLAUDE_CONFIG_DIR）。作りはしない */
    usageDir,
    hasUsageLogin,
    /** 使用量の認可（`claude auth login`）が済んだ印を置く */
    async markUsageLogin(id) {
      if (!(await read()).accounts.some(a => a.id === id)) throw new Error(t('claude.accounts.notRegistered'));
      await fs.mkdir(usageDir(id), { recursive: true });
      await fs.writeFile(usageMarker(id), JSON.stringify({ at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    },
    /**
     * 委譲の振り分けで同じ人のアカウントを見分ける手がかり（core/delegation-routing.mjs の dedupeAccounts）。
     * login はログイン中のアカウント、accounts[].identity は使用量の設定フォルダでログインしたアカウント（{ org, email } か null）
     */
    async identities() {
      const [{ accounts }, keys, login] = await Promise.all([read(), secrets.keys(SECRET_PREFIX).catch(() => []), readOauthAccount(cliConfig)]);
      const stored = new Set(keys);
      return { login, accounts: await Promise.all(accounts.map(async a => ({ id: a.id, hasToken: stored.has(key(a.id)),
        identity: (await hasUsageLogin(a.id)) ? await usageAccount(a.id) : null }))) };
    },
    /** 使用量の表示に使うアカウント（トークンは要らない。設定フォルダで読む） */
    async usageTargets() {
      const { accounts } = await read();
      return Promise.all(accounts.map(async a => ({ id: a.id, name: a.name, configDir: usageDir(a.id), usageLogin: await hasUsageLogin(a.id) })));
    },
    /**
     * 会話で使うトークンを引く。'' / 未指定はログイン中のアカウント（null を返す＝env に何も足さない）。
     * 削除済み・トークン無し・読めないときは AccountError（黙ってログイン中のアカウントへ落とさない）
     */
    async resolve(id) {
      if (!id) return null;
      const entry = (await read()).accounts.find(a => a.id === id);
      if (!entry) throw new AccountError(t('claude.accounts.deleted'), 'deleted');
      let value;
      try { value = await secrets.get(key(id)); }
      catch (e) {
        throw new AccountError(t('claude.accounts.tokenUnreadable', { name: entry.name, message: e.message }), 'unreadable');
      }
      if (!value?.token) throw new AccountError(t('claude.accounts.tokenMissing', { name: entry.name }), 'missing-token');
      return { id, name: entry.name, token: value.token };
    },
  };
}
