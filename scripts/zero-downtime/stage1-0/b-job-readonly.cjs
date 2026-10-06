// 1-0 b（読み取りだけ）: 走っているプロセスが Job Object に入っているかを調べる。
//   node scripts/zero-downtime/stage1-0/b-job-readonly.cjs <pid>...      pid を省くと、自分と、自分の祖先をたどった分
// 使う API は OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) と IsProcessInJob だけ。相手には書き込まず、止めない
// （インストール版の Ply.exe にも使ってよい調べ方）。
// Job の制限（KILL_ON_JOB_CLOSE など）は読めない: QueryInformationJobObject は Job のハンドルが要り、他のプロセスの Job のハンドルは
// 読み取りだけでは得られない（自分が Job に入っていても、Node は最初の spawn で自分用の Job を入れ子に作る）。制限は、起こして確かめた
// 同じ実行ファイル・同じ起動経路の結果（b-ply-job.mjs）から推す。
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const koffi = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'koffi'));
const { inJob } = require('../runtime/job-info.cjs');

const r = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }'], { encoding: 'utf8', windowsHide: true });
const procs = new Map();
for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) { const [pid, ppid, name] = line.split('|'); procs.set(Number(pid), { ppid: Number(ppid), name }); }
const pids = process.argv.slice(2).map(Number);
if (!pids.length) for (let p = process.pid; p && procs.has(p) && pids.length < 12; p = procs.get(p).ppid) pids.push(p);
console.log(JSON.stringify(pids.map(pid => ({ pid, name: procs.get(pid)?.name ?? '?', ppid: procs.get(pid)?.ppid ?? null, inJob: inJob(koffi, pid) })), null, 1));
