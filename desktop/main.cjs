const { app, BrowserWindow, utilityProcess, shell, dialog, ipcMain, Notification, nativeTheme, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Updates } = require('./updates.cjs');
const { prepareUpdateCheck } = require('./update-auth.cjs');
const { savedPort, rememberPort } = require('./server-port.cjs');
const { attachSecretBridge } = require('./secret-bridge.cjs');
const { attachFileBridge } = require('./file-bridge.cjs');
let worker, window, origin, updates, quitting = false, closing = false;
let requestId = 0;
const { createDesktopNotifications } = require('./notifications.cjs');
const notifyCompletion = createDesktopNotifications({ Notification, getWindow: () => window, icon: path.join(__dirname, 'icon.png') });
// electron-builder.yml の appId と、スタートメニューのショートカットの AUMID（build/installer.nsh）に揃える。
// 開発起動（electron.exe）が同じ ID で「Electron」としてシェルに覚えられないよう、別の ID にする
const APP_USER_MODEL_ID = app.isPackaged ? 'jp.ply.desktop' : 'jp.ply.desktop.dev';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid sender');
}
function workerRequest(type) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const done = message => {
      if (message.type !== type || message.id !== id) return;
      clearTimeout(timer); worker.off('message', done); resolve(message);
    };
    const timer = setTimeout(() => { worker.off('message', done); reject(new Error('実行状態を確認できませんでした。再試行してください。')); }, 10000);
    worker.on('message', done); worker.postMessage({ type, id });
  });
}

async function installUpdate() {
  try {
    const lock = await workerRequest('update-lock');
    if (!lock.ok) throw new Error(`更新できません：${lock.reason}。完了してから更新してください。更新は準備済みのまま残ります。`);
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
        reject(new Error('更新を適用できませんでした。再試行してください。'));
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

async function boot() {
  // 開発版と配布版が同時に動いても互いのポートを奪い合わないよう、記録を分ける
  const portFile = path.join(app.getPath('userData'), app.isPackaged ? 'server-port.json' : 'server-port-dev.json');
  worker = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
    cwd: app.getPath('home'),
    env: { ...process.env, AGENT_HOST_BIND: '127.0.0.1', AGENT_HOST_PORT: String(savedPort(portFile)) },
    stdio: 'pipe', serviceName: 'Pleiad server',
  });
  // Consume logs without exposing the private authentication URL.
  worker.stdout.on('data', () => {});
  // 外部 MCP の秘密は safeStorage で暗号化する。safeStorage は main でしか使えないので、サーバーの依頼をここで受ける
  // MCP の OAuth の同意画面も、サーバー（utilityProcess）はブラウザを開けないので頼まれて開く
  attachSecretBridge(worker, { safeStorage, openExternal: url => shell.openExternal(url).catch(() => {}) });
  // 「エクスプローラーで表示」「ブラウザーで開く」。範囲と接続元はサーバーが確かめ、実行は本体の shell（窓を前に出せる）
  attachFileBridge(worker, { shell });
  let startupError = '';
  worker.stderr.on('data', data => { startupError = (startupError + data.toString()).replace(/token=\S+/g, 'token=[redacted]').slice(-2000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバーの起動が時間切れになりました')), 60_000);
    worker.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error(`サーバーを起動できませんでした\n${startupError}`)); });
  });
  origin = `http://127.0.0.1:${ready.port}`;
  rememberPort(portFile, ready.port);
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 640, minHeight: 480, title: 'Pleiad', icon: path.join(__dirname, 'icon.png'), show: false,
    ...titleBar(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // ショートカットに AUMID が無くても、タスクバーが「Pleiad」とアプリのアイコンで出るよう窓に直接持たせる
  if (process.platform === 'win32' && app.isPackaged) {
    window.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: process.execPath, appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Pleiad' });
  }
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
  });
  // 権限は断るのが基本。navigator.clipboard.writeText も権限要求（clipboard-sanitized-write）を通るので、
  // これだけは Pleiad 自身の画面（埋め込みの枠ではなく本体）に限って通す。断るとコピーのボタンが効かない
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    let own = false;
    try { own = details.isMainFrame && new URL(details.requestingUrl).origin === origin; } catch {}
    callback(permission === 'clipboard-sanitized-write' && own);
  });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    closeSafely();
  });
  worker.once('exit', () => {
    if (quitting) return;
    dialog.showErrorBox('Pleiad', 'サーバーが終了しました。Pleiad を起動し直してください。保存済みの会話は残っています。');
    quitting = true; app.quit();
  });
  await window.loadURL(`${origin}/?token=${encodeURIComponent(ready.token)}`);
  window.show();
  const { autoUpdater } = require('electron-updater');
  // Provider errors may include authenticated HTTP request details.
  autoUpdater.logger = null;
  updates = new Updates({ updater: autoUpdater, version: app.getVersion(), file: path.join(app.getPath('userData'), 'updates.json'),
    enabled: app.isPackaged && require('../package.json').plyRelease === true && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')), install: installUpdate,
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

async function closeSafely() {
  if (updates?.state.phase === 'installing') return;
  if (closing) return;
  closing = true;
  try {
    const work = await new Promise((resolve, reject) => {
      const onMessage = message => { if (message.type === 'running') { clearTimeout(timer); worker.off('message', onMessage); resolve(message.work); } };
      const timer = setTimeout(() => { worker.off('message', onMessage); reject(new Error('実行状態を確認できませんでした。少し待ってから閉じてください。')); }, 10_000);
      worker.on('message', onMessage); worker.postMessage({ type: 'running' });
    });
    if (work.count > 0) {
      await dialog.showMessageBox(window, { type: 'info', title: '作業が実行中です', message: '会話の作業が完了してから終了してください。中断する場合は会話内の「中断」を使えます。', buttons: ['作業に戻る'] });
      return;
    }
    quitting = true; worker.postMessage({ type: 'shutdown' }); app.quit();
  } catch (e) { await dialog.showMessageBox(window, { message: e.message, buttons: ['戻る'] }); }
  finally { closing = false; }
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
  catch (e) { throw new Error(['check', 'download'].includes(action) ? updates.snapshot().error || '更新を取得できませんでした。接続と配布先の閲覧権限を確認して再試行してください。' : e.message); }
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
  app.on('second-instance', () => { if (window) { window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => { if (!quitting && window) { event.preventDefault(); closeSafely(); } });
  app.whenReady().then(boot).catch(e => { console.error(e.message); dialog.showErrorBox('Pleiad の起動に失敗しました', e.message); quitting = true; worker?.kill(); app.quit(); });
}
