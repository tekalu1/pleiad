// エージェントのブラウザー（PC の Chrome）の絞り込みの中継（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0153）。
//
// 会話ごとに鍵付きの loopback の ws の端点（ws://127.0.0.1:<port>/devtools/browser/<鍵 48 桁>。内蔵ブラウザーの中継と同じ形）を出し、
// Chrome への 1 本の接続（core/chrome/connection.mjs）の上で、その会話の窓の範囲にだけ絞った CDP を中継する。
//   - 範囲: 会話の窓（windowId）のタブ。中継が作った窓のタブと、範囲のタブが開いたタブ（openerId。popup の別窓はその窓も範囲に足す）。
//     ほかの窓（利用者の普段の窓・ほかの会話の窓）のタブは、getTargets にもイベントにも出さない。URL・題は覚えずログにも出さない
//   - 上りへは、ブラウザー全体の Target.setAutoAttach を一度も送らない（利用者の全タブに attach するため）。エージェントのものは中継の中で真似る
//   - sessionId は、どのエージェントの接続が attach したものかを覚え、ほかの接続の sessionId は断る
//   - ブラウザー全体に効く操作（Browser.close・Storage.*・Cookie の一括の読み書きなど）は断る。断る・真似る・許すの一覧は下の表と docs
// サイトの利用の確認（confirmAgentSites が ON のとき）は、中継が範囲のタブに自分のセッションを attach して Fetch で主フレームの要求を止めて聞く。
// window.open で開いたタブの最初の要求は Fetch では止められない（実機。docs）ので、開いた後に聞き、断られたら閉じる。
// 窓の作り方は scope の口（第 4 段で専用の窓に差し替える）。ここの既定は仮の窓（createTarget の newWindow＋background と最小化）。
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const KEY_PATH = /^\/devtools\/browser\/([a-f0-9]{48})$/;
const random = () => crypto.randomBytes(24).toString('hex');
const CONNECT_WAIT_MS = 20_000;
/** エージェントのコマンドの上りの上限。移動の確認（人が答える）を待つことがあるので長くとる。CLI は自分で先に打ち切る */
const COMMAND_TIMEOUT_MS = 600_000;

/** 人の操作と区別して、エージェントがタブを動かしているとみなすコマンド（内蔵ブラウザーの中継と同じ。desktop/browser-navigation.cjs） */
const OPERATES = /^(Input\.|Runtime\.(evaluate|callFunctionOn)$|Page\.(navigate|reload|navigateToHistoryEntry)$)/;

// セッションの上（タブ・iframe・worker）で断るもの。ほかは通す
const SESSION_DENIED_DOMAINS = ['Browser.', 'Storage.', 'Extensions.', 'PWA.', 'Autofill.', 'Cast.', 'SystemInfo.', 'Tethering.'];
const SESSION_DENIED = new Set(['Network.getAllCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Page.setDownloadBehavior', 'Security.setIgnoreCertificateErrors']);
const COOKIE_WRITES = new Set(['Network.setCookie', 'Network.setCookies', 'Network.deleteCookies']);
// ブラウザーの上（sessionId なし）で許すもの。ここに無いものは断る
const BROWSER_ALLOWED = new Set([
  'Browser.getVersion',
  // 真似る（上りへ送らない・送り方を変える）
  'Target.getBrowserContexts', 'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.getTargets', 'Target.createTarget',
  // 範囲のタブ・窓だけ
  'Target.getTargetInfo', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.closeTarget', 'Target.activateTarget',
  'Browser.getWindowForTarget', 'Browser.getWindowBounds', 'Browser.setContentsSize',
]);

class RelayError extends Error {
  constructor(message, code = -32000) { super(message); this.code = code; }
}
const denied = what => new RelayError(`${what} denied`);

/** http(s)（認証情報なし）と about:blank だけ（内蔵ブラウザーの中継と同じ） */
export function safeUrl(value) {
  try { const url = new URL(value); return (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) || url.href === 'about:blank'; }
  catch { return false; }
}
const originOf = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; } };
const hostOf = value => { try { return new URL(value).hostname; } catch { return null; } };

/**
 * 仮の窓（第 3 段）。タブを 1 つ作るたびに、前面を取らない新しい窓（newWindow・background）を作ってすぐ最小化する。
 * CDP の createTarget は窓を選べない（windowId が無い）ので、2 つ目以降のタブも別の窓になる。第 4 段で専用の窓（chrome.exe --profile-directory）に差し替える
 */
