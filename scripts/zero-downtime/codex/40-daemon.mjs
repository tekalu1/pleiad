// 項目 2: codex app-server daemon（start / version / stop）を一時の CODEX_HOME で。インストール版の daemon には触れない。
import { makeEnv, log, sleep, codexExe } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const E = await makeEnv();
const run = (args) => { try { return execFileSync(codexExe(), ['app-server', 'daemon', ...args], { env: E.env, encoding: 'utf8', timeout: 60000, windowsHide: true }).trim(); } catch (e) { return 'EXIT ' + e.status + ' ' + String(e.stdout ?? '') + String(e.stderr ?? ''); } };
const list = () => execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { \"$($_.ProcessId) <- $($_.ParentProcessId) $($_.CommandLine)\" }"], { encoding: 'utf8', windowsHide: true }).trim().split('\n').map((l) => l.replace(E.home, '<CODEX_HOME>').slice(0, 220));
try {
  log('codex.exe before:', list());
  log('version:', run(['version']));
  log('start:', run(['start']));
  await sleep(4000);
  log('codex.exe after start:', list());
  log('home tree:', fs.readdirSync(E.home).join(','), '| control:', fs.existsSync(path.join(E.home, 'app-server-control')) ? fs.readdirSync(path.join(E.home, 'app-server-control')).join(',') : '-');
  log('version (running):', run(['version']));
} finally {
  log('stop:', run(['stop']));
  await sleep(2000);
  log('codex.exe after stop:', list());
  // stop のあとも `daemon pid-update-loop` が残る。この CODEX_HOME のものだけを止める（コマンドラインで確かめる）
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(E.home)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
  await sleep(1500);
  await E.close();
}
