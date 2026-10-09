// 偽の Chrome の中身（tests/lib/fake-chrome.mjs が ws の接続ごとに serve する）。中継（core/chrome/relay.mjs）と agent-browser の本物が使う分だけの CDP を真似る。
//   - 窓（windowId）とタブ（page のターゲット）。最初は利用者の窓 1 つに利用者のタブ 2 つ（URL・題は中継から漏れてはいけない値）
//   - flatten のセッション（Target.attachToTarget）。イベントの順は実機に合わせる（targetInfoChanged → attachedToTarget → 応答）
//   - Target.setDiscoverTargets・getTargets・createTarget（newWindow なら新しい窓、無ければ最後に使われた利用者の窓）・closeTarget・activateTarget
//   - Fetch.enable したセッションがあるタブの移動は、Fetch.requestPaused で止まり continueRequest / failRequest を待つ（主フレームの Document だけ）。
//     止められた移動はエラーのページ（chrome-error://chromewebdata/。frameNavigated の unreachableUrl）に移り、targetInfo の URL は断られた URL になる（実機と同じ）
//   - 履歴（Page.getNavigationHistory・navigateToHistoryEntry）。履歴の移動は bfcache の復元として扱い、要求を出さない（Fetch で止まらない。served に残らない）
//   - window.open（windowOpen）で開いたタブの最初の要求は止まらない（実機と同じ。served に残る）
//   - 窓は位置・大きさ（bounds。DIP）を持つ。createTarget の newWindow は left・top・width・height を守り、popup の窓は既定で左上（0,0・324×298）に出る（実機）。
//     窓ができたら onWindow の聞き手に知らせる（偽の OS の層が、その窓の HWND を作る）。windowTitle は窓の最後のタブの題（Chrome の窓の題は「<題> - Google Chrome」）
//   - launchWindow は chrome.exe --new-window の窓（URL は題に nonce を持つ data: のページ。題は <title> から取る）
//   - プロフィール: タブは browserContextId を持つ（既定は CTX-DEFAULT。launchWindow の profileDir が Default 以外なら CTX-<profileDir>）。
//     createTarget の browserContextId は知っている値だけ受け（知らない値はエラー）、ignoreTargetContext(true) の間は無視して CTX-DEFAULT に開く。popup は開いたタブと同じ
//   - Emulation.setFocusEmulationEnabled はページに 1 つの状態として効く（実機: 有効にするとページは focus・visible。あるセッションが enabled: false にするか、有効にしたセッションを外すと、
//     ほかのセッションが有効にしていても外れる。2026-10-08）。s.fe はセッションが最後に送った値。focusEmulated(targetId) は、今そのページで効いているか
//   - Page.startScreencast・stopScreencast・screencastFrameAck はセッションごとの状態。screencastFrame(targetId) が、始めているセッションへ Page.screencastFrame を流す（実機は ack まで次を出さない）。
//     screencasting(targetId) は今どのセッションかが始めているか。screencastParams(targetId) はその引数
//   - ページはとても小さな型（題と、見出し・リンク・ボタンの並び）。Accessibility.getFullAXTree・DOM.getBoxModel・Input.dispatchMouseEvent で押せる
// 受けたメソッドは calls（{ method, sessionId, params }）に、サーバーに届いた要求（移動）の URL は served に残す。
import crypto from 'node:crypto';

const hex = () => crypto.randomBytes(16).toString('hex').toUpperCase();
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const originOf = url => { try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.origin : '://'; } catch { return '://'; } };

export const USER_TABS = Object.freeze([
  Object.freeze({ url: 'https://mail.example/inbox', title: 'Inbox — secret-user@example.com' }),
  Object.freeze({ url: 'https://bank.example/account', title: 'Bank account 1234' }),
]);

