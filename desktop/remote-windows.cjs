// デスクトップ版の端末（docs/remote.md §7。issue #14）。main プロセスで動く。
//   - ほかのホストにつなぐ窓（アプリに同梱の desktop/remote-hosts.html）: ペアリングしたホストの一覧と、貼り付けでのペアリング
//   - リモートの窓: ホストごとに 1 枚。端末内プロキシ（core/remote/device-proxy.mjs）から画面を読む。
//     保存領域はホストごとの session（persist:remote-<hostId>）。ポートはホストごとに覚える（device.mjs の hosts.json）
//   - リモートの印: 画面の帯のバッジ（preload の plyRemote を見て web/ が描く。差しの青の字）、
//     OS の窓タイトル（Pleiad — リモート: <ホスト>）とタスクバーの重ねアイコン。帯は塗らない（2026-09-23 から。
//     ローカルの窓と同じ脇の面で、色は画面が ply:remote-title-bar で送ってくる）
//   - 同じ PC を前提にしたブリッジ（フォルダーの選択・更新）はリモートの窓に出さない（desktop/remote-preload.cjs）
// リモートの窓を閉じてもホストでは何も止めない（端末内プロキシを閉じるだけ。確認も出さない）。
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { t, bundle } = require('./i18n.cjs');
const { createDesktopNotifications } = require('./notifications.cjs');
const { originOf } = require('./window-trust.cjs');
const { stableLauncher } = require('./msix.cjs');

const HOST_ID = /^[a-z2-7]{26}$/;
const TITLE_BAR_HEIGHT = 40;   // desktop/main.cjs と web/style.css の --bar-h と同じ
// リモートの窓の帯（web/tokens.css の --surface-0 と --ink。ローカルの窓の desktop/main.cjs と同じ）。画面が色を送ってくるまでの一瞬に使う
const REMOTE_BAR = { light: { color: '#eceef4', symbolColor: '#1c2247' }, dark: { color: '#121318', symbolColor: '#dfe3f2' } };
const HOSTS_ARG = '--remote-hosts';
const REMOTE_ARG = '--ply-remote=';

// ---------------------------------------------------------------- 純粋な部品（tests/unit/desktop-remote.mjs）

/** ホストごとの保存領域。hostId の形を確かめてから作る（partition の名前に変なものを入れない） */
function partitionFor(hostId) {
  if (!HOST_ID.test(String(hostId))) throw new Error('invalid hostId');
  return `persist:remote-${hostId}`;
}

/** 一覧・バッジ・タイトルに出す名前。利用者が付けた名前 → ホストの名乗り → hostId の頭 */
function displayName(rec) {
  return String(rec?.label || rec?.hostName || String(rec?.hostId ?? '').slice(0, 8));
}

