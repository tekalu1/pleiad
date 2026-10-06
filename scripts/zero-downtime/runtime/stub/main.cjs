// NSIS の更新・アンインストールをまたいで、$INSTDIR の外のプロセスが生き残るかを測る試験用の最小アプリ。
// 本物の Pleiad とは appId・製品名・実行ファイル名・userData が違う（インストール版に触れない）。窓は作らない。
// 動きは %TEMP%\zdprobe\scenario.json が決め、記録は %TEMP%\zdprobe\stub.log に 1 行 1 JSON で追記する。
const { app, utilityProcess } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const probeRoot = path.join(os.tmpdir(), 'zdprobe');
app.setPath('userData', path.join(probeRoot, 'userdata'));   // 本物の userData を作らない。ready より前に決める
app.setPath('sessionData', path.join(probeRoot, 'userdata', 'session'));
app.on('window-all-closed', () => {});

const logFile = path.join(probeRoot, 'stub.log');
const log = obj => { try { fs.appendFileSync(logFile, JSON.stringify({ t: Date.now(), pid: process.pid, v: app.getVersion(), ...obj }) + '\n'); } catch { /* 記録できなければ黙る */ } };
const scenario = JSON.parse(fs.readFileSync(path.join(probeRoot, 'scenario.json'), 'utf8'));
const instDir = path.dirname(process.execPath);
const updated = process.argv.includes('--updated');
const childrenFile = path.join(probeRoot, 'children.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let koffi = null, jobInfo = null;
try { koffi = require('koffi'); jobInfo = require('./job-info.cjs').jobInfo; } catch (e) { log({ event: 'koffi-failed', error: String(e) }); }

function childEnv() { return { ...process.env, ZD_KOFFI: scenario.koffiDir }; }
function spawnNode(exe, label, { detached = true } = {}) {
  const c = cp.spawn(exe, [scenario.heartbeat, scenario.hbDir, label], { detached, stdio: 'ignore', windowsHide: true, env: childEnv() });
  c.unref();
  return c.pid;
}

function status() {
  const children = fs.existsSync(childrenFile) ? JSON.parse(fs.readFileSync(childrenFile, 'utf8')) : {};
  const out = {};
  for (const [label, info] of Object.entries(children)) {
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch { /* 死んでいる */ }
    let lastBeatAgoMs = null;
    try {
      const lines = fs.readFileSync(path.join(scenario.hbDir, `${label}.hb`), 'utf8').trim().split('\n');
      lastBeatAgoMs = Date.now() - JSON.parse(lines.at(-1)).t;
    } catch { /* まだ無い */ }
    out[label] = { pid: info.pid, alive, lastBeatAgoMs };
  }
  return out;
}

async function spawnChildren() {
  const children = {};
  const want = new Set(scenario.spawn ?? []);
  const nodeExe = path.join(scenario.runtimeDir, 'node', 'pleiad-node.exe');
  if (want.has('A')) children['A-cp-detached'] = { pid: spawnNode(nodeExe, 'A-cp-detached') };
  if (want.has('A2')) children['A2-cp-attached'] = { pid: spawnNode(nodeExe, 'A2-cp-attached', { detached: false }) };
  if (want.has('B')) {
    // utilityProcess（今のサーバーの置き方）の中から detached で起動する
    const w = utilityProcess.fork(path.join(__dirname, 'spawner.cjs'), [nodeExe, scenario.heartbeat, scenario.hbDir, 'B-utility-detached', scenario.koffiDir], { stdio: 'ignore', serviceName: 'zdprobe server' });
    const pid = await new Promise(resolve => { w.on('message', m => resolve(m.childPid)); setTimeout(() => resolve(null), 5000); });
    children['B-utility-detached'] = { pid, utilityPid: w.pid };
  }
  // 対照: $INSTDIR の中の実行ファイル（NSIS に止められるはず）
  if (want.has('C')) {
    const exe = path.join(instDir, 'zd-ctl-node.exe');
    fs.copyFileSync(nodeExe, exe);
    children['C-in-instdir'] = { pid: spawnNode(exe, 'C-in-instdir') };
  }
  // 対照: $INSTDIR と同じ文字列で始まる兄弟のフォルダー（前方一致で止められるはず）
  if (want.has('D')) {
    const dir = instDir + '-runtime';
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'pleiad-node.exe');
    fs.copyFileSync(nodeExe, exe);
    children['D-instdir-prefix'] = { pid: spawnNode(exe, 'D-instdir-prefix') };
  }
  fs.writeFileSync(childrenFile, JSON.stringify(children));
  return children;
}

// resourcespp の全ファイルを読む時間（NSIS が書いた直後の最初の読みと、2 回目の読みの比較）
async function readAppTree() {
  const base = path.join(process.resourcesPath, 'app');
  const files = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } })(base);
  const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  const once = async () => {
    const t = Date.now(); let i = 0;
    await Promise.all(Array.from({ length: 16 }, async () => { for (;;) { const k = i++; if (k >= files.length) return; await fs.promises.readFile(files[k]); } }));
    return Date.now() - t;
  };
  return { files: files.length, MB: Math.round(bytes / 1048576 * 10) / 10, firstReadMs: await once(), secondReadMs: await once() };
}

async function runUpdate() {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = { info: m => log({ updater: 'info', m: String(m) }), warn: m => log({ updater: 'warn', m: String(m) }), error: m => log({ updater: 'error', m: String(m) }), debug: () => {} };
  const r = await autoUpdater.checkForUpdates();
  log({ event: 'update-checked', version: r?.updateInfo?.version });
  await autoUpdater.downloadUpdate();
  log({ event: 'update-downloaded' });
  app.on('will-quit', () => log({ event: 'will-quit' }));
  app.on('quit', () => log({ event: 'quit' }));
  log({ event: 'quitAndInstall' });
  autoUpdater.quitAndInstall(scenario.updateSilent !== false, true);   // electron-updater: インストーラーを先に spawn してから app.quit()。本物の Pleiad は (false, true)
}

app.whenReady().then(async () => {
  log({ event: 'start', argv: process.argv.slice(1), ppid: process.ppid, exe: process.execPath, updated, job: jobInfo ? jobInfo(koffi) : null });
  if (scenario.readTree) log({ event: 'read-app-tree', updated, ...(await readAppTree()) });
  if (updated) {
    // 更新後の新しい版: 入れ替えの前に起こした子が生きているかを、起動の直後と少し後に見る
    log({ event: 'children-at-start', status: status() });
    await sleep(3000);
    log({ event: 'children-after-3s', status: status() });
    await sleep(scenario.v2LifeMs ?? 5000);
    log({ event: 'children-before-quit', status: status() });
    app.quit();
    return;
  }
  const children = await spawnChildren();
  log({ event: 'spawned', children });
  await sleep(scenario.settleMs ?? 2000);
  log({ event: 'children-settled', status: status() });
  if (scenario.action === 'quit') { log({ event: 'app.quit' }); app.quit(); }
  else if (scenario.action === 'update') await runUpdate();
  // action: 'hold' なら窓も無いまま居続ける（外から止める）
});