export function createFakeBrowser({ product, calls, userTabs = USER_TABS } = {}) {
  const windows = new Map();     // windowId -> { state, bounds }
  const windowListeners = new Set();
  const targets = new Map();     // targetId -> { targetId, type, url, title, windowId, openerId, browserContextId }
  const sessions = new Map();    // sessionId -> { id, targetId, socket, fetch }
  const discovering = new Set(); // socket
  const pages = new Map();       // url -> { title, elements, redirect }
  const pausedFetch = new Map(); // requestId -> resolve(decision)
  const served = [];
  const autoAttachCalls = [];
  let windowSeq = 100, requestSeq = 0, contextSeq = 0, entrySeq = 0;
  const contexts = new Set(['CTX-DEFAULT']);   // プロフィールごとの browserContextId（launchWindow の profileDir で増える）
  let contextIgnored = false;    // createTarget の browserContextId を無視する（Chrome が別のプロフィールに開いたときの確かめ）
  let movesRefused = false;      // Browser.setWindowBounds の left・top を受けない（Chrome が画面の外へ置かせてくれない）
  let launchMaximized = false;   // chrome.exe --new-window の窓が、前回の最大化のまま開く（プロフィールに最大化が残っているとき）
  const restoreListeners = new Set();
  let lastActive = null;
  let fetchEnableDelayMs = 0;
  let frameSeq = 0;
  let screencastStartDelayMs = 0;   // Page.startScreencast の応答を遅らせる（始まった印は先に付く。開始の途中を試す）

  const send = (socket, message) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)); };
  const info = t => ({ targetId: t.targetId, type: t.type, title: t.title, url: t.url, attached: [...sessions.values()].some(s => s.targetId === t.targetId), canAccessOpener: false, ...(t.openerId ? { openerId: t.openerId } : {}), browserContextId: t.browserContextId ?? 'CTX-DEFAULT' });
  const toDiscovering = (method, params) => { for (const socket of discovering) send(socket, { method, params }); };
  const sessionsOf = t => [...sessions.values()].filter(s => s.targetId === t.targetId);
  const emit = (t, method, params) => { for (const s of sessionsOf(t)) send(s.socket, { method, params, sessionId: s.id }); };
  const pageFor = url => pages.get(url) ?? { title: url === 'about:blank' ? 'about:blank' : (/^data:text\/html,<title>(.*)<\/title>/.exec(url)?.[1] ?? url).replace(/^https?:\/\//, ''), elements: [{ role: 'heading', name: url }] };

  const DEFAULT_BOUNDS = Object.freeze({ left: 0, top: 0, width: 1200, height: 800 });
  const POPUP_BOUNDS = Object.freeze({ left: 0, top: 0, width: 324, height: 298 });
  function newWindow(state = 'normal', bounds = DEFAULT_BOUNDS) {
    const id = ++windowSeq;
    windows.set(id, { state, bounds: { ...bounds } });
    for (const fn of [...windowListeners]) fn({ windowId: id, bounds: { ...bounds } });
    return id;
  }
  const boundsOf = windowId => ({ ...(windows.get(windowId)?.bounds ?? DEFAULT_BOUNDS), windowState: windows.get(windowId)?.state ?? 'normal' });
  const windowTitle = windowId => { const last = [...targets.values()].filter(t => t.windowId === windowId && t.type === 'page').pop(); return last ? `${last.title} - Google Chrome` : ''; };
  function newTarget({ url = 'about:blank', title, windowId, openerId = null, type = 'page', browserContextId = 'CTX-DEFAULT' }) {
    const t = { targetId: hex(), type, url, title: title ?? (url === 'about:blank' ? '' : pageFor(url).title), windowId, openerId, browserContextId,
      history: [{ id: ++entrySeq, url }], index: 0 };
    targets.set(t.targetId, t);
    toDiscovering('Target.targetCreated', { targetInfo: info(t) });
    return t;
  }
  function closeTarget(t) {
    targets.delete(t.targetId);
    for (const s of sessionsOf(t)) { sessions.delete(s.id); send(s.socket, { method: 'Target.detachedFromTarget', params: { sessionId: s.id, targetId: t.targetId } }); }
    toDiscovering('Target.targetDestroyed', { targetId: t.targetId });
    if (![...targets.values()].some(o => o.windowId === t.windowId)) windows.delete(t.windowId);
  }

  // 利用者の窓とタブ（ほかに Chrome の内部のターゲットも混ぜる。中継は page だけを見るはず）
  const userWindow = newWindow();
  lastActive = userWindow;
  for (const tab of userTabs) newTarget({ url: tab.url, title: tab.title, windowId: userWindow });
  newTarget({ url: 'chrome-extension://fake/background.js', title: 'Service Worker', windowId: null, type: 'service_worker' });

  /** Fetch で止める（そのタブで Fetch.enable したセッションの順に聞く）。'continue' か 'fail' */
  async function intercept(t, url, redirectedRequestId) {
    for (const s of sessionsOf(t).filter(x => x.fetch)) {
      const requestId = `interception-job-${++requestSeq}.0`;
      const decision = await new Promise(resolve => {
        pausedFetch.set(requestId, resolve);
        send(s.socket, { method: 'Fetch.requestPaused', sessionId: s.id, params: { requestId, request: { url, method: 'GET', headers: {} }, frameId: t.targetId, resourceType: 'Document', ...(redirectedRequestId ? { redirectedRequestId } : {}) } });
      });
      if (decision === 'fail') return 'fail';
    }
    return 'continue';
  }

  /** 主フレームの移動。止められたら errorText を返す */
  async function navigate(t, url) {
    const loaderId = hex();
    if (await intercept(t, url) === 'fail') {
      commitError(t, url, loaderId);
      return { frameId: t.targetId, loaderId, errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
    }
    if (!url.startsWith('data:')) served.push(url);   // data: は要求が出ない
    let finalUrl = url;
    const redirect = pages.get(url)?.redirect;
    if (redirect) {
      if (await intercept(t, redirect, 'redirect') === 'fail') {
        commitError(t, redirect, loaderId);
        return { frameId: t.targetId, loaderId, errorText: 'net::ERR_BLOCKED_BY_CLIENT' };
      }
      served.push(redirect);
      finalUrl = redirect;
    }
    if (!targets.has(t.targetId)) return { frameId: t.targetId, loaderId, errorText: 'net::ERR_ABORTED' };
    commit(t, finalUrl, loaderId);
    return { frameId: t.targetId, loaderId };
  }
  /** 履歴に積む（今より先の分は捨てる） */
  function pushHistory(t, url) {
    t.history = t.history.slice(0, t.index + 1);
    t.history.push({ id: ++entrySeq, url });
    t.index = t.history.length - 1;
  }
  /** 止められた移動のエラーのページ。frame の URL は chrome-error、targetInfo の URL は断られた URL（実機と同じ） */
  function commitError(t, url, loaderId = hex()) {
    t.url = url; t.title = url.replace(/^https?:\/\//, '');
    pushHistory(t, url);
    emit(t, 'Page.frameStartedLoading', { frameId: t.targetId });
    emit(t, 'Runtime.executionContextsCleared', {});
    emit(t, 'Page.frameNavigated', { frame: { id: t.targetId, loaderId, url: 'chrome-error://chromewebdata/', unreachableUrl: url, securityOrigin: '://', mimeType: 'text/html' }, type: 'Navigation' });
    toDiscovering('Target.targetInfoChanged', { targetInfo: info(t) });
    emit(t, 'Page.frameStoppedLoading', { frameId: t.targetId });
  }
  function commit(t, url, loaderId = hex(), { restore = false } = {}) {
    t.url = url; t.title = pageFor(url).title;
    if (!restore) pushHistory(t, url);
    emit(t, 'Page.frameStartedLoading', { frameId: t.targetId });
    emit(t, 'Runtime.executionContextsCleared', {});
    emit(t, 'Page.frameNavigated', { frame: { id: t.targetId, loaderId, url, securityOrigin: originOf(url), mimeType: 'text/html' }, type: restore ? 'BackForwardCacheRestore' : 'Navigation' });
    toDiscovering('Target.targetInfoChanged', { targetInfo: info(t) });
    emit(t, 'Runtime.executionContextCreated', { context: { id: ++contextSeq, origin: originOf(url), name: '', uniqueId: hex(), auxData: { isDefault: true, type: 'default', frameId: t.targetId } } });
    emit(t, 'Page.domContentEventFired', { timestamp: Date.now() / 1000 });
    emit(t, 'Page.loadEventFired', { timestamp: Date.now() / 1000 });
    emit(t, 'Page.frameStoppedLoading', { frameId: t.targetId });
  }

  /** ページの window.open。同じ窓（popup なら新しい窓）に openerId 付きのタブを作り、最初の要求は止めずに出す（実機と同じ） */
  function windowOpen(openerId, url, { popup = false } = {}) {
    const opener = targets.get(openerId);
    if (!opener) throw new Error('no opener');
    const t = newTarget({ url: 'about:blank', title: '', windowId: popup ? newWindow('normal', POPUP_BOUNDS) : opener.windowId, openerId, browserContextId: opener.browserContextId });
    setImmediate(() => {
      if (!targets.has(t.targetId)) return;
      served.push(url);
      t.url = url; t.title = pageFor(url).title;
      toDiscovering('Target.targetInfoChanged', { targetInfo: info(t) });
    });
    return t.targetId;
  }

  const box = i => { const y = 20 + 30 * i; return [8, y, 108, y, 108, y + 24, 8, y + 24]; };
  function axTree(t) {
    const spec = pageFor(t.url);
    const nodes = [{ nodeId: '1', ignored: false, role: { type: 'internalRole', value: 'RootWebArea' }, name: { type: 'computedString', value: spec.title }, properties: [], childIds: spec.elements.map((_, i) => String(10 + i)), backendDOMNodeId: 1 }];
    spec.elements.forEach((el, i) => nodes.push({ nodeId: String(10 + i), ignored: false, role: { type: 'role', value: el.role }, name: { type: 'computedString', value: el.name },
      properties: el.role === 'heading' ? [{ name: 'level', value: { type: 'integer', value: 1 } }] : [], parentId: '1', childIds: [], backendDOMNodeId: 10 + i }));
    return { nodes };
  }
  function click(t, x, y) {
    const spec = pageFor(t.url);
    const i = spec.elements.findIndex((_, n) => { const [x0, y0, x1, , , y2] = box(n); return x >= x0 && x <= x1 && y >= y0 && y <= y2; });
    const el = spec.elements[i];
    if (!el) return;
    if (el.open) windowOpen(t.targetId, new URL(el.open.url, t.url).href, { popup: el.open.popup === true });
    else if (el.href) navigate(t, new URL(el.href, t.url).href).catch(() => {});
    else if (el.setTitle) { t.title = el.setTitle; toDiscovering('Target.targetInfoChanged', { targetInfo: info(t) }); }
  }

  function browserCommand(socket, method, params) {
    switch (method) {
      case 'Browser.getVersion': return { product, protocolVersion: '1.3', userAgent: 'fake', jsVersion: '1' };
      case 'Target.setDiscoverTargets':
        // 本物の Chrome は、すでに発見中の接続への 2 回目の setDiscoverTargets では既存のタブの targetCreated を送り直さない（実機で確かめた）
        if (params.discover) { const already = discovering.has(socket); discovering.add(socket); if (!already) for (const t of targets.values()) send(socket, { method: 'Target.targetCreated', params: { targetInfo: info(t) } }); }
        else discovering.delete(socket);
        return {};
      case 'Target.getTargets': return { targetInfos: [...targets.values()].map(info) };
      case 'Target.getTargetInfo': { const t = targets.get(params.targetId); if (!t) throw { code: -32602, message: 'No target with given id found' }; return { targetInfo: info(t) }; }
      case 'Target.attachToTarget': {
        const t = targets.get(params.targetId);
        if (!t) throw { code: -32602, message: 'No target with given id found' };
        const id = hex();
        sessions.set(id, { id, targetId: t.targetId, socket, fetch: false, fe: false, flatten: params.flatten === true });
        toDiscovering('Target.targetInfoChanged', { targetInfo: info(t) });
        send(socket, { method: 'Target.attachedToTarget', params: { sessionId: id, targetInfo: info(t), waitingForDebugger: false } });
        return { sessionId: id };
      }
      case 'Target.detachFromTarget': {
        const s = sessions.get(params.sessionId);
        if (!s || s.socket !== socket) throw { code: -32602, message: 'No session with given id' };
        sessions.delete(s.id);
        if (s.fe) { const t = targets.get(s.targetId); if (t) t.focusOn = false; }
        send(socket, { method: 'Target.detachedFromTarget', params: { sessionId: s.id, targetId: s.targetId } });
        return {};
      }
      case 'Target.setAutoAttach': autoAttachCalls.push(params); return {};
      case 'Target.createTarget': {
        const bounds = { ...DEFAULT_BOUNDS, ...Object.fromEntries(['left', 'top', 'width', 'height'].filter(k => Number.isFinite(params[k])).map(k => [k, params[k]])) };
        if (params.browserContextId != null && !contexts.has(params.browserContextId)) throw { code: -32602, message: 'Failed to find browser context with given id' };
        const windowId = params.newWindow ? newWindow('normal', bounds) : lastActive;
        const t = newTarget({ url: 'about:blank', windowId, browserContextId: !contextIgnored && params.browserContextId ? params.browserContextId : 'CTX-DEFAULT' });
        if (params.url && params.url !== 'about:blank') setImmediate(() => { if (targets.has(t.targetId)) navigate(t, params.url).catch(() => {}); });
        return { targetId: t.targetId };
      }
      case 'Target.closeTarget': { const t = targets.get(params.targetId); if (!t) throw { code: -32602, message: 'No target with given id found' }; closeTarget(t); return { success: true }; }
      case 'Target.activateTarget': { const t = targets.get(params.targetId); if (!t) throw { code: -32602, message: 'No target with given id found' }; const w = windows.get(t.windowId); if (w) w.state = 'normal'; return {}; }
      case 'Browser.getWindowForTarget': { const t = targets.get(params.targetId); if (!t || t.windowId == null) throw { code: -32000, message: 'No web contents in the target' }; return { windowId: t.windowId, bounds: boundsOf(t.windowId) }; }
      case 'Browser.setWindowBounds': { const w = windows.get(params.windowId); if (!w) throw { code: -32000, message: 'Browser window not found' };
        // 実物（chrome/browser/devtools/protocol/browser_handler.cc の SetWindowBounds）に合わせる。windowState の既定は normal で、位置・大きさは normal とだけ一緒に送れる。
        // normal: 最大化・最小化・全画面の窓は戻すだけで、位置・大きさは当てない（戻った窓は、前に保存していた通常の位置（画面の中）へ動く）。通常の窓にだけ位置・大きさを当てる
        const state = params.bounds?.windowState ?? 'normal';
        const keys = ['left', 'top', 'width', 'height'].filter(k => params.bounds?.[k] !== undefined);
        if (keys.length && state !== 'normal') throw { code: -32602, message: "The 'minimized', 'maximized' and 'fullscreen' states cannot be combined with 'left', 'top', 'width' or 'height'" };
        if (state !== 'normal') { w.state = state; return {}; }
        if (w.state !== 'normal') { w.state = 'normal'; w.bounds = { ...w.bounds, left: 10, top: 10 }; for (const fn of [...restoreListeners]) fn({ windowId: params.windowId }); return {}; }
        for (const k of keys) if (Number.isFinite(params.bounds[k]) && !(movesRefused && (k === 'left' || k === 'top'))) w.bounds[k] = params.bounds[k];
        return {}; }
      case 'Browser.getWindowBounds': { const w = windows.get(params.windowId); if (!w) throw { code: -32000, message: 'Browser window not found' }; return { bounds: boundsOf(params.windowId) }; }
      case 'Browser.setContentsSize': return {};
      case 'Browser.close': return {};
      case 'Storage.getCookies': case 'Network.getAllCookies': return { cookies: [{ name: 'session', value: 'secret-cookie', domain: 'bank.example' }] };
      default: throw { code: -32601, message: `'${method}' wasn't found` };
    }
  }

  async function sessionCommand(socket, s, method, params) {
    const t = targets.get(s.targetId);
    if (!t) throw { code: -32602, message: 'Target closed' };
    switch (method) {
      case 'Runtime.enable': setImmediate(() => send(socket, { method: 'Runtime.executionContextCreated', sessionId: s.id, params: { context: { id: ++contextSeq, origin: originOf(t.url), name: '', uniqueId: hex(), auxData: { isDefault: true, type: 'default', frameId: t.targetId } } } })); return {};
      case 'Runtime.evaluate': {
        const expr = String(params.expression ?? '');
        if (expr === '1') return { result: { type: 'number', value: 1, description: '1' } };
        if (expr === 'location.href') return { result: { type: 'string', value: t.url } };
        if (expr === 'document.title') return { result: { type: 'string', value: t.title } };
        if (expr.includes('interactiveRoles')) return { result: { type: 'object', value: [] } };
        return { result: { type: 'undefined' } };
      }
      case 'Runtime.callFunctionOn': return { result: { type: 'object', subtype: 'null', value: null } };
      case 'Page.getFrameTree': return { frameTree: { frame: { id: t.targetId, loaderId: hex(), url: t.url, securityOrigin: originOf(t.url), mimeType: 'text/html' } } };
      case 'Page.navigate': return navigate(t, params.url);
      case 'Page.getNavigationHistory': return { currentIndex: t.index, entries: t.history.map(e => ({ id: e.id, url: e.url, userTypedURL: e.url, title: pageFor(e.url).title, transitionType: 'typed' })) };
      case 'Page.navigateToHistoryEntry': {
        // bfcache の復元: 要求を出さず（Fetch で止まらない）、移り終える
        const i = t.history.findIndex(e => e.id === params.entryId);
        if (i < 0) throw { code: -32000, message: 'No entry with passed id' };
        t.index = i;
        commit(t, t.history[i].url, hex(), { restore: true });
        return {};
      }
      case 'Page.reload': return navigate(t, t.url).then(() => ({}));
      case 'Page.captureScreenshot': return { data: PNG_1X1 };
      case 'Accessibility.getFullAXTree': return axTree(t);
      case 'DOM.getBoxModel': { const i = Number(params.backendNodeId) - 10; const q = box(i); return { model: { content: q, padding: q, border: q, margin: q, width: 100, height: 24 } }; }
      case 'DOM.resolveNode': return { object: { type: 'object', subtype: 'node', className: 'HTMLElement', description: 'el', objectId: `obj-${params.backendNodeId}` } };
      case 'Input.dispatchMouseEvent': if (params.type === 'mouseReleased') setImmediate(() => click(t, params.x, params.y)); return {};
      case 'Emulation.setFocusEmulationEnabled': s.fe = params.enabled === true; t.focusOn = s.fe; return {};
      case 'Page.startScreencast': s.screencast = { ...params }; if (screencastStartDelayMs) await new Promise(resolve => setTimeout(resolve, screencastStartDelayMs)); return {};
      case 'Page.stopScreencast': s.screencast = null; return {};
      case 'Page.screencastFrameAck': return {};
      case 'Fetch.enable': if (fetchEnableDelayMs) await new Promise(resolve => setTimeout(resolve, fetchEnableDelayMs)); s.fetch = true; return {};
      case 'Fetch.disable': s.fetch = false; return {};
      case 'Fetch.continueRequest': { const r = pausedFetch.get(params.requestId); pausedFetch.delete(params.requestId); r?.('continue'); return {}; }
      case 'Fetch.failRequest': { const r = pausedFetch.get(params.requestId); pausedFetch.delete(params.requestId); r?.('fail'); return {}; }
      case 'Network.getCookies': return { cookies: [{ name: 'page', value: 'page-cookie', domain: new URL(t.url.startsWith('http') ? t.url : 'http://blank').hostname }] };
      case 'Network.getAllCookies': case 'Storage.getCookies': return { cookies: [{ name: 'session', value: 'secret-cookie', domain: 'bank.example' }] };
      default: return {};   // ほかの有効化（Page.enable など）は黙って通す
    }
  }

  return {
    /** ws の接続 1 本に CDP を答える */
    serve(socket) {
      socket.on('message', async raw => {
        let message; try { message = JSON.parse(raw.toString()); } catch { return; }
        calls.push({ method: message.method, sessionId: message.sessionId ?? null, params: message.params ?? {} });
        try {
          let result;
          if (message.sessionId) {
            const s = sessions.get(message.sessionId);
            if (!s || s.socket !== socket) throw { code: -32001, message: 'Session with given id not found.' };
            result = await sessionCommand(socket, s, message.method, message.params ?? {});
          } else result = browserCommand(socket, message.method, message.params ?? {});
          send(socket, { id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
        } catch (error) {
          send(socket, { id: message.id, error: { code: error?.code ?? -32000, message: error?.message ?? String(error) }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
        }
      });
      socket.on('close', () => {
        discovering.delete(socket);
        for (const s of [...sessions.values()]) if (s.socket === socket) { sessions.delete(s.id); if (s.fe) { const t = targets.get(s.targetId); if (t) t.focusOn = false; } }
        for (const [id, resolve] of [...pausedFetch]) { pausedFetch.delete(id); resolve('continue'); }
      });
    },
    userWindow,
    served,
    autoAttachCalls,
    windows: () => [...windows].map(([windowId, w]) => ({ windowId, state: w.state, bounds: { ...w.bounds } })),
    targets: () => [...targets.values()].map(t => ({ ...t })),
    sessions: () => [...sessions.values()].map(s => ({ id: s.id, targetId: s.targetId, fetch: s.fetch, fe: s.fe, screencast: Boolean(s.screencast) })),
    /** Page.startScreencast の応答を ms 遅らせる（始まった印は先に付く） */
    delayScreencastStart(ms) { screencastStartDelayMs = ms; },
    /** そのタブで Page.startScreencast を回しているセッションが今あるか */
    screencasting: targetId => [...sessions.values()].some(s => s.targetId === targetId && s.screencast),
    screencastParams: targetId => [...sessions.values()].find(s => s.targetId === targetId && s.screencast)?.screencast ?? null,
    /** 始めているセッションへ 1 フレームを流す（実機は ack まで次を出さない）。戻り値は ack の id（流せなければ null） */
    screencastFrame(targetId, { data = 'QUJD', metadata = { deviceWidth: 1100, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 } } = {}) {
      const id = ++frameSeq;
      let sent = false;
      for (const s of sessions.values()) if (s.targetId === targetId && s.screencast) { send(s.socket, { method: 'Page.screencastFrame', sessionId: s.id, params: { data, metadata, sessionId: id } }); sent = true; }
      return sent ? id : null;
    },
    /** そのタブに focus emulation を有効にしているセッションが今あるか */
    focusEmulated: targetId => targets.get(targetId)?.focusOn === true,
    windowTitle,
    windowBounds: windowId => (windows.has(windowId) ? boundsOf(windowId) : null),
    /** Browser.setWindowBounds の位置（left・top）を受けなくする（大きさは受ける） */
    refuseWindowMoves(on) { movesRefused = on; },
    /** createTarget の browserContextId を無視する（別のプロフィールに開く） */
    ignoreTargetContext(on) { contextIgnored = on; },
    /** chrome.exe --new-window の窓を、最大化のまま開く（Browser.setWindowBounds で通常に戻すと、窓は画面の中の位置へ動く。戻す依頼では大きさは当たらない） */
    launchMaximized(on) { launchMaximized = on; },
    /** 最大化の窓が通常へ戻された（偽の OS の層が、その HWND を画面の中へ動かす） */
    onWindowRestored(fn) { restoreListeners.add(fn); return () => restoreListeners.delete(fn); },
    /** タブの browserContextId（プロフィール） */
    contextOf: targetId => targets.get(targetId)?.browserContextId ?? null,
    onWindow(fn) { windowListeners.add(fn); return () => windowListeners.delete(fn); },
    /** chrome.exe --new-window の窓（最初のタブは url。bounds は --window-position・--window-size が効いたとき） */
    launchWindow({ url, bounds, profileDir = null } = {}) {
      const browserContextId = profileDir && profileDir !== 'Default' ? `CTX-${profileDir}` : 'CTX-DEFAULT';
      contexts.add(browserContextId);
      const windowId = newWindow(launchMaximized ? 'maximized' : 'normal', { ...DEFAULT_BOUNDS, ...(bounds ?? {}) });
      const t = newTarget({ url, windowId, browserContextId });
      return { windowId, targetId: t.targetId };
    },
    /** Chrome の側が、セッションを外した（付けた側へ detachedFromTarget を送る） */
    detachSession(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return false;
      sessions.delete(sessionId);
      if (s.fe) { const t = targets.get(s.targetId); if (t) t.focusOn = false; }
      send(s.socket, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: s.targetId } });
      return true;
    },
    /** 利用者が窓を閉じた（窓の全部のタブが消える） */
    closeWindow(windowId) { for (const t of [...targets.values()].filter(x => x.windowId === windowId)) closeTarget(t); windows.delete(windowId); },
    pausedCount: () => pausedFetch.size,
    setPage(url, spec) { pages.set(url, { elements: [], ...spec }); },
    /** Fetch.enable の応答（と効き始め）を ms 遅らせる（確認を ON にした直後の移動を試す） */
    delayFetchEnable(ms) { fetchEnableDelayMs = ms; },
    history(targetId) { const t = targets.get(targetId); return t ? { index: t.index, entries: t.history.map(e => ({ ...e })) } : null; },
    /** 利用者がタブを開いた（既定は利用者の窓。windowId を渡すとその窓に。エージェントの窓に人が開いた、など） */
    openUserTab(url, title, windowId = userWindow) { return newTarget({ url, title, windowId }).targetId; },
    windowOpen,
    navigateUser(targetId, url) { const t = targets.get(targetId); return t ? navigate(t, url) : null; },
    /** 利用者がタブを引き離して新しい窓にした（タブはそのまま、窓が替わる。元の窓にタブが無ければ元の窓は無くなる）。新しい窓の id を返す */
    detachTab(targetId) {
      const t = targets.get(targetId);
      if (!t) return null;
      const previous = t.windowId;
      const windowId = newWindow('normal', { ...DEFAULT_BOUNDS });
      t.windowId = windowId;
      if (![...targets.values()].some(o => o.windowId === previous)) windows.delete(previous);
      return windowId;
    },
    /** 利用者がタブを閉じた */
    closeTab(targetId) { const t = targets.get(targetId); if (t) closeTarget(t); },
  };
}
