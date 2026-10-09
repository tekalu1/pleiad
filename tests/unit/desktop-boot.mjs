// desktop/main.cjs の boot() の、サーバーの起こし方の選び方（無停止の更新 1-4。docs/zero-downtime-update/plan.md 1-4）。
// 既存の desktop-exit-dialog.mjs と同じく vm で main.cjs を評価し、Electron と desktop/ の部品は偽物に差し替える。
//   - 既定: パッケージ版は on（env が無ければ on）・開発（パッケージ版でない）は off。off を明示・on でもパッケージ版でない・chooseServer が null → 今の utilityProcess（変わらない）
//   - on（既定を含む）のパッケージ版: パイプの包みを worker にして、つなぐ前に message を付け、ready のポート・トークンで窓を読み込む。utilityProcess は起こさない
//   - 起動の失敗: 文は describeBootError。パイプのサーバーは kill（shutdown）せず leave で切る
//   - サーバーが居なくなったとき: bye 'replaced' なら静かに終わる・つながりだけ切れたなら付け直す・居なければ起こし直して窓を 1 回読み直す（2e。desktop/server-restart.cjs）・
//     起こし直せない・続けて落ちるなら「サーバーが終了しました」。切り替え中・main-leaving の後・bye 'closing'・off は起こし直さない
//   - 更新（1-6）: on は作業を止めず・ロックせず main-leaving → つながりだけ切る（shutdown しない）、off は今のまま update-lock → shutdown。
//     付け直した後は切り替え（desktop/switch.cjs）を始め、S1 を手放している間はサーバーの終了を知らせない
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const name = 'desktop-boot';
export const title = 'main の boot: AGENT_HOST_HANDOVER の選び方（utilityProcess のまま・パイプの包み）と、サーバーが居なくなったときの扱い';

const source = fs.readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');
const tick = () => new Promise(resolve => setImmediate(resolve));
const workerMessages = createRequire(import.meta.url)('../../desktop/worker-messages.cjs');
const loginItem = createRequire(import.meta.url)('../../desktop/login-item.cjs');
// 本物の橋と同じに message の受け手を 1 つ付ける偽物（受け手が worker の listener を増やさないことを見る）
const listens = (calls, key) => worker => { worker.on('message', () => {}); if (key) calls[key] = worker; return { keepOnClose: () => false, close: () => {} }; };

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

