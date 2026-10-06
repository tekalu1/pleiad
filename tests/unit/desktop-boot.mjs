// desktop/main.cjs の boot() の、サーバーの起こし方の選び方（無停止の更新 1-4。docs/zero-downtime-update/plan.md 1-4）。
// 既存の desktop-exit-dialog.mjs と同じく vm で main.cjs を評価し、Electron と desktop/ の部品は偽物に差し替える。
//   - 既定: パッケージ版は on（env が無ければ on）・開発（パッケージ版でない）は off。off を明示・on でもパッケージ版でない・chooseServer が null → 今の utilityProcess（変わらない）
//   - on（既定を含む）のパッケージ版: パイプの包みを worker にして、つなぐ前に message を付け、ready のポート・トークンで窓を読み込む。utilityProcess は起こさない
//   - 起動の失敗: 文は describeBootError。パイプのサーバーは kill（shutdown）せず leave で切る
//   - サーバーが居なくなったとき: bye 'replaced' なら静かに終わる・つながりだけ切れたなら付け直す・居なければ「サーバーが終了しました」
//   - 更新（1-6）: on は作業を止めず・ロックせず main-leaving → つながりだけ切る（shutdown しない）、off は今のまま update-lock → shutdown。
//     付け直した後は切り替え（desktop/switch.cjs）を始め、S1 を手放している間はサーバーの終了を知らせない
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
  leave(reason) { this.calls.left = reason; this.calls.order.push(`leave:${reason}`); }
  kill() { this.calls.killed = true; }
  async connect() {
    this.calls.connects++;
    if (this.connectError) throw this.connectError;
    queueMicrotask(() => this.emit('message', { type: 'ready', port: 7611, token: 'attached-token' }));
    return { attached: true, pid: 4242 };
  }
}

