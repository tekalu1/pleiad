// 起動のしかた（直に spawn・explorer 経由・cmd start・PowerShell Start-Process）ごとに、起動された素の Node が
// Job Object に入っているか（入っていれば制限フラグと同居の PID）を調べる。
//   node scripts/zero-downtime/runtime/launch-job-probe.mjs
// explorer 経由は .cmd を開くので、コンソールの窓が一瞬出る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-launchjob-'));
const probe = path.join(dir, 'probe.cjs');
fs.writeFileSync(probe, `const fs=require('fs');const koffi=require(${JSON.stringify(path.join(root, 'node_modules/koffi'))});const {jobInfo}=require(${JSON.stringify(path.join(here, 'job-info.cjs'))});
fs.writeFileSync(process.argv[2], JSON.stringify({pid:process.pid, ppid:process.ppid, job:jobInfo(koffi)}));`);
const node = process.execPath;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = {};

async function waitOut(file) {
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await sleep(100);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

{ const out = path.join(dir, 'direct.json'); spawnSync(node, [probe, out], { env }); results.directSpawnFromThisShell = await waitOut(out); }
{ const out = path.join(dir, 'explorer.json'); const cmd = path.join(dir, 'run.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${node}" "${probe}" "${out}"\r\n`);
  spawn('explorer.exe', [cmd], { detached: true, stdio: 'ignore' }).unref(); results.viaExplorer = await waitOut(out); }
{ const out = path.join(dir, 'start.json'); spawn('cmd.exe', ['/c', 'start', '""', '/b', node, probe, out], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref(); results.cmdStart = await waitOut(out); }
{ const out = path.join(dir, 'ps.json'); spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process -WindowStyle Hidden -FilePath '${node}' -ArgumentList '"${probe}"','"${out}"'`], { env }); results.powershellStartProcess = await waitOut(out); }
console.log(JSON.stringify(results, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