export function createTempWindowScope() {
  return {
    /** @returns {Promise<{ targetId: string, windowId: number }>} */
    async openTab({ cdp, url = 'about:blank' }) {
      const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true, background: true });
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
      return { targetId, windowId };
    },
  };
}

/**
 * @param {object} deps
 * @param deps.connection  core/chrome/connection.mjs の接続（demand({ signal }) で cdp を返す）
 * @param [deps.scope]     窓の作り方（openTab）。既定は仮の窓
 * @param [deps.authorize] サイトの利用の確認（core/browser-confirm.mjs の createBrowserSiteApprovals）。({ sessionId, url }, signal) → { allow, message? }
 * @param [deps.deniedMessage] 確認で断られた移動をエージェントへ返す文
 */
export function createChromeRelay({ connection, scope = createTempWindowScope(), authorize = async () => ({ allow: false }), deniedMessage = () => 'navigation denied',
  connectWaitMs = CONNECT_WAIT_MS, commandTimeoutMs = COMMAND_TIMEOUT_MS, log = () => {} } = {}) {
  const entries = new Map();   // 会話の id -> entry
  const byKey = new Map();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  let address = null, listening = null;
  let confirm = false;         // サイトの利用の確認（confirmAgentSites）
  let up = null;               // 上り（Chrome への接続 1 本）の上の状態
  let binding = null;
  let closed = false;

  server.on('upgrade', (request, socket, head) => {
    const key = KEY_PATH.exec(request.url || '')?.[1];
    const entry = key ? byKey.get(key) : null;
    if (closed || !entry || entry.stopped || request.headers.host !== `127.0.0.1:${address?.port}` || request.socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => attachClient(entry, ws));
  });

  // ---- 上り ------------------------------------------------------------------------------------
  /** 上りの状態を作る（cdp 1 本につき 1 回）。範囲を知るため、Target.setDiscoverTargets を上りに 1 回だけ送る */
  function bind(cdp) {
    if (up?.cdp === cdp) return Promise.resolve(up);
    if (binding?.cdp === cdp) return binding.promise;
    const state = { cdp, tabs: new Map(), windows: new Map(), sessions: new Map(), attaching: new Map(), offs: [] };
    state.offs.push(cdp.onEvent((method, params, sessionId) => { if (up === state) onUpEvent(state, method, params, sessionId); }));
    state.offs.push(cdp.onClose(() => teardown(state)));
    const promise = (async () => {
      up = state;
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      return state;
    })();
    binding = { cdp, promise };
    promise.catch(() => {}).finally(() => { if (binding?.cdp === cdp) binding = null; });
    return promise;
  }

  /** 上りが切れた（Chrome が閉じた・許可の取り消し・切る）。エージェントの接続も閉じる（次の接続でつなぎ直す） */
  function teardown(state) {
    if (up !== state) return;
    up = null;
    for (const off of state.offs) off();
    for (const tab of state.tabs.values()) tab.controller.abort();
    for (const entry of entries.values()) {
      entry.windows.clear();
      for (const client of [...entry.clients]) { try { client.ws.close(1011, 'chrome disconnected'); } catch { /* 閉じていてもよい */ } }
    }
  }

  /** エージェントの接続が上りを待つ。つながっていなければ接続を求め、connectWaitMs で諦める（Chrome の許可を待つ。agent-browser は 30 秒で読むのをやめる） */
  async function upFor(client) {
    if (up && !up.cdp.closed) return up;
    client.upWait ??= (async () => {
      const ac = new AbortController();
      client.upAbort = ac;
      const timer = setTimeout(() => ac.abort(), connectWaitMs);
      try {
        const cdp = await connection.demand({ signal: ac.signal });
        return await bind(cdp);
      } catch (error) {
        const code = error?.code;
        if (code === 'unsupported') throw new RelayError('the agent browser (Chrome) is not available on this computer');
        if (code === 'declined') throw new RelayError('the user did not allow the connection to Chrome');
        throw new RelayError('Chrome is not connected yet (waiting for the user to allow remote debugging in Chrome). Try again later');
      } finally { clearTimeout(timer); client.upWait = null; client.upAbort = null; }
    })();
    return client.upWait;
  }

  // ---- 範囲（会話の窓のタブ） ------------------------------------------------------------------
  function newTab(entry, info, windowId, opener = null) {
    return { targetId: info.targetId, entry, info: { ...info }, windowId, opener, internal: null, internalReady: null,
      active: opener?.active ?? false, granted: new Set(), controller: new AbortController(), pending: new Set(), paused: new Map(), denial: null, popupChecked: false };
  }
  const tabsOf = (state, entry) => [...state.tabs.values()].filter(tab => tab.entry === entry);
  const clientsOf = entry => [...entry.clients];
  function addWindow(state, entry, windowId) {
    if (windowId == null || state.windows.has(windowId)) return;
    state.windows.set(windowId, entry);
    entry.windows.add(windowId);
  }

  /** タブを会話の範囲に入れる。発見中の接続に targetCreated を送り、真似た自動 attach と確認の Fetch を付ける */
  function adopt(state, entry, info, { windowId = null, opener = null } = {}) {
    if (state.tabs.has(info.targetId)) return state.tabs.get(info.targetId);
    const tab = newTab(entry, info, windowId, opener);
    state.tabs.set(tab.targetId, tab);
    addWindow(state, entry, windowId);
    for (const client of clientsOf(entry)) {
      if (client.discovering) send(client, { method: 'Target.targetCreated', params: { targetInfo: { ...tab.info } } });
      if (client.autoAttach) attachFor(state, client, tab).catch(() => {});
    }
    if (confirm) ensureInternal(state, tab).catch(() => {});
    if (opener) checkPopup(state, tab);
    return tab;
  }

  function dropTab(state, tab) {
    if (state.tabs.get(tab.targetId) !== tab) return;
    state.tabs.delete(tab.targetId);
    tab.controller.abort();
    for (const client of clientsOf(tab.entry)) if (client.discovering) send(client, { method: 'Target.targetDestroyed', params: { targetId: tab.targetId } });
    if (tab.windowId != null && ![...state.tabs.values()].some(other => other.windowId === tab.windowId)) {
      state.windows.delete(tab.windowId);
      tab.entry.windows.delete(tab.windowId);
    }
  }

  async function onTargetCreated(state, info) {
    if (info?.type !== 'page' || state.tabs.has(info.targetId)) return;
    const opener = info.openerId ? state.tabs.get(info.openerId) : null;
    if (opener) {
      // 範囲のタブが開いたタブ（window.open）。popup の別窓なら、その窓も範囲に足す
      const tab = adopt(state, opener.entry, info, { opener });
      const where = await state.cdp.send('Browser.getWindowForTarget', { targetId: info.targetId }).catch(() => null);
      if (where?.windowId != null && state.tabs.get(tab.targetId) === tab) { tab.windowId = where.windowId; addWindow(state, tab.entry, where.windowId); }
      return;
    }
    // ほかの経路で会話の窓に入ったタブ（利用者が窓へ移した、など）。会話の窓が 1 つも無ければ見ない（利用者のタブの数だけ問い合わせない）
    if (!state.windows.size) return;
    const where = await state.cdp.send('Browser.getWindowForTarget', { targetId: info.targetId }).catch(() => null);
    const entry = where ? state.windows.get(where.windowId) : null;
    if (entry && up === state && !state.tabs.has(info.targetId)) {
      const fresh = await state.cdp.send('Target.getTargetInfo', { targetId: info.targetId }).catch(() => null);
      if (fresh?.targetInfo && up === state) adopt(state, entry, fresh.targetInfo, { windowId: where.windowId });
    }
  }

  // ---- 上りのイベントの配り分け --------------------------------------------------------------
  function onUpEvent(state, method, params, sessionId) {
    if (sessionId) {
      const rec = state.sessions.get(sessionId);
      if (!rec) return;
      if (!rec.client) { onInternalEvent(state, rec.tab, method, params); return; }
      if (method === 'Target.attachedToTarget' && params.sessionId) {
        // セッションの自動 attach（iframe・worker）。子のセッションも同じエージェントの接続のもの
        state.sessions.set(params.sessionId, { client: rec.client, tab: rec.tab, parent: sessionId });
        rec.client.sessions.add(params.sessionId);
      } else if (method === 'Target.detachedFromTarget' && params.sessionId) forgetSession(state, params.sessionId);
      send(rec.client, { method, params, sessionId });
      return;
    }
    switch (method) {
      case 'Target.targetCreated': onTargetCreated(state, params.targetInfo).catch(() => {}); return;
      case 'Target.targetInfoChanged': {
        const tab = state.tabs.get(params.targetInfo?.targetId);
        if (!tab) return;   // 範囲の外のタブの URL・題は捨てる（覚えない）
        tab.info = { ...params.targetInfo };
        onTabUrl(state, tab);
        for (const client of clientsOf(tab.entry)) if (client.discovering) send(client, { method, params });
        return;
      }
      case 'Target.targetDestroyed': { const tab = state.tabs.get(params.targetId); if (tab) dropTab(state, tab); return; }
      case 'Target.attachedToTarget': {
        // attach の応答より先に届く。待っている attach（エージェントの接続か中継自身）に結ぶ
        const queue = state.attaching.get(params.targetInfo?.targetId);
        const token = queue?.shift();
        if (queue && !queue.length) state.attaching.delete(params.targetInfo.targetId);
        if (!token || !params.sessionId) return;
        token.sessionId = params.sessionId;
        register(state, params.sessionId, token);
        if (token.client) send(token.client, { method, params });
        return;
      }
      case 'Target.detachedFromTarget': {
        const rec = state.sessions.get(params.sessionId);
        if (!rec) return;
        forgetSession(state, params.sessionId);
        if (rec.client) send(rec.client, { method, params });
        else if (rec.tab.internal === params.sessionId) { rec.tab.internal = null; rec.tab.internalReady = null; }
        return;
      }
      default: return;   // ほかのブラウザー全体のイベント（ダウンロードなど）は配らない
    }
  }

  function register(state, sessionId, { client, tab }) {
    state.sessions.set(sessionId, { client, tab, parent: null });
    if (client) client.sessions.add(sessionId);
  }
  function forgetSession(state, sessionId) {
    const rec = state.sessions.get(sessionId);
    if (!rec) return;
    state.sessions.delete(sessionId);
    rec.client?.sessions.delete(sessionId);
    for (const [sid, child] of [...state.sessions]) if (child.parent === sessionId) forgetSession(state, sid);
  }

  /** 上りへ attach（flatten）。セッションは上りの attachedToTarget（応答より先に届く）で結び、届かなければ応答で結ぶ */
  async function attach(state, tab, client) {
    const token = { client, tab, sessionId: null };
    if (!state.attaching.has(tab.targetId)) state.attaching.set(tab.targetId, []);
    state.attaching.get(tab.targetId).push(token);
    let result;
    try { result = await state.cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true }); }
    finally {
      const queue = state.attaching.get(tab.targetId);
      const i = queue?.indexOf(token) ?? -1;
      if (i >= 0) queue.splice(i, 1);
      if (queue && !queue.length) state.attaching.delete(tab.targetId);
    }
    if (!token.sessionId) {
      token.sessionId = result.sessionId;
      register(state, result.sessionId, token);
      if (client) send(client, { method: 'Target.attachedToTarget', params: { sessionId: result.sessionId, targetInfo: { ...tab.info, attached: true }, waitingForDebugger: false } });
    }
    return result.sessionId;
  }
  const attachFor = (state, client, tab) => attach(state, tab, client);

  // ---- サイトの利用の確認（Fetch） ------------------------------------------------------------
  /** 確認のために、中継自身のセッションをタブに付けて主フレームの Document の要求を止める */
  function ensureInternal(state, tab) {
    tab.internalReady ??= (async () => {
      const sessionId = await attach(state, tab, null);
      tab.internal = sessionId;
      await state.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
      return sessionId;
    })().catch(error => { tab.internalReady = null; throw error; });
    return tab.internalReady;
  }
  function dropInternal(state, tab) {
    for (const resume of [...tab.paused.values()]) resume();
    const sessionId = tab.internal;
    tab.internal = null; tab.internalReady = null;
    if (sessionId) { forgetSession(state, sessionId); state.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  function ask(tab, url) {
    const signal = tab.controller.signal;
    const work = Promise.resolve().then(() => authorize({ sessionId: tab.entry.id, url }, signal)).then(answer => answer ?? { allow: false }, () => ({ allow: false }));
    tab.pending.add(work);
    work.finally(() => tab.pending.delete(work));
    return work;
  }

  function onInternalEvent(state, tab, method, params) {
    if (method !== 'Fetch.requestPaused') return;
    const { requestId } = params;
    const sessionId = tab.internal;
    let settled = false;
    const resume = () => { if (settled) return; settled = true; tab.paused.delete(requestId); state.cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {}); };
    const block = () => { if (settled) return; settled = true; tab.paused.delete(requestId); state.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {}); };
    tab.paused.set(requestId, resume);
    const url = params.request?.url ?? '';
    const origin = originOf(url);
    // 主フレームだけを聞く（iframe は聞かない）。エージェントが動かしていないタブ（人の操作）・同じ origin・許可済みは聞かない
    if (!confirm || params.frameId !== tab.targetId || !tab.active || !origin || origin === originOf(tab.info.url) || tab.granted.has(origin)) { resume(); return; }
    ask(tab, url).then(answer => {
      if (!confirm) { resume(); return; }
      if (answer.allow && !tab.controller.signal.aborted) { tab.granted.add(origin); resume(); return; }
      tab.denial = answer.message || deniedMessage();
      block();
    });
  }

  /** タブの URL が替わった。許可は今の origin の分だけ残す（内蔵ブラウザーと同じ）。window.open のタブは最初の要求の後に聞く */
  function onTabUrl(state, tab) {
    const origin = originOf(tab.info.url);
    if (origin) tab.granted = new Set([...tab.granted].filter(value => value === origin));
    if (tab.opener) checkPopup(state, tab);
  }

  /** window.open で開いたタブ（最初の要求は Fetch で止められない）。開いた後に聞き、断られたら閉じる */
  function checkPopup(state, tab) {
    if (tab.popupChecked || !confirm || !tab.opener.active) return;
    const origin = originOf(tab.info.url);
    if (!origin) return;   // まだ about:blank。URL が付いたら聞く
    tab.popupChecked = true;
    const opener = tab.opener;
    if (origin === originOf(opener.info.url) || opener.granted.has(origin)) { tab.granted.add(origin); return; }
    ask(tab, tab.info.url).then(answer => {
      if (state.tabs.get(tab.targetId) !== tab) return;   // 先に閉じられた
      if (answer.allow && !tab.controller.signal.aborted) { tab.granted.add(origin); return; }
      opener.denial = answer.message || deniedMessage();
      if (up === state && state.tabs.get(tab.targetId) === tab) state.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    });
  }

  /** 操作のコマンドの応答のときに、そのタブの確認がまだ済んでいなければ待ち、断られていれば断られた文を返す（内蔵ブラウザーと同じ） */
  async function settleApprovals(tab) {
    await new Promise(resolve => setImmediate(resolve));
    while (tab.pending.size) await Promise.all([...tab.pending]);
    const message = tab.denial;
    tab.denial = null;
    return message;
  }

  // ---- エージェントの接続 ------------------------------------------------------------------------
  function send(client, message) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(message));
  }

  function attachClient(entry, ws) {
    const client = { entry, ws, sessions: new Set(), discovering: false, autoAttach: false, upWait: null, upAbort: null, closed: false };
    entry.clients.add(client);
    ws.on('message', raw => { void onMessage(client, raw); });
    ws.on('error', () => {});
    ws.on('close', () => {
      client.closed = true;
      entry.clients.delete(client);
      client.upAbort?.abort();
      const state = up;
      if (!state) return;
      // この接続が attach したセッションを上りで外す（上りの接続は残るので、外さないと Chrome にセッションが残る）
      for (const sessionId of [...client.sessions]) {
        const rec = state.sessions.get(sessionId);
        if (!rec || rec.client !== client) continue;
        const top = rec.parent == null;
        forgetSession(state, sessionId);
        if (top) state.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    });
  }

  async function onMessage(client, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const { id, method, params = {}, sessionId } = message ?? {};
    if (!Number.isInteger(id) || typeof method !== 'string') return;
    if (client.entry.stopped) { try { client.ws.close(1008, 'stopped'); } catch { /* 閉じていてもよい */ } return; }
    const reply = body => send(client, { id, ...body, ...(sessionId ? { sessionId } : {}) });
    try {
      const state = await upFor(client);
      if (client.closed) return;
      const result = sessionId ? await sessionCommand(state, client, method, params ?? {}, sessionId) : await browserCommand(state, client, method, params ?? {});
      reply({ result: result ?? {} });
    } catch (error) {
      reply({ error: { code: Number.isInteger(error?.code) ? error.code : -32000, message: String(error?.message ?? error) } });
    }
  }

  function mine(state, client, targetId) {
    const tab = state.tabs.get(targetId);
    if (!tab || tab.entry !== client.entry) throw denied('target');
    return tab;
  }

  async function sessionCommand(state, client, method, params, sessionId) {
    const rec = state.sessions.get(sessionId);
    if (!rec || rec.client !== client) throw denied('session');
    const tab = rec.tab;
    if (method.startsWith('Target.') && method !== 'Target.setAutoAttach') throw denied('browser command');
    if (SESSION_DENIED.has(method) || SESSION_DENIED_DOMAINS.some(prefix => method.startsWith(prefix))) throw denied('browser command');
    let forward = params;
    if (method === 'Page.navigate' && !safeUrl(params.url)) throw denied('navigation');
    // Cookie は今のページのものだけ（ほかのサイトのログインを読む・消す・植えるのを防ぐ）
    if (method === 'Network.getCookies') forward = {};
    if (COOKIE_WRITES.has(method)) {
      const host = hostOf(tab.info.url);
      const list = method === 'Network.setCookies' ? (Array.isArray(params.cookies) ? params.cookies : []) : [params];
      const ok = cookie => {
        if (!host) return false;
        if (cookie?.url) return hostOf(cookie.url) === host;
        const domain = typeof cookie?.domain === 'string' ? cookie.domain.replace(/^\./, '') : '';
        return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
      };
      if (!list.length || !list.every(ok)) throw denied('cookie');
    }
    const operates = OPERATES.test(method);
    if (operates) { tab.active = true; tab.denial = null; }
    const result = await state.cdp.send(method, forward, sessionId, { timeoutMs: commandTimeoutMs });
    if (operates && confirm) {
      const message = await settleApprovals(tab);
      if (message) throw new RelayError(message);
    }
    return result;
  }

  async function browserCommand(state, client, method, params) {
    if (!BROWSER_ALLOWED.has(method)) throw denied('browser command');
    const entry = client.entry;
    switch (method) {
      case 'Browser.getVersion': return state.cdp.send(method, {});
      case 'Target.getBrowserContexts': return { browserContextIds: [] };
      case 'Target.setDiscoverTargets':
        client.discovering = params.discover === true;
        if (client.discovering) for (const tab of tabsOf(state, entry)) send(client, { method: 'Target.targetCreated', params: { targetInfo: { ...tab.info } } });
        return {};
      case 'Target.setAutoAttach':
        // ブラウザー全体の自動 attach は上りへ送らない（利用者の全タブに attach するため）。範囲のタブにだけ attach して真似る
        client.autoAttach = params.autoAttach === true;
        if (client.autoAttach) queueMicrotask(() => { for (const tab of tabsOf(state, entry)) if (![...client.sessions].some(sid => state.sessions.get(sid)?.tab === tab && state.sessions.get(sid)?.parent == null)) attachFor(state, client, tab).catch(() => {}); });
        return {};
      case 'Target.getTargets': return { targetInfos: tabsOf(state, entry).map(tab => ({ ...tab.info })) };
      case 'Target.getTargetInfo': {
        if (!params.targetId) throw denied('target');
        mine(state, client, params.targetId);
        return state.cdp.send(method, { targetId: params.targetId });
      }
      case 'Target.attachToTarget': return { sessionId: await attachFor(state, client, mine(state, client, params.targetId)) };
      case 'Target.detachFromTarget': {
        const rec = state.sessions.get(params.sessionId);
        if (!rec || rec.client !== client) throw denied('session');
        return state.cdp.send(method, { sessionId: params.sessionId });
      }
      case 'Target.closeTarget': mine(state, client, params.targetId); return state.cdp.send(method, { targetId: params.targetId });
      case 'Target.activateTarget': mine(state, client, params.targetId); return state.cdp.send(method, { targetId: params.targetId });
      case 'Browser.getWindowForTarget': {
        if (!params.targetId) throw denied('target');
        mine(state, client, params.targetId);
        return state.cdp.send(method, { targetId: params.targetId });
      }
      case 'Browser.getWindowBounds':
      case 'Browser.setContentsSize':
        if (!entry.windows.has(params.windowId)) throw denied('window');
        return state.cdp.send(method, params);
      case 'Target.createTarget': return { targetId: await createTab(state, client, params) };
      default: throw denied('browser command');
    }
  }

  /** Target.createTarget を真似る。context・窓の指定は信じず、会話の窓（scope）に作る。確認が ON なら、移動は確認を通してから */
  async function createTab(state, client, params) {
    const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
    if (!safeUrl(url)) throw denied('navigation');
    const entry = client.entry;
    const direct = url === 'about:blank' || !confirm;
    const { targetId, windowId } = await scope.openTab({ cdp: state.cdp, url: direct ? url : 'about:blank', entryId: entry.id });
    const fresh = await state.cdp.send('Target.getTargetInfo', { targetId }).catch(() => null);
    const tab = adopt(state, entry, fresh?.targetInfo ?? { targetId, type: 'page', title: '', url: 'about:blank', attached: false, canAccessOpener: false }, { windowId });
    if (direct) return targetId;
    tab.active = true;
    try {
      const sessionId = await ensureInternal(state, tab);
      const result = await state.cdp.send('Page.navigate', { url }, sessionId, { timeoutMs: commandTimeoutMs });
      if (result?.errorText) {
        const message = tab.denial || result.errorText;
        tab.denial = null;
        throw new RelayError(message);
      }
    } catch (error) {
      state.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    }
    return targetId;
  }

  // ---- 公開 ------------------------------------------------------------------------------------
  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(server.address()); });
    });
  }
  function ensureListening() {
    listening ??= listenOn(0).then(value => { address = value; return value; }, error => { listening = null; throw error; });
    return listening;
  }
  function closeClients(entry, code, reason) {
    for (const client of [...entry.clients]) { try { client.ws.close(code, reason); } catch { /* 閉じていてもよい */ } }
  }
  /** 会話のタブの確認の待ちを取り下げ、エージェントが動かしている印を外す（ターンの終わり・止める） */
  function settleEntry(entry) {
    if (!up) return;
    for (const tab of tabsOf(up, entry)) {
      tab.active = false; tab.granted.clear(); tab.denial = null;
      tab.controller.abort(); tab.controller = new AbortController();
    }
  }

  return {
    /** 会話の端点。unlock（人の送信で始まったターン）なら、止めた会話を新しい鍵で開け直す */
    async endpoint(sessionId, { unlock = false } = {}) {
      if (closed) throw new Error('relay closed');
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
      await ensureListening();
      let entry = entries.get(sessionId);
      if (!entry) { entry = { id: sessionId, key: random(), stopped: false, clients: new Set(), windows: new Set() }; entries.set(sessionId, entry); byKey.set(entry.key, entry); }
      if (unlock) this.resume(sessionId);
      return `ws://127.0.0.1:${address.port}/devtools/browser/${entry.key}`;
    },
    /** 止める: 接続を閉じ、次の人の送信（resume）まで再接続を断る */
    stop(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.stopped = true;
      settleEntry(entry);
      closeClients(entry, 1000, 'stopped');
    },
    resume(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry || !entry.stopped) return;
      byKey.delete(entry.key);
      entry.key = random();
      byKey.set(entry.key, entry);
      entry.stopped = false;
    },
    /** 新しい会話の id が決まった（turn.key → 本物の id） */
    rebind(from, to) {
      const entry = entries.get(from);
      if (!entry || entries.has(to)) return;
      entries.delete(from); entry.id = to; entries.set(to, entry);
    },
    endTurn(sessionId) { const entry = entries.get(sessionId); if (entry) settleEntry(entry); },
    /** 会話を消した。接続を閉じて鍵を捨てる（窓を閉じるのは第 8 段） */
    forget(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.stopped = true;
      settleEntry(entry);
      closeClients(entry, 1000, 'forgotten');
      entries.delete(sessionId); byKey.delete(entry.key);
    },
    /** サイトの利用の確認（confirmAgentSites）。ON なら範囲のタブに確認の Fetch を付け、OFF なら外す（止めている要求は通す） */
    setConfirm(enabled) {
      const next = enabled === true;
      if (next === confirm) return;
      confirm = next;
      if (!up) return;
      for (const tab of up.tabs.values()) {
        if (confirm) ensureInternal(up, tab).catch(() => {});
        else dropInternal(up, tab);
      }
    },
    get port() { return address?.port ?? null; },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) { entry.stopped = true; closeClients(entry, 1001, 'closing'); }
      if (up) teardown(up);
      wss.close(); server.close();
      log('chrome-relay: closed');
    },
  };
}
