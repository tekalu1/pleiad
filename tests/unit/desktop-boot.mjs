// desktop/main.cjs の boot() の、サーバーの起こし方の選び方（無停止の更新 1-4。docs/zero-downtime-update/plan.md 1-4）。
// 既存の desktop-exit-dialog.mjs と同じく vm で main.cjs を評価し、Electron と desktop/ の部品は偽物に差し替える。
//   - AGENT_HOST_HANDOVER が off（既定）・on でもパッケージ版でない・chooseServer が null → 今の utilityProcess（変わらない）
//   - on のパッケージ版: パイプの包みを worker にして、つなぐ前に message を付け、ready のポート・トークンで窓を読み込む。utilityProcess は起こさない
//   - 起動の失敗: 文は describeBootError。パイプのサーバーは kill（shutdown）せず leave で切る
//   - サーバーが居なくなったとき: bye 'replaced' なら静かに終わる・つながりだけ切れたなら付け直す・居なければ「サーバーが終了しました」
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

export const name = 'desktop-boot';
export const title = 'main の boot: AGENT_HOST_HANDOVER の選び方（utilityProcess のまま・パイプの包み）と、サーバーが居なくなったときの扱い';

const source = fs.readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeLink extends EventEmitter {
  constructor(calls) {
    super();
    this.calls = calls;
    this.exitReason = null;
    this.connectError = null;
  }
  postMessage(message) { this.calls.messages.push(message); return true; }
  leave(reason) { this.calls.left = reason; }
  kill() { this.calls.killed = true; }
  async connect() {
    this.calls.connects++;
    if (this.connectError) throw this.connectError;
    queueMicrotask(() => this.emit('message', { type: 'ready', port: 7611, token: 'attached-token' }));
    return { attached: true, pid: 4242 };
  }
}

async function start({ env = {}, packaged = false, choice = 'link', connectError = null, reattach = false, resourcesPath = 'C:\\inst\\resources' } = {}) {
  const calls = { dialogs: [], messages: [], quits: 0, forks: 0, connects: 0, loads: [], left: null, killed: false, chosen: null, reattaches: 0, logs: [] };
  const link = new FakeLink(calls);
  link.connectError = connectError;
  const utility = new EventEmitter();
  utility.stdout = new EventEmitter();
  utility.stderr = new EventEmitter();
  utility.postMessage = message => calls.messages.push(message);
  utility.kill = () => { calls.killed = true; };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: packaged, exit: () => {}, quit: () => { calls.quits++; }, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getPath: name => name === 'userData' ? 'test-user' : 'test-home', getPreferredSystemLanguages: () => ['ja-JP'], getVersion: () => '1.2.3',
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
    loadURL(url) { calls.loads.push(url); return Promise.resolve(); }
    show() {}
  }
  const dialog = { showMessageBox: (...args) => { calls.dialogs.push(args); return new Promise(() => {}); } };
  const electron = {
    app, BrowserWindow, WebContentsView: class {}, dialog,
    utilityProcess: { fork: () => { calls.forks++; queueMicrotask(() => utility.emit('message', { type: 'ready', port: 7499, token: 'utility-token' })); return utility; } },
    shell: { openExternal: () => Promise.resolve() },
    ipcMain: { on: () => {}, handle: () => {} },
    Notification: class {}, nativeTheme: { shouldUseDarkColors: false }, safeStorage: {}, session: {}, nativeImage: {}, Menu: {}, powerMonitor: new EventEmitter(),
  };
  const serverBoot = {
    chooseServer: async options => { calls.chosen = options; return choice === 'link' ? { link, logFile: 'C:\\rt\\logs\\server.log', connect: () => link.connect() } : null; },
    describeBootError: (error, t) => `described:${error.code}:${t('server.startTimeout')}`,
    reattachServer: async () => { calls.reattaches++; return reattach; },
    resolveDataDir: () => 'D:\\data',
    readLogTail: () => 'tail of the log',
  };
  const modules = {
    './updates.cjs': { Updates: class { constructor() { this.enabled = false; this.state = { phase: 'idle' }; } on() {} async init() {} snapshot() { return {}; } } },
    './update-auth.cjs': { prepareUpdateCheck: () => {} },
    './update-log.cjs': { createUpdateLog: () => ({}) },
    './server-port.cjs': { savedPort: () => 7499, rememberPort: (_file, port) => { calls.remembered = port; } },
    './secret-bridge.cjs': { attachSecretBridge: worker => { calls.secretBridge = worker; } },
    './i18n.cjs': { t: key => key, setLocale: () => {}, resolveLocale: () => 'ja', initDesktopI18n: async () => {} },
    './file-bridge.cjs': { attachFileBridge: () => {} },
    './resident.cjs': { attachResident: () => ({ keepOnClose: () => false }) },
    './window-trust.cjs': { createWindowTrust: () => ({ register: () => {} }) },
    './remote-windows.cjs': { createRemoteWindows: () => ({ attach: () => {}, handleArgv: () => false }) },
    './browser-panel.cjs': { createBrowserPanel: () => ({ attach: () => {} }) },
    './agent-browser-bridge.cjs': { attachAgentBrowserBridge: () => ({ close: () => {} }) },
    './computer/service.cjs': { attachComputerService: () => ({}) },
    './browser-screencast-bridge.cjs': { attachBrowserScreencastBridge: () => ({ close: () => {} }) },
    './computer-overlay.cjs': { attachComputerOverlay: () => ({ close: () => {} }) },
    './agent-browser-bin.cjs': { prepareAgentBrowserBin: () => '' },
    './notifications.cjs': { createDesktopNotifications: () => () => {} },
    './server-boot.cjs': serverBoot,
    'electron-updater': { autoUpdater: {} },
  };
  const require = id => {
    if (id === 'electron') return electron;
    if (id.startsWith('node:')) return id === 'node:path' ? path : fs;
    if (id === '../package.json') return {};
    if (id in modules) return modules[id];
    throw new Error(`unexpected require ${id}`);
  };
  vm.runInNewContext(source, { require, __dirname: desktop, process: { platform: 'linux', argv: [], env, resourcesPath, execPath: 'C:\\inst\\Ply.exe' },
    console: { error: () => {}, warn: (...args) => calls.logs.push(args.join(' ')) }, setTimeout, clearTimeout, setInterval, queueMicrotask, URL });
  for (let i = 0; i < 4; i++) await tick();
  return { app, link, utility, calls };
}

