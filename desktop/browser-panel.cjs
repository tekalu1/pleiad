// 内蔵ブラウザー（docs/inapp-browser.md、ADR 0041）。本体の窓（ローカルの画面）の右パネルの位置に WebContentsView を重ねる。
//   - 保存領域はプロフィールごと（ADR 0078）。メインは今までの persist:pleiad-browser、ほかは persist:pleiad-browser-<id>。
//     Pleiad 本体（既定の session）とリモートの窓（persist:remote-<id>）から分ける。権限・UA・ダウンロードの設定は session ごとに 1 回
//   - 会話は今のプロフィールを 1 つ持つ（正本はサーバーの会話のメタ。ここは resolveProfile で引いて覚える）。
//     パネルの一覧・中継（tabsFor / createFor）は、会話の今のプロフィールのタブだけ。ほかのプロフィールのタブは閉じずに残す
//   - タブごとに WebContentsView を 1 つ。窓に載せるのは今のタブだけで、ほかのタブは外したまま裏で動き続ける
//   - 置く場所は画面が決める（右パネルの本文の枠の位置と大きさを ply:browser-layout で送ってくる）。
//     ネイティブの View は DOM より上に描かれるので、メニューなどが重なる間は画面が freeze を頼み、写した画像と差し替えて View を外す
//   - タブは開いた会話（sessionId）を覚える。CDP 中継は会話ごとのタブへつなぐ（ADR 0043）
//   - パネルの一覧と今のタブは、今の会話のタブと、会話に属さないタブ（sessionId が null）だけ。会話を移ると、その会話で最後に選んだタブへ替わる
// 画面との口は ipcMain の ply:browser（invoke）・ply:browser-layout（send）と、画面への ply:browser-state。
// 送り元はローカルの窓の本体フレームだけ（trust.check(event, ['local'])）。リモートの窓の preload には口を出さない。
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { checkRequest } = require('./file-bridge.cjs');

