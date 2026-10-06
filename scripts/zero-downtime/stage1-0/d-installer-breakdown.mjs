// 1-0 d: 本物の配布物の形（本物の `npm run desktop:pack` の中身・本物の installer.nsh・本物と同じ圧縮）で、
// `quitAndInstall` から新しい版の main が動き出すまでの時間と内訳を測る。
//   env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/d-installer-breakdown.mjs build | measure [--silent] | cleanup
//
// build: dist-desktop/win-unpacked を temporary/zdprobe-d/stage-tree へ写し、Ply.exe を PlyZdProbe.exe に改名し、resources/app の main だけを
//        段階 0 の試験用 main（runtime/stub/main.cjs）に替える（4,017 ファイルの木・Electron 本体・node_modules は本物のまま）。
//        それを `electron-builder --prepackaged`（appId jp.ply.zdprobe・製品名 PlyZdProbe・本物の build/installer.nsh・圧縮は既定）で 1.0.0 / 1.0.1 の installer にする。
// measure: 1.0.0 を入れ、electron-updater の quitAndInstall（既定は本物と同じ (false, true)＝進捗バーあり。--silent で (true, true)）で 1.0.1 へ更新し、
//          100ms ごとのプロセス一覧と 250ms ごとの $INSTDIR のファイル数で、各段階の時刻を記録する。人の操作・OS のキー入力は要らない。
// インストール版 Pleiad（Ply.exe）・そのデータ置き場には触れない。止めるのはこの試験が起こしたプロセスの PID だけ。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const runtimeScripts = path.join(root, 'scripts', 'zero-downtime', 'runtime');
// ZD_D_COMPRESSION=store で圧縮なしの変種（展開の時間のうち、圧縮の展開と書き込みを切り分ける）。既定は本物と同じ（electron-builder の既定）
const compression = process.env.ZD_D_COMPRESSION || null;
const work = path.join(root, 'temporary', compression ? `zdprobe-d-${compression}` : 'zdprobe-d');
const tree = path.join(work, 'stage-tree');
const feed = path.join(work, 'feed');
const probeRoot = path.join(os.tmpdir(), 'zdprobe');
const instDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'PlyZdProbe');
const logFile = path.join(probeRoot, 'stub.log');
const port = 8765;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// ------------------------------------------------------------------ build
function build() {
  const unpacked = path.join(root, 'dist-desktop', 'win-unpacked');
  if (!fs.existsSync(path.join(unpacked, 'Ply.exe'))) throw new Error('run `npm run desktop:pack` first');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(feed, { recursive: true });
  console.log('copying win-unpacked ->', tree);
  fs.cpSync(unpacked, tree, { recursive: true });
  fs.renameSync(path.join(tree, 'Ply.exe'), path.join(tree, 'PlyZdProbe.exe'));
  const app = path.join(tree, 'resources', 'app');
  for (const [from, to] of [['main.cjs', 'zd-main.cjs'], ['spawner.cjs', 'spawner.cjs']]) fs.copyFileSync(path.join(runtimeScripts, 'stub', from), path.join(app, to));
  fs.copyFileSync(path.join(runtimeScripts, 'job-info.cjs'), path.join(app, 'job-info.cjs'));
  // --prepackaged は app-update.yml を書かない（通常のビルドは publish の設定から resources/ に書く）。electron-updater が読むので、同じ内容を置く
  fs.writeFileSync(path.join(tree, 'resources', 'app-update.yml'), `provider: generic
url: http://127.0.0.1:${port}/
updaterCacheDirName: plyzdprobe-updater
`);
  const config = {
    appId: 'jp.ply.zdprobe', productName: 'PlyZdProbe', artifactName: 'PlyZdProbe-${version}.${ext}',
    electronVersion: '44.5.1',
    ...(compression ? { compression } : {}),
    directories: { output: path.join(work, 'out') },
    win: { executableName: 'PlyZdProbe', target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, include: path.join(root, 'build', 'installer.nsh') },
    publish: { provider: 'generic', url: `http://127.0.0.1:${port}/`, updaterCacheDirName: 'plyzdprobe-updater' },
  };
  const configFile = path.join(work, 'builder-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  for (const version of ['1.0.0', '1.0.1']) {
    const pj = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    Object.assign(pj, { name: 'zdprobe', version, main: 'zd-main.cjs', description: 'zero-downtime update probe (real-shape payload)' });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(pj, null, 2));
    const r = spawnSync('npx', ['electron-builder', '--config', configFile, '--prepackaged', tree, '--win', 'nsis', '--x64', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error('electron-builder failed');
    fs.copyFileSync(path.join(work, 'out', `PlyZdProbe-${version}.exe`), path.join(work, `PlyZdProbe-${version}.exe`));
    if (version === '1.0.1') for (const f of ['latest.yml', `PlyZdProbe-${version}.exe`]) fs.copyFileSync(path.join(work, 'out', f), path.join(feed, f));
  }
  const files = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? files(path.join(d, e.name)) : 1), 0);
  const bytes = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? bytes(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  console.log(JSON.stringify({ installerMB: Math.round(fs.statSync(path.join(work, 'PlyZdProbe-1.0.0.exe')).size / 1048576 * 10) / 10, treeFiles: files(tree), treeMB: Math.round(bytes(tree) / 1048576 * 10) / 10, appFiles: files(path.join(tree, 'resources', 'app')) }));
}

