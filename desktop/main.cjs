const { app, BrowserWindow, WebContentsView, utilityProcess, shell, dialog, ipcMain, Notification, nativeTheme, safeStorage, session, nativeImage, Menu, screen, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Updates, isStoreBuild, updaterEnabled } = require('./updates.cjs');
const { packagedIdentity } = require('./msix.cjs');
const { prepareUpdateCheck } = require('./update-auth.cjs');
const { createUpdateLog } = require('./update-log.cjs');
const { savedPort, rememberPort } = require('./server-port.cjs');
const { attachSecretBridge } = require('./secret-bridge.cjs');
const { t, setLocale, resolveLocale, initDesktopI18n } = require('./i18n.cjs');
const { attachFileBridge } = require('./file-bridge.cjs');
// ホストとして常駐する（リモートが有効な間、窓を閉じてもトレイに残す・スリープを防ぐ。docs/remote.md §6.3）
const { attachResident } = require('./resident.cjs');
let resident;
// 窓ごとのオリジンの表と、ほかのホストへつなぐ端末の窓（docs/remote.md §7。desktop/remote-windows.cjs）
const { createWindowTrust } = require('./window-trust.cjs');
const { createRemoteWindows } = require('./remote-windows.cjs');
// 内蔵ブラウザー（右パネルに重ねる WebContentsView。docs/inapp-browser.md、ADR 0041）。ローカルの窓にだけ置く
const { createBrowserPanel } = require('./browser-panel.cjs');
const { attachAgentBrowserBridge } = require('./agent-browser-bridge.cjs');
// リモートの端末から内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」）
const { attachBrowserScreencastBridge } = require('./browser-screencast-bridge.cjs');
const { prepareAgentBrowserBin } = require('./agent-browser-bin.cjs');
// コンピューターの操作（Windows）の Win32 の層: 撮影・入力・アプリの特定（docs/computer-use.md、desktop/computer/service.cjs）
const { attachComputerService } = require('./computer/service.cjs');
let computerService;
let browserPanel;
let agentBrowserBridge;
let browserScreencastBridge;
// コンピューターの操作中のオーバーレイと Esc（docs/computer-use.md、ADR 0073）。画面を撮る・入力する側（desktop/computer）はこの overlay を受け取って使う
const { attachComputerOverlay } = require('./computer-overlay.cjs');
let computerOverlay;
const trust = createWindowTrust();
let remoteWindows;
let worker, window, origin, updates, quitting = false, closing = false, exitInProgress = false;
const nativeExit = app.exit.bind(app);
app.exit = (...args) => { exitInProgress = true; return nativeExit(...args); };
function showFatalError(title, message) {
  const options = { type: 'error', title, message };
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}
let requestId = 0;
const { createDesktopNotifications } = require('./notifications.cjs');
const notifyCompletion = createDesktopNotifications({ Notification, getWindow: () => window, icon: path.join(__dirname, 'icon.png') });
// electron-builder.yml の appId と、スタートメニューのショートカットの AUMID（build/installer.nsh）に揃える。
// 開発起動（electron.exe）が同じ ID で「Electron」としてシェルに覚えられないよう、別の ID にする
const APP_USER_MODEL_ID = app.isPackaged ? 'jp.ply.desktop' : 'jp.ply.desktop.dev';
// Microsoft Store の MSIX として動くときは、Windows がパッケージの AUMID（<パッケージファミリー名>!Pleiad）を付ける。
// jp.ply.desktop を付けると、窓がスタートメニューのタイルとは別のアプリとしてタスクバーに並ぶ（docs/microsoft-store.md）
const PACKAGED_IDENTITY = packagedIdentity();
if (process.platform === 'win32' && !PACKAGED_IDENTITY) app.setAppUserModelId(APP_USER_MODEL_ID);

// ローカルの窓の本体フレームで、ローカルのサーバーの画面からの IPC だけを通す（リモートの窓・同梱の窓は別の口）
function trusted(event) { trust.check(event, ['local']); }
function workerRequest(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const done = message => {
      if (message.type !== type || message.id !== id) return;
      clearTimeout(timer); worker.off('message', done); resolve(message);
    };
    const timer = setTimeout(() => { worker.off('message', done); reject(new Error(t('errors.runningCheckFailed'))); }, 10000);
    worker.on('message', done); worker.postMessage({ ...extra, type, id });
  });
}

