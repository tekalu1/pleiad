// main が入っている Windows の Job Object の制限を調べ、サーバーを main と別の寿命で起こせるかを決める（段階 1 の 1-4。
// docs/zero-downtime-update/design.md §3.2）。
//   KILL_ON_JOB_CLOSE が無い・SILENT_BREAKAWAY_OK がある → Node の detached 起動で、Job を閉じても生き残る
//   KILL_ON_JOB_CLOSE と BREAKAWAY_OK だけ            → CreateProcessW に CREATE_BREAKAWAY_FROM_JOB を付けて起こす（launchBreakaway）
//   KILL_ON_JOB_CLOSE があり抜け道が無い                → 無停止の更新を使わず、今の utilityProcess に落とす（mode: 'unsupported'）
// Job は起こす側が作るので、起動のたびに調べる。koffi は呼び出し側が渡す（読めなければ判断できないので unsupported）。
// 動く例（Job を作って 3 通りを測る）は scripts/zero-downtime/runtime/job-breakaway.mjs。
const LIMIT = { BREAKAWAY_OK: 0x800, SILENT_BREAKAWAY_OK: 0x1000, KILL_ON_JOB_CLOSE: 0x2000 };
const LIMIT_NAMES = Object.entries(LIMIT).map(([name, bit]) => [bit, name]);

// CreateProcessW の dwCreationFlags
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const DETACHED_PROCESS = 0x8;
const CREATE_NEW_PROCESS_GROUP = 0x200;
const CREATE_NO_WINDOW = 0x08000000;

const apis = new WeakMap();   // koffi の型は名前がグローバルなので、同じ koffi では 1 回だけ定義する

function api(koffi) {
  if (apis.has(koffi)) return apis.get(koffi);
  const k32 = koffi.load('kernel32.dll');
  const STARTUPINFOW = koffi.struct('PleiadJobStartupInfoW', { cb: 'uint32', lpReserved: 'void*', lpDesktop: 'void*', lpTitle: 'void*', dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32', dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void*', hStdInput: 'void*', hStdOutput: 'void*', hStdError: 'void*' });
  const PROCESS_INFORMATION = koffi.struct('PleiadJobProcessInformation', { hProcess: 'void*', hThread: 'void*', dwProcessId: 'uint32', dwThreadId: 'uint32' });
  const table = {
    IsProcessInJob: k32.func('int __stdcall IsProcessInJob(void* process, void* job, _Out_ int* result)'),
    GetCurrentProcess: k32.func('void* __stdcall GetCurrentProcess()'),
    QueryInformationJobObject: k32.func('int __stdcall QueryInformationJobObject(void* job, int cls, void* buf, uint32 len, _Out_ uint32* ret)'),
    CreateProcessW: k32.func('int __stdcall CreateProcessW(const char16_t* app, char16_t* cmd, void* pa, void* ta, int inherit, uint32 flags, void* env, const char16_t* cwd, _Inout_ PleiadJobStartupInfoW* si, _Out_ PleiadJobProcessInformation* pi)'),
    CloseHandle: k32.func('int __stdcall CloseHandle(void* h)'),
    GetLastError: k32.func('uint32 __stdcall GetLastError()'),
    STARTUPINFOW, PROCESS_INFORMATION,
  };
  apis.set(koffi, table);
  return table;
}

function limitNames(flags) {
  return LIMIT_NAMES.filter(([bit]) => flags & bit).map(([, name]) => name);
}

/**
 * 自分の Job を調べる。戻り値 { inJob, flags, limits }
 *   inJob   true / false。調べられなければ null（error に理由）
 *   flags   LimitFlags の数値。Job に入っていない・読めなければ null
 *   limits  立っている制限の名前（KILL_ON_JOB_CLOSE・BREAKAWAY_OK・SILENT_BREAKAWAY_OK）
 * Windows 以外・koffi が読めないときは inJob: null（decideLaunch が platform で分ける）
 */
function inspectJob({ koffi = null, loadKoffi = () => require('koffi'), platform = process.platform } = {}) {
  if (platform !== 'win32') return { inJob: false, flags: null, limits: [] };
  try {
    const k = koffi ?? loadKoffi();
    const a = api(k);
    const out = [0];
    if (!a.IsProcessInJob(a.GetCurrentProcess(), null, out)) return { inJob: null, flags: null, limits: [], error: `IsProcessInJob failed (${a.GetLastError()})` };
    if (!out[0]) return { inJob: false, flags: null, limits: [] };
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION（x64・arm64: 144 バイト。LimitFlags は先頭から 16 バイト目）
    const ext = Buffer.alloc(144);
    if (!a.QueryInformationJobObject(null, 9, ext, ext.length, [0])) return { inJob: true, flags: null, limits: [], error: `QueryInformationJobObject failed (${a.GetLastError()})` };
    const flags = ext.readUInt32LE(16);
    return { inJob: true, flags, limits: limitNames(flags) };
  } catch (error) {
    return { inJob: null, flags: null, limits: [], error: String(error?.message ?? error) };
  }
}

