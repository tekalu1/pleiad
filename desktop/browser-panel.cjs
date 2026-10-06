// 内蔵ブラウザー（docs/inapp-browser.md、ADR 0041）。本体の窓（ローカルの画面）の右パネルの位置に WebContentsView を重ねる。
//   - 保存領域は persist:pleiad-browser の 1 つ。Pleiad 本体（既定の session）とリモートの窓（persist:remote-<id>）から分ける。権限・UA・ダウンロードの設定は session に 1 回
//   - タブごとに WebContentsView を 1 つ。窓に載せるのは今のタブだけで、ほかのタブは外したまま裏で動き続ける
//   - 置く場所は画面が決める（右パネルの本文の枠の位置と大きさを ply:browser-layout で送ってくる）。
//     ネイティブの View は DOM より上に描かれるので、メニューなどが重なる間は画面が freeze を頼み、写した画像と差し替えて View を外す
//   - タブは開いた会話（sessionId）を覚える。CDP 中継は会話ごとのタブへつなぐ（ADR 0043）
//   - パネルの一覧と今のタブは、今の会話のタブと、会話に属さないタブ（sessionId が null）だけ。会話を移ると、その会話で最後に選んだタブへ替わる
//   - 画面が開いた file: のタブ（HTML ファイル・可視化の写し。allowFile）だけ、session の webRequest で資源を止める（docs/inapp-browser.md「PC のファイルのタブ」、ADR 0079）:
//     file: の資源は UNC・デバイスパス・データ置き場（添付の uploads を除く）を常に、http(s) は「外部の読み込みの前に確認」が ON のとき「常に」許可した https だけ通す。
//     ページの中で移った先と Web のページには効かせない。session ごとに 1 度だけ張る（setupSession）
// 画面との口は ipcMain の ply:browser（invoke）・ply:browser-layout（send）と、画面への ply:browser-state。
// 送り元はローカルの窓の本体フレームだけ（trust.check(event, ['local'])）。リモートの窓の preload には口を出さない。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
/** 画面が開いた file: のタブの照合の鍵。同じ実体のファイル（可視化の写しは会話と記録の id）は同じタブで開く（docs/inapp-browser.md） */
function fileKey(url, source = null) {
  if (source?.kind === 'snapshot') return `snapshot\0${source.sessionId}\0${source.id || source.at || ''}`;
  const file = filePath(url);
  if (!file) return null;
  const resolved = path.resolve(file);
  return `file\0${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
}
/** 画面から届いた source の形を確かめる。形が違えば null（タブの照合と画面の ⋯ のファイルの操作にだけ使い、読み込みの判断には使わない） */
function cleanSource(source, url) {
  if (!source || typeof source !== 'object' || !String(url).startsWith('file:')) return null;
  const text = (value, max) => typeof value === 'string' && value.length <= max ? value : null;
  if (source.kind === 'file') {
    const file = filePath(url);
    return file ? { kind: 'file', label: text(source.label, 400) } : null;
  }
  if (source.kind === 'snapshot') {
    const sessionId = text(source.sessionId, 300), id = text(source.id, 100), at = text(source.at, 100);
    if (!sessionId || (!id && !at)) return null;
    return { kind: 'snapshot', sessionId, id, at, title: text(source.title, 400) ?? '', origin: text(source.origin, 2000) };
  }
  return null;
}
const realOf = (file, realpath) => { try { return realpath(file); } catch { return null; } };
const insideOf = (file, root) => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
/**
 * file: の URL を、画面が開いた file: のタブの資源として読ませない範囲か（ADR 0050 と同じ）:
 * UNC・デバイスパス、Pleiad のデータ置き場（添付の uploads を除く）。実体を解決して比べる。file: 以外は false
 */
function protectedFile(url, dataDir, realpath = fs.realpathSync) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (u.protocol !== 'file:') return false;
  if (u.host && u.host.toLowerCase() !== 'localhost') return true;
  let file;
  try { file = fileURLToPath(u); } catch { return true; }
  if (/^[\\/]{2}/.test(file)) return true;
  const root = dataDir ? realOf(path.resolve(dataDir), realpath) : null;
  if (!root) return false;
  const real = realOf(file, realpath) ?? path.resolve(file);
  const inside = (a, b) => insideOf(fold(a), fold(b));
  if (!inside(real, root)) return false;
  const uploads = realOf(path.join(root, 'uploads'), realpath) ?? path.join(root, 'uploads');
  return !inside(real, uploads);
}
/** 外部の資源の読み込みを、確認の設定で止めるか。ws・wss は http・https と同じに見る。https の出どころだけ「常に」の許可と一時の許可で通す */
function externalVerdict(url, { confirm = false, origins = [], once = [] } = {}) {
  let u;
  try { u = new URL(url); } catch { return { block: false }; }
  const scheme = { 'http:': 'http:', 'https:': 'https:', 'ws:': 'http:', 'wss:': 'https:' }[u.protocol];
  if (!scheme || u.username || u.password) return { block: false };
  if (!confirm) return { block: false };
  const origin = `${scheme}//${u.host}`;
  if (scheme === 'https:' && (origins.includes(origin) || [...once].includes(origin))) return { block: false };
  return { block: true, origin, secure: scheme === 'https:' };
}
/** 1 件の要求（resourceType は Electron の details.resourceType）の判定。mainFrame はページ自身の移動なので止めない */
function requestVerdict({ url, resourceType }, policy, dataDir, realpath) {
  if (resourceType === 'mainFrame') return { block: false };
  if (String(url).startsWith('file:')) return { block: protectedFile(url, dataDir, realpath), kind: 'file' };
  const verdict = externalVerdict(url, policy);
  return verdict.block ? { ...verdict, kind: 'external' } : { block: false };
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
/**
 * 右パネルのブラウザーを開閉する近道（Ctrl+Shift+B、macOS は ⌘⇧B。画面の側は web/header-entries.mjs）か。
 * input は before-input-event のもの。押したときだけ（離したときはページへ渡す）。IME の変換中は奪わない
 */
function isPanelShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isComposing || input.alt || !input.shift) return false;
  if (platform === 'darwin' ? !input.meta || input.control : !input.control || input.meta) return false;
  return String(input.key ?? '').toLowerCase() === 'b';
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
function createBrowserPanel({ window, WebContentsView, BrowserWindow, session, shell, ipcMain, app, trust, icon, log = () => {}, agentControl = () => {}, now,
  dataDir = process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host'), realpath = fs.realpathSync }) {
  const tabs = new Map();          // id -> { id, view, sessionId, detached }
  let order = [];                  // タブの並び（id）
  let current = null;              // 今のタブの id
  let attached = null;             // 窓に載せている View（今のタブ）
  let visible = false, frozen = false, rect = null, radius = 0;
  let context = { sessionId: null };   // 画面で今開いている会話
  const selected = new Map();      // 会話（selectKey）-> そこで最後に選んだタブの id
  let nextId = 1;
  const tabListeners = new Set();
  const agents = new Map();
  const agentListeners = new Set();
  // リモートの端末が見ているタブ（desktop/browser-screencast.cjs）。窓に載っていないと描かれないので、窓の外に 1px で載せておく
  const pinned = new Set(), parked = new Set();
  let navigation = null;
  const openFileAllowed = createRateLimit({ now });
  const byContents = new Map();    // webContents の id -> タブ（webRequest が要求の持ち主を引く。別の窓に出したタブも残す）
  let loadPolicy = { confirm: false, origins: [] };   // 外部の読み込みの確認（サーバーの設定。setLoadPolicy）
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
    // 画面が開いた file: のタブの資源を止める。持ち主は byContents で引く
    s.webRequest?.onBeforeRequest((details, callback) => {
      let cancel = false;
      try { cancel = decideRequest(details); } catch {}
      callback({ cancel });
    });
  }
  /** そのタブが「画面が開いた file: のタブ」か（allowFile で、今のページが開いたファイルのまま。読み込みの確定前は頼んだ URL とみなす） */
  function guarded(tab) {
    if (!tab?.allowFile || tab.view.webContents.isDestroyed()) return false;
    const loaded = tab.view.webContents.getURL();
    const now = !loaded || loaded === 'about:blank' ? tab.requested : loaded;
    const a = filePath(now), b = filePath(tab.requested);
    return !!a && !!b && samePath(path.resolve(a), path.resolve(b));
  }
  function recordBlocked(tab, url, verdict) {
    const key = String(url).slice(0, 2048);
    if (tab.blocked.has(key) || tab.blocked.size >= 500) return;
    tab.blocked.set(key, { origin: verdict.origin, secure: verdict.secure });
    push();
  }
  /** true なら要求を取り消す */
  function decideRequest(details) {
    const tab = byContents.get(details.webContentsId);
    if (!tab || details.resourceType === 'mainFrame' || !guarded(tab)) return false;
    const verdict = requestVerdict(details, { ...loadPolicy, once: tab.once }, dataDir, realpath);
    if (verdict.block && verdict.kind === 'external') recordBlocked(tab, details.url, verdict);
    return verdict.block;
  }

  const tabOf = id => tabs.get(id) ?? null;
  const currentTab = () => tabOf(current);
  /** パネルに出してよいタブ: 今の会話のものと、会話に属さないもの */
  const isVisible = tab => tab.sessionId === null || tab.sessionId === context.sessionId;
  const visibleTabs = () => order.map(id => tabs.get(id)).filter(isVisible);
  // 最後に選んだタブは会話ごと
  const selectKey = sessionId => sessionId ?? '';
  /** そのタブを、その会話で最後に選んだタブとして覚える（会話に属さないタブは今の会話の分） */
  const remember = tab => { selected.set(selectKey(tab.sessionId ?? context.sessionId), tab.id); };
  /** 今のタブが見えないもの（無い・別の会話のもの）になっていたら、見えるタブの先頭へ。無ければ current なし */
  function reconcile() {
    const tab = currentTab();
    if (tab && isVisible(tab)) return;
    current = visibleTabs()[0]?.id ?? null;
  }
  /** 会話を移ったとき: そこで最後に選んだタブ、なければ見えるタブの先頭、なければ current なし */
  function pickForContext() {
    const last = tabOf(selected.get(selectKey(context.sessionId)));
    current = (last && isVisible(last) ? last : visibleTabs()[0])?.id ?? null;
  }
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
      ...guardInfo(tab),
    };
  }
  /**
   * 画面が開いた file: のタブの印。file / snapshot: ⋯ のファイルの操作の対象（source は画面が開くときに渡したもの。無ければパスだけ）。
   * guard: 止めた資源の件数と、「読み込む」で通せる https の出どころ（確認が ON のときだけ）
   */
  function guardInfo(tab) {
    if (!guarded(tab)) return {};
    const out = {};
    if (tab.source?.kind === 'snapshot') out.snapshot = { sessionId: tab.source.sessionId, id: tab.source.id, at: tab.source.at, title: tab.source.title, origin: tab.source.origin };
    else out.file = { path: path.resolve(filePath(tab.requested)), label: tab.source?.label ?? null };
    if (loadPolicy.confirm) {
      const rows = [...tab.blocked.values()];
      out.guard = { blocked: rows.length, origins: [...new Set(rows.filter(row => row.secure).map(row => row.origin))] };
    }
    return out;
  }
  function snapshot() {
    return { tabs: visibleTabs().map(info), current, agent: agents.get(context.sessionId) ?? null, sessionId: context.sessionId };
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
    placeCurrent();
    park();
  }
  function park() {
    const keep = new Set();
    for (const id of pinned) {
      const tab = tabs.get(id);
      if (!tab || tab.view === attached || tab.view.webContents.isDestroyed()) continue;
      keep.add(tab.view);
      tab.view.setBounds({ x: -4000, y: 0, width: 1, height: 1 });
      if (!parked.has(tab.view)) { try { window.contentView.addChildView(tab.view); parked.add(tab.view); } catch {} }
    }
    for (const view of [...parked]) {
      if (keep.has(view)) continue;
      parked.delete(view);
      if (view !== attached) { try { window.contentView.removeChildView(view); } catch {} }
    }
  }
  function placeCurrent() {
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
              // 開いた元のタブ（ポップアップの中から開いたならその窓）の保存領域
              webPreferences: { session: c.session ?? ses, contextIsolation: true, sandbox: true, nodeIntegration: false }
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
    Object.assign(tab, { once: new Set(), blocked: new Map(), source: null, key: null });
    const contentsId = c.id;
    byContents.set(contentsId, tab);
    const navigationTab = { id: tab.id, sessionId: tab.sessionId, webContents: c };
    navigation?.watch(navigationTab);
    if (agentFrom) navigation?.inherit(agentFrom, navigationTab, url);
    setupPopupWindow(c, tab.sessionId, navigationTab);
    // ページから file: や独自のスキームへは移らない
    const guard = (event, next) => { if (!navigable(next) && !(tab.allowFile && next.startsWith('file:') && !protectedFile(next, dataDir, realpath))) event.preventDefault(); };
    c.on('will-navigate', guard);
    c.on('will-redirect', guard);
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-fail-load']) c.on(name, push);
    // ページにフォーカスがあるときの開閉の近道。この近道だけページへ渡さず、本体の画面へ知らせる（フォーカスも本体へ戻す）。
    // 別の窓に出したタブでは拾わない
    c.on('before-input-event', (event, input) => {
      if (tab.detached || !isPanelShortcut(input)) return;
      event.preventDefault();
      if (input.isAutoRepeat || window.isDestroyed()) return;
      window.webContents.focus?.();
      window.webContents.send('ply:browser-shortcut');
    });
    // 可視化の写し（画面の枠が無く、親へ知らせられない）が、止められた資源を console へ知らせる（web/visualize-document.mjs の CONSOLE_BRIDGE）
    c.on('console-message', (event, _level, text) => {
      const message = typeof event?.message === 'string' ? event.message : text;
      if (tab.source?.kind !== 'snapshot' || typeof message !== 'string' || !message.startsWith('ply-preview-blocked ') || !guarded(tab)) return;
      const url = message.slice('ply-preview-blocked '.length).trim();
      const verdict = requestVerdict({ url, resourceType: 'image' }, { ...loadPolicy, once: tab.once }, dataDir, realpath);
      if (verdict.block && verdict.kind === 'external') recordBlocked(tab, url, verdict);
    });
    c.on('destroyed', () => { byContents.delete(contentsId); if (tabs.has(tab.id)) removeTab(tab.id); });
    if (select) { remember(tab); if (isVisible(tab)) current = tab.id; }
    if (url) load(tab, url);
    place(); push();
    for (const listener of tabListeners) listener('created', tab);
    return tab;
  }
  function load(tab, url, source = null) {
    tab.blank = false; tab.requested = url;
    tab.allowFile = url.startsWith('file:');
    // 別のファイル・写しを読むなら、そのタブだけの一時の許可（「読み込む」）は引き継がない。同じものの読み直しでは残す
    const key = tab.allowFile ? fileKey(url, source) : null;
    if (key !== tab.key) tab.once = new Set();
    tab.key = key; tab.source = tab.allowFile ? source : null; tab.blocked.clear();
    tab.view.webContents.loadURL(url).catch(() => {});   // 失敗は Chromium のエラーページが出る
    place();
  }
  function removeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (attached === tab.view) { try { window.contentView.removeChildView(tab.view); } catch {} attached = null; }
    if (parked.delete(tab.view)) { try { window.contentView.removeChildView(tab.view); } catch {} }
    pinned.delete(id);
    const shown = visibleTabs(), index = shown.indexOf(tab);
    tabs.delete(id);
    for (const [key, value] of selected) if (value === id) selected.delete(key);
    order = order.filter(x => x !== id);
    if (current === id) {
      const rest = shown.filter(x => x !== tab);
      current = rest[Math.min(index, rest.length - 1)]?.id ?? null;
    }
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
    const s = tab.view.webContents.session ?? ses;
    await s.clearStorageData({ origin }).catch(() => {});
    // Cookie はドメイン単位なので、そのページへ送られる Cookie も消す
    const cookies = await s.cookies.get({ url }).catch(() => []);
    await Promise.all(cookies.map(cookie => {
      const host = cookie.domain.replace(/^\./, '');
      return s.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`, cookie.name).catch(() => {});
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
      case 'context': {
        context = { sessionId: typeof args.sessionId === 'string' ? args.sessionId : null };
        pickForContext(); place(); push(); return snapshot();
      }
      case 'open': {
        if (tab) navigation?.human({ id: tab.id }, true);
        const url = openable(args.url);
        if (!url) throw new Error('invalid-url');
        const source = cleanSource(args.source, url);
        // reuse: 同じ実体のファイル（写しは同じ記録）のタブがこの会話にあれば、新しく作らず前に出して読み直す
        const key = args.reuse === true && url.startsWith('file:') ? fileKey(url, source) : null;
        const same = key ? visibleTabs().find(x => x.allowFile && x.key === key) : null;
        if (same) {
          navigation?.human({ id: same.id }, true);
          current = same.id; remember(same); load(same, url, source); push();
          return { ...snapshot(), reused: same.id };
        }
        if (!tab || args.newTab) { const created = createTab({ url }); if (source) Object.assign(created, { source, key: fileKey(url, source) }); }
        else { current = tab.id; remember(tab); load(tab, url, source); }
        push(); return snapshot();
      }
      case 'newTab': createTab({}); return snapshot();
      // 「読み込む」: 止めた https の出どころを、このタブだけ一時的に通して読み直す。写しは meta の CSP が先に止めているので、
      // 画面が一時の許可付きで写しを書き直して開き直す（rewrite を返す）
      case 'allowOnce': {
        if (!tab || !guarded(tab)) return snapshot();
        for (const row of tab.blocked.values()) if (row.secure) tab.once.add(row.origin);
        tab.blocked.clear();
        if (tab.source?.kind === 'snapshot') { push(); return { ...snapshot(), rewrite: { source: tab.source, origins: [...tab.once] } }; }
        tab.view.webContents.reload(); push(); return snapshot();
      }
      case 'select': if (tab && isVisible(tab)) { current = tab.id; remember(tab); place(); push(); } return snapshot();
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
        // 重なりの間に今のタブが替わった（会話の切り替えなど）ときは、窓から外れている今のタブを写す。描かれていなければ写しは出さない
        const tab = currentTab();
        const shown = attached ?? (tab && !tab.blank && !tab.view.webContents.isDestroyed() ? tab.view : null);
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
    selectFor: id => { const tab = tabs.get(id); if (!tab) return; remember(tab); if (isVisible(tab)) { current = id; place(); } push(); },
    closeFor: id => removeTab(id),
    rebindSession: (from, to) => {
      for (const tab of tabs.values()) if (tab.sessionId === from) tab.sessionId = to;
      const fromKey = selectKey(from), toKey = selectKey(to);
      if (selected.has(fromKey)) {
        if (!selected.has(toKey)) selected.set(toKey, selected.get(fromKey));
        selected.delete(fromKey);
      }
      reconcile(); place();
      if (agents.has(from)) { const active = agents.get(from); agents.delete(from); agents.set(to, { ...active, sessionId: to }); }
      push();
    },
    onTabsChanged: listener => { tabListeners.add(listener); return () => tabListeners.delete(listener); },
    setAgent: (sessionId, tabId) => {
      const before = agents.get(sessionId)?.tabId ?? null;
      if (tabId) agents.set(sessionId, { sessionId, tabId }); else agents.delete(sessionId);
      if (tabId && tabs.has(tabId)) selected.set(selectKey(sessionId), tabId);
      if (tabId && context.sessionId === sessionId && tabs.has(tabId)) { current = tabId; place(); }
      push();
      if (before !== (tabId ?? null)) for (const listener of agentListeners) listener(sessionId);
    },
    // ---- リモートの端末から見る（desktop/browser-screencast.cjs）
    agentFor: sessionId => agents.get(sessionId) ?? null,
    onAgentChanged: listener => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
    pin: (id, on) => { if (on && tabs.has(id)) pinned.add(id); else pinned.delete(id); place(); },
    human: id => navigation?.human({ id }, true),
    session: ses,
    /** 外部の読み込みの確認の設定（desktop/agent-browser-bridge.cjs がサーバーから受ける）。もう通る出どころは止めた一覧から外す */
    setLoadPolicy: policy => {
      const origins = (Array.isArray(policy?.origins) ? policy.origins : []).filter(o => typeof o === 'string' && /^https:\/\/[^/\s]+$/.test(o)).slice(0, 500);
      loadPolicy = { confirm: policy?.confirm === true, origins };
      for (const tab of tabs.values()) {
        for (const [url, row] of [...tab.blocked]) if (!loadPolicy.confirm || (row.secure && origins.includes(row.origin))) tab.blocked.delete(url);
      }
      push();
    },
  };
}

module.exports = { createBrowserPanel, PARTITION, openable, navigable, externalUrl, externalFile, cleanRect, plainUserAgent, uniquePath, isPanelShortcut,
  fileKey, cleanSource, protectedFile, externalVerdict, requestVerdict };