/** 実行中の作業（core/server.mjs の runningWork）。10 秒で答えが無ければ失敗 */
function runningWork() {
  return new Promise((resolve, reject) => {
    const onMessage = message => { if (message.type === 'running') { clearTimeout(timer); worker.off('message', onMessage); resolve(message.work); } };
    const timer = setTimeout(() => { worker.off('message', onMessage); reject(new Error(t('quit.checkFailed'))); }, 10_000);
    worker.on('message', onMessage); worker.postMessage({ type: 'running' });
  });
}

// 「中断して終了」で作業が止まり終えるのを待つ上限（画面の「中断して更新」と同じ 30 秒。docs/desktop-releases.md）
const ABORT_WAIT_MS = 30_000;
/**
 * 全部の作業を reason 付きで中断し、実行中の数が 0 になるまで待つ。止まった会話は中断として残り、次の起動で「再開」できる。
 * 待つ間に始まったターン（別の端末からの送信・委譲の完了の届け・送信待ち）も止めるため、残っている間は見るたびに
 * 中断を送り直す（止め始めたものには何もしない。理由も最初のまま）。上限までに止まらなければ、残っている数を理由にして失敗する（終了しない）
 */
async function abortAll(reason) {
  const until = Date.now() + ABORT_WAIT_MS;
  for (;;) {
    const result = await workerRequest('abort', { reason });
    if (result.error) throw new Error(result.error);
    const work = await runningWork();
    if (work.count === 0) return;
    if (Date.now() >= until) throw new Error(t('quit.abortTimeout', { count: work.count, seconds: ABORT_WAIT_MS / 1000 }));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function installUpdate() {
  try {
    const lock = await workerRequest('update-lock');
    if (!lock.ok) throw new Error(t('update.blocked', { reason: lock.reason }));
    // The renderer flushes drafts before invoking this operation. The lease now
    // rejects new server commands until shutdown, eliminating the idle-check race.
    const updater = require('electron-updater').autoUpdater;
    const native = require('electron').autoUpdater;
    await new Promise((resolve, reject) => {
      const before = new Set(native.listeners('update-downloaded'));
      const cleanup = () => { updater.off('error', failed); native.off('before-quit-for-update', ready); };
      const failed = () => {
        cleanup();
        // MacUpdater registers an install callback while Squirrel stages the ZIP.
        // Remove that callback after failure so a late event cannot quit the app.
        for (const listener of native.listeners('update-downloaded')) if (!before.has(listener)) native.off('update-downloaded', listener);
        reject(new Error(t('update.applyFailed')));
      };
      const ready = () => { cleanup(); quitting = true; worker.postMessage({ type: 'shutdown' }); resolve(); };
      updater.once('error', failed); native.once('before-quit-for-update', ready);
      // Windows はインストーラーの進捗バーだけを出して適用し、終わったら起動し直す。
      // 入れ先とインストールの種類は前回を引き継ぎ、選択と完了の画面は出さない（build/installer.nsh）
      try { updater.quitAndInstall(false, true); } catch { failed(); }
    });
  } catch (e) {
    quitting = false; worker.postMessage({ type: 'update-unlock' }); throw e;
  }
}

function external(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && !u.username && !u.password) shell.openExternal(u.href).catch(() => {});
  } catch {}
}

// 窓の上端を脇のパネルと同じ面にする。OS の枠を消し、閉じる・最小化のボタンだけを重ねて残す。
// 高さは脇の見出し行（web/style.css の --bar-h）と揃える。色は画面が決めて ply:title-bar で送ってくる。
// 送られるまでの一瞬は OS の明暗に合わせた脇の色（web/tokens.css の --surface-0 / --ink）で待つ
const TITLE_BAR_HEIGHT = 40;
function titleBarColors() {
  return nativeTheme.shouldUseDarkColors ? { color: '#121318', symbolColor: '#dfe3f2' } : { color: '#eceef4', symbolColor: '#1c2247' };
}
function titleBar() {
  // macOS は信号の 3 つを見出し行の縦の中央へ。ボタンの色は OS が決めるので重ねる面は要らない
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } };
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...titleBarColors(), height: TITLE_BAR_HEIGHT } };
}