const PARTITION = 'persist:pleiad-browser';
// プロフィール（web/browser-profiles.mjs と同じ形。main は ESM を同期で読めないので、id の形だけここにも持つ）
const MAIN_PROFILE = 'main';
const PROFILE_ID = /^(?:main|p[0-9a-f]{8,32})$/;
const validProfile = id => typeof id === 'string' && PROFILE_ID.test(id);
/** プロフィールの保存領域。メインは今までの名前のまま（移行で何も失わない）。ほかは別の接頭辞（persist:pleiad-browser を接頭辞にした列挙をしない） */
function partitionOf(profile) {
  return profile === MAIN_PROFILE || !validProfile(profile) ? PARTITION : `${PARTITION}-${profile}`;
}
/** <userData>/Partitions の下のディレクトリ名（persist: を外したもの） */
const partitionDir = profile => partitionOf(profile).slice('persist:'.length);
/** ディレクトリの大きさ（バイト）。読めないものは数えない */
async function directorySize(dir) {
  let total = 0;
  const walk = async current => {
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) { try { total += (await fs.promises.stat(full)).size; } catch {} }
    }
  };
  await walk(dir);
  return total;
}
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
  resolveProfile = async () => null, userData = null }) {
  const tabs = new Map();          // id -> { id, view, sessionId, profile, detached }
  let order = [];                  // タブの並び（id）
  let current = null;              // 今のタブの id
  let attached = null;             // 窓に載せている View（今のタブ）
  let visible = false, frozen = false, rect = null, radius = 0;
  let context = { sessionId: null, profile: MAIN_PROFILE };   // 画面で今開いている会話と、その会話の今のプロフィール
  const selected = new Map();      // 会話とプロフィール（selectKey）-> そこで最後に選んだタブの id
  let nextId = 1;
  const tabListeners = new Set();
  const agents = new Map();
  const agentListeners = new Set();
  const profileListeners = new Set();
  // リモートの端末が見ているタブ（desktop/browser-screencast.cjs）。窓に載っていないと描かれないので、窓の外に 1px で載せておく
  const pinned = new Set(), parked = new Set();
  let navigation = null;
  const openFileAllowed = createRateLimit({ now });
  // プロフィール: 使える id と既定（サーバーの設定から届く。setProfiles）、会話 -> 今のプロフィール、プロフィール -> session
  let profileIds = [MAIN_PROFILE], defaultId = MAIN_PROFILE;
  const profileOf = new Map();
  const sessions = new Map();
  // エージェントが切り替えたときの知らせ（画面が 1 回だけ出す。seq で見分ける）
  let notice = null, noticeSeq = 0, contextSeq = 0;
  const known = id => profileIds.includes(id);
  const userDataDir = () => { try { return userData ?? app?.getPath?.('userData') ?? null; } catch { return null; } };
  const removalFile = () => { const dir = userDataDir(); return dir ? path.join(dir, 'browser-profiles-removed.json') : null; };
  sweepRemoved();
  const ses = sessionFor(MAIN_PROFILE);

  /** そのプロフィールの session。初めて使うときに作り、設定を 1 回だけかける */
  function sessionFor(profile) {
    const id = validProfile(profile) ? profile : MAIN_PROFILE;
    let s = sessions.get(id);
    if (!s) { s = session.fromPartition(partitionOf(id)); setupSession(s); sessions.set(id, s); }
    return s;
  }
  /** 消したプロフィールの保存領域のディレクトリを、次の起動で（まだ session を作る前に）消す。使っている間は Windows が掴んでいて消せない */
  function sweepRemoved() {
    const file = removalFile(), dir = userDataDir();
    if (!file || !dir) return;
    let names = [];
    try { names = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    const left = [];
    for (const name of Array.isArray(names) ? names : []) {
      if (typeof name !== 'string' || !/^pleiad-browser-p[0-9a-f]{8,32}$/.test(name)) continue;
      try { fs.rmSync(path.join(dir, 'Partitions', name), { recursive: true, force: true, maxRetries: 2 }); } catch { left.push(name); }
    }
    try { if (left.length) fs.writeFileSync(file, JSON.stringify(left)); else fs.rmSync(file, { force: true }); } catch {}
  }
  function queueRemoval(profile) {
    const file = removalFile();
    if (!file || profile === MAIN_PROFILE) return;
    let names = [];
    try { names = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const name = partitionDir(profile);
    if (!Array.isArray(names)) names = [];
    if (!names.includes(name)) names.push(name);
    try { fs.writeFileSync(file, JSON.stringify(names)); } catch {}
  }

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
  /** 会話の今のプロフィール。まだ引いていない会話は既定（中継・画面の転送は先に setProfileFor / ensureProfile で覚えさせる） */
  const profileFor = sessionId => { const p = profileOf.get(sessionId ?? null); return known(p) ? p : defaultId; };
  /** パネルに出してよいタブ: 今の会話のものと会話に属さないもののうち、今のプロフィールのもの */
  const isVisible = tab => (tab.sessionId === null || tab.sessionId === context.sessionId) && tab.profile === context.profile;
  const visibleTabs = () => order.map(id => tabs.get(id)).filter(isVisible);
  // 最後に選んだタブは会話とプロフィールの組ごと（プロフィールを戻すと、そこで選んでいたタブも戻る）
  const selectKey = (sessionId, profile) => `${sessionId ?? ''}\u0000${profile}`;
  /** そのタブを、その会話で最後に選んだタブとして覚える（会話に属さないタブは今の会話の分） */
  const remember = tab => { selected.set(selectKey(tab.sessionId ?? context.sessionId, tab.profile), tab.id); };
  /** 今のタブが見えないもの（無い・別の会話のもの）になっていたら、見えるタブの先頭へ。無ければ current なし */
  function reconcile() {
    const tab = currentTab();
    if (tab && isVisible(tab)) return;
    current = visibleTabs()[0]?.id ?? null;
  }
  /** 会話（かプロフィール）を移ったとき: そこで最後に選んだタブ、なければ見えるタブの先頭、なければ current なし */
  function pickForContext() {
    const last = tabOf(selected.get(selectKey(context.sessionId, context.profile)));
    current = (last && isVisible(last) ? last : visibleTabs()[0])?.id ?? null;
  }
  /**
   * 会話の今のプロフィールを替える。画面で開いている会話なら一覧と今のタブも替える。
   * agent があれば（エージェントが切り替えた）画面へ 1 回だけ知らせる。中継はタブの集合を作り直す（onProfileChanged）
   */
  function setProfileFor(sessionId, profile, { agent = null } = {}) {
    const key = sessionId ?? null;
    if (!known(profile)) return false;
    const before = profileFor(key);
    profileOf.set(key, profile);
    if (before === profile) return true;
    if (key === context.sessionId) { context = { ...context, profile }; pickForContext(); place(); }
    if (agent) notice = { seq: ++noticeSeq, sessionId: key, profile, agent: String(agent).slice(0, 80) };
    push();
    for (const listener of profileListeners) listener(key, profile);
    return true;
  }
  /** まだ覚えていない会話のプロフィールをサーバーに引く（画面の会話の切り替え・画面の転送の前） */
  async function ensureProfile(sessionId) {
    const key = sessionId ?? null;
    if (profileOf.has(key) && validProfile(profileOf.get(key))) return profileFor(key);
    let resolved = null;
    try { resolved = await resolveProfile(key); } catch {}
    // 引いている間に別の口（中継の準備・エージェントの切り替え）が決めていれば、そちらを優先する
    if (profileOf.has(key) && validProfile(profileOf.get(key))) return profileFor(key);
    // 設定がまだ届いていない（起動の直後）ときも id は覚える。届くまでは profileFor が既定で見せ、届いたら setProfiles が替える
    profileOf.set(key, validProfile(resolved) ? resolved : defaultId);
    return profileFor(key);
  }
  function info(tab) {
    const c = tab.view.webContents;
    // 読み込みが確定するまで getURL は空なので、頼んだ URL を見せる
    const loaded = c.isDestroyed() ? '' : c.getURL();
    const url = loaded && loaded !== 'about:blank' ? loaded : tab.requested ?? '';
    return {
      id: tab.id, sessionId: tab.sessionId, profile: tab.profile, url,
      title: c.isDestroyed() ? '' : c.getTitle(), loading: !c.isDestroyed() && c.isLoading(),
      canGoBack: !c.isDestroyed() && c.navigationHistory.canGoBack(), canGoForward: !c.isDestroyed() && c.navigationHistory.canGoForward(),
      // 「既定のブラウザーで開く」を押せるか（http・https と、画面が明示して開いた file: の HTML）
      external: !!(externalUrl(url) || externalFile(url, tab)),
    };
  }
  function snapshot() {
    return { tabs: visibleTabs().map(info), current, agent: agents.get(context.sessionId) ?? null, sessionId: context.sessionId, profile: context.profile,
      ...(notice ? { notice } : {}) };
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

  function setupPopupWindow(c, sessionId, agentFromTab, profile) {
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
              // 開いた元のタブ（ポップアップの中から開いたならその窓）の保存領域。ログインのポップアップが別のプロフィールの Cookie で動かないように
              webPreferences: { session: c.session ?? ses, contextIsolation: true, sandbox: true, nodeIntegration: false }
            }
          };
        }
        const open = () => createTab({ url: target, sessionId, profile, select: disposition !== 'background-tab', agentFrom: agentFromTab });
        if (!navigation?.popup(agentFromTab, target, open)) open();
      }
      return { action: 'deny' };
    });
    c.on('did-create-window', (popupWin, details) => {
      popupWin.setMenuBarVisibility?.(false);
      const popupTab = { id: `popup-${nextId++}`, sessionId, webContents: popupWin.webContents };
      navigation?.watch(popupTab);
      if (agentFromTab) navigation?.inherit(agentFromTab, popupTab, details.url);
      setupPopupWindow(popupWin.webContents, sessionId, popupTab, profile);
      const guard = (event, nextUrl) => { if (!navigable(nextUrl)) event.preventDefault(); };
      popupWin.webContents.on('will-navigate', guard);
      popupWin.webContents.on('will-redirect', guard);
    });
  }

  function createTab({ url = '', sessionId = context.sessionId, profile, select = true, agentFrom = null } = {}) {
    // プロフィールを指定しなければ、その会話の今のプロフィール（画面の会話なら画面のもの）
    const use = known(profile) ? profile : (sessionId ?? null) === context.sessionId ? context.profile : profileFor(sessionId);
    const view = new WebContentsView({ webPreferences: { session: sessionFor(use), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    view.setBackgroundColor?.('#ffffff');
    const tab = { id: `t${nextId++}`, view, sessionId: sessionId ?? null, profile: use, blank: !url };
    tabs.set(tab.id, tab); order.push(tab.id);
    const c = view.webContents;
    const navigationTab = { id: tab.id, sessionId: tab.sessionId, webContents: c };
    navigation?.watch(navigationTab);
    if (agentFrom) navigation?.inherit(agentFrom, navigationTab, url);
    setupPopupWindow(c, tab.sessionId, navigationTab, tab.profile);
    // ページから file: や独自のスキームへは移らない
    const guard = (event, next) => { if (!navigable(next) && !(tab.allowFile && next.startsWith('file:'))) event.preventDefault(); };
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
    c.on('destroyed', () => { if (tabs.has(tab.id)) removeTab(tab.id); });
    if (select) { remember(tab); if (isVisible(tab)) current = tab.id; }
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
    // そのタブのプロフィールの保存領域を消す（別のプロフィールのタブで押して既定のログインを消さない）
    const s = tab.view.webContents.session ?? sessionFor(tab.profile);
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

  /** プロフィールのログインとデータを全部消す（設定の「ログインとデータを消す」）。開いているそのプロフィールのタブは読み直す */
  async function clearProfile(profile) {
    if (!known(profile)) return false;
    const s = sessionFor(profile);
    await s.clearStorageData?.().catch(() => {});
    await s.clearCache?.().catch(() => {});
    await s.clearAuthCache?.().catch(() => {});
    for (const tab of tabs.values()) if (tab.profile === profile && !tab.blank && !tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    return true;
  }
  /** プロフィールを消す: そのタブを閉じ、保存領域を空にし、ディレクトリは次の起動で消す。そのプロフィールを使っていた会話は既定へ戻る */
  async function deleteProfile(profile) {
    if (!validProfile(profile) || profile === MAIN_PROFILE) return false;
    for (const tab of [...tabs.values()]) if (tab.profile === profile) removeTab(tab.id);
    if (sessions.has(profile)) {
      const s = sessions.get(profile);
      await s.clearStorageData?.().catch(() => {});
      await s.clearCache?.().catch(() => {});
      sessions.delete(profile);
    }
    queueRemoval(profile);
    profileIds = profileIds.filter(id => id !== profile);
    if (defaultId === profile) defaultId = MAIN_PROFILE;
    for (const [key, value] of [...profileOf]) if (value === profile) setProfileFor(key, defaultId);
    if (context.profile === profile) { context = { ...context, profile: profileFor(context.sessionId) }; pickForContext(); place(); }
    push();
    return true;
  }
  /** プロフィールごとの保存領域の大きさ（バイト）。設定の一覧に出す */
  async function profileSizes() {
    const dir = userDataDir();
    const out = {};
    for (const id of profileIds) out[id] = dir ? await directorySize(path.join(dir, 'Partitions', partitionDir(id))) : 0;
    return out;
  }

  async function command(action, args = {}) {
    const tab = args.id ? tabOf(args.id) : currentTab();
    switch (action) {
      case 'state': return snapshot();
      case 'agentStop': agentControl('stop', context.sessionId); return snapshot();
      case 'agentTakeOver': agentControl('takeOver', context.sessionId); return snapshot();
      case 'context': {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : null;
        const seq = ++contextSeq;
        await ensureProfile(sessionId);
        // 引いている間に画面が別の会話へ移っていたら、後から来た方に任せる
        if (seq !== contextSeq) return snapshot();
        context = { sessionId, profile: profileFor(sessionId) };
        pickForContext(); place(); push(); return snapshot();
      }
      // 人がパネルのメニューで今の会話のプロフィールを替える。エージェントが操作中は替えない（1 会話 1 プロフィール。ADR 0078）
      case 'profile': {
        if (!known(args.profile)) throw new Error('unknown-profile');
        if (agents.has(context.sessionId) && args.profile !== context.profile) return { ...snapshot(), error: 'agent-busy' };
        setProfileFor(context.sessionId, args.profile);
        return snapshot();
      }
      case 'profileSizes': return { sizes: await profileSizes() };
      case 'clearProfile': return { ok: await clearProfile(args.profile) };
      case 'deleteProfile': return { ok: await deleteProfile(args.profile) };
      case 'open': {
        if (tab) navigation?.human({ id: tab.id }, true);
        const url = openable(args.url);
        if (!url) throw new Error('invalid-url');
        if (!tab || args.newTab) createTab({ url });
        else { current = tab.id; remember(tab); load(tab, url); }
        push(); return snapshot();
      }
      case 'newTab': createTab({}); return snapshot();
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
        // 重なりの間に今のタブが替わった（プロフィールの切り替えなど）ときは、窓から外れている今のタブを写す。描かれていなければ写しは出さない
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
    // 中継と画面の転送には、その会話の今のプロフィールのタブだけを見せる（エージェントにほかのプロフィールのタブは見えない）
    tabsFor: sessionId => { const profile = profileFor(sessionId); return order.map(id => tabs.get(id)).filter(tab => tab.sessionId === sessionId && tab.profile === profile).map(tab => ({ id: tab.id, profile: tab.profile, webContents: tab.view.webContents })); },
    contentsOf: id => tabs.get(id)?.view.webContents ?? null,
    createFor: (sessionId, url = '') => { const tab = createTab({ sessionId, profile: profileFor(sessionId), url: url || 'about:blank', select: true }); return { id: tab.id, profile: tab.profile, webContents: tab.view.webContents }; },
    profileOfTab: id => tabs.get(id)?.profile ?? null,
    // ---- プロフィール（ADR 0078）。setProfiles はサーバーの設定（使える id と既定）、setProfileFor は会話の今のプロフィール
    setProfiles: ({ ids, defaultProfile } = {}) => {
      const next = Array.isArray(ids) ? ids.filter(validProfile) : [];
      profileIds = next.includes(MAIN_PROFILE) ? next : [MAIN_PROFILE, ...next];
      defaultId = known(defaultProfile) ? defaultProfile : MAIN_PROFILE;
      // 画面の会話のプロフィールを見直す（消えたものは既定、設定が届いて分かったものはその id）
      const shownProfile = profileFor(context.sessionId);
      if (shownProfile !== context.profile) { context = { ...context, profile: shownProfile }; pickForContext(); place(); push(); }
    },
    setProfileFor, ensureProfile, profileFor,
    onProfileChanged: listener => { profileListeners.add(listener); return () => profileListeners.delete(listener); },
    selectFor: id => { const tab = tabs.get(id); if (!tab) return; remember(tab); if (isVisible(tab)) { current = id; place(); } push(); },
    closeFor: id => removeTab(id),
    rebindSession: (from, to) => {
      for (const tab of tabs.values()) if (tab.sessionId === from) tab.sessionId = to;
      for (const [key, id] of [...selected]) {
        if (!key.startsWith(`${from ?? ''}\u0000`)) continue;
        const moved = selectKey(to, key.slice(key.indexOf('\u0000') + 1));
        if (!selected.has(moved)) selected.set(moved, id);
        selected.delete(key);
      }
      if (profileOf.has(from)) { if (!profileOf.has(to)) profileOf.set(to, profileOf.get(from)); profileOf.delete(from); }
      reconcile(); place();
      if (agents.has(from)) { const active = agents.get(from); agents.delete(from); agents.set(to, { ...active, sessionId: to }); }
      push();
    },
    onTabsChanged: listener => { tabListeners.add(listener); return () => tabListeners.delete(listener); },
    setAgent: (sessionId, tabId) => {
      const before = agents.get(sessionId)?.tabId ?? null;
      if (tabId) agents.set(sessionId, { sessionId, tabId }); else agents.delete(sessionId);
      if (tabId && tabs.has(tabId)) selected.set(selectKey(sessionId, tabs.get(tabId).profile), tabId);
      if (tabId && context.sessionId === sessionId && tabs.has(tabId)) { current = tabId; place(); }
      push();
      if (before !== (tabId ?? null)) for (const listener of agentListeners) listener(sessionId);
    },
    // ---- リモートの端末から見る（desktop/browser-screencast.cjs）
    agentFor: sessionId => agents.get(sessionId) ?? null,
    onAgentChanged: listener => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
    pin: (id, on) => { if (on && tabs.has(id)) pinned.add(id); else pinned.delete(id); place(); },
    human: id => navigation?.human({ id }, true),
    // メインのプロフィールの session（テストと、プロフィールを持たない呼び出し元のため）。プロフィールごとは sessionFor
    session: ses,
    sessionFor,
  };
}

module.exports = { createBrowserPanel, PARTITION, MAIN_PROFILE, partitionOf, partitionDir, directorySize, openable, navigable, externalUrl, externalFile, cleanRect, plainUserAgent, uniquePath, isPanelShortcut };