/**
 * サーバーをどう起こすか。戻り値 { mode, reason }
 *   mode  'detached'（Node の detached 起動）・'breakaway'（CREATE_BREAKAWAY_FROM_JOB）・'unsupported'（無停止の更新を使わない）
 * Job が分からないときは unsupported（main の終了で道連れになるかもしれないのに、サーバーだけ別の寿命だと思い込まない）
 */
function decideLaunch(info, { platform = process.platform } = {}) {
  if (platform !== 'win32') return { mode: 'detached', reason: 'not a Windows job' };
  if (info?.inJob === false) return { mode: 'detached', reason: 'not in a job' };
  if (info?.inJob == null) return { mode: 'unsupported', reason: `the job could not be inspected${info?.error ? `: ${info.error}` : ''}` };
  if (info.flags == null) return { mode: 'unsupported', reason: `the job limits could not be read${info.error ? `: ${info.error}` : ''}` };
  const flags = info.flags;
  if (!(flags & LIMIT.KILL_ON_JOB_CLOSE)) return { mode: 'detached', reason: 'the job does not kill its members on close' };
  if (flags & LIMIT.SILENT_BREAKAWAY_OK) return { mode: 'detached', reason: 'the job lets children break away silently' };
  if (flags & LIMIT.BREAKAWAY_OK) return { mode: 'breakaway', reason: 'the job kills its members on close but allows CREATE_BREAKAWAY_FROM_JOB' };
  return { mode: 'unsupported', reason: 'the job kills its members on close and allows no breakaway' };
}

/** CreateProcessW の lpCommandLine（CommandLineToArgvW の規則で 1 つずつ囲む） */
function quoteArg(arg) {
  const text = String(arg);
  if (text !== '' && !/[\s"]/.test(text)) return text;
  let out = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    else out += `${'\\'.repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}
const commandLine = (exe, args) => [exe, ...args].map(quoteArg).join(' ');

/** CreateProcessW の lpEnvironment（UTF-16LE の name=value\0 …\0\0。名前の大小を無視した順に並べる）。値が undefined のものは入れない */
function environmentBlock(env) {
  const names = Object.keys(env).filter(name => env[name] !== undefined && env[name] !== null && !name.includes('=')).sort((a, b) => {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const text = names.map(name => `${name}=${env[name]}\0`).join('') || '\0';
  return Buffer.from(`${text}\0`, 'utf16le');
}

/**
 * CREATE_BREAKAWAY_FROM_JOB 付きで起こす（親が KILL_ON_JOB_CLOSE と BREAKAWAY_OK の Job に入っているとき）。
 * 標準入出力は渡さない（detached・windowsHide と同じ形）。戻り値 { pid }。失敗は Error（code: 'CREATE_PROCESS_FAILED'、winError に GetLastError）
 */
function launchBreakaway({ exe, args = [], env, cwd = null, koffi = null, loadKoffi = () => require('koffi') }) {
  const k = koffi ?? loadKoffi();
  const a = api(k);
  const si = { cb: 104, lpReserved: null, lpDesktop: null, lpTitle: null, dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0, dwFlags: 0, wShowWindow: 0, cbReserved2: 0, lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null };
  const pi = {};
  const flags = CREATE_BREAKAWAY_FROM_JOB | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
  const ok = a.CreateProcessW(null, commandLine(exe, args), null, null, 0, flags, environmentBlock(env ?? process.env), cwd, si, pi);
  if (!ok) {
    const winError = a.GetLastError();
    throw Object.assign(new Error(`CreateProcessW failed (GetLastError=${winError})`), { code: 'CREATE_PROCESS_FAILED', winError });
  }
  a.CloseHandle(pi.hProcess);
  a.CloseHandle(pi.hThread);
  return { pid: pi.dwProcessId };
}

module.exports = { LIMIT, inspectJob, decideLaunch, launchBreakaway, quoteArg, commandLine, environmentBlock, limitNames };