/** OS の表示言語（例 ja-JP）。優先言語の先頭、取れなければ Electron のロケール */
function systemLanguage() {
  try { return app.getPreferredSystemLanguages()[0] || app.getLocale() || ''; } catch { return ''; }
}

async function boot() {
  // サーバーが起動するまでは、設定（prefs.json）と OS の言語で決める。起動後はサーバーが解決した言語に合わせる（desktop/i18n.cjs）。
  // main の中のリモートの端末側（core/remote/device.mjs）が引く core/i18n.mjs もここで同じ言語にそろえる
  await initDesktopI18n({ systemLanguage: systemLanguage() }).catch(() => setLocale(resolveLocale({ system: systemLanguage() })));
  // 開発版と配布版が同時に動いても互いのポートを奪い合わないよう、記録を分ける
  const portFile = path.join(app.getPath('userData'), app.isPackaged ? 'server-port.json' : 'server-port-dev.json');
  const agentBrowserBin = prepareAgentBrowserBin({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: path.join(__dirname, '..'), dataDir: app.getPath('userData') });
  worker = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
    cwd: app.getPath('home'),
    // OS の言語はサーバーからは確実に取れない（utilityProcess の Intl は OS の表示言語と一致しないことがある）ので、ここで渡す。
    // 画面の言語を「OS に合わせる」ときに使う（core/i18n.mjs）
    env: { ...process.env, PATH: `${agentBrowserBin}${path.delimiter}${process.env.PATH || ''}`, AGENT_HOST_BIND: '127.0.0.1', AGENT_HOST_PORT: String(savedPort(portFile)), AGENT_HOST_SYSTEM_LOCALE: systemLanguage() },
    stdio: 'pipe', serviceName: 'Pleiad server',
  });
  powerMonitor.on('resume', () => worker?.postMessage({ type: 'wake' }));
  // Consume logs without exposing the private authentication URL.
  worker.stdout.on('data', () => {});
  // 外部 MCP の秘密は safeStorage で暗号化する。safeStorage は main でしか使えないので、サーバーの依頼をここで受ける
  // MCP の OAuth の同意画面も、サーバー（utilityProcess）はブラウザを開けないので頼まれて開く
  attachSecretBridge(worker, { safeStorage, openExternal: url => shell.openExternal(url).catch(() => {}) });
  // 「エクスプローラーで表示」「ブラウザーで開く」。範囲と接続元はサーバーが確かめ、実行は本体の shell（窓を前に出せる）
  attachFileBridge(worker, { shell });
  // Esc の登録を外す・戻すのは、オーバーレイ（computerOverlay。下で作る）が持つ。Esc を拾ったら、オーバーレイが computerService.escape を呼ぶ
  computerService = attachComputerService(worker, { electron: { screen, nativeImage }, app, log: line => console.warn('[computer]', line),
    escape: { suspend: () => computerOverlay?.suspendEscape() ?? (() => {}) } });
  resident = attachResident({ app, worker, icon: path.join(__dirname, 'icon.png'), getWindow: () => window, quit: () => closeSafely() });
  let startupError = '';
  worker.stderr.on('data', data => { startupError = (startupError + data.toString()).replace(/token=\S+/g, 'token=[redacted]').slice(-2000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('server.startTimeout'))), 60_000);
    worker.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error(t('server.startFailed', { detail: startupError }))); });
  });
  if (ready.locale) setLocale(ready.locale);
  // 画面で言語を変えたら、サーバーが解決し直した言語が届く（core/server.mjs の savePref）
  worker.on('message', message => { if (message?.type === 'locale' && message.locale) setLocale(message.locale); });
  origin = `http://127.0.0.1:${ready.port}`;
  rememberPort(portFile, ready.port);
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 640, minHeight: 480, title: 'Pleiad', icon: path.join(__dirname, 'icon.png'), show: false,
    ...titleBar(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // ショートカットに AUMID が無くても、タスクバーが「Pleiad」とアプリのアイコンで出るよう窓に直接持たせる
  if (process.platform === 'win32' && app.isPackaged && !PACKAGED_IDENTITY) {
    window.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: process.execPath, appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Pleiad' });
  }
  window.removeMenu();
  trust.register(window, { kind: 'local', origin });
  remoteWindows = createRemoteWindows({ app, BrowserWindow, session, ipcMain, nativeImage, nativeTheme, Notification, Menu, safeStorage, trust,
    icon: path.join(__dirname, 'icon.png'), external });
  remoteWindows.attach();
  remoteWindows.attachWorker(worker);
  browserPanel = createBrowserPanel({ window, WebContentsView, BrowserWindow, session, shell, ipcMain, app, trust, icon: path.join(__dirname, 'icon.png'), agentControl: (action, id) => agentBrowserBridge?.[action]?.(id) });
  browserPanel.attach();
  agentBrowserBridge = attachAgentBrowserBridge(worker, browserPanel);
  computerOverlay = attachComputerOverlay(worker, { onEscape: owner => computerService?.escape({ owner, notify: false }) });
  browserScreencastBridge = attachBrowserScreencastBridge(worker, browserPanel, {
    agentControl: (action, id) => agentBrowserBridge?.[action]?.(id),
    // 隠れた窓（常駐で閉じた）ではページが描かれない。見られている間だけ最小化で出し、終われば隠し直す
    keepVisible: () => {
      if (!window || window.isDestroyed() || window.isVisible()) return () => {};
      window.showInactive(); window.minimize();
      return () => { if (!quitting && window && !window.isDestroyed() && window.isMinimized()) window.hide(); };
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
  });
  // 権限は断るのが基本。navigator.clipboard.writeText も権限要求（clipboard-sanitized-write）を通るので、
  // これだけは Pleiad 自身の画面（埋め込みの枠ではなく本体）に限って通す。断るとコピーのボタンが効かない。
  // 通話モード（docs/voice-call.md）のマイクも同じ決まり: 本体の画面（メインフレーム・同じ origin）の音声入力（media で audio だけ。映像は断る）に限って通す
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    let own = false;
    try { own = details.isMainFrame && new URL(details.requestingUrl).origin === origin; } catch {}
    const audioOnly = permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
    callback(own && (permission === 'clipboard-sanitized-write' || audioOnly));
  });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (resident?.keepOnClose()) { window.hide(); return; }
    closeSafely();
  });
  window.on('session-end', () => { quitting = true; worker.postMessage({ type: 'shutdown' }); });
  worker.once('exit', () => {
    if (quitting || exitInProgress) return;
    quitting = true;
    void showFatalError('Pleiad', t('server.exited')).catch(e => console.error(e)).finally(() => app.quit());
  });
  await window.loadURL(`${origin}/?token=${encodeURIComponent(ready.token)}`);
  window.show();
  remoteWindows.handleArgv(process.argv);
  const { autoUpdater } = require('electron-updater');
  // 記録は userData/logs/updater.log に残す。トークンと配信の署名付きの URL は伏せて書く（desktop/update-log.cjs）
  autoUpdater.logger = createUpdateLog(path.join(app.getPath('userData'), 'logs', 'updater.log'));
  // Microsoft Store の版は Store が更新する。確認もダウンロードもしない（docs/microsoft-store.md「自動更新」）
  const pkg = require('../package.json');
  updates = new Updates({ updater: autoUpdater, version: app.getVersion(), file: path.join(app.getPath('userData'), 'updates.json'),
    store: isStoreBuild({ pkg, windowsStore: process.windowsStore }),
    enabled: updaterEnabled({ packaged: app.isPackaged, pkg, windowsStore: process.windowsStore, feed: fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')) }), install: installUpdate,
    prepareCheck: () => prepareUpdateCheck(autoUpdater, path.join(process.resourcesPath, 'app-update.yml')) });
  updates.on('state', state => { if (!window.isDestroyed()) window.webContents.send('ply:update-state', state); });
  try { await updates.init(); }
  catch (e) { updates.enabled = false; updates.patch({ enabled: false, phase: 'unavailable', error: e.message }); }
  window.webContents.send('ply:update-state', updates.snapshot());
  // 先行版は 1 日に何度も出る。6 時間おきでは、開きっぱなしの Pleiad が半日近く新しい版に気付かなかった。
  // 30 分おきに確認し、ウィンドウへ戻ってきたときも（前回から 10 分あいていれば）確認する
  if (updates.enabled) {
    setTimeout(() => updates.auto(), 15000).unref();
    setInterval(() => updates.auto(), 30 * 60 * 1000).unref();
    window.on('focus', () => updates.auto(10 * 60 * 1000));
  }
}

/** 終了の確認に足す、動かなくなる予定の文（送信予定の件数と次の時刻・上限の解除後の再開の件数）。無ければ null */
function scheduledText(scheduled) {
  const send = Number(scheduled?.send) || 0;
  const resume = Number(scheduled?.resume) || 0;
  if (!send && !resume) return null;
  const next = Number.isFinite(scheduled?.nextSendAt)
    ? t('quit.scheduledSendNext', { time: new Date(scheduled.nextSendAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) }) : '';
  const parts = [send ? t('quit.scheduledSend', { count: send, next }) : '', resume ? t('quit.scheduledResume', { count: resume }) : ''].filter(Boolean);
  // 送信予定は終了している間は送られない。上限の解除後の再開は、次に開いたときに（時刻を過ぎていても）再開する（ADR 0132）
  const tail = send && resume ? t('quit.scheduledTailBoth') : resume ? t('quit.scheduledTailResume') : t('quit.scheduledTail');
  return parts.join(t('quit.scheduledJoin')) + tail + (send ? t('quit.scheduledLate') : '');
}

async function closeSafely() {
  if (updates?.state.phase === 'installing') return;
  if (closing) return;
  closing = true;
  try {
    const work = await runningWork();
    const waiting = scheduledText(work.scheduled);
    if (work.count > 0) {
      // 「作業に戻る」か「中断して終了」（reason: quit。中断した会話は次の起動で残り、「再開」で続けられる。ADR 0036）。
      // 送信予定・上限の解除後の再開があれば、終了している間は動かないことも添える
      const { response } = await dialog.showMessageBox(window, { type: 'info', title: t('quit.busyTitle'),
        message: waiting ? `${t('quit.busyMessage')}

${waiting}` : t('quit.busyMessage'),
        buttons: [t('quit.backToWork'), t('quit.abortAndQuit')], defaultId: 0, cancelId: 0, noLink: true });
      if (response !== 1) return;
      await abortAll('quit');
    } else if (waiting) {
      // 作業が無くても、送信予定や再開の予定があれば確かめる（終了している間は送られない。ADR 0103）
      const { response } = await dialog.showMessageBox(window, { type: 'info', title: t('quit.scheduledTitle'), message: waiting,
        buttons: [t('quit.backToWork'), t('quit.quitAnyway')], defaultId: 0, cancelId: 0, noLink: true });
      if (response !== 1) return;
    }
    quitting = true; worker.postMessage({ type: 'shutdown' }); app.quit();
  } catch (e) { await dialog.showMessageBox(window, { message: e.message, buttons: [t('common.back')] }); }
  finally { closing = false; if (!quitting) exitInProgress = false; }
}

ipcMain.handle('ply:choose-folder', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('ply:notify-completion', (event, notice) => {
  trusted(event);
  return notifyCompletion(notice);
});
ipcMain.handle('ply:update', async (event, action, value) => {
  trusted(event);
  if (!updates) return { version: app.getVersion(), enabled: false, phase: 'unavailable', channel: app.getVersion().includes('-') ? 'beta' : 'stable' };
  try { return await updates.command(action, value); }
  catch (e) { throw new Error(['check', 'download'].includes(action) ? updates.snapshot().error || t('update.fetchFailed') : e.message); }
});
// 画面の配色（自動・明・暗）や帯の下の面（脇の開閉・プレビュー）が変わるたびに、重ねたボタンの地と記号の色を合わせ直す
ipcMain.on('ply:title-bar', (event, colors) => {
  try { trusted(event); } catch { return; }
  if (process.platform === 'darwin' || !window || window.isDestroyed()) return;
  const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  if (!hex(colors?.color) || !hex(colors?.symbolColor)) return;
  window.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLE_BAR_HEIGHT });
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('will-quit', () => { browserScreencastBridge?.close(); agentBrowserBridge?.close(); computerOverlay?.close(); });
  app.on('second-instance', (_event, argv) => { if (remoteWindows?.handleArgv(argv)) return; if (window) { window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => { exitInProgress = true; if (!quitting && window) { event.preventDefault(); void closeSafely(); } });
  app.on('will-quit', () => { exitInProgress = true; });
  app.whenReady().then(boot).catch(e => {
    console.error(e.message);
    if (quitting || exitInProgress) return;
    quitting = true; worker?.kill();
    void showFatalError(t('boot.failedTitle'), e.message).catch(error => console.error(error)).finally(() => app.quit());
  });
}