/** 中継の URL から、面に出す部分（ホスト名とポート）だけ */
function relayLabel(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/** 確認コード 482193 → 「482 193」（docs/remote.md §3.2） */
function formatCode(code) {
  const s = String(code ?? '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** 画面が送ってきた帯の色。#rrggbb の 2 つだけ通す */
function validTitleBarColors(colors) {
  const hex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  return hex(colors?.color) && hex(colors?.symbolColor) ? { color: colors.color, symbolColor: colors.symbolColor } : null;
}

/** preload へ渡す引数（sandbox の preload は process.argv だけ読める）。秘密は入れない */
function encodeRemoteArg(info) {
  const { hostId, hostName, relay, device } = info;
  return REMOTE_ARG + encodeURIComponent(JSON.stringify({ hostId, hostName, relay, device, shell: 'desktop' }));
}
function decodeRemoteArg(argv) {
  const arg = (argv ?? []).find(a => typeof a === 'string' && a.startsWith(REMOTE_ARG));
  if (!arg) return null;
  try {
    const v = JSON.parse(decodeURIComponent(arg.slice(REMOTE_ARG.length)));
    return HOST_ID.test(v?.hostId) ? v : null;
  } catch { return null; }
}

/** 画面へ渡す接続の状態（トークン・URL は入れない） */
function publicStatus(status, connectedAt = null) {
  if (!status) return { state: 'connecting', since: null, retryAt: null, connectedAt };
  return { state: status.state, since: status.since ?? null, retryAt: status.retryAt ?? null, connectedAt,
    ...(status.hostName ? { hostName: status.hostName } : {}) };
}

/** ほかのホストにつなぐ窓の一覧の 1 行。device.list() の行から、秘密でも内部でもないものだけ */
function hostRow(rec, { windowOpen = false } = {}) {
  return { hostId: rec.hostId, name: displayName(rec), hostName: rec.hostName ?? '', label: rec.label ?? '',
    relay: relayLabel(rec.relayUrl), state: rec.revokedAt && rec.state !== 'connected' ? 'revoked' : rec.state ?? 'closed',
    lastConnectedAt: rec.lastConnectedAt ?? null, pairedAt: rec.pairedAt ?? null, windowOpen,
    // この PC の AI から任せる（docs/remote.md §4.5）: 端末側のスイッチと、ホスト側の許可（線がつながっているときの ready の allowed）
    agentUse: rec.agentUse === true, agentAllowed: rec.agent?.allowed === true, agentState: rec.agent?.state ?? 'offline' };
}

const SNAPSHOT_PATH = '/visualization-snapshot';
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** localhost・ループバック。WHATWG の URL が正規化した hostname（IPv6 は [] 付き）を受ける */
function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || LOOPBACK_V4.test(h) || h === '0.0.0.0'
    || h === '::1' || h === '::' || h.startsWith('::ffff:127.') || h.startsWith('::ffff:7f');
}

/**
 * リモートの窓で押したリンクの行き先（docs/remote.md §8.5。Android の LinkPolicy、web/host-only-links.mjs と同じ規則）。
 *   'snapshot'  この窓のプロキシの /visualization-snapshot。プロキシの Cookie はこの窓の保存領域にしか無いので、アプリの中の窓で開く
 *   'external'  Web のページ。この PC の既定のブラウザー
 *   'host-only' localhost。ホストの PC を指すが、ここで開くとこの PC を指してしまう（画面が知らせる）
 *   'blocked'   それ以外（ほかのスキーム・URL の中の資格情報・プロキシのほかのページ）
 */
function linkTarget(url, origin) {
  let u;
  try { u = new URL(url); } catch { return 'blocked'; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return 'blocked';
  if (u.origin === origin) return u.pathname === SNAPSHOT_PATH ? 'snapshot' : 'blocked';
  return isLoopbackHost(u.hostname) ? 'host-only' : 'external';
}

/** 起動の引数に「ほかのホストにつなぐ窓を開く」（Windows のジャンプリスト）があるか */
const wantsHostsWindow = argv => Array.isArray(argv) && argv.includes(HOSTS_ARG);

/**
 * タスクバーの重ねアイコン（⇄）の BGRA。明るい丸の上に塗りの色の矢印 2 本（web/icons の ⇄ と同じ線）。
 * 画像のファイルを持たず、ここで描く（大きさを変えても滲まない）。premultiplied alpha
 */
function drawOverlayBitmap(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 32, c = size / 2, r = 15 * s;
  const ring = [0xf4, 0xf5, 0xff], ink = [0x3a, 0x49, 0x9e];
  // 24 の升の線（M4 8h13l-3-3 M20 16H7l3 3）を丸の中へ
  const map = ([x, y]) => [(x - 12) * 1.1 * s + c, (y - 12) * 1.1 * s + c];
  const segs = [[[4, 8], [17, 8]], [[17, 8], [14, 5]], [[20, 16], [7, 16]], [[7, 16], [10, 19]]].map(([a, b]) => [map(a), map(b)]);
  const half = 1.3 * s;
  const dist = (px, py, [[ax, ay], [bx, by]]) => {
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const k = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
    return Math.hypot(px - ax - k * dx, py - ay - k * dy);
  };
  const clamp = v => Math.max(0, Math.min(1, v));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x + 0.5, py = y + 0.5;
    const disc = clamp(r + 0.5 - Math.hypot(px - c, py - c));
    if (!disc) continue;
    const line = clamp(half + 0.5 - Math.min(...segs.map(g => dist(px, py, g))));
    const rgb = ring.map((v, i) => v * (1 - line) + ink[i] * line);
    const o = (y * size + x) * 4;
    buf[o] = Math.round(rgb[2] * disc); buf[o + 1] = Math.round(rgb[1] * disc); buf[o + 2] = Math.round(rgb[0] * disc); buf[o + 3] = Math.round(255 * disc);
  }
  return buf;
}

// ---------------------------------------------------------------- 窓とプロキシ

/**
 * deps: Electron の部品（app, BrowserWindow, session, ipcMain, nativeImage, nativeTheme, Notification, Menu, safeStorage）と、
 *   trust（desktop/window-trust.cjs）、icon（窓のアイコン）、external（https を既定のブラウザーで開く）、
 *   shell（省けば electron の shell。リモートの窓のリンクを http も含めて既定のブラウザーで開く）
 */
function createRemoteWindows(deps) {
  const { app, BrowserWindow, session, ipcMain, nativeImage, nativeTheme, Notification, Menu, safeStorage, trust, icon, external } = deps;
  const platform = deps.platform ?? process.platform;
  const shell = () => deps.shell ?? require('electron').shell;
  const windows = new Map();       // hostId -> { win, name, origin, notify, state }
  const opening = new Map();       // hostId -> Promise（2 度押しで 2 枚開かない）
  const connectedAt = new Map();   // hostId -> 最後につながった時刻（ms）
  let devicePromise = null, hostsWindow = null, pairing = null, pushTimer = null, agentBridge = null;

  function device() {
    devicePromise ??= (async () => {
      const { createRemoteDevice } = await import(pathToFileURL(path.join(__dirname, '..', 'core', 'remote', 'device.mjs')).href);
      const { safeStorageCipher } = require('./secret-bridge.cjs');
      // 開発版と配布版が同時に動いても、互いの資格情報とポートの記録を取り合わないよう分ける（server-port.cjs と同じ）
      const d = createRemoteDevice({
        dir: path.join(app.getPath('userData'), app.isPackaged ? 'remote-hosts' : 'remote-hosts-dev'),
        cipher: safeStorageCipher({ safeStorage, platform }), app: app.getVersion(), name: os.hostname(), platform: 'desktop',
      });
      d.on('status', onStatus);
      d.on('agent-state', pushHosts);
      return d;
    })();
    devicePromise.catch(() => { devicePromise = null; });
    return devicePromise;
  }

  function onStatus(s) {
    if (s.state === 'connected') connectedAt.set(s.hostId, Date.now());
    const entry = windows.get(s.hostId);
    if (entry && !entry.win.isDestroyed()) {
      const before = entry.state;
      entry.state = s.state;
      entry.win.webContents.send('ply:remote-status-changed', publicStatus(s, connectedAt.get(s.hostId) ?? null));
      // 取り消されたら張り直さない。画面は /ws を叩き続けるだけになるので、読み直してプロキシの案内（取り消されました）を出す
      if (s.state === 'revoked' && before !== 'revoked') entry.win.webContents.reload();
    }
    pushHosts();
  }

  /** ほかのホストにつなぐ窓へ一覧を送り直す（状態の変化はまとめて） */
  function pushHosts() {
    if (!hostsWindow || hostsWindow.isDestroyed() || pushTimer) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      try { if (hostsWindow && !hostsWindow.isDestroyed()) hostsWindow.webContents.send('ply:hosts-changed', await listHosts()); } catch {}
    }, 150);
  }

  async function listHosts() {
    const d = await device();
    return (await d.list()).map(rec => hostRow(rec, { windowOpen: windows.has(rec.hostId) }));
  }

  function remoteBar() {
    if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } };
    return { titleBarStyle: 'hidden', titleBarOverlay: { ...REMOTE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'], height: TITLE_BAR_HEIGHT } };
  }

  function setOverlay(win) {
    if (platform !== 'win32' || !nativeImage) return;
    try { win.setOverlayIcon(nativeImage.createFromBitmap(drawOverlayBitmap(32), { width: 32, height: 32 }), t('remote.overlay')); } catch {}
  }

  function focus(win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

  /** sessionId を渡すと、その会話を開く（承認の中継のカードの「子の会話を見る」。docs/remote.md §4.5）。開いている窓へは IPC、新しい窓は URL の ?open= */
  async function openHost(hostId, { sessionId = null } = {}) {
    if (!HOST_ID.test(String(hostId))) throw Object.assign(new Error(t('remote.hosts.unknown')), { code: 'unknown-host' });
    const wanted = typeof sessionId === 'string' && sessionId && sessionId.length <= 200 ? sessionId : null;
    const existing = windows.get(hostId);
    if (existing && !existing.win.isDestroyed()) {
      focus(existing.win);
      if (wanted) existing.win.webContents.send('ply:remote-open-session', wanted);
      return;
    }
    if (opening.has(hostId)) return opening.get(hostId);
    const run = createHostWindow(hostId, wanted).finally(() => opening.delete(hostId));
    opening.set(hostId, run);
    return run;
  }

  async function createHostWindow(hostId, sessionId = null) {
    const d = await device();
    const rec = (await d.list()).find(h => h.hostId === hostId);
    if (!rec) throw Object.assign(new Error(t('remote.hosts.unknown')), { code: 'unknown-host' });
    const proxy = await d.open(hostId);
    const name = displayName(rec);
    const origin = `http://127.0.0.1:${proxy.port}`;
    const ses = session.fromPartition(partitionFor(hostId));
    // 権限は断るのが基本。コピーのボタン（clipboard-sanitized-write）だけ、このホストの画面の本体に通す（main.cjs と同じ）
    // 写しの窓（openSnapshot）は同じ保存領域・同じ URL のオリジンなので、窓そのものでも確かめる
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      let own = false;
      try { own = details.isMainFrame && contents === windows.get(hostId)?.win.webContents && originOf(details.requestingUrl) === windows.get(hostId)?.origin; } catch {}
      callback(permission === 'clipboard-sanitized-write' && own);
    });
    const win = new BrowserWindow({
      width: 1200, height: 850, minWidth: 640, minHeight: 480, title: t('remote.windowTitle', { host: name }), icon, show: false,
      backgroundColor: REMOTE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].color,
      ...remoteBar(),
      webPreferences: {
        preload: path.join(__dirname, 'remote-preload.cjs'), session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true,
        additionalArguments: [encodeRemoteArg({ hostId, hostName: name, relay: relayLabel(rec.relayUrl), device: os.hostname() })],
      },
    });
    win.removeMenu();
    trust.register(win, { kind: 'remote', origin, hostId });
    const entry = { win, name, origin, state: proxy.status?.state, snapshots: new Set(),
      notify: createDesktopNotifications({ Notification, getWindow: () => win, icon }) };
    windows.set(hostId, entry);
    // 画面の <title> ではなく、どのホストかが分かる名前を OS に出す（§7.2 の 3）
    win.on('page-title-updated', event => event.preventDefault());
    // 新しい窓は開かせず、行き先で振り分ける（linkTarget）。localhost は画面が知らせる（web/host-only-links.mjs）
    win.webContents.setWindowOpenHandler(({ url }) => {
      const kind = linkTarget(url, entry.origin);
      if (kind === 'snapshot') openSnapshot(entry, ses, url);
      else if (kind === 'external') openOutside(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (originOf(url) === entry.origin) return;
      event.preventDefault();
      if (linkTarget(url, entry.origin) === 'external') openOutside(url);
    });
    win.once('ready-to-show', () => { setOverlay(win); win.show(); });
    win.on('closed', () => {
      for (const s of entry.snapshots) if (!s.isDestroyed()) s.close();
      windows.delete(hostId);
      d.close(hostId).catch(() => {});   // 手元のプロキシを閉じるだけ。ホストの作業は止めない
      pushHosts();
    });
    pushHosts();
    try { await win.loadURL(sessionId ? `${proxy.url}&open=${encodeURIComponent(sessionId)}` : proxy.url); } catch { /* 読み込みの失敗（中断など）でも窓は出す。案内はプロキシが返す */ }
    if (!win.isDestroyed()) { setOverlay(win); focus(win); }
  }

  /** リモートの窓のリンクを、この PC の既定のブラウザーで（http も。linkTarget が 'external' と決めたものだけ来る） */
  function openOutside(url) {
    try { shell().openExternal(new URL(url).href).catch(() => {}); } catch {}
  }

  /**
   * 可視化の写し（「ブラウザーで開く」）を、リモートの窓と同じ保存領域の窓で開く。既定のブラウザーにはプロキシの Cookie が無く 401 になる。
   * preload は入れない（plyRemote もブリッジも無い）。写しはホストが sandbox の CSP で返すので、不透明なオリジンで動く（docs/visualize.md）。
   * 中のリンクは写しの窓では開かず、行き先で振り分ける
   */
  function openSnapshot(entry, ses, url) {
    const child = new BrowserWindow({
      width: 1000, height: 760, minWidth: 320, minHeight: 240, icon, autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c23' : '#ffffff',
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    child.removeMenu();
    entry.snapshots.add(child);
    child.on('closed', () => entry.snapshots.delete(child));
    const route = to => { if (linkTarget(to, entry.origin) === 'external') openOutside(to); };
    child.webContents.setWindowOpenHandler(({ url: to }) => { route(to); return { action: 'deny' }; });
    child.webContents.on('will-navigate', (event, to) => { event.preventDefault(); route(to); });
    child.loadURL(url).catch(() => {});
  }

  function openHostsWindow() {
    if (hostsWindow && !hostsWindow.isDestroyed()) { focus(hostsWindow); return; }
    const file = path.join(__dirname, 'remote-hosts.html');
    const dark = nativeTheme.shouldUseDarkColors;
    const win = hostsWindow = new BrowserWindow({
      width: 560, height: 680, minWidth: 360, minHeight: 420, title: t('remote.hosts.windowTitle'), icon, show: false,
      backgroundColor: dark ? '#121318' : '#eceef4',
      webPreferences: { preload: path.join(__dirname, 'remote-hosts-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.removeMenu();
    trust.register(win, { kind: 'hosts', origin: pathToFileURL(file).href });
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { event.preventDefault(); external(url); });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { if (hostsWindow === win) hostsWindow = null; pairing?.abort(); pairing = null; });
    win.loadFile(file).catch(() => {});
  }

  const fail = e => ({ ok: false, code: e?.code ?? 'error', message: String(e?.message ?? e) });

  function attach() {
    // ---- ローカルの窓から
    ipcMain.handle('ply:open-remote-hosts', event => { trust.check(event, ['local']); openHostsWindow(); });
    // 承認の中継のカードの「子の会話を見る」: そのホストのリモートの窓で、ホストの子の会話を開く（見るための補助。docs/remote.md §4.5）
    ipcMain.handle('ply:open-remote-session', async (event, hostId, sessionId) => {
      trust.check(event, ['local']);
      try { await openHost(hostId, { sessionId }); return { ok: true }; } catch (e) { return fail(e); }
    });

    // ---- リモートの窓から（同じ PC のブリッジは無い。帯・通知・接続の状態だけ）
    ipcMain.on('ply:remote-title-bar', (event, colors) => {
      const entry = trust.find(event, ['remote']);
      const valid = validTitleBarColors(colors);
      if (!entry || !valid || platform === 'darwin' || entry.window.isDestroyed()) return;
      entry.window.setTitleBarOverlay({ ...valid, height: TITLE_BAR_HEIGHT });
    });
    ipcMain.handle('ply:remote-notify-completion', (event, notice) => {
      const { hostId } = trust.check(event, ['remote']);
      const w = windows.get(hostId);
      if (!w || !notice || typeof notice.body !== 'string') return false;
      return w.notify({ ...notice, body: t('remote.notifyBody', { host: w.name, body: notice.body }) });
    });
    ipcMain.handle('ply:remote-status', async event => {
      const { hostId } = trust.check(event, ['remote']);
      const px = await (await device()).proxy(hostId);
      return publicStatus(px?.status, connectedAt.get(hostId) ?? null);
    });
    ipcMain.handle('ply:remote-retry', async event => {
      const { hostId } = trust.check(event, ['remote']);
      (await (await device()).proxy(hostId))?.retryNow();
    });
    ipcMain.on('ply:remote-close', event => { trust.find(event, ['remote'])?.window.close(); });

    // ---- ほかのホストにつなぐ窓から
    ipcMain.handle('ply:hosts-init', async event => {
      trust.check(event, ['hosts']);
      try {
        const d = await device();
        const storage = await d.store.storageStatus().catch(() => ({ encrypted: false }));
        return { ok: true, ...bundle(), platform, deviceName: os.hostname(), encrypted: Boolean(storage.encrypted), hosts: await listHosts() };
      } catch (e) { return { ...fail(e), ...bundle(), platform }; }
    });
    ipcMain.handle('ply:hosts-list', async event => {
      trust.check(event, ['hosts']);
      try { return { ok: true, hosts: await listHosts() }; } catch (e) { return fail(e); }
    });
    ipcMain.handle('ply:hosts-pair', async (event, payload) => {
      trust.check(event, ['hosts']);
      pairing?.abort();
      const ctl = pairing = new AbortController();
      const sender = event.sender;
      try {
        const d = await device();
        const rec = await d.pair(String(payload ?? '').trim(), { signal: ctl.signal,
          onCode: code => { if (!sender.isDestroyed()) sender.send('ply:hosts-code', formatCode(code)); } });
        pushHosts();
        return { ok: true, host: hostRow({ ...rec, state: 'closed' }) };
      } catch (e) { return fail(e); }
      finally { if (pairing === ctl) pairing = null; }
    });
    ipcMain.handle('ply:hosts-pair-cancel', event => { trust.check(event, ['hosts']); pairing?.abort(); pairing = null; });
    ipcMain.handle('ply:hosts-open', async (event, hostId) => {
      trust.check(event, ['hosts']);
      try { await openHost(hostId); return { ok: true }; } catch (e) { return fail(e); }
    });
    ipcMain.handle('ply:hosts-rename', async (event, hostId, label) => {
      trust.check(event, ['hosts']);
      try {
        await (await device()).rename(hostId, String(label ?? ''));
        const w = windows.get(hostId);
        if (w && !w.win.isDestroyed()) {
          const rec = (await (await device()).list()).find(h => h.hostId === hostId);
          w.name = displayName(rec); w.win.setTitle(t('remote.windowTitle', { host: w.name }));
        }
        pushHosts();
        return { ok: true };
      } catch (e) { return fail(e); }
    });
    // この PC の AI からそのホストへ任せるか（人だけが変えられる。ローカルのサーバーの設定・AI の操作の一覧には置かない。remote.md §4.5）
    ipcMain.handle('ply:hosts-agent-use', async (event, hostId, enabled) => {
      trust.check(event, ['hosts']);
      try {
        if (!HOST_ID.test(String(hostId))) throw Object.assign(new Error(t('remote.hosts.unknown')), { code: 'unknown-host' });
        await (await device()).setAgentUse(hostId, enabled === true);
        await agentBridge?.refresh();
        pushHosts();
        return { ok: true };
      } catch (e) { return fail(e); }
    });
    ipcMain.handle('ply:hosts-remove', async (event, hostId) => {
      trust.check(event, ['hosts']);
      try {
        windows.get(hostId)?.win.close();
        await (await device()).remove(hostId);
        await agentBridge?.refresh();
        pushHosts();
        return { ok: true };
      } catch (e) { return fail(e); }
    });

    // リモートの窓のタイトルは言語が決まってから付けるので、ここで OS の入口（ジャンプリスト・Dock）も作る
    try {
      if (platform === 'win32') {
        // Microsoft Store の版は App Execution Alias から起こす（パッケージの中の実行ファイルを直に起こすと識別子が付かない。desktop/msix.cjs）
        app.setUserTasks([{ program: stableLauncher(), arguments: app.isPackaged ? HOSTS_ARG : `"${app.getAppPath()}" ${HOSTS_ARG}`,
          title: t('remote.hosts.jumpTask'), description: t('remote.hosts.jumpTaskDescription'), iconPath: process.execPath, iconIndex: 0 }]);
      }
      if (platform === 'darwin' && app.dock && Menu) app.dock.setMenu(Menu.buildFromTemplate([{ label: t('remote.hosts.jumpTask'), click: openHostsWindow }]));
    } catch {}
    app.on('will-quit', () => { devicePromise?.then(d => d.closeAll()).catch(() => {}); });
  }

  /** 2 つ目の起動（ジャンプリスト）や最初の起動の引数。扱ったら true */
  function handleArgv(argv) {
    if (!wantsHostsWindow(argv)) return false;
    openHostsWindow();
    return true;
  }

  /** ローカルのサーバー（utilityProcess）との橋。この PC の AI がホストへ任せる口（remote.md §4.5） */
  function attachWorker(worker) {
    const { attachRemoteAgentBridge } = require('./remote-agent-bridge.cjs');
    agentBridge = attachRemoteAgentBridge(worker, { getDevice: device, log: line => console.warn('[remote-agent]', line) });
    // agentUse のホストへ線を張り、一覧をサーバーへ送る（サーバーはこの便りで「任せられるホスト」を知る）
    agentBridge.refresh();
    return agentBridge;
  }

  return { attach, attachWorker, openHostsWindow, openHost, handleArgv, listHosts, windows };
}

module.exports = {
  createRemoteWindows, partitionFor, displayName, relayLabel, formatCode, validTitleBarColors, encodeRemoteArg, decodeRemoteArg,
  publicStatus, hostRow, wantsHostsWindow, drawOverlayBitmap, linkTarget, isLoopbackHost, REMOTE_BAR, HOSTS_ARG,
};
