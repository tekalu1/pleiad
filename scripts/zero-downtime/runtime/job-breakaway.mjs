// Job Object の制限（KILL_ON_JOB_CLOSE と BREAKAWAY の組み合わせ）ごとに、Node の detached 起動と
// CREATE_BREAKAWAY_FROM_JOB 付きの CreateProcessW が、Job を閉じたあとに生き残るかを測る。
//   node job-breakaway.mjs            全部の組み合わせを流して表にする
// 内部用: node job-breakaway.mjs --launcher <LimitFlags(10進)> <出力先>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const req = createRequire(import.meta.url);
const koffiDir = path.join(root, 'node_modules/koffi');
const heartbeat = path.join(here, 'heartbeat.mjs');

if (process.argv[2] === '--launcher') launcher(Number(process.argv[3]), process.argv[4]);
else await harness();

function launcher(limitFlags, outDir) {
  const koffi = req(koffiDir);
  const { jobInfo } = req('./job-info.cjs');
  const k32 = koffi.load('kernel32.dll');
  const CreateJobObjectW = k32.func('void* __stdcall CreateJobObjectW(void* attrs, void* name)');
  const SetInformationJobObject = k32.func('int __stdcall SetInformationJobObject(void* job, int cls, void* buf, uint32 len)');
  const AssignProcessToJobObject = k32.func('int __stdcall AssignProcessToJobObject(void* job, void* proc)');
  const GetCurrentProcess = k32.func('void* __stdcall GetCurrentProcess()');
  const CloseHandle = k32.func('int __stdcall CloseHandle(void* h)');
  const GetLastError = k32.func('uint32 __stdcall GetLastError()');
  const STARTUPINFOW = koffi.struct('STARTUPINFOW', { cb: 'uint32', lpReserved: 'void*', lpDesktop: 'void*', lpTitle: 'void*', dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32', dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void*', hStdInput: 'void*', hStdOutput: 'void*', hStdError: 'void*' });
  const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', { hProcess: 'void*', hThread: 'void*', dwProcessId: 'uint32', dwThreadId: 'uint32' });
  const CreateProcessW = k32.func('int __stdcall CreateProcessW(const char16_t* app, char16_t* cmd, void* pa, void* ta, int inherit, uint32 flags, void* env, const char16_t* cwd, _Inout_ STARTUPINFOW* si, _Out_ PROCESS_INFORMATION* pi)');

  const result = { limitFlags, steps: {} };
  const job = CreateJobObjectW(null, null);
  const ext = Buffer.alloc(144); ext.writeUInt32LE(limitFlags, 16);
  result.setInfo = SetInformationJobObject(job, 9, ext, ext.length);
  result.assign = AssignProcessToJobObject(job, GetCurrentProcess());
  result.launcherJob = jobInfo(koffi);

  // (a) Node の child_process（detached）。libuv は detached でも CREATE_BREAKAWAY_FROM_JOB を付けない
  try {
    const c = spawn(process.execPath, [heartbeat, outDir, 'node-detached'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ZD_KOFFI: koffiDir } });
    c.unref(); result.steps.nodeDetached = { pid: c.pid };
  } catch (e) { result.steps.nodeDetached = { error: String(e) }; }

  // (b) CreateProcessW + CREATE_BREAKAWAY_FROM_JOB（0x01000000）。DETACHED_PROCESS 0x8 | CREATE_NEW_PROCESS_GROUP 0x200 | CREATE_NO_WINDOW 0x08000000
  const q = s => `"${s}"`;
  const cmd = `${q(process.execPath)} ${q(heartbeat)} ${q(outDir)} breakaway-flag`;
  const si = { cb: 104, lpReserved: null, lpDesktop: null, lpTitle: null, dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0, dwFlags: 0, wShowWindow: 0, cbReserved2: 0, lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null };
  const pi = {};
  process.env.ZD_KOFFI = koffiDir;
  const ok = CreateProcessW(null, cmd, null, null, 0, 0x01000000 | 0x8 | 0x200 | 0x08000000, null, null, si, pi);
  result.steps.createProcessBreakaway = ok ? { pid: pi.dwProcessId } : { error: 'GetLastError=' + GetLastError() };
  if (ok) { CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }

  fs.writeFileSync(path.join(outDir, 'launcher.json'), JSON.stringify(result));
  setTimeout(() => { CloseHandle(job); process.exit(0); }, 1500);   // 最後の Job ハンドルを閉じる → KILL_ON_JOB_CLOSE ならメンバーが殺される
}

async function harness() {
  const KILL = 0x2000, BREAKAWAY_OK = 0x800, SILENT = 0x1000;
  const cases = [
    ['KILL_ON_JOB_CLOSE', KILL],
    ['KILL_ON_JOB_CLOSE | BREAKAWAY_OK', KILL | BREAKAWAY_OK],
    ['KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK', KILL | SILENT],
  ];
  const rows = [];
  for (const [name, flags] of cases) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-jobbreak-'));
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--launcher', String(flags), outDir], { stdio: 'inherit', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));   // Job を閉じた後の時間
    const launcher = JSON.parse(fs.readFileSync(path.join(outDir, 'launcher.json'), 'utf8'));
    const alive = label => {
      const f = path.join(outDir, `${label}.hb`);
      if (!fs.existsSync(f)) return { started: false };
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const start = lines[0], last = lines.at(-1);
      let running = false;
      try { process.kill(start.pid, 0); running = true; } catch { /* 死んでいる */ }
      return { started: true, pid: start.pid, running, job: start.job?.inJob, lastBeatAgoMs: Date.now() - last.t };
    };
    const row = { case: name, setInfo: launcher.setInfo, assign: launcher.assign, launcherJob: launcher.launcherJob?.limits,
      nodeDetached: alive('node-detached'), createProcessBreakaway: launcher.steps.createProcessBreakaway?.error ?? alive('breakaway-flag') };
    rows.push(row);
    for (const label of ['node-detached', 'breakaway-flag']) {   // 後始末（自分が起こした試験用の子だけ）
      const a = alive(label); if (a.pid && a.running) try { process.kill(a.pid); } catch { /* 済み */ }
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(rows, null, 2));
}
