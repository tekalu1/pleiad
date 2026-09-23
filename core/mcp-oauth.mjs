// 外部 MCP（担当が Pleiad のもの）の OAuth 2.1。MCP の認可仕様（2025-06-18 / 2025-11-25）に沿う。
//
// 土台は @modelcontextprotocol/sdk 1.30 の auth()（OAuthClientProvider）。任せているのは
//   WWW-Authenticate の resource_metadata → RFC 9728 保護リソースメタデータ → RFC 8414 / OIDC の AS メタデータ探索、
//   DCR（RFC 7591）、Client ID Metadata Documents（SEP-991）の client_id、PKCE S256 の認可 URL、
//   認可コードの交換、リフレッシュの 1 回分（refreshAuthorization）。
// SDK で足りない点をここで補う:
//   - 認可を始める前に MCP へ 1 回つないで WWW-Authenticate の resource_metadata と scope を拾う（SDK は 401 を受けた transport からしか渡さない）
//   - クライアントの選び方は「手入力の clientId > Client ID Metadata Document（AS が対応していて URL を設定したとき）> DCR」。
//     DCR で登録したクライアントは保存して再利用する（AS とリダイレクト URI が同じ間）。作り直したときは古い方を RFC 7592 で消す
//   - resource（RFC 8707）を常に付ける（SDK は保護リソースメタデータが無いと付けない）
//   - ブラウザの戻り先はループバック（127.0.0.1）。127.0.0.1 を拒む AS には localhost で登録し直す。state を検証し、合わないものは捨てて待ち続ける
//   - 探索で得た URL は取りに行く前に検査する（core/mcp-url-guard.mjs。https 必須・内部アドレスの拒否・リダイレクトの検査）
//   - 期限前のリフレッシュ、期限の無いトークンの定期リフレッシュ、ローテーションの保存、プロセス内 single-flight とプロセス間ロック
//   - 401 を受けたら 1 回だけリフレッシュして再送（authFetch）。transport の authProvider は使わない
//     （SDK の transport は 401 で auth() を呼び、ブラウザへ飛ぶ流れまで進めてしまう。ターンの中では開かない）
//   - 403 insufficient_scope の scope を覚えて、次のログインで今の scope と合わせて求める（ステップアップ）
//   - ログアウト時の失効（RFC 7009）
// 流れの組み立ては上流の Procway の MCP 接続（OAuth）の実装に合わせた。
// コードはこのリポジトリ向けに書き直している。
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { auth, discoverAuthorizationServerMetadata, extractWWWAuthenticateParams, isHttpsUrl, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidClientError, InvalidGrantError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { oauthErrorHtml, oauthSuccessHtml } from './auth/oauth-page.mjs';
import { withFileLock } from './secret-store.mjs';
import { createUrlGuard } from './mcp-url-guard.mjs';
import { pinnedFetch } from './pinned-fetch.mjs';

const EARLY_REFRESH_MS = 60_000;
// 期限（expires_in）の無いトークン。401 を受けてからのリフレッシュだけだと、AS 側で取り消されたアクセストークンや、
// 期限を知らせないだけで実際は短命なトークンのたびに「送る → 401 → リフレッシュ → 送り直す」の往復が挟まる。
// そこで取得から 1 時間を過ぎたものは、使う前に 1 回だけ軽くリフレッシュを試みる。
// 失敗しても（通信の失敗・AS の拒否）今のアクセストークンで続け、ログインを求めるのは実際に 401 を受けたときだけにする。
// リフレッシュトークンが無いものは何もしない（試みようがない）。1 時間は一般的なアクセストークンの寿命に合わせた値
const STALE_WITHOUT_EXPIRY_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const stateKey = name => `mcp:${name}:oauth`;

/** 利用者のログインが要る（トークンが無い・失効した・リフレッシュが拒まれた） */
export class McpAuthRequired extends Error {
  constructor(message = 'ログインが必要です。設定 › コンテキストの外部 MCP から「ログイン」してください') { super(message); this.code = 'MCP_AUTH_REQUIRED'; }
}

/** 空白区切りの scope を重複なく合わせる。空なら undefined */
export function scopeUnion(...lists) {
  const set = new Set();
  for (const s of lists) for (const x of String(s ?? '').split(/\s+/)) if (x) set.add(x);
  return set.size ? [...set].join(' ') : undefined;
}

/** 期限つきのトークンに expires_at（ミリ秒）を足す。期限が無ければ付けない */
function withExpiry(tokens, now) {
  const { expires_in, ...rest } = tokens;
  return { ...rest, ...(Number.isFinite(expires_in) ? { expires_at: now + expires_in * 1000 } : {}), obtained_at: now };
}
const fresh = (tokens, now) => Boolean(tokens?.access_token) && (!tokens.expires_at || tokens.expires_at - now > EARLY_REFRESH_MS);
/** 期限の無いトークンで、取得から時間が経ったもの（使う前に軽くリフレッシュする） */
const stale = (tokens, now) => Boolean(tokens?.refresh_token) && !tokens.expires_at && now - (tokens.obtained_at ?? 0) > STALE_WITHOUT_EXPIRY_MS;
const timed = fetchFn => (url, init = {}) => fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
const sameUrl = (a, b) => { try { return new URL(a).href === new URL(b).href; } catch { return false; } };

function listen(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
function closeServer(server) {
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
}
function page(res, status, html) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); }

