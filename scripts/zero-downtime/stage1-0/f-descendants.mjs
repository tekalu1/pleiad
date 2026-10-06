// 1-0 f: サーバー（起こす側）が落ちたとき、detached でない子と、その子が起こした孫が生き残るか。
//   node scripts/zero-downtime/stage1-0/f-descendants.mjs
// 起こす側の代わりの Node（stand-in。サーバーと同じく detached で起こし、Job には入っていない）が、次の木を作る:
//   direct        stand-in → 長く走る node（detached なし）                       … サーバーの直の子（Claude の CLI・codex・agy・外部の stdio MCP と同じ形）
//   cmd-ping      stand-in → cmd.exe → ping.exe                                  … 子が Node ではなく、孫を普通に起こす（bash・npm のシムなど）
//   node-attached stand-in → node → node（どちらも detached なし）                 … 子が Node で、孫を libuv で起こす
//   node-detached stand-in → node → node（孫は detached: true）                   … 子が孫を切り離して起こす
//   direct-detached stand-in → 長く走る node（detached: true）                    … 比較用（切り離した子）
// stand-in を（強制終了 / 自分で exit）して、2 秒後にそれぞれの末端が生きているかを見る。止めるのはこの試験が起こしたプロセスの PID だけ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-f-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const SLEEPER = 'setTimeout(()=>{},120000)';

const standin = path.join(work, 'standin.mjs');
fs.writeFileSync(standin, `import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [dir, how] = process.argv.slice(2);
const SLEEPER = ${JSON.stringify(SLEEPER)};
const out = {};
const wr = () => fs.writeFileSync(path.join(dir, 'pids.json'), JSON.stringify(out));
const exe = process.execPath;
const opts = (detached = false) => ({ detached, stdio: 'ignore', windowsHide: true });
out.direct = spawn(exe, ['-e', SLEEPER], opts()).pid;
out.directDetached = spawn(exe, ['-e', SLEEPER], opts(true)).pid;
const cmd = spawn('cmd.exe', ['/c', 'ping -n 120 127.0.0.1 > nul'], opts());
out.cmd = cmd.pid;
const nodeAttached = spawn(exe, ['-e', "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','" + SLEEPER + "'],{stdio:'ignore',windowsHide:true});require('fs').writeFileSync(" + JSON.stringify(path.join(dir, 'na.json')) + ",JSON.stringify({leaf:c.pid}));setTimeout(()=>{},120000)"], opts());
out.nodeAttached = nodeAttached.pid;
const nodeDetached = spawn(exe, ['-e', "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','" + SLEEPER + "'],{detached:true,stdio:'ignore',windowsHide:true});require('fs').writeFileSync(" + JSON.stringify(path.join(dir, 'nd.json')) + ",JSON.stringify({leaf:c.pid}));setTimeout(()=>{},120000)"], opts());
out.nodeDetached = nodeDetached.pid;
setTimeout(() => { wr(); fs.writeFileSync(path.join(dir, 'ready'), '1'); if (how === 'exit') setTimeout(() => process.exit(0), 500); else setInterval(() => {}, 1000); }, 1500);
`);

function pingChild(cmdPid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${cmdPid}" | Where-Object { $_.Name -eq 'PING.EXE' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true });
  return Number(r.stdout.trim().split(/\s+/)[0]) || null;
}

const results = {};
for (const how of ['crash', 'exit']) {
  const dir = path.join(work, how);
  fs.mkdirSync(dir);
  const sp = spawn(process.execPath, [standin, dir, how], { detached: true, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'ready')); i++) await sleep(100);
  const pids = JSON.parse(fs.readFileSync(path.join(dir, 'pids.json'), 'utf8'));
  const leaf = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).leaf; } catch { return null; } };
  const tracked = { 'direct (non-detached node)': pids.direct, 'direct-detached': pids.directDetached, 'cmd.exe (child)': pids.cmd, 'cmd -> ping (grandchild)': pingChild(pids.cmd), 'node-attached (child)': pids.nodeAttached, 'node-attached -> node (grandchild)': leaf('na.json'), 'node-detached (child)': pids.nodeDetached, 'node-detached -> node detached (grandchild)': leaf('nd.json') };
  const before = Object.fromEntries(Object.entries(tracked).map(([k, v]) => [k, v ? alive(v) : null]));
  if (how === 'crash') spawnSync('taskkill', ['/PID', String(sp.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
  else for (let i = 0; i < 50 && alive(sp.pid); i++) await sleep(100);
  await sleep(2000);
  const after = Object.fromEntries(Object.entries(tracked).map(([k, v]) => [k, v ? alive(v) : null]));
  results[how] = { standinAlive: alive(sp.pid), before, afterAlive: after };
  for (const pid of Object.values(tracked)) if (pid && alive(pid)) { try { process.kill(pid); } catch { /* 済み */ } }
}
console.log(JSON.stringify(results, null, 1));
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 残っても %TEMP% */ }
