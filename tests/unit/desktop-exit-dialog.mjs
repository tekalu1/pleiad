import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const name = 'desktop-exit-dialog';
export const title = 'サーバー終了の通知は非同期で、終了中は表示しない';

const source = fs.readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');
const workerMessages = createRequire(import.meta.url)('../../desktop/worker-messages.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function start({ ready = true, work = { count: 0 } } = {}) {
  const calls = { dialogs: [], messages: [], quits: 0, syncDialogs: 0 };
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.postMessage = message => {
    calls.messages.push(message);
    if (message.type === 'running') queueMicrotask(() => worker.emit('message', { type: 'running', work }));
  };
  worker.kill = () => {};
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    exit: () => {},
    quit: () => { calls.quits++; },
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: name => name === 'userData' ? 'test-user' : 'test-home',
    getPreferredSystemLanguages: () => ['ja-JP'],
    getVersion: () => '0.1.0',
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      calls.window = this;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = { setPermissionRequestHandler: () => {} };
      this.webContents.send = () => {};
    }
    isDestroyed() { return false; }
    removeMenu() {}
    loadURL() { return Promise.resolve(); }
    show() {}
  }
  let resolveDialog;
  const dialog = {
    showErrorBox: () => { calls.syncDialogs++; throw new Error('synchronous dialog'); },
    showMessageBox: (...args) => {
      calls.dialogs.push(args);
      return new Promise(resolve => { resolveDialog = resolve; });
    },
  };
  const electron = {
    app, BrowserWindow, WebContentsView: class {}, dialog,
    utilityProcess: { fork: () => { queueMicrotask(() => worker.emit(ready ? 'message' : 'exit', ready ? { type: 'ready', port: 7499, token: 'test' } : undefined)); return worker; } },
    shell: { openExternal: () => Promise.resolve() },
    ipcMain: { on: () => {}, handle: () => {} },
    Notification: class {}, nativeTheme: { shouldUseDarkColors: false }, safeStorage: {}, session: {}, nativeImage: {}, Menu: {}, powerMonitor: new EventEmitter(), screen: new EventEmitter(),
  };
  const modules = {
    './updates.cjs': { Updates: class { constructor() { this.enabled = false; this.state = { phase: 'idle' }; } on() {} async init() {} snapshot() { return {}; } }, isStoreBuild: () => false, updaterEnabled: () => false },
    './msix.cjs': { packagedIdentity: () => false },
    './update-auth.cjs': { prepareUpdateCheck: () => {} },
    './update-log.cjs': { createUpdateLog: () => ({}) },
    './server-port.cjs': { savedPort: () => 7499, rememberPort: () => {} },
    './secret-bridge.cjs': { attachSecretBridge: () => {} },
    './i18n.cjs': { t: key => key, setLocale: () => {}, resolveLocale: () => 'ja', initDesktopI18n: async () => {} },
    './file-bridge.cjs': { attachFileBridge: () => {} },
    './resident.cjs': { attachResident: () => ({ keepOnClose: () => false }) },
    './window-trust.cjs': { createWindowTrust: () => ({ register: () => {} }) },
    './remote-windows.cjs': { createRemoteWindows: () => ({ attach: () => {}, attachWorker: () => {}, handleArgv: () => false }) },
    './browser-panel.cjs': { createBrowserPanel: () => ({ attach: () => {} }) },
    './agent-browser-bridge.cjs': { attachAgentBrowserBridge: () => ({ close: () => {} }) },
    './computer/service.cjs': { attachComputerService: () => ({}), withPerMonitorDpi: w => w },
    './computer/win32.cjs': { loadWin32: () => { throw Object.assign(new Error('not windows'), { reason: 'platform' }); } },
    './chrome-os/index.cjs': { createChromeOs: () => ({}), attachChromeOs: () => {} },
    './browser-screencast-bridge.cjs': { attachBrowserScreencastBridge: () => ({ close: () => {} }) },
    './computer-overlay.cjs': { attachComputerOverlay: () => ({ close: () => {} }) },
    './agent-browser-bin.cjs': { prepareAgentBrowserBin: () => '' },
    './notifications.cjs': { createDesktopNotifications: () => () => {} },
    './worker-messages.cjs': workerMessages,
    // 起動の失敗の理由は、サーバーが書いた logs\server.log の末尾（core/server-log.mjs）
    './server-boot.cjs': { readLogTail: () => 'tail of the log' },
    './switch-screen.cjs': { createSwitchScreen: () => ({ attach() {}, reset() {}, supported: () => false, ask: async () => 'later' }) },
    'electron-updater': { autoUpdater: {} },
  };
  const require = id => {
    if (id === 'electron') return electron;
    if (id.startsWith('node:')) return id === 'node:path' ? path : fs;
    if (id === '../package.json') return {};
    if (id in modules) return modules[id];
    throw new Error(`unexpected require ${id}`);
  };
  vm.runInNewContext(source, { require, __dirname: desktop, process: { platform: 'linux', argv: [], env: {}, resourcesPath: '' },
    console: { error: () => {} }, setTimeout, clearTimeout, setInterval, queueMicrotask, URL });
  await tick();
  await tick();
  return { app, worker, calls, resolveDialog: () => resolveDialog?.({ response: 0 }) };
}