/** DCR が「リダイレクト URI を受け付けない」で断ったか（RFC 7591 §3.2.2） */
function redirectRejectedByRegistration(flow, error) {
  if (flow.dcrError === 'invalid_redirect_uri') return true;
  return flow.dcrError === 'invalid_client_metadata' && /redirect/i.test(`${flow.dcrErrorDescription ?? ''} ${error?.message ?? ''}`);
}

/**
 * @param {object} o
 * @param {ReturnType<import('./secret-store.mjs').createSecretStore>} o.secrets
 * @param {string} o.lockDir リフレッシュのプロセス間ロックを置く場所
 * @param {(url: string) => void} [o.openExternal] 同意画面をブラウザで開く
 * @param {(event: object) => void} [o.emit] { type:'mcpAuth', name, phase:'url'|'done'|'error', url?, message? }
 * @param {() => (string|undefined|Promise<string|undefined>)} [o.clientMetadataUrl] Client ID Metadata Document の URL（設定値。既定は無し）
 * @param {Function} [o.lookup] 名前解決（SSRF の検査用。テストで差し替える）
 * @param {boolean} [o.preflight] 認可 URL を先に 1 回叩いて、戻り先（127.0.0.1）が拒まれないかを見る
 */
export function createMcpOAuth({ secrets, lockDir, openExternal = () => {}, emit = () => {}, fetchFn = fetch, now = Date.now, clientName = 'Pleiad',
  flowTtlMs = 10 * 60 * 1000, clientMetadataUrl = () => undefined, lookup, preflight = true }) {
  // 検査で名前を解決した行き先は、その答えのアドレスに固定して接続する（pinnedAddresses が無ければ fetchFn のまま）
  const f = timed((url, init) => pinnedFetch(url, init, { fetchFn }));
  const flows = new Map();      // name -> 進行中のログイン
  const refreshing = new Map(); // name(+種類) -> 進行中のリフレッシュ（single-flight）
  const lastError = new Map();  // name -> 直近の失敗の文（ログイン・探索先の拒否など）

  /** 探索で得た URL を検査してから取りに行く fetch。基準は利用者が登録した MCP の URL */
  const guardFor = definition => createUrlGuard({ serverUrl: definition.url, ...(lookup ? { lookup } : {}) });
  /** リフレッシュのプロセス間ロック。登録名を変えても同じロックを使うよう、名前を変えたものは lockId を持つ */
  const lockPath = (name, definition) => path.join(lockDir, `${crypto.createHash('sha256').update(definition?.lockId ?? name).digest('hex').slice(0, 24)}.lock`);

  /** 手入力のクライアント（DCR 非対応の AS 向け）。無ければ Client ID Metadata Document か DCR */
  const manualClient = (definition, conn) => definition.oauth?.clientId
    ? { client_id: definition.oauth.clientId, ...(conn?.oauth?.clientSecret ? { client_secret: conn.oauth.clientSecret } : {}) } : null;
  /** 保存したクライアントの情報（リフレッシュ・失効で使う） */
  const savedClientInfo = (s, definition, conn) => (s?.client?.dynamic || s?.client?.metadataDocument) ? s.client.info : manualClient(definition, conn);

  /** 認可前に MCP へ 1 回つなぎ、401 / 403 の WWW-Authenticate から resource_metadata と scope を拾う */
  async function probe(definition) {
    try {
      const res = definition.transport === 'sse'
        ? await f(definition.url, { headers: { accept: 'text/event-stream' }, redirect: 'manual' })
        : await f(definition.url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ply', version: '1.0.0' } } }) });
      await res.body?.cancel().catch(() => {});
      if (res.status !== 401 && res.status !== 403) return { status: res.status };
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
      return { status: res.status, bearer: /^\s*bearer\b/i.test(res.headers.get('www-authenticate') ?? ''), resourceMetadataUrl, scope };
    } catch { return {}; }
  }

  /** RFC 7592 の登録管理でクライアントを消す。失敗しても止めない（AS に古い登録が残るだけ） */
  async function deleteRegistration(client, definition) {
    const uri = client?.management?.uri, token = client?.management?.token;
    if (!uri || !token) return { deleted: false, reason: 'registration_client_uri / registration_access_token がありません' };
    try {
      const res = await guardFor(definition).wrap(f, '登録管理の URL')(uri, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      await res.body?.cancel().catch(() => {});
      return res.status === 204 || res.ok ? { deleted: true } : { deleted: false, reason: `HTTP ${res.status}` };
    } catch (e) { return { deleted: false, reason: String(e.message).slice(0, 200) }; }
  }

  /** 認可 URL を 1 回叩いて、AS が戻り先を拒むか見る。ブラウザで開く前に分かれば localhost に切り替えられる */
  async function authorizationRejectsRedirect(url, guard) {
    try {
      const { addresses } = await guard.inspect(url, '認可エンドポイント');
      const res = await pinnedFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS), ...(addresses ? { pinnedAddresses: addresses } : {}) }, { fetchFn });
      if (res.status < 400 || res.status >= 500) { await res.body?.cancel().catch(() => {}); return false; }
      const text = (await res.text()).slice(0, 8192);
      return /redirect[_\s-]?ur[il]/i.test(text);
    } catch { return false; }
  }

  function cancel(name, message) {
    const flow = flows.get(name);
    if (!flow) return;
    flows.delete(name);
    clearTimeout(flow.timer);
    for (const s of flow.servers) closeServer(s);
    if (message) { lastError.set(name, message); emit({ type: 'mcpAuth', name, phase: 'error', message }); }
  }

  /**
   * ログインを始める。認可 URL を作ってブラウザを開き、戻り（ループバック）は裏で待つ。
   * 完了・失敗は emit（phase: done / error）と status() で分かる。
   */
  async function start(name, definition, conn = null) {
    if (definition?.auth !== 'oauth') throw new Error('この MCP の認証方式は OAuth ではありません');
    cancel(name);
    lastError.delete(name);
    const saved = await secrets.get(stateKey(name)).catch(e => { if (e.code === 'SECRET_LOCKED') throw e; return undefined; });
    const current = saved?.serverUrl === definition.url ? saved : undefined;
    const serverUrl = definition.url;
    const manual = manualClient(definition, conn);
    const metadataUrl = manual ? undefined : await clientMetadataUrl();
    const cimdUrl = metadataUrl && isHttpsUrl(metadataUrl) ? metadataUrl : undefined;
    const guard = guardFor(definition);
    const www = await probe(definition);
    // ステップアップ: 403 insufficient_scope が示した scope があれば、今の scope と合わせて求める
    const baseScope = definition.oauth?.scope || www.scope || undefined;
    const scope = current?.stepUpScope ? scopeUnion(baseScope, current.tokens?.scope ?? current.scope, current.stepUpScope) : baseScope;
    // 戻り先のポート。固定の指定 > 前回 DCR で登録したポート（同じ URI なら登録を使い回せる）> 空き
    const savedPort = !manual && saved?.client?.dynamic && saved.client.redirectUri ? Number(new URL(saved.client.redirectUri).port) : 0;
    let server;
    if (definition.oauth?.callbackPort) {
      server = await listen(definition.oauth.callbackPort).catch(() => { throw new Error(`戻り先のポート ${definition.oauth.callbackPort} が使えません。ほかのアプリを閉じるか、callbackPort を変えてください`); });
    } else {
      server = await listen(savedPort).catch(() => listen(0));
    }
    // 前に 127.0.0.1 を拒まれた AS には、最初から localhost で登録する
    const host = saved?.redirectHost === 'localhost' || (saved?.client?.redirectUri && new URL(saved.client.redirectUri).hostname === 'localhost') ? 'localhost' : '127.0.0.1';
    const flow = { name, servers: [server], port: server.address().port, host, state: crypto.randomBytes(32).toString('hex'), verifier: null, discovery: null, client: null,
      clientKind: null, tokens: null, resource: null, url: null, scope, definition, conn, registration: null, removed: [] };
    Object.defineProperty(flow, 'redirectUri', { get: () => `http://${flow.host}:${flow.port}/callback` });
    const cimdApplies = () => Boolean(cimdUrl) && flow.discovery?.authorizationServerMetadata?.client_id_metadata_document_supported === true;

    // 探索・登録・トークンの要求はすべて検査つきの fetch で。DCR の応答からは登録管理（RFC 7592）の値とエラーの種類も拾う
    // （SDK の registerClient は registration_access_token などを捨て、未知のエラーコードは server_error にしてしまう）
    const guarded = guard.wrap(f);
    const flowFetch = async (url, init = {}) => {
      // 拒んだ理由は覚えておく。SDK は保護リソースメタデータの失敗を握りつぶして既定の場所へ進むので、最後の失敗の文より先に出す
      const res = await guarded(url, init).catch(e => { if (e?.code === 'MCP_URL_REJECTED') flow.rejected ??= e.message; throw e; });
      const endpoint = flow.discovery?.authorizationServerMetadata?.registration_endpoint;
      if ((init.method ?? 'GET').toUpperCase() === 'POST' && endpoint && sameUrl(String(url), endpoint)) {
        const body = await res.clone().json().catch(() => null);
        if (res.ok) flow.registration = body?.registration_client_uri && body?.registration_access_token ? { uri: body.registration_client_uri, token: body.registration_access_token } : null;
        else { flow.dcrError = body?.error; flow.dcrErrorDescription = body?.error_description; }
      }
      return res;
    };

    const provider = {
      get redirectUrl() { return flow.redirectUri; },
      get clientMetadata() {
        return { client_name: clientName, redirect_uris: [flow.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          token_endpoint_auth_method: manual?.client_secret ? 'client_secret_basic' : 'none', ...(scope ? { scope } : {}) };
      },
      ...(cimdUrl ? { clientMetadataUrl: cimdUrl } : {}),
      state: () => flow.state,
      clientInformation() {
        if (manual) { flow.clientKind = 'manual'; return manual; }
        if (flow.client) return flow.client.info;
        // AS が Client ID Metadata Document に対応し、文書の URL を設定してあれば、その URL を client_id にする（DCR より優先）
        if (cimdApplies()) { flow.clientKind = 'metadata-document'; return { client_id: cimdUrl }; }
        // 保存済みの DCR クライアントは、同じ認可サーバー・同じ戻り先の間だけ使い回す
        const c = saved?.client;
        if (c?.dynamic && !flow.dropClient && c.redirectUri === flow.redirectUri && c.issuer === flow.discovery?.authorizationServerUrl) { flow.clientKind = 'dynamic'; return c.info; }
        return undefined;
      },
      async saveClientInformation(info) {
        // ここに来るのは DCR で新しく登録したときだけ（手入力・メタデータ文書は clientInformation() が返す）
        const replaced = flow.superseded ?? flow.client ?? (saved?.client?.dynamic ? saved.client : null);
        flow.superseded = null;
        flow.client = { info, issuer: flow.discovery?.authorizationServerUrl, redirectUri: flow.redirectUri, dynamic: true, registeredAt: new Date(now()).toISOString(),
          ...(flow.registration ? { management: flow.registration } : {}) };
        flow.clientKind = 'dynamic';
        // 同意を途中でやめても、登録したクライアントは次に使い回せるよう先に保存する
        await secrets.update(stateKey(name), s => ({ ...(s ?? {}), serverUrl, client: flow.client }));
        // 作り直した（ポートが塞がっていた・localhost に切り替えた）なら、古い登録を AS から消す
        if (replaced && replaced.info?.client_id !== info.client_id) flow.removed.push({ client_id: replaced.info?.client_id, ...(await deleteRegistration(replaced, definition)) });
      },
      tokens: () => undefined,           // 始めるときは必ず同意画面から（リフレッシュは refresh() が持つ）
      saveTokens(tokens) { flow.tokens = tokens; },
      redirectToAuthorization(url) { flow.url = url; },
      saveCodeVerifier(v) { flow.verifier = v; },
      codeVerifier() { if (!flow.verifier) throw new Error('code verifier missing'); return flow.verifier; },
      saveDiscoveryState(s) { flow.discovery = s; },
      discoveryState: () => flow.discovery ?? undefined,
      async validateResourceURL(defaultResource, advertised) {
        // 登録で resource を指定したもの（Codex の oauth_resource を取り込んだもの）はそれを使う
        if (definition.oauth?.resource) { flow.resource = definition.oauth.resource; return new URL(flow.resource); }
        // RFC 8707 の resource は常に付ける。保護リソースメタデータの resource が接続先と合わなければ止める
        if (advertised && !checkResourceAllowed({ requestedResource: defaultResource, configuredResource: advertised })) throw new Error(`保護リソースメタデータの resource（${advertised}）が接続先と一致しません`);
        flow.resource = String(advertised ? new URL(advertised) : resourceUrlFromServerUrl(defaultResource));
        return new URL(flow.resource);
      },
      invalidateCredentials(scope) {
        if (scope === 'all' || scope === 'client') { flow.dropClient = true; flow.client = null; }
        if (scope === 'all' || scope === 'discovery') flow.discovery = null;
      },
    };
    flow.provider = provider;
    flow.fetch = flowFetch;
    const attempt = () => { flow.url = null; flow.verifier = null; flow.dcrError = undefined; flow.dcrErrorDescription = undefined; return auth(provider, { serverUrl, scope, resourceMetadataUrl: www.resourceMetadataUrl, fetchFn: flowFetch }); };
    /**
     * 127.0.0.1 を拒む AS に備えて、戻り先を http://localhost:<同じポート>/callback に切り替える。
     * 待ち受けは 127.0.0.1 のまま。localhost の名前解決が ::1 になる環境（ブラウザが ::1 に先につなぐ）のために、
     * 同じポートで ::1 にも待ち受けを足す（IPv6 が無い・塞がっているときは 127.0.0.1 だけで続ける）
     */
    const listenV6 = async () => { try { flow.servers.push(await listen(flow.port, '::1')); } catch {} };
    const switchToLocalhost = async () => {
      // 127.0.0.1 で登録したばかりの DCR クライアントは使えないので、新しく登録したあとで AS から消す
      flow.superseded = flow.client ?? flow.superseded; flow.client = null; flow.host = 'localhost';
      await listenV6();
    };
    if (flow.host === 'localhost') await listenV6();
    try {
      let result;
      try { result = await attempt(); }
      catch (e) {
        if (flow.host !== '127.0.0.1' || !redirectRejectedByRegistration(flow, e)) throw e;
        // DCR が 127.0.0.1 の戻り先を拒んだ。localhost で登録し直す
        await switchToLocalhost();
        result = await attempt();
      }
      if (result !== 'REDIRECT' || !flow.url) throw new Error('認可 URL を作れませんでした');
      // 認可エンドポイントが 127.0.0.1 の戻り先を拒むか（DCR は通しても認可で弾く AS、手入力の clientId が localhost で登録されている AS）
      if (preflight && flow.host === '127.0.0.1' && await authorizationRejectsRedirect(String(flow.url), guard)) {
        await switchToLocalhost();
        result = await attempt();
        if (result !== 'REDIRECT' || !flow.url) throw new Error('認可 URL を作れませんでした');
      }
    } catch (e) {
      for (const s of flow.servers) closeServer(s);
      const message = e?.code === 'MCP_URL_REJECTED' ? e.message
        : flow.rejected ? `${flow.rejected}（${String(e.message).slice(0, 120)}）`
        : /dynamic client registration/i.test(e.message)
          ? 'この認可サーバーは動的クライアント登録に対応していません。MCP の登録で oauth.clientId（必要なら clientSecret）を指定してください'
          : `認可の準備に失敗しました：${String(e.message).slice(0, 300)}`;
      lastError.set(name, message);
      throw Object.assign(new Error(message), e?.code || flow.rejected ? { code: e?.code ?? 'MCP_URL_REJECTED' } : {});
    }
    flow.resourceMetadataUrl = www.resourceMetadataUrl ? String(www.resourceMetadataUrl) : undefined;
    for (const s of flow.servers) s.on('request', (req, res) => handleCallback(flow, req, res));
    flow.timer = setTimeout(() => cancel(name, 'ログインの待ち時間（10 分）を過ぎました。もう一度「ログイン」してください'), flowTtlMs);
    flow.timer.unref?.();
    flows.set(name, flow);
    const url = String(flow.url);
    emit({ type: 'mcpAuth', name, phase: 'url', url });
    try { openExternal(url); } catch {}
    return { name, url, redirectUri: flow.redirectUri, client: flow.clientKind ?? 'dynamic', ...(scope ? { scope } : {}), ...(flow.removed.length ? { removedClients: flow.removed } : {}) };
  }

  async function handleCallback(flow, req, res) {
    let url;
    try { url = new URL(req.url ?? '/', flow.redirectUri); } catch { return page(res, 400, oauthErrorHtml('Invalid request.')); }
    if (url.pathname !== '/callback') return page(res, 404, oauthErrorHtml('Callback route not found.'));
    // state が合わないものは、ほかのページからの偽の戻りとみなして捨てる。待つのはやめない
    if (url.searchParams.get('state') !== flow.state) return page(res, 400, oauthErrorHtml('State mismatch.'));
    if (flows.get(flow.name) !== flow || flow.exchanging) return page(res, 409, oauthErrorHtml('This login is no longer active.'));
    const error = url.searchParams.get('error');
    if (error) {
      page(res, 400, oauthErrorHtml('Authorization was not completed.', error.slice(0, 200)));
      return cancel(flow.name, `認可サーバーが拒否しました：${error.slice(0, 100)}`);
    }
    const code = url.searchParams.get('code');
    if (!code) return page(res, 400, oauthErrorHtml('Missing authorization code.'));
    flow.exchanging = true;
    try {
      await auth(flow.provider, { serverUrl: flow.definition.url, authorizationCode: code, scope: flow.scope, resourceMetadataUrl: flow.resourceMetadataUrl ? new URL(flow.resourceMetadataUrl) : undefined, fetchFn: flow.fetch });
      if (!flow.tokens?.access_token) throw new Error('トークンを受け取れませんでした');
      const at = now();
      const issuer = flow.discovery?.authorizationServerUrl;
      const client = flow.clientKind === 'manual' ? { manual: true, issuer, redirectUri: flow.redirectUri }
        : flow.clientKind === 'metadata-document' ? { metadataDocument: true, info: flow.provider.clientInformation(), issuer, redirectUri: flow.redirectUri }
        : undefined;
      // 新しい状態で置き換える。ステップアップの scope はここで求め終えたので消える
      await secrets.update(stateKey(flow.name), s => ({
        serverUrl: flow.definition.url,
        client: client ?? flow.client ?? s?.client,
        discovery: flow.discovery, resource: flow.resource, scope: flow.scope, resourceMetadataUrl: flow.resourceMetadataUrl, redirectHost: flow.host,
        tokens: withExpiry(flow.tokens, at), updatedAt: new Date(at).toISOString(),
      }));
      page(res, 200, oauthSuccessHtml('Pleiad: MCP authentication completed. You can close this window.'));
      flows.delete(flow.name); clearTimeout(flow.timer); for (const s of flow.servers) closeServer(s);
      lastError.delete(flow.name);
      emit({ type: 'mcpAuth', name: flow.name, phase: 'done' });
    } catch (e) {
      page(res, 400, oauthErrorHtml('Token exchange failed.'));
      cancel(flow.name, `トークンの取得に失敗しました：${String(e.message).slice(0, 200)}`);
    }
  }

  async function readState(name, definition) {
    const s = await secrets.get(stateKey(name));
    // 接続先が変わった登録の古いトークンは使わない（別のリソース向けに出たもの）
    if (!s || s.serverUrl !== definition.url) return undefined;
    return s;
  }

  /**
   * 保存済みのトークンを 1 回リフレッシュする。呼ぶのは accessToken() だけ。
   * soft は「期限の無いトークンを念のため新しくする」場合。失敗しても今のアクセストークンを返す
   */
  async function refresh(name, definition, conn, { rejected, soft = false }) {
    return withFileLock(lockPath(name, definition), async () => {
      // ロックを取ったあとに読み直す。別のプロセスが先にリフレッシュしていれば、それを使う
      const s = await readState(name, definition);
      if (!s?.tokens) throw new McpAuthRequired();
      const t = now();
      if (s.tokens.access_token !== rejected && fresh(s.tokens, t) && !(soft && stale(s.tokens, t))) return s.tokens.access_token;
      if (soft && !stale(s.tokens, t)) return s.tokens.access_token;
      if (!s.tokens.refresh_token) throw new McpAuthRequired('トークンの期限が切れました。もう一度「ログイン」してください');
      const guarded = guardFor(definition).wrap(f);
      let tokens;
      try {
        const asUrl = s.discovery?.authorizationServerUrl ?? String(new URL('/', definition.url));
        const metadata = s.discovery?.authorizationServerMetadata ?? await discoverAuthorizationServerMetadata(asUrl, { fetchFn: guarded });
        const clientInformation = savedClientInfo(s, definition, conn);
        if (!clientInformation) throw new McpAuthRequired('クライアント情報がありません。もう一度「ログイン」してください');
        tokens = await refreshAuthorization(asUrl, { metadata, clientInformation, refreshToken: s.tokens.refresh_token, resource: s.resource ? new URL(s.resource) : undefined, fetchFn: guarded });
      } catch (e) {
        const rejectedGrant = e instanceof InvalidGrantError || e instanceof InvalidClientError || e instanceof UnauthorizedClientError;
        if (soft) {
          // 念のためのリフレッシュ。リフレッシュトークンが使えなくなっていたらそれだけ捨て、アクセストークンは使えるうちは使う
          if (rejectedGrant) await secrets.update(stateKey(name), x => x && ({ ...x, tokens: x.tokens && { ...x.tokens, refresh_token: undefined } }));
          return s.tokens.access_token;
        }
        if (rejectedGrant) {
          // リフレッシュトークンが失効・取り消し済み。持っていても使えないので捨てて、ログインを求める
          await secrets.update(stateKey(name), x => x && ({ ...x, tokens: undefined }));
          throw new McpAuthRequired('ログインの有効期限が切れました。もう一度「ログイン」してください');
        }
        if (e?.code === 'MCP_URL_REJECTED') lastError.set(name, e.message);
        throw e;
      }
      // ローテーション: 新しいリフレッシュトークンが来れば差し替える（来なければ SDK が前のものを残している）
      const next = withExpiry(tokens, now());
      await secrets.update(stateKey(name), x => ({ ...(x ?? s), tokens: next, updatedAt: new Date(now()).toISOString() }));
      return next.access_token;
    }, { timeoutMs: REQUEST_TIMEOUT_MS + 15_000, staleMs: REQUEST_TIMEOUT_MS * 2 });
  }

  /**
   * 使ってよいアクセストークン。期限が近ければリフレッシュする。期限の無いものは取得から 1 時間で軽くリフレッシュする。
   * force は「今のトークンが 401 で拒まれた」とき。rejected にそのトークンを渡す
   */
  async function accessToken(name, definition, conn = null, { force = false, rejected } = {}) {
    const s = await readState(name, definition);
    if (!s?.tokens?.access_token) throw new McpAuthRequired();
    const t = now();
    if (!force && fresh(s.tokens, t) && !stale(s.tokens, t)) return s.tokens.access_token;
    const soft = !force && fresh(s.tokens, t);
    const key = `${name}\0${soft ? 'soft' : 'hard'}`;
    let running = refreshing.get(key);
    if (!running) {
      running = refresh(name, definition, conn, { rejected: rejected ?? s.tokens.access_token, soft }).finally(() => refreshing.delete(key));
      refreshing.set(key, running);
    }
    return running;
  }

  /** 403 insufficient_scope が示した scope を覚える。次のログインで今の scope と合わせて求める */
  async function rememberStepUp(name, definition, scope) {
    if (!scope) return;
    await secrets.update(stateKey(name), x => x && x.serverUrl === definition.url ? { ...x, stepUpScope: scopeUnion(x.stepUpScope, scope) } : x).catch(() => {});
  }

  /**
   * transport に渡す fetch。Authorization を付け、401 なら 1 回だけリフレッシュして送り直す。
   * それでも 401・403（insufficient_scope）なら tracker.authRequired に理由を残す（context-bridge が「要ログイン」に分ける）
   */
  function authFetch(name, definition, conn = null, tracker = {}) {
    return async (url, init = {}) => {
      const send = token => { const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`); return fetchFn(url, { ...init, headers }); };
      let token;
      try { token = await accessToken(name, definition, conn); }
      catch (e) { if (e.code === 'MCP_AUTH_REQUIRED') tracker.authRequired = e.message; throw e; }
      let res = await send(token);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        try { token = await accessToken(name, definition, conn, { force: true, rejected: token }); }
        catch (e) { if (e.code === 'MCP_AUTH_REQUIRED') tracker.authRequired = e.message; throw e; }
        res = await send(token);
        if (res.status === 401) tracker.authRequired = 'MCP がトークンを受け付けません。もう一度「ログイン」してください';
      }
      if (res.status === 403) {
        const challenge = extractWWWAuthenticateParams(res);
        if (challenge.error === 'insufficient_scope') {
          await rememberStepUp(name, definition, challenge.scope);
          tracker.authRequired = `権限（scope${challenge.scope ? `: ${challenge.scope}` : ''}）が足りません。もう一度「ログイン」すると、今の権限と合わせて求めます`;
        }
      }
      return res;
    };
  }

  async function status(name, definition) {
    const flow = flows.get(name);
    const base = { name, auth: definition?.auth };
    if (definition?.auth !== 'oauth') return { ...base, state: 'not-oauth' };
    if (flow) return { ...base, state: 'pending', url: String(flow.url) };
    let s;
    try { s = await readState(name, definition); }
    catch (e) { return { ...base, state: e.code === 'SECRET_LOCKED' ? 'locked' : 'error', message: e.message }; }
    const error = lastError.get(name);
    const client = s?.client ? (s.client.dynamic ? 'dynamic' : s.client.metadataDocument ? 'metadata-document' : 'manual') : null;
    // 追加の権限が要る（403 insufficient_scope を受けた）。ログインし直すと今の scope と合わせて求める
    const stepUp = s?.stepUpScope ? { needsScope: true, requiredScope: s.stepUpScope,
      message: `追加の権限（${s.stepUpScope}）が必要です。もう一度「ログイン」すると、今の権限と合わせて求めます` } : {};
    if (!s?.tokens?.access_token) return { ...base, state: 'signed-out', client, ...(error ? { message: error } : {}), ...stepUp };
    const expired = s.tokens.expires_at && s.tokens.expires_at <= now();
    return { ...base, state: expired && !s.tokens.refresh_token ? 'expired' : 'signed-in', client,
      expiresAt: s.tokens.expires_at ? new Date(s.tokens.expires_at).toISOString() : null, refreshable: Boolean(s.tokens.refresh_token),
      scope: s.tokens.scope ?? s.scope ?? null, issuer: s.discovery?.authorizationServerUrl ?? null, ...(error ? { message: error } : {}), ...stepUp };
  }

  /** RFC 7009。失敗してもローカルのトークンは消す（消せないと「ログアウトできない」になる） */
  async function revoke(s, definition, conn) {
    const endpoint = s?.discovery?.authorizationServerMetadata?.revocation_endpoint;
    if (!endpoint) return { revoked: false, reason: 'revocation_endpoint がありません' };
    const client = savedClientInfo(s, definition, conn);
    const guarded = guardFor(definition).wrap(f, 'revocation_endpoint');
    const results = [];
    for (const [token, hint] of [[s.tokens?.refresh_token, 'refresh_token'], [s.tokens?.access_token, 'access_token']]) {
      if (!token) continue;
      const body = new URLSearchParams({ token, token_type_hint: hint });
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (client?.client_secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
      else if (client?.client_id) body.set('client_id', client.client_id);
      try { const res = await guarded(endpoint, { method: 'POST', headers, body }); await res.body?.cancel().catch(() => {}); results.push(res.ok); }
      catch (e) { results.push(false); if (e?.code === 'MCP_URL_REJECTED') return { revoked: false, reason: `${e.message}（ローカルのトークンは消しました）` }; }
    }
    return results.length && results.every(Boolean) ? { revoked: true } : { revoked: false, reason: '失効の要求に失敗しました（ローカルのトークンは消しました）' };
  }

  async function logout(name, definition, conn = null) {
    cancel(name);
    lastError.delete(name);
    const s = await secrets.get(stateKey(name)).catch(() => undefined);
    const result = s?.tokens ? await revoke(s, definition, conn) : { revoked: false, reason: 'ログインしていません' };
    // 登録したクライアントと探索結果は残す（次のログインで使い回す）。トークンだけ捨てる
    await secrets.update(stateKey(name), x => x && ({ ...x, tokens: undefined }));
    return { name, ...result };
  }

  /**
   * 登録名の変更（core/ply-mcp.mjs の rename が move を渡す）。進行中のログインはやめ、
   * リフレッシュのロックを持ったまま秘密を移す（別のプロセスが古い名前でリフレッシュ中に移すと、ローテーションした新しいトークンを失う）
   */
  async function rename(from, to, definition, move) {
    cancel(from);
    for (const [key, running] of refreshing) if (key.startsWith(`${from}\0`)) await running.catch(() => {});
    return withFileLock(lockPath(from, definition), async () => {
      const result = await move();
      if (lastError.has(from)) { lastError.set(to, lastError.get(from)); lastError.delete(from); }
      return result;
    }, { timeoutMs: REQUEST_TIMEOUT_MS + 15_000, staleMs: REQUEST_TIMEOUT_MS * 2 });
  }

  /**
   * ネイティブ登録の取り込み（core/mcp-import.mjs）で使う。MCP が Bearer の 401 を返せば OAuth とみなす。
   * 探索やクライアント登録はしない（ログインのときに行う）
   */
  async function detect(definition) {
    const r = await probe(definition);
    return { oauth: r.status === 401 && Boolean(r.bearer), status: r.status ?? null };
  }

  return { start, status, logout, accessToken, authFetch, cancel, rename, detect, pending: name => flows.has(name) };
}