async function start({ env = {}, packaged = false, choice = 'link', connectError = null, reattach = false, resourcesPath = 'C:\\inst\\resources', quitFails = false, hangInstall = false, restart = { ok: false, reason: 'failed' } } = {}) {
  const calls = { dialogs: [], messages: [], quits: 0, forks: 0, connects: 0, loads: [], left: null, killed: false, chosen: null, reattaches: 0, logs: [], order: [], switches: [], updates: null, restarts: 0, restarterOptions: null };
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
    utilityProcess: { fork: (_file, _args, options) => { calls.forks++; calls.forkOptions = options; queueMicrotask(() => utility.emit('message', { type: 'ready', port: 7499, token: 'utility-token' })); return utility; } },
    shell: { openExternal: () => Promise.resolve() },
    ipcMain: { on: () => {}, handle: () => {} },
    Notification: class {}, nativeTheme: { shouldUseDarkColors: false }, safeStorage: {}, session: {}, nativeImage: {}, Menu: {}, powerMonitor: new EventEmitter(), screen: calls.screen = new EventEmitter(),
    autoUpdater: new EventEmitter(),
  };
  // electron-updater の quitAndInstall: インストーラーを起こした後に before-quit-for-update を出して終わる（node_modules/electron-updater の BaseUpdater）
  const autoUpdater = new EventEmitter();
  autoUpdater.quitAndInstall = () => { calls.order.push('quitAndInstall'); if (hangInstall) return; if (quitFails) throw new Error('installer did not start'); electron.autoUpdater.emit('before-quit-for-update'); };
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
    './secret-bridge.cjs': { attachSecretBridge: listens(calls, 'secretBridge') },
    './i18n.cjs': { t: key => key, setLocale: () => {}, resolveLocale: () => 'ja', initDesktopI18n: async () => {} },
    './file-bridge.cjs': { attachFileBridge: listens(calls) },
    './resident.cjs': { attachResident: ({ worker }) => listens(calls)(worker) },
    './window-trust.cjs': { createWindowTrust: () => ({ register: () => {}, update: (_window, patch) => { calls.trusted = patch.origin; } }) },
    './remote-windows.cjs': { createRemoteWindows: () => ({ attach: () => {}, attachWorker: listens(calls), handleArgv: () => false }) },
    './browser-panel.cjs': { createBrowserPanel: () => ({ attach: () => {} }) },
    './browser-viewer-bridge.cjs': { attachBrowserViewerBridge: listens(calls) },
    './computer/service.cjs': { attachComputerService: listens(calls), withPerMonitorDpi: win32 => win32 },
    './computer/win32.cjs': { loadWin32: () => { throw Object.assign(new Error('not windows'), { reason: 'platform' }); } },
    './computer/mac.cjs': { loadMac: () => { throw Object.assign(new Error('not macOS'), { reason: 'platform' }); } },
    './chrome-pill.cjs': { attachChromePill: (worker, options) => { calls.chromePillOptions = options; return listens(calls, 'chromePill')(worker); } },
    './chrome-os/index.cjs': { createChromeOs: () => ({ reconceal: () => { calls.reconceals = (calls.reconceals ?? 0) + 1; }, closeAllAgents: () => { calls.closeAlls = (calls.closeAlls ?? 0) + 1; if (calls.failCloseAll) throw new Error('boom'); return 0; } }), attachChromeOs: listens(calls) },
    './browser-screencast-bridge.cjs': { attachBrowserScreencastBridge: listens(calls) },
    './computer-overlay.cjs': { attachComputerOverlay: listens(calls) },
    './agent-browser-bin.cjs': { prepareAgentBrowserBin: () => '' },
    './notifications.cjs': { createDesktopNotifications: () => () => {} },
    './server-boot.cjs': serverBoot,
    './server-restart.cjs': { createServerRestarter: options => { calls.restarterOptions = options; return { restart: async () => { calls.restarts++; calls.order.push('restart'); return typeof restart === 'function' ? restart(calls) : restart; } }; } },
    './worker-messages.cjs': workerMessages,
    './login-item.cjs': loginItem,
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
    t.ok('off: サーバーの出力を userData の logs/server-dev.log へ向ける（開発版。core/server-log.mjs がサーバーの中で書く）', calls.forkOptions?.env?.AGENT_HOST_SERVER_LOG === path.join('test-user', 'logs', 'server-dev.log'));
  }
  {
    const { calls, utility } = await start({ env: { AGENT_HOST_HANDOVER: 'off' }, packaged: true });
    t.ok('off のパッケージ版: 出力は userData の logs/server.log', calls.forks === 1 && calls.forkOptions?.env?.AGENT_HOST_SERVER_LOG === path.join('test-user', 'logs', 'server.log'));
    t.ok('橋が 9 つ message を受けても、worker の message の listener は 1 つ（MaxListenersExceededWarning を出さない。desktop/worker-messages.cjs）', utility.listenerCount('message') === 1 && calls.secretBridge !== utility);
    const seen = [];
    calls.secretBridge.on('message', message => seen.push(message.type));
    utility.emit('message', { type: 'probe' });
    calls.secretBridge.postMessage({ type: 'probe-out' });
    t.ok('橋に渡すのは worker の包み: message は届き、postMessage は worker へ', seen.join() === 'probe' && calls.messages.some(m => m.type === 'probe-out'));
  }
  {
    const { calls } = await start({ env: { AGENT_HOST_SERVER_LOG: 'D:/x/mine.log' } });
    t.ok('AGENT_HOST_SERVER_LOG があればそれを使う', calls.forkOptions?.env?.AGENT_HOST_SERVER_LOG === 'D:/x/mine.log');
  }
  {
    const { calls, link } = await start({ env: {}, packaged: true });
    t.ok('パッケージ版の既定は on: env が無くてもパイプの包みを worker にし、utilityProcess は起こさない', calls.forks === 0 && calls.connects === 1 && link.listenerCount('message') === 1 && (calls.secretBridge.postMessage({ type: 'via-hub' }), calls.messages.at(-1)?.type === 'via-hub') && calls.chosen !== null);
    const snapshots = calls.messages.filter(message => message.type === 'chrome-pill-snapshot').length;
    link.emit('message', { type: 'ready', port: 7611, token: 'attached-token' });
    t.ok('サーバーへ付け直した後も Chrome ピルの引き継ぎ状態を取り直す', calls.messages.filter(message => message.type === 'chrome-pill-snapshot').length === snapshots + 1);
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
    const { calls } = await start({ env: { AGENT_HOST_HANDOVER: 'off' }, packaged: true });
    calls.screen.emit('display-added'); calls.screen.emit('display-removed'); calls.screen.emit('display-metrics-changed');
    t.ok('画面の構成が変わったら（display-added・display-removed・display-metrics-changed）、隠しているエージェントの Chrome の窓を置き直す（chromeOs.reconceal。ADR 0154）', calls.reconceals === 3, String(calls.reconceals));
    // ピルはモニターの上端より上に出さない（最大化した窓の上端は見えない枠の分だけ画面の外）。その判定に electron の screen が要る
    t.ok('Chrome のピルに electron の screen を渡す（無いと最大化した窓でピルが画面の上にはみ出る）', calls.chromePillOptions?.electron?.screen === calls.screen);
  }
  {
    // 画面の外に隠したエージェントの窓は、Pleiad が終わると誰にも戻せない。終了の道で片付ける（閉じる。閉じられなければ戻す）
    const { app, calls } = await start({ env: { AGENT_HOST_HANDOVER: 'off' }, packaged: true });
    t.ok('前提: 起動しただけでは片付けない', calls.closeAlls === undefined);
    app.emit('will-quit');
    t.ok('will-quit で、隠しているエージェントの Chrome の窓を片付ける（chromeOs.closeAllAgents。ADR 0154）', calls.closeAlls === 1, String(calls.closeAlls));
    app.exit(0);
    t.ok('will-quit を通らない app.exit（再起動・致命的な終了）でも片付ける', calls.closeAlls === 2, String(calls.closeAlls));
    calls.failCloseAll = true;
    let threw = null;
    try { app.emit('will-quit'); app.exit(0); } catch (error) { threw = error; }
    t.ok('片付けが投げても、終了を妨げない（ログに残す）', threw === null && calls.closeAlls === 4 && calls.logs.some(line => line.includes('closeAllAgents failed')), String(threw?.message));
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
    t.ok('on のパッケージ版: パイプの包みを worker にし、utilityProcess は起こさない', calls.forks === 0 && calls.connects === 1 && link.listenerCount('message') === 1 && (calls.secretBridge.postMessage({ type: 'via-hub' }), calls.messages.at(-1)?.type === 'via-hub'));
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
    t.ok('パイプの経路: サーバーが居なくて起こし直しにも失敗したら、致命的なダイアログ（起こし直せなかった文）', calls.reattaches === 1 && calls.restarts === 1 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.restartFailed' && calls.quits === 0);
  }
  {
    // 落ちた（付け直せない）→ 同じ版・トークン・ポートで起こし直す（2e）。窓は 1 回だけ読み直し、次の落ちも見張る
    const next = { type: 'ready', port: 7611, token: 'attached-token', locale: 'ja' };
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: false, restart: { ok: true, ready: next } });
    t.ok('起こし直し: 起こす部品に、最後の ready・実行場所の置き場・データ置き場・resources を渡す', calls.restarterOptions.getReady().token === 'attached-token' && calls.restarterOptions.link === link && calls.restarterOptions.dataDir === 'D:\\data' && calls.restarterOptions.resourcesPath === 'C:\\inst\\resources');
    const loads = calls.loads.length;
    link.emit('exit', 1);
    await tick();
    t.ok('起こし直し: 落ちたら付け直しを試してから起こし直し、ダイアログを出さず終了もしない', calls.order.filter(step => step === 'restart').length === 1 && calls.reattaches === 1 && calls.dialogs.length === 0 && calls.quits === 0);
    t.ok('起こし直し: 窓は 1 回だけ、起こし直したサーバーの ready のポート・トークンで読み直す', calls.loads.length === loads + 1 && calls.loads.at(-1) === 'http://127.0.0.1:7611/?token=attached-token' && calls.remembered === 7611);
    link.emit('exit', 1);
    await tick();
    t.ok('起こし直し: 起こし直した後の次の落ちも見張る（もう一度起こし直す）', calls.restarts === 2 && calls.loads.length === loads + 2 && calls.dialogs.length === 0);
  }
  {
    // 起こし直したサーバーの port が変わったとき（同じポートが取れなかった）は origin を替えて読み直す
    const next = { type: 'ready', port: 7777, token: 'attached-token' };
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, restart: { ok: true, ready: next } });
    link.emit('exit', 1);
    await tick();
    t.ok('起こし直し: ポートが変わったら新しい origin で読み直し、信頼する origin も替える', calls.loads.at(-1) === 'http://127.0.0.1:7777/?token=attached-token' && calls.trusted === 'http://127.0.0.1:7777' && calls.remembered === 7777);
  }
  {
    // サーバーが起こし直されたとき、最後の ready は新しいサーバーのもの（次に落ちたとき、その版・トークンで起こす）
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, restart: { ok: true, ready: { type: 'ready', port: 7611, token: 'attached-token' } } });
    link.emit('message', { type: 'ready', port: 7611, token: 'attached-token', runtimeKey: 'v2' });
    t.ok('起こし直し: つながり直すたびに届く ready を、次の起こし直しの材料として持つ', calls.restarterOptions.getReady().runtimeKey === 'v2');
  }
  {
    // 続けて落ちる（起こす部品が loop で断る）なら起こし直しをやめてダイアログ
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, restart: { ok: false, reason: 'loop' } });
    link.emit('exit', 1);
    await tick();
    t.ok('起こし直し: 短い間に続けて落ちて起こし直しを断られたら、窓を読み直さずダイアログ', calls.loads.length === 1 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.restartFailed');
  }
  {
    // 起こし直している間に利用者が終了した: 起こしたサーバーに shutdown を送って終わらせ、窓は読み直さない
    let finish;
    const next = { type: 'ready', port: 7611, token: 'attached-token' };
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, restart: () => new Promise(resolve => { finish = () => resolve({ ok: true, ready: next }); }) });
    const loads = calls.loads.length;
    link.emit('exit', 1);
    await tick();
    // 終了の流れ（closeSafely）は running の問い合わせに答える相手が居ないので、quitting を立てる session-end で代える
    calls.window.emit('session-end');
    calls.messages.length = 0;
    finish();
    await tick();
    t.ok('起こし直し中に終了が始まったら、起こしたサーバーを終わらせ、窓は読み直さない', calls.messages.some(m => m.type === 'shutdown') && calls.loads.length === loads && calls.dialogs.length === 0);
  }
  {
    // サーバー自身が終わるところ（bye closing）・切り替え中・off は起こし直さない
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, reattach: true });
    link.exitReason = 'closing';
    link.emit('exit', 0);
    await tick();
    t.ok('起こし直さない: サーバーが終わるところ（bye closing）', calls.restarts === 0 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.exited');
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, restart: { ok: true, ready: { type: 'ready', port: 7611, token: 't' } } });
    calls.switches[0].replacing = true;
    link.emit('exit', 0);
    await tick();
    t.ok('起こし直さない: 切り替えが古いサーバーを手放している間', calls.restarts === 0 && calls.reattaches === 0 && calls.dialogs.length === 0);
  }
  {
    const { calls, utility } = await start({ env: {}, restart: { ok: true, ready: { type: 'ready', port: 7611, token: 't' } } });
    utility.emit('exit');
    await tick();
    t.ok('起こし直さない: off（utilityProcess）は今のとおり「サーバーが終了しました」', calls.restarterOptions === null && calls.restarts === 0 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.exited');
  }
  {
    // main-leaving を送った後（更新で離れる途中）に切れても起こし直さない。更新を取りやめたら、また起こし直す
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, hangInstall: true, restart: { ok: true, ready: { type: 'ready', port: 7611, token: 'attached-token' } } });
    void calls.updates.install().catch(() => {});
    await tick();
    link.emit('exit', 1);
    await tick();
    t.ok('起こし直さない: main-leaving の後（更新で離れる途中）に切れたとき', calls.messages.some(m => m.type === 'main-leaving') && calls.restarts === 0 && calls.dialogs.length === 1 && calls.dialogs[0][1].message === 'server.exited');
  }
  {
    // 更新で離れるときは、隠したエージェントの Chrome の窓を閉じない（新しい main が印から引き継ぐ。ADR 0167）
    const { app, calls } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, hangInstall: true });
    void calls.updates.install().catch(() => {});
    await tick();
    app.emit('will-quit');
    app.exit(0);
    t.ok('更新で離れるとき（main-leaving の後）は、隠した窓を閉じない', calls.messages.some(m => m.type === 'main-leaving') && calls.closeAlls === undefined, String(calls.closeAlls));
  }
  {
    const { calls, link } = await start({ env: { AGENT_HOST_HANDOVER: 'on' }, packaged: true, quitFails: true, restart: { ok: true, ready: { type: 'ready', port: 7611, token: 'attached-token' } } });
    await calls.updates.install().catch(() => {});
    link.emit('exit', 1);
    await tick();
    t.ok('更新を取りやめた後（main-leaving-cancel）は、また起こし直す', calls.restarts === 1 && calls.dialogs.length === 0);
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