export default async function (t) {
  {
    const { worker, calls, resolveDialog } = await start();
    worker.emit('exit');
    await tick();
    t.ok('サーバー異常終了は本体の窓を親に非同期の通知を出す', calls.dialogs.length === 1 && calls.dialogs[0][0] === calls.window && calls.dialogs[0][1].message === 'server.exited');
    t.ok('通知を閉じるまでイベントループとアプリが動く', calls.syncDialogs === 0 && calls.quits === 0);
    resolveDialog();
    await tick();
    t.ok('通知を閉じると終了する', calls.quits === 1);
  }
  for (const [label, begin] of [
    ['app.exit', ({ app }) => app.exit(0)],
    ['before-quit', ({ app }) => app.emit('before-quit', { preventDefault() {} })],
    ['will-quit', ({ app }) => app.emit('will-quit')],
  ]) {
    const state = await start();
    begin(state);
    state.worker.emit('exit');
    await tick();
    t.ok(`${label} の後は通知しない`, state.calls.dialogs.length === 0 && state.calls.syncDialogs === 0);
  }
  {
    const { worker, calls } = await start();
    calls.window.emit('session-end');
    worker.emit('exit');
    await tick();
    t.ok('session-end は shutdown を送り、サーバー終了を通知しない', calls.messages.some(m => m.type === 'shutdown') && calls.dialogs.length === 0);
  }
  {
    // 作業が無くても、送信予定があれば終了の前に確かめる（終了している間は送られない。ADR 0103）
    const { calls, resolveDialog } = await start({ work: { count: 0, scheduled: { send: 2, held: 0, nextSendAt: Date.UTC(2026, 9, 4, 0, 0) } } });
    calls.window.emit('close', { preventDefault() {} });
    await tick();
    const dialog = calls.dialogs[0]?.[1];
    t.ok('予定があれば、作業が無くても終了の前に確かめる', dialog?.title === 'quit.scheduledTitle' && dialog.buttons.join() === 'quit.backToWork,quit.quitAnyway', JSON.stringify(dialog));
    t.ok('確認には送信予定の件数と次の時刻・遅れの扱いが入る', ['quit.scheduledSend', 'quit.scheduledTail', 'quit.scheduledLate'].every(key => dialog.message.includes(key)), dialog?.message);
    resolveDialog();
    await tick();
    t.ok('「作業に戻る」なら終了しない', calls.quits === 0 && !calls.messages.some(m => m.type === 'shutdown'));
  }
  {
    const { calls } = await start({ work: { count: 0, scheduled: { send: 0, held: 0 } } });
    calls.window.emit('close', { preventDefault() {} });
    await tick(); await tick();
    t.ok('予定が無ければ確認なしで終了する', calls.dialogs.length === 0 && calls.quits === 1);
  }
  {
    const { calls, resolveDialog } = await start({ ready: false });
    t.ok('起動失敗も親なしの非同期通知を出す', calls.dialogs.length === 1 && calls.dialogs[0][0].message === 'server.startFailed' && calls.syncDialogs === 0);
    resolveDialog();
    await tick();
    t.ok('起動失敗の通知を閉じると終了する', calls.quits === 1);
  }
}
