// Windows の Job Object の所属を調べる（段階 0 の実測用。koffi を呼び出し側から受け取る）。
//   jobInfo(koffi)            自分が入っている Job の有無・制限フラグ・同じ Job の PID の一覧
//   inJob(koffi, pid)         指定した PID が（どれかの）Job に入っているか
const FLAGS = { 0x2000: 'KILL_ON_JOB_CLOSE', 0x800: 'BREAKAWAY_OK', 0x1000: 'SILENT_BREAKAWAY_OK', 0x8: 'ACTIVE_PROCESS', 0x4: 'PRIORITY_CLASS' };

function api(koffi) {
  const k32 = koffi.load('kernel32.dll');
  return {
    GetCurrentProcess: k32.func('void* __stdcall GetCurrentProcess()'),
    OpenProcess: k32.func('void* __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)'),
    CloseHandle: k32.func('int __stdcall CloseHandle(void* h)'),
    IsProcessInJob: k32.func('int __stdcall IsProcessInJob(void* h, void* job, _Out_ int* result)'),
    QueryInformationJobObject: k32.func('int __stdcall QueryInformationJobObject(void* job, int cls, void* buf, uint32 len, _Out_ uint32* ret)'),
  };
}

function inJob(koffi, pid) {
  const a = api(koffi);
  const h = pid == null ? a.GetCurrentProcess() : a.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
  if (!h) return null;
  try {
    const out = [0];
    if (!a.IsProcessInJob(h, null, out)) return null;
    return out[0] !== 0;
  } finally { if (pid != null) a.CloseHandle(h); }
}

function jobInfo(koffi) {
  const a = api(koffi);
  const info = { inJob: inJob(koffi) };
  if (!info.inJob) return info;
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION（x64: 144 バイト。LimitFlags は先頭から 16 バイト目）
  const ext = Buffer.alloc(144);
  if (a.QueryInformationJobObject(null, 9, ext, ext.length, [0])) {
    const flags = ext.readUInt32LE(16);
    info.limitFlags = '0x' + flags.toString(16);
    info.limits = Object.entries(FLAGS).filter(([bit]) => flags & Number(bit)).map(([, name]) => name);
  }
  // JOBOBJECT_BASIC_PROCESS_ID_LIST（Job に入っている全 PID）
  const list = Buffer.alloc(8 + 8 * 256);
  if (a.QueryInformationJobObject(null, 3, list, list.length, [0])) {
    const n = list.readUInt32LE(4);
    info.pids = Array.from({ length: n }, (_, i) => Number(list.readBigUInt64LE(8 + 8 * i)));
  }
  return info;
}

module.exports = { jobInfo, inJob };