export default async function (t) {
  {
    const { calls } = await start({ env: {} });
    t.ok('既定（off）: 今の utilityProcess で起こし、chooseServer は呼ばない', calls.forks === 1 && calls.chosen === null && calls.loads[0] === 'http://127.0.0.1:7499/?token=utility-token');
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'off' }, packaged: true });
    t.ok('off を明示しても同じ（パッケージ版でも utilityProcess）', calls.forks === 1 && calls.chosen === null);
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: false });
    t.ok('on でもパッケージ版でなく、確認用の resources の指定も無ければ utilityProcess のまま（理由を記録する）', calls.forks === 1 && calls.chosen === null && calls.logs.some(line => /needs a packaged app/.test(line)));
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, choice: 'none' });
    t.ok('on のパッケージ版でも、chooseServer が null（Job が許さない・実行場所を組めない）なら utilityProcess に落ちる', calls.chosen !== null && calls.forks === 1 && calls.loads[0].includes('utility-token'));
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true });
    t.ok('on のパッケージ版: パイプの包みを worker にし、utilityProcess は起こさない', calls.forks === 0 && calls.connects === 1 && calls.secretBridge === link);
    t.ok('on: 付け直した ready のトークン・ポートで窓を読み込み、ポートを覚える', calls.loads[0] === 'http://127.0.0.1:7611/?token=attached-token' && calls.remembered === 7611);
    t.ok('on: chooseServer に配布物の resources・実行ファイル・版・保存したポート・cwd を渡す', calls.chosen.resourcesPath === 'C:\\inst\\resources' && calls.chosen.execPath === 'C:\\inst\\Ply.exe' && calls.chosen.appVersion === '1.2.3' && calls.chosen.port === 7499 && calls.chosen.cwd === 'test-home' && calls.chosen.dataDir === 'D:\\data');
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'ON', AGENT_HOST_RUNTIME_RESOURCES: 'D:\\pack\\resources' }, packaged: false });
    t.ok('確認用: AGENT_HOST_RUNTIME_RESOURCES があればパッケージ版でなくても使え、その resources から組む（大文字の ON も on）', calls.chosen?.resourcesPath === 'D:\\pack\\resources' && calls.forks === 0);
  }
  {
    const error = Object.assign(new Error('x'), { code: 'timeout' });
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, connectError: error });
    t.ok('起動の失敗: 文は describeBootError で作り、起動の失敗のダイアログを出す', calls.dialogs.length === 1 && calls.dialogs[0][0].title === 'boot.failedTitle' && calls.dialogs[0][0].message === 'described:timeout:server.startTimeout', JSON.stringify(calls.dialogs[0]));
    t.ok('起動の失敗: パイプのサーバーは shutdown（kill）せず、つながりだけ切る（居続けるのは孤児の見張りが終わらせる）', calls.left === 'boot-failed' && calls.killed === false);
  }
  {
    const { calls, utility } = await start({ env: {} });
    utility.emit('exit');
    await tick();
    t.ok('off の経路: サーバーの終了は今のとおり「サーバーが終了しました」', calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.exited');
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true });
    link.exitReason = 'replaced';
    link.emit('exit', 0);
    await tick();
    t.ok('パイプの経路: 別の main が付け直した（bye replaced）なら、ダイアログを出さずに静かに終わる', calls.dialogs.length === 0 && calls.quits === 1 && calls.reattaches === 0);
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true });
    link.emit('exit', 1);
    await tick();
    t.ok('パイプの経路: つながりだけが切れた（サーバーは居る）なら付け直し、ダイアログを出さない', calls.reattaches === 1 && calls.dialogs.length === 0 && calls.quits === 0);
    link.emit('exit', 1);
    await tick();
    t.ok('パイプの経路: 付け直した後の次の切断も見張っている', calls.reattaches === 2 && calls.dialogs.length === 0);
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: false });
    link.emit('exit', 1);
    await tick();
    t.ok('パイプの経路: サーバーが居なければ「サーバーが終了しました」', calls.reattaches === 1 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.exited');
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true });
    link.exitReason = 'closing';
    link.emit('exit', 0);
    await tick();
    t.ok('パイプの経路: サーバーが終わるところ（bye closing）は付け直さず「サーバーが終了しました」', calls.reattaches === 0 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.exited');
  }
  {
    const { calls, link, app } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true });
    app.exit(0);
    link.emit('exit', 0);
    await tick();
    t.ok('パイプの経路: app.exit の後のつながりの切断は何もしない', calls.reattaches === 0 && calls.dialogs.length === 0);
  }
}
