// 内蔵ブラウザー（docs/inapp-browser.md、ADR 0041）。本体の窓（ローカルの画面）の右パネルの位置に WebContentsView を重ねる。
//   - 保存領域は persist:pleiad-browser。Pleiad 本体（既定の session）とリモートの窓（persist:remote-<id>）から分ける
//   - タブごとに WebContentsView を 1 つ。窓に載せるのは今のタブだけで、ほかのタブは外したまま裏で動き続ける
//   - 置く場所は画面が決める（右パネルの本文の枠の位置と大きさを ply:browser-layout で送ってくる）。
//     ネイティブの View は DOM より上に描かれるので、メニューなどが重なる間は画面が freeze を頼み、写した画像と差し替えて View を外す
//   - タブは開いた会話（sessionId）を覚える。CDP 中継は会話ごとのタブへつなぐ（ADR 0043）
// 画面との口は ipcMain の ply:browser（invoke）・ply:browser-layout（send）と、画面への ply:browser-state。
// 送り元はローカルの窓の本体フレームだけ（trust.check(event, ['local'])）。リモートの窓の preload には口を出さない。
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { checkRequest } = require('./file-bridge.cjs');

const PARTITION = 'persist:pleiad-browser';
// 開いてよい URL。画面の入力は web/browser-address.mjs が http(s) に直してから送る。file: は画面が明示したときだけ（HTML のファイル）
const OPENABLE = new Set(['http:', 'https:', 'file:']);
// ページの中から移ってよい先（と about:blank）。file: へはページからは移らせない（Chromium も http(s) からは止める）
const NAVIGABLE = new Set(['http:', 'https:']);
// URL のまま既定のブラウザーへ渡すのは http(s) だけ（userinfo の無いもの）
function externalUrl(url) {
  try {
    const u = new URL(url);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.href;
  } catch {}
  return null;
}
// file: の HTML も既定のブラウザーで開ける。ただし画面が明示して開いたファイル（tab.requested）そのものだけで、
// ページの中で移った先の file: は断る。拡張子は URL の段階と、実体を解決した後（file-bridge の checkRequest）の両方で確かめる
const OPENABLE_FILE = /\.html?$/i;
function filePath(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && !u.host ? fileURLToPath(u) : null;   // file://server/share（UNC）は断る
  } catch { return null; }
}
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** そのタブの今の URL が、画面が明示して開いた file: の HTML ならそのパス。それ以外は null */
function externalFile(url, tab) {
  if (!tab?.allowFile) return null;
  const file = filePath(url), requested = filePath(tab.requested);
  if (!file || !requested || !OPENABLE_FILE.test(file) || !samePath(path.resolve(file), path.resolve(requested))) return null;
  return file;
}
/** 短い時間に何度も開かせない。core/os-open.mjs の createRateLimit と同じで、サーバーの openPath と同じ 5 回 / 10 秒 */
function createRateLimit({ limit = 5, windowMs = 10_000, now = () => Date.now() } = {}) {
  const times = [];
  return () => {
    const t = now();
    while (times.length && t - times[0] > windowMs) times.shift();
    if (times.length >= limit) return false;
    times.push(t);
    return true;
  };
}
function openable(url) {
  try { const u = new URL(url); return OPENABLE.has(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function navigable(url) {
  try { const u = new URL(url); return NAVIGABLE.has(u.protocol) || u.href === 'about:blank'; } catch { return false; }
}
/** 送られてきた枠。数でなければ null（隠す） */
function cleanRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const n = key => Number.isFinite(rect[key]) ? rect[key] : NaN;
  const r = { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
  if (Object.values(r).some(Number.isNaN) || r.width < 1 || r.height < 1) return null;
  return r;
}
/** Electron と Pleiad の印を外した UA。付いたままだとログインを断るサイトがある */
function plainUserAgent(ua) {
  return String(ua ?? '').replace(/\s(?:Electron|agent-host|Pleiad|Ply)\/\S+/g, '');
}
/** 既定のダウンロードの置き場で、同じ名前があれば「名前 (2).拡張子」 */
function uniquePath(dir, name, exists = fs.existsSync) {
  const safe = path.basename(String(name || 'download')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_') || 'download';
  const ext = path.extname(safe), stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 2; exists(candidate) && i < 1000; i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/**
 * @param {object} deps
 *   window: 本体の BrowserWindow。WebContentsView・BrowserWindow・session・shell・ipcMain・app は electron のもの（テストでは偽物）
 *   trust: desktop/window-trust.cjs。icon: 別の窓のアイコン
 */
function createBrowserPanel({ window, WebContentsView, BrowserWindow, session, shell, ipcMain, app, trust, icon, log = () => {}, agentControl = () => {}, now }) {
  const tabs = new Map();          // id -> { id, view, sessionId, detached }
  let order = [];                  // タブの並び（id）
  let current = null;              // 今のタブの id
  let attached = null;             // 窓に載せている View（今のタブ）
  let visible = false, frozen = false, rect = null, radius = 0;
  let context = { sessionId: null };   // 画面で今開いている会話
  let nextId = 1;
  const tabListeners = new Set();
  const agents = new Map();
  let navigation = null;
  const openFileAllowed = createRateLimit({ now });
  const ses = session.fromPartition(PARTITION);
  setupSession(ses);

  function setupSession(s) {
    // 権限は既定で断る（カメラ・マイク・位置・通知・クリップボードの読み取りなど）。確認の UI は持たない
    s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    s.setDevicePermissionHandler?.(() => false);
    try { if (app?.userAgentFallback) s.setUserAgent(plainUserAgent(app.userAgentFallback)); } catch {}
    // ダウンロードは確かめずに既定の場所へ（管理の UI は作らない。ADR 0041）
    s.on('will-download', (_event, item) => {
      try { item.setSavePath(uniquePath(app.getPath('downloads'), item.getFilename())); } catch {}
    });
  }

  const tabOf = id => tabs.get(id) ?? null;
  const currentTab = () => tabOf(current);
  function info(tab) {
    const c = tab.view.webContents;
    // 読み込みが確定するまで getURL は空なので、頼んだ URL を見せる
    const loaded = c.isDestroyed() ? '' : c.getURL();
    const url = loaded && loaded !== 'about:blank' ? loaded : tab.requested ?? '';
    return {
      id: tab.id, sessionId: tab.sessionId, url,
      title: c.isDestroyed() ? '' : c.getTitle(), loading: !c.isDestroyed() && c.isLoading(),
      canGoBack: !c.isDestroyed() && c.navigationHistory.canGoBack(), canGoForward: !c.isDestroyed() && c.navigationHistory.canGoForward(),
      // 「既定のブラウザーで開く」を押せるか（http・https と、画面が明示して開いた file: の HTML）
      external: !!(externalUrl(url) || externalFile(url, tab)),
    };
  }
  function snapshot() {
    return { tabs: order.map(id => info(tabs.get(id))), current, agent: agents.get(context.sessionId) ?? null };
  }
  let pushTimer = null;
  function push() {
    // 読み込みの途中は細かく届くので、まとめて送る
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (!window.isDestroyed()) window.webContents.send('ply:browser-state', snapshot());
    }, 16);
  }

  /** 今のタブの View を窓に載せる・外す。見せるのは、画面が表示中と言い、枠があり、凍らせていない間だけ */
  function place() {
    if (window.isDestroyed() || window.webContents.isDestroyed?.()) return;
    const tab = currentTab();
    const want = visible && !frozen && rect && tab && !tab.blank && !tab.view.webContents.isDestroyed() ? tab.view : null;
    if (attached && attached !== want) {
      try { window.contentView.removeChildView(attached); } catch {}
      attached = null;
    }
    if (!want) return;
    const zoom = window.webContents.getZoomFactor?.() ?? 1;
    want.setBounds({ x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) });
    want.setBorderRadius?.(Math.round(radius * zoom));
    if (attached !== want) { window.contentView.addChildView(want); attached = want; }
  }

  function setupPopupWindow(c, sessionId, agentFromTab) {
    // 新しい窓のうち、ポップアップ（disposition: 'new-window'）は opener を保って別の窓で開く
    // 通常の新しいタブ（target=_blank）は内蔵ブラウザーの新しいタブにする（opener なし）
    c.setWindowOpenHandler(({ url: next, disposition, features }) => {
      const target = openable(next);
      // ログインのポップアップは空の窓（about:blank）を先に開けてから行き先を入れることがあるので、それも窓で開く
      const blankPopup = disposition === 'new-window' && (!next || next === 'about:blank');
      if (blankPopup || (target && navigable(target))) {
        if (disposition === 'new-window') {
          const parsedFeatures = (features || '').split(',').reduce((acc, f) => {
            const [k, v] = f.split('=');
            if (k) acc[k.trim()] = v ? v.trim() : true;
            return acc;
          }, {});
          const width = parseInt(parsedFeatures.width) || 500;
          const height = parseInt(parsedFeatures.height) || 700;
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              parent: window,
              width,
              height,
              webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false }
            }
          };
        }
        const open = () => createTab({ url: target, sessionId, select: disposition !== 'background-tab', agentFrom: agentFromTab });
        if (!navigation?.popup(agentFromTab, target, open)) open();
      }
      return { action: 'deny' };
    });
    c.on('did-create-window', (popupWin, details) => {
      popupWin.setMenuBarVisibility?.(false);
      const popupTab = { id: `popup-${nextId++}`, sessionId, webContents: popupWin.webContents };
      navigation?.watch(popupTab);
      if (agentFromTab) navigation?.inherit(agentFromTab, popupTab, details.url);
      setupPopupWindow(popupWin.webContents, sessionId, popupTab);
      const guard = (event, nextUrl) => { if (!navigable(nextUrl)) event.preventDefault(); };
      popupWin.webContents.on('will-navigate', guard);
      popupWin.webContents.on('will-redirect', guard);
    });
  }

  function createTab({ url = '', sessionId = context.sessionId, select = true, agentFrom = null } = {}) {
    const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor?.('#ffffff');
    const tab = { id: `t${nextId++}`, view, sessionId: sessionId ?? null, blank: !url };
    tabs.set(tab.id, tab); order.push(tab.id);
    const c = view.webContents;
    const navigationTab = { id: tab.id, sessionId: tab.sessionId, webContents: c };
    navigation?.watch(navigationTab);
    if (agentFrom) navigation?.inherit(agentFrom, navigationTab, url);
    setupPopupWindow(c, tab.sessionId, navigationTab);
    // ページから file: や独自のスキームへは移らない
    const guard = (event, next) => { if (!navigable(next) && !(tab.allowFile && next.startsWith('file:'))) event.preventDefault(); };
    c.on('will-navigate', guard);
    c.on('will-redirect', guard);
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-fail-load']) c.on(name, push);
    c.on('destroyed', () => { if (tabs.has(tab.id)) removeTab(tab.id); });
    if (select) current = tab.id;
    if (url) load(tab, url);
    place(); push();
    for (const listener of tabListeners) listener('created', tab);
    return tab;
  }
  function load(tab, url) {
    tab.blank = false; tab.requested = url;
    tab.allowFile = url.startsWith('file:');
    tab.view.webContents.loadURL(url).catch(() => {});   // 失敗は Chromium のエラーページが出る
    place();
  }
  function removeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (attached === tab.view) { try { window.contentView.removeChildView(tab.view); } catch {} attached = null; }
    tabs.delete(id);
    const index = order.indexOf(id);
    order = order.filter(x => x !== id);
    if (current === id) current = order[Math.min(index, order.length - 1)] ?? null;
    try { if (!tab.detached && !tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
    place(); push();
    for (const listener of tabListeners) listener('destroyed', tab);
  }

  /** そのタブを独立した窓へ移す。パネルの一覧からは外れる（窓を閉じるとページも閉じる） */
  function detach(id) {
    const tab = tabs.get(id);
    if (!tab || tab.blank) return false;
    if (attached === tab.view) { try { window.contentView.removeChildView(tab.view); } catch {} attached = null; }
    tab.detached = true;
    removeTab(id);
    const c = tab.view.webContents;
    const bounds = tab.view.getBounds?.() ?? { width: 1000, height: 760 };
    const win = new BrowserWindow({ width: Math.max(640, bounds.width), height: Math.max(480, bounds.height), title: c.getTitle() || 'Pleiad', icon, autoHideMenuBar: true });
    win.removeMenu?.();
    win.contentView.addChildView(tab.view);
    const fit = () => { const [width, height] = win.getContentSize(); tab.view.setBounds({ x: 0, y: 0, width, height }); };
    tab.view.setBorderRadius?.(0);
    fit(); win.on('resize', fit);
    const title = (_event, text) => { if (!win.isDestroyed()) win.setTitle(text); };
    c.on('page-title-updated', title);
    win.on('closed', () => { try { if (!c.isDestroyed()) c.close(); } catch {} });
    return true;
  }

  async function clearSiteData(tab) {
    const url = tab?.view.webContents.getURL();
    let origin;
    try { origin = new URL(url).origin; } catch { return false; }
    if (!origin || origin === 'null') return false;
    await ses.clearStorageData({ origin }).catch(() => {});
    // Cookie はドメイン単位なので、そのページへ送られる Cookie も消す
    const cookies = await ses.cookies.get({ url }).catch(() => []);
    await Promise.all(cookies.map(cookie => {
      const host = cookie.domain.replace(/^\./, '');
      return ses.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`, cookie.name).catch(() => {});
    }));
    tab.view.webContents.reload();
    return true;
  }

  async function command(action, args = {}) {
    const tab = args.id ? tabOf(args.id) : currentTab();
    switch (action) {
      case 'state': return snapshot();
      case 'agentStop': agentControl('stop', context.sessionId); return snapshot();
      case 'agentTakeOver': agentControl('takeOver', context.sessionId); return snapshot();
      case 'context': context = { sessionId: typeof args.sessionId === 'string' ? args.sessionId : null }; return snapshot();
      case 'open': {
        if (tab) navigation?.human({ id: tab.id }, true);
        const url = openable(args.url);
        if (!url) throw new Error('invalid-url');
        if (!tab || args.newTab) createTab({ url });
        else { current = tab.id; load(tab, url); }
        push(); return snapshot();
      }
      case 'newTab': createTab({}); return snapshot();
      case 'select': if (tab) { current = tab.id; place(); push(); } return snapshot();
      case 'close': if (tab) removeTab(tab.id); return snapshot();
      case 'back': if (tab) navigation?.human({ id: tab.id }, true); if (tab?.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack(); return snapshot();
      case 'forward': if (tab) navigation?.human({ id: tab.id }, true); if (tab?.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward(); return snapshot();
      case 'reload': if (tab) navigation?.human({ id: tab.id }, true); tab?.view.webContents.reload(); return snapshot();
      case 'stop': tab?.view.webContents.stop(); return snapshot();
      case 'devtools': if (tab && !tab.blank) tab.view.webContents.openDevTools({ mode: 'detach' }); return snapshot();
      case 'external': {
        const loaded = tab?.view.webContents.getURL();
        const file = externalFile(loaded, tab);
        if (file) return openFile(file);
        const url = externalUrl(loaded);
        if (!url) return { ok: false };
        log('external', url);
        await shell.openExternal(url).catch(() => {});
        return { ok: true };
      }
      // 会話・プレビューのリンクを既定のブラウザーへ（web/link-open.mjs）。本体の窓の setWindowOpenHandler は https しか通さないので、http の localhost もここで渡す
      case 'openExternal': {
        const url = externalUrl(args.url);
        if (!url) return { ok: false };
        log('external', url);
        await shell.openExternal(url).catch(() => {});
        return { ok: true };
      }
      case 'detach': return { ok: detach(tab?.id) };
      case 'clearSiteData': return { ok: await clearSiteData(tab) };
      // 重なりの間は、今の見た目を画像にして画面へ返し、View を外す。画面は画像を同じ位置に置く
      case 'freeze': {
        const shown = attached;
        frozen = true;
        if (!shown) { place(); return { image: null }; }
        let image = null;
        // 窓が隠れている（ほかの窓に覆われている）間は描かれず空の画像になる。そのときは写しを出さない
        try { const shot = await shown.webContents.capturePage(); if (!shot.isEmpty?.()) image = shot.toDataURL(); } catch {}
        place();
        return { image };
      }
      case 'unfreeze': frozen = false; place(); return { ok: true };
      default: throw new Error(`unknown browser action: ${action}`);
    }
  }

  /** 画面が開いた file: の HTML を既定のブラウザーで。実体を解決して HTML のファイルと確かめてから shell.openPath（シェルを通さない） */
  async function openFile(file) {
    let real;
    try {
      real = await fs.promises.realpath(file);
      checkRequest({ action: 'open', path: real });
    } catch { return { ok: false }; }
    if (!openFileAllowed()) return { ok: false, reason: 'too-many' };
    log('external', real);
    const error = await shell.openPath(real).catch(e => String(e?.message ?? e));
    return error ? { ok: false } : { ok: true };
  }

  function layout(message) {
    visible = !!message?.visible;
    rect = cleanRect(message?.rect);
    radius = Number.isFinite(message?.radius) ? Math.max(0, Math.min(24, message.radius)) : 0;
    if (!visible) frozen = false;
    place();
  }

  function attach() {
    ipcMain.handle('ply:browser', (event, action, args) => { trust.check(event, ['local']); return command(action, args ?? {}); });
    ipcMain.on('ply:browser-layout', (event, message) => {
      try { trust.check(event, ['local']); } catch { return; }
      layout(message);
    });
    // 画面を読み直したら（開発中の再読み込みなど）、古い位置に View を残さない
    window.webContents.on('did-start-navigation', (_event, _url, inPage, isMainFrame) => {
      if (isMainFrame && !inPage) { visible = false; frozen = false; place(); }
    });
  }

  return {
    attach, command, layout, snapshot,
    setNavigationGuard: guard => { navigation = guard; for (const tab of tabs.values()) guard.watch({ id: tab.id, sessionId: tab.sessionId, webContents: tab.view.webContents }); },
    // ---- エージェントの操作の中継へ渡す、会話ごとのタブと webContents
    tabsFor: sessionId => order.map(id => tabs.get(id)).filter(tab => tab.sessionId === sessionId).map(tab => ({ id: tab.id, webContents: tab.view.webContents })),
    contentsOf: id => tabs.get(id)?.view.webContents ?? null,
    createFor: (sessionId, url = '') => { const tab = createTab({ sessionId, url: url || 'about:blank', select: true }); return { id: tab.id, webContents: tab.view.webContents }; },
    selectFor: id => { if (tabs.has(id)) { current = id; place(); push(); } },
    closeFor: id => removeTab(id),
    rebindSession: (from, to) => { for (const tab of tabs.values()) if (tab.sessionId === from) tab.sessionId = to; if (agents.has(from)) { const active = agents.get(from); agents.delete(from); agents.set(to, { ...active, sessionId: to }); } push(); },
    onTabsChanged: listener => { tabListeners.add(listener); return () => tabListeners.delete(listener); },
    setAgent: (sessionId, tabId) => { if (tabId) agents.set(sessionId, { sessionId, tabId }); else agents.delete(sessionId); if (tabId && context.sessionId === sessionId) { current = tabId; place(); } push(); },
    session: ses,
  };
}

module.exports = { createBrowserPanel, PARTITION, openable, navigable, externalUrl, externalFile, cleanRect, plainUserAgent, uniquePath };