async function start({ env = {}, packaged = false, choice = 'link', connectError = null, reattach = false, resourcesPath = 'C:\\inst\\resources', quitFails = false } = {}) {
  const calls = { dialogs: [], messages: [], quits: 0, forks: 0, connects: 0, loads: [], left: null, killed: false, chosen: null, reattaches: 0, logs: [], order: [], switches: [], updates: null };
  const link = new FakeLink(calls);
  link.connectError = connectError;
  const utility = new EventEmitter();
  utility.stdout = new EventEmitter();
  utility.stderr = new EventEmitter();
  utility.postMessage = message => {
    calls.messages.push(message);
    if (message.type === 'update-lock') queueMicrotask(() => utility.emit('message', { type: 'update-lock', id: message.id, ok: true }));
  };
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
    autoUpdater: new EventEmitter(),
  };
  // electron-updater の quitAndInstall: インストーラーを起こした後に before-quit-for-update を出して終わる（node_modules/electron-updater の BaseUpdater）
  const autoUpdater = new EventEmitter();
  autoUpdater.quitAndInstall = () => { calls.order.push('quitAndInstall'); if (quitFails) throw new Error('installer did not start'); electron.autoUpdater.emit('before-quit-for-update'); };
  const serverBoot = {
    chooseServer: async options => { calls.chosen = options; return choice === 'link' ? { link, logFile: 'C:\\rt\\logs\\server.log', connect: () => link.connect() } : null; },
    describeBootError: (error, t) => `described:${error.code}:${t('server.startTimeout')}`,
    reattachServer: async () => { calls.reattaches++; return reattach; },
    resolveDataDir: () => 'D:\\data',
    readLogTail: () => 'tail of the log',
  };
  const modules = {
    './updates.cjs': { Updates: class { constructor(options) { calls.updates = options; this.enabled = false; this.state = { phase: 'idle' }; } on() {} async init() {} snapshot() { return {}; } }, isStoreBuild: () => false, updaterEnabled: () => false },
    './msix.cjs': { packagedIdentity: () => false },
    './update-auth.cjs': { prepareUpdateCheck: () => {} },
    './update-log.cjs': { createUpdateLog: () => ({}) },
    './server-port.cjs': { savedPort: () => 7499, rememberPort: (_file, port) => { calls.remembered = port; } },
    './secret-bridge.cjs': { attachSecretBridge: worker => { calls.secretBridge = worker; } },
    './i18n.cjs': { t: key => key, setLocale: () => {}, resolveLocale: () => 'ja', initDesktopI18n: async () => {} },
    './file-bridge.cjs': { attachFileBridge: () => {} },
    './resident.cjs': { attachResident: () => ({ keepOnClose: () => false }) },
    './window-trust.cjs': { createWindowTrust: () => ({ register: () => {}, update: (_window, patch) => { calls.trusted = patch.origin; } }) },
    './remote-windows.cjs': { createRemoteWindows: () => ({ attach: () => {}, attachWorker: () => {}, handleArgv: () => false }) },
    './browser-panel.cjs': { createBrowserPanel: () => ({ attach: () => {} }) },
    './agent-browser-bridge.cjs': { attachAgentBrowserBridge: () => ({ close: () => {} }) },
    './computer/service.cjs': { attachComputerService: () => ({}) },
    './browser-screencast-bridge.cjs': { attachBrowserScreencastBridge: () => ({ close: () => {} }) },
    './computer-overlay.cjs': { attachComputerOverlay: () => ({ close: () => {} }) },
    './agent-browser-bin.cjs': { prepareAgentBrowserBin: () => '' },
    './notifications.cjs': { createDesktopNotifications: () => () => {} },
    './server-boot.cjs': serverBoot,
    './switch-screen.cjs': { createSwitchScreen: () => ({ attach: control => { calls.screenAttached = control; }, reset() {}, supported: () => false, ask: async () => 'later' }) },
    './switch.cjs': {
      startSwitch: options => { const control = { replacing: false, cancelled: false, cancel() { this.cancelled = true; }, options }; calls.switches.push(control); return control; },
      incompatibleDialog: () => async () => 'later',
    },
    'electron-updater': { autoUpdater },
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
    t.ok('開発（パッケージ版でない）の既定は off: 今の utilityProcess で起こし、chooseServer は呼ばない', calls.forks === 1 && calls.chosen === null && calls.loads[0] === 'http://127.0.0.1:7499/?token=utility-token');
  }
  {
    const { calls, link } = await start({ env: {}, packaged: true });
    t.ok('パッケージ版の既定は on: env が無くてもパイプの包みを worker にし、utilityProcess は起こさない', calls.forks === 0 && calls.connects === 1 && calls.secretBridge === link && calls.chosen !== null);
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: '  ' }, packaged: true });
    t.ok('パッケージ版で空の値も「無い」と同じ（on）', calls.forks === 0 && calls.chosen !== null);
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'false' }, packaged: true });
    t.ok('パッケージ版で on でも空でもない値（false など）は off と同じ: utilityProcess に落とし、chooseServer は呼ばない', calls.forks === 1 && calls.chosen === null);
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'off' }, packaged: true });
    t.ok('off を明示すると、パッケージ版でも utilityProcess（今の流れ。戻し道）', calls.forks === 1 && calls.chosen === null);
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

  // ---- 更新の流れ（1-6）
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true });
    t.ok('on: 画面の更新の状態に handover（作業を止めない）を渡す', calls.updates?.handover === true);
    calls.messages.length = 0;
    await calls.updates.install();
    const types = calls.messages.map(m => m.type);
    t.ok('on の更新: 作業を中断せず、ロックもせず、main-leaving（update）を送る', types.join() === 'main-leaving' && calls.messages[0].reason === 'update', types.join());
    t.ok('on の更新: shutdown を送らず、インストーラーを起こした後につながりだけを切る（サーバーは走り続ける）', calls.order.join() === 'quitAndInstall,leave:update' && calls.killed === false);
    link.emit('exit', 0);
    await tick();
    t.ok('on の更新: 切った後のつながりの切断で付け直さず、ダイアログも出さない', calls.reattaches === 0 && calls.dialogs.length === 0);
  }
  {
    // 更新を取りやめた（インストーラーが起きなかった）: main-leaving の後に取りやめを知らせ、サーバーの「猶予を数えない」状態を解く。つながりは切らない
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true, quitFails: true });
    calls.messages.length = 0;
    const failed = await calls.updates.install().then(() => false, () => true);
    const types = calls.messages.map(m => m.type);
    t.ok('on の更新を取りやめたら、main-leaving の後に main-leaving-cancel を送る（つながりは切らず、shutdown もしない）', failed && types.join() === 'main-leaving,main-leaving-cancel' && calls.left === null && calls.killed === false, types.join());
    link.emit('exit', 1);
    await tick();
    t.ok('取りやめの後のつながりの切断は、普通に付け直す（終了の扱いにしない）', calls.reattaches === 1 && calls.quits === 0);
  }
  {
    const { calls, utility } = await start({ env: {} });
    t.ok('off: handover は false', calls.updates?.handover === false);
    await calls.updates.install();
    const types = calls.messages.map(m => m.type);
    t.ok('off の更新は今のまま: update-lock を取ってから shutdown', types.join() === 'update-lock,shutdown' && !types.includes('main-leaving'), types.join());
    void utility;
  }
  {
    const { calls } = await start({ env: {} });
    t.ok('off: 切り替えは始めない', calls.switches.length === 0);
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true });
    const control = calls.switches[0];
    t.ok('on: 付け直した後に切り替えを始め、S1 の ready・resources・main の部品を渡す', calls.switches.length === 1 && control.options.ready.token === 'attached-token' && control.options.resourcesPath === 'C:\\inst\\resources'
      && typeof control.options.reload === 'function' && typeof control.options.abortAll === 'function' && typeof control.options.request === 'function');
    t.ok('on: 状態機械を切り替えの表示の橋（desktop/switch-screen.cjs）へつなぎ、聞くのは橋を通す（表示を持たない画面にだけダイアログ）', calls.screenAttached === control && await control.options.ask({ reason: 'schema', waiting: { count: 0 } }) === 'later');
    control.replacing = true;
    link.emit('exit', 0);
    await tick();
    t.ok('切り替えが S1 を手放している間は、サーバーの終了を知らせず付け直さない', calls.reattaches === 0 && calls.dialogs.length === 0 && calls.quits === 0);
    control.replacing = false;
    control.options.rearm();
    link.emit('exit', 1);
    await tick();
    t.ok('S2 につないだ後は（rearm）、次の切断をまた見張る', calls.reattaches === 1);
    await control.options.reload({ port: 7612, token: 'new-token' });
    t.ok('読み直し: S2 の ready のトークン・ポートで窓を読み込み、ポートを覚える', calls.loads.at(-1) === 'http://127.0.0.1:7612/?token=new-token' && calls.remembered === 7612 && calls.trusted === 'http://127.0.0.1:7612');
  }
}