// ------------------------------------------------------------------ sampler
function createSampler() {
  const koffi = require(path.join(root, 'node_modules', 'koffi'));
  const k32 = koffi.load('kernel32.dll');
  const PE = koffi.struct('ZD_PROCESSENTRY32W', { dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32_t', cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t', dwFlags: 'uint32_t', szExeFile: koffi.array('char16_t', 260, 'String') });
  const Snap = k32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)');
  const First = k32.func('bool __stdcall Process32FirstW(intptr_t snap, _Inout_ uint8_t *entry)');
  const Next = k32.func('bool __stdcall Process32NextW(intptr_t snap, _Inout_ uint8_t *entry)');
  const Close = k32.func('bool __stdcall CloseHandle(intptr_t h)');
  const pidAt = koffi.offsetof(PE, 'th32ProcessID'), exeAt = koffi.offsetof(PE, 'szExeFile');
  const processes = () => {
    const snap = Snap(0x2, 0);
    const out = new Map();
    const entry = Buffer.alloc(koffi.sizeof(PE));
    entry.writeUInt32LE(entry.length, 0);
    try { for (let ok = First(snap, entry); ok; ok = Next(snap, entry)) out.set(entry.readUInt32LE(pidAt), entry.toString('utf16le', exeAt, exeAt + 520).replace(/\0.*$/, '')); } finally { Close(snap); }
    return out;
  };
  const events = [];     // { t, kind, name?, pid?, files? }
  const seen = new Map(); // pid -> name
  const countFiles = dir => { let n = 0; const stack = [dir]; while (stack.length) { const d = stack.pop(); let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of es) { if (e.isDirectory()) stack.push(path.join(d, e.name)); else n++; } } return n; };
  let timerP = null, timerF = null, lastFiles = -1;
  const t0 = () => Date.now();
  return {
    start() {
      timerP = setInterval(() => {
        const now = processes();
        const t = t0();
        for (const [pid, name] of now) if (!seen.has(pid) && /plyzdprobe|uninstall|__uninstaller|elevate|nsis/i.test(name)) { seen.set(pid, name); events.push({ t, kind: 'proc-start', name, pid }); }
        for (const [pid, name] of [...seen]) if (!now.has(pid)) { seen.delete(pid); events.push({ t, kind: 'proc-end', name, pid }); }
      }, 100);
      timerF = setInterval(() => {
        const n = countFiles(instDir);
        if (n !== lastFiles) { lastFiles = n; events.push({ t: t0(), kind: 'files', files: n }); }
      }, 250);
    },
    stop() { clearInterval(timerP); clearInterval(timerF); return events; },
  };
}

