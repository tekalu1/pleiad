// $INSTDIR の外で detached 起動したプロセスが、(a) app.quit (b) NSIS の更新 (c) アンインストール をまたいで生き残るかを測る。
// build-stub.mjs で作った試験用アプリ（PlyZdProbe）だけを入れる。インストール版 Pleiad（Ply.exe）・そのデータ置き場には触れない。
//
//   node scripts/zero-downtime/runtime/nsis-survival.mjs <step> [--from-shell]
//   step: prep | install | run-quit | run-update | run-uninstall | cleanup | all
//   --non-silent  run-update で本物の Pleiad と同じ quitAndInstall(false, true)（インストーラーの進捗バーを出す。人の操作は要らない）にする
//   --from-shell  アプリを explorer 経由ではなく、このシェルの子として直に起動する（Job の所属の比較用）
//
// 環境: ELECTRON_RUN_AS_NODE を外して起動する（Pleiad のシェルには入っている）。止めるのは、この試験が起こしたプロセスだけ（PID は children.json）。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const work = path.join(root, 'temporary', process.env.ZD_WORK_NAME || 'zdprobe');   // build-stub.mjs の出力先（ZD_WORK_NAME で変種を選ぶ）
const probeRoot = path.join(os.tmpdir(), 'zdprobe');
const runtimeDir = path.join(process.env.LOCALAPPDATA, 'zdprobe-runtime');
const instDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'PlyZdProbe');
const stubExe = path.join(instDir, 'PlyZdProbe.exe');
const logFile = path.join(probeRoot, 'stub.log');
const childrenFile = path.join(probeRoot, 'children.json');
const hbDir = path.join(probeRoot, 'hb');
const port = 8765;
const fromShell = process.argv.includes('--from-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readLog = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(pred, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}

function writeScenario(s) {
  fs.mkdirSync(probeRoot, { recursive: true });
  fs.writeFileSync(path.join(probeRoot, 'scenario.json'), JSON.stringify({
    runtimeDir, hbDir, heartbeat: path.join(runtimeDir, 'heartbeat.mjs'), koffiDir: path.join(runtimeDir, 'node_modules', 'koffi'), ...s }));
}

function prep() {
  // $INSTDIR の外の実行場所（design.md §3.2 の形の縮小版）: pleiad-node.exe（公式 Node の改名）と、heartbeat・koffi
  fs.mkdirSync(path.join(runtimeDir, 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtimeDir, 'node', 'pleiad-node.exe'));
  for (const f of ['heartbeat.mjs', 'job-info.cjs']) fs.copyFileSync(path.join(here, f), path.join(runtimeDir, f));
  fs.cpSync(path.join(root, 'node_modules', 'koffi'), path.join(runtimeDir, 'node_modules', 'koffi'), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules', '@koromix'), path.join(runtimeDir, 'node_modules', '@koromix'), { recursive: true });
}

function resetProbe() {
  killChildren();
  fs.rmSync(hbDir, { recursive: true, force: true });
  fs.rmSync(logFile, { force: true });
  fs.rmSync(childrenFile, { force: true });
  fs.mkdirSync(hbDir, { recursive: true });
}

function killChildren() {
  // この試験が起こした子だけ（children.json の PID と、heartbeat の最初の行の PID）
  const pids = new Set();
  if (fs.existsSync(childrenFile)) for (const c of Object.values(JSON.parse(fs.readFileSync(childrenFile, 'utf8')))) { if (c.pid) pids.add(c.pid); if (c.utilityPid) pids.add(c.utilityPid); }
  if (fs.existsSync(hbDir)) for (const f of fs.readdirSync(hbDir)) { try { pids.add(JSON.parse(fs.readFileSync(path.join(hbDir, f), 'utf8').split('\n')[0]).pid); } catch { /* 空 */ } }
  for (const pid of pids) if (alive(pid)) try { process.kill(pid); } catch { /* 済み */ }
}

function launchApp() {
  if (fromShell) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const c = spawn(stubExe, [], { detached: true, stdio: 'ignore', env }); c.unref(); return 'shell';
  }
  const c = spawn('explorer.exe', [stubExe], { detached: true, stdio: 'ignore' }); c.unref(); return 'explorer';
}

function heartbeatReport(sinceMs = 0) {
  const out = {};
  if (!fs.existsSync(hbDir)) return out;
  for (const f of fs.readdirSync(hbDir)) {
    const lines = fs.readFileSync(path.join(hbDir, f), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const start = lines[0], beats = lines.slice(1).map(l => l.t);
    let maxGap = 0, maxGapAt = null;
    for (let i = 1; i < beats.length; i++) if (beats[i] - beats[i - 1] > maxGap) { maxGap = beats[i] - beats[i - 1]; maxGapAt = beats[i - 1]; }
    out[f.replace(/\.hb$/, '')] = { pid: start.pid, running: alive(start.pid), beats: beats.length, maxGapMs: maxGap, maxGapAfterStartMs: maxGapAt ? maxGapAt - start.t : null,
      lastBeatAgoMs: Date.now() - (beats.at(-1) ?? start.t), job: start.job?.inJob ? { limits: start.job.limits, pids: start.job.pids } : false };
  }
  return out;
}

function installApp(version) {
  const r = spawnSync(path.join(work, `PlyZdProbe-${version}.exe`), ['/S', '/currentuser'], { timeout: 180000 });
  return { status: r.status, exeExists: fs.existsSync(stubExe) };
}

async function uninstallApp() {
  const un = path.join(instDir, 'Uninstall PlyZdProbe.exe');
  if (!fs.existsSync(un)) return { skipped: true };
  const t0 = Date.now();
  spawnSync(un, ['/S', '/currentuser'], { timeout: 120000 });
  await waitFor(() => !fs.existsSync(stubExe), 60000, 'uninstall removes exe').catch(() => {});
  await sleep(1500);
  return { ms: Date.now() - t0, exeExists: fs.existsSync(stubExe), instDirExists: fs.existsSync(instDir), instDirLeft: fs.existsSync(instDir) ? fs.readdirSync(instDir) : [] };
}

async function runQuit() {
  resetProbe();
  writeScenario({ spawn: ['A', 'A2', 'B', 'C', 'D'], action: 'quit', settleMs: 2000 });
  const how = launchApp();
  await waitFor(() => readLog().find(e => e.event === 'app.quit'), 60000, 'app.quit');
  const mainPid = readLog()[0].pid;
  await waitFor(() => !alive(mainPid), 30000, 'main exit');
  const quitAt = Date.now();
  await sleep(4000);
  const log = readLog();
  return { launchedVia: how, mainJob: log.find(e => e.event === 'start').job, ppid: log.find(e => e.event === 'start').ppid, afterQuitMs: Date.now() - quitAt, children: heartbeatReport() };
}

async function runUpdate() {
  resetProbe();
  writeScenario({ spawn: ['A', 'A2', 'B', 'C', 'D'], action: 'update', settleMs: 2000, v2LifeMs: 5000, updateSilent: !process.argv.includes('--non-silent'), readTree: true });
  const server = http.createServer((req, res) => {
    const f = path.join(work, 'feed', decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  try {
    const how = launchApp();
    const qai = await waitFor(() => readLog().find(e => e.event === 'quitAndInstall'), 120000, 'quitAndInstall');
    const v1Pid = readLog()[0].pid;
    const v2Start = await waitFor(() => readLog().find(e => e.event === 'start' && e.updated), 240000, 'v2 start').catch(() => null);
    const done = v2Start ? await waitFor(() => readLog().find(e => e.event === 'children-before-quit'), 60000, 'v2 children check').catch(() => null) : null;
    await sleep(3000);
    const log = readLog();
    return {
      launchedVia: how,
      timeline: { quitAndInstallToV2StartMs: v2Start ? v2Start.t - qai.t : null, v1MainGone: !alive(v1Pid), v2Argv: v2Start?.argv, v2Version: v2Start?.v, v2Job: v2Start?.job, v1Job: log[0].job, v1Ppid: log[0].ppid, v2Ppid: v2Start?.ppid },
      v2SawChildren: { atStart: log.find(e => e.event === 'children-at-start')?.status, after3s: log.find(e => e.event === 'children-after-3s')?.status, beforeQuit: done?.status },
      appTreeReads: log.filter(e => e.event === 'read-app-tree').map(({ v, updated, files, MB, firstReadMs, secondReadMs }) => ({ v, updated, files, MB, firstReadMs, secondReadMs })),
      children: heartbeatReport(), updaterLog: log.filter(e => e.updater).map(e => e.m).slice(-12),
    };
  } finally { server.close(); }
}

async function runUninstall() {
  // 更新後（v2 が入っている状態）で、子を全部起こしたまま旧版ではなく今の版のアンインストーラーを走らせる
  resetProbe();
  writeScenario({ spawn: ['A', 'A2', 'B', 'C', 'D'], action: 'hold', settleMs: 2000 });
  const how = launchApp();
  await waitFor(() => readLog().find(e => e.event === 'children-settled'), 60000, 'children-settled');
  const before = heartbeatReport();
  const appPid = readLog()[0].pid;
  const t0 = Date.now();
  const un = await uninstallApp();
  await sleep(3000);
  return { launchedVia: how, uninstall: un, mainStillAliveAfterUninstall: alive(appPid), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.running])), after: heartbeatReport(), elapsedMs: Date.now() - t0 };
}

async function cleanup() {
  killChildren();
  await uninstallApp();
  for (const p of [instDir + '-runtime', path.join(process.env.LOCALAPPDATA, 'plyzdprobe-updater'), path.join(process.env.LOCALAPPDATA, 'zdprobe-updater'), probeRoot, runtimeDir]) {
    for (let i = 0; i < 5; i++) { try { fs.rmSync(p, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  }
  return { instDirExists: fs.existsSync(instDir), runtimeLeft: fs.existsSync(runtimeDir) };
}

const step = process.argv[2];
const steps = { prep, install: () => installApp('1.0.0'), 'run-quit': runQuit, 'run-update': runUpdate, 'run-uninstall': runUninstall, cleanup };
const show = v => console.log(JSON.stringify(v, null, 2));
if (step === 'all') {
  prep();
  console.log('install v1', installApp('1.0.0'));
  try {
    show({ quit: await runQuit() });
    show({ update: await runUpdate() });
    show({ uninstall: await runUninstall() });
  } finally { show({ cleanup: await cleanup() }); }
} else if (steps[step]) show(await steps[step]());
else { console.error('usage: nsis-survival.mjs prep|install|run-quit|run-update|run-uninstall|cleanup|all'); process.exit(2); }
