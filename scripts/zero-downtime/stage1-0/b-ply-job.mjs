// 1-0 b: electron-builder が作った本物の `Ply.exe`（`npm run desktop:pack` の win-unpacked）を、起動のしかたを変えて起こし、Job Object の制限を調べる。
//   env -u ELECTRON_RUN_AS_NODE node scripts/zero-downtime/stage1-0/b-ply-job.mjs [--node <node.exe>]
// win-unpacked を `%LOCALAPPDATA%\Programs\<試験用の名前>` へ写し、resources\app の main だけを b-ply-probe-main.cjs に替える
// （実行ファイルは本物の Ply.exe のまま。Job の所属は起こした側と実行ファイルで決まり、アプリのコードでは変わらない）。
// インストール版の Pleiad（%LOCALAPPDATA%\Programs\Ply）・データ置き場には触れない。止めるのはこの試験が起こしたプロセスの PID だけ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const unpacked = path.join(root, 'dist-desktop', 'win-unpacked');
const argAfter = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const nodeExe = argAfter('--node') ?? process.execPath;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = path.join(process.env.LOCALAPPDATA, 'Programs', `ZdBProbe-${process.pid}`);
const dest = path.join(base, 'win-unpacked');
fs.mkdirSync(base, { recursive: true });
console.log('copying', unpacked, '->', dest);
fs.cpSync(unpacked, dest, { recursive: true });
const appDir = path.join(dest, 'resources', 'app');
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
pkg.main = 'zd-probe-main.cjs';
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2));
fs.copyFileSync(path.join(here, 'b-ply-probe-main.cjs'), path.join(appDir, 'zd-probe-main.cjs'));
fs.copyFileSync(path.join(here, '..', 'runtime', 'job-info.cjs'), path.join(appDir, 'job-info.cjs'));
fs.writeFileSync(path.join(base, 'zd-b-config.json'), JSON.stringify({ node: nodeExe }));
const exe = path.join(dest, 'Ply.exe');
const outs = () => fs.readdirSync(base).filter(f => /^zd-b-out-\d+\.json$/.test(f));

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const results = {};
async function run(label, start) {
  const before = new Set(outs());
  start();
  let f = null;
  for (let i = 0; i < 150 && !f; i++) { await sleep(200); f = outs().find(x => !before.has(x)); }
  if (!f) { results[label] = { error: 'no output' }; return; }
  results[label] = JSON.parse(fs.readFileSync(path.join(base, f), 'utf8'));
  await sleep(1500);
}
try {
  // A: 利用者がショートカットを押す形（explorer 経由。更新後に NSIS が ExecShellAsUser で起こす形も explorer 経由）
  await run('explorer', () => spawn('explorer.exe', [exe], { stdio: 'ignore', detached: true }).unref());
  // B: シェルの子（Node から detached で直接）
  await run('direct-detached', () => spawn(exe, [], { env, stdio: 'ignore', detached: true, windowsHide: true }).unref());
  // C: cmd の start 経由
  await run('cmd-start', () => spawn('cmd.exe', ['/c', 'start', '""', exe], { env, stdio: 'ignore', detached: true, windowsHide: true }).unref());
} finally {
  console.log(JSON.stringify(results, null, 1));
  // 念のため、このコピーの実行ファイルから起きたプロセスだけを PID で止める（名前では止めない）
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { encoding: 'utf8' });
  await sleep(1500);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { console.log('cleanup failed', e.message); }
}