// ------------------------------------------------------------------ measure
const readLog = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
async function waitFor(pred, timeoutMs, what) { const t0 = Date.now(); for (;;) { const v = pred(); if (v) return v; if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`); await sleep(200); } }

async function measure() {
  const silent = process.argv.includes('--silent');
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.rmSync(logFile, { force: true });
  fs.writeFileSync(path.join(probeRoot, 'scenario.json'), JSON.stringify({ spawn: [], action: 'update', settleMs: 500, v2LifeMs: 4000, updateSilent: silent, readTree: true, runtimeDir: path.join(os.tmpdir(), 'zdprobe-none'), hbDir: path.join(probeRoot, 'hb'), heartbeat: '', koffiDir: '' }));
  console.log('installing 1.0.0 (silent, /S) ...');
  const t = Date.now();
  const inst = spawnSync(path.join(work, 'PlyZdProbe-1.0.0.exe'), ['/S', '/currentuser'], { timeout: 300000 });
  const installMs = Date.now() - t;
  if (!fs.existsSync(path.join(instDir, 'PlyZdProbe.exe'))) throw new Error('install failed');
  const files = (function count(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0); })(instDir);
  const server = http.createServer((req, res) => {
    const f = path.join(feed, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); } else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const sampler = createSampler();
  try {
    // 利用者がショートカットを押す形（explorer 経由）
    spawn('explorer.exe', [path.join(instDir, 'PlyZdProbe.exe')], { detached: true, stdio: 'ignore' }).unref();
    const qai = await waitFor(() => readLog().find(e => e.event === 'quitAndInstall'), 180000, 'quitAndInstall');
    sampler.start();
    const v2 = await waitFor(() => readLog().find(e => e.event === 'start' && e.updated), 300000, 'v2 start').catch(() => null);
    await waitFor(() => readLog().find(e => e.event === 'children-before-quit'), 60000, 'v2 settle').catch(() => null);
    await sleep(1000);
    const ev = sampler.stop();
    const log = readLog();
    const rel = t => t == null ? null : Math.round((t - qai.t) / 100) / 10;   // 秒（0.1 秒）
    const firstOf = (kind, re) => ev.find(e => e.kind === kind && re.test(e.name ?? ''));
    const lastOf = (kind, re) => [...ev].reverse().find(e => e.kind === kind && re.test(e.name ?? ''));
    const filesCurve = ev.filter(e => e.kind === 'files').map(e => [rel(e.t), e.files]);
    const full = files;
    const minFiles = Math.min(...filesCurve.map(x => x[1]));
    const tMin = filesCurve.find(x => x[1] === minFiles)?.[0];
    const tFullAgain = filesCurve.find(x => x[0] >= (tMin ?? 0) && x[1] >= full * 0.995)?.[0];
    const summary = {
      silent, compression: compression ?? 'default', installOf1_0_0Ms: installMs, installedFiles: files,
      seconds_from_quitAndInstall: {
        oldMainExit: rel(firstOf('proc-end', /^plyzdprobe\.exe$/i)?.t),
        installerFirstSeen: rel(firstOf('proc-start', /^plyzdprobe-1\.0\.1\.exe$/i)?.t),
        oldUninstallerFirstSeen: rel(ev.find(e => e.kind === 'proc-start' && /uninstall/i.test(e.name))?.t),
        oldUninstallerLastSeen: rel([...ev].reverse().find(e => e.kind === 'proc-end' && /uninstall/i.test(e.name))?.t),
        instdirFilesMinReached: tMin, instdirFilesMin: minFiles,
        instdirFilesFullAgain: tFullAgain,
        newMainReady: v2 ? rel(v2.t) : null,
      },
      stubEvents: log.filter(e => ['start', 'quitAndInstall', 'will-quit', 'quit', 'update-checked', 'update-downloaded'].includes(e.event)).map(e => ({ event: e.event, v: e.v, atSec: rel(e.t), updated: e.updated })),
      // 起動のしかた別の Job（v1: explorer 経由、v2: 更新後に NSIS が起こす）
      startJobs: log.filter(e => e.event === 'start').map(e => ({ v: e.v, updated: e.updated, ppid: e.ppid, job: e.job ? { inJob: e.job.inJob, limits: e.job.limits } : null })),
      appTreeReads: log.filter(e => e.event === 'read-app-tree').map(({ v, updated, files, MB, firstReadMs, secondReadMs }) => ({ v, updated, files, MB, firstReadMs, secondReadMs })),
      procEvents: ev.filter(e => e.kind !== 'files').map(e => ({ at: rel(e.t), kind: e.kind, name: e.name, pid: e.pid })),
      filesCurve,
    };
    console.log(JSON.stringify(summary, null, 1));
    fs.writeFileSync(path.join(work, 'measure-result.json'), JSON.stringify(summary, null, 1));
  } finally { sampler.stop(); server.close(); }
}

async function cleanup() {
  spawnSync(process.execPath, [path.join(runtimeScripts, 'nsis-survival.mjs'), 'cleanup'], { env: { ...process.env, ZD_WORK_NAME: path.basename(work) }, stdio: 'inherit' });
}

const step = process.argv[2];
if (step === 'build') build();
else if (step === 'measure') { try { await measure(); } finally { await cleanup(); } }
else if (step === 'cleanup') await cleanup();
else { console.error('usage: d-installer-breakdown.mjs build|measure [--silent]|cleanup'); process.exit(2); }
