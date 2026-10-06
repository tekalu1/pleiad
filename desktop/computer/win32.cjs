'use strict';
// koffi で Win32 を呼ぶ層（docs/computer-use.md「core と main」）。koffi を知っているのはこのファイルだけで、
// 上の層（capture・input・apps・desktop-state）が受け取るのは、ここが返す「表」（普通の JS の関数の集まり）。
// テストは koffi を使わず、同じ形の偽の表を渡す（tests/unit/computer-native.mjs）。
// 宣言の下書きは sshh12/windows-computer-use-mcp（MIT）の ctypes 版（NOTICE）。ハンドルは intptr_t（Number）で扱う。

const types = new WeakMap(); // koffi の型は名前がグローバルなので、同じ koffi では 1 回だけ定義する

function defineTypes(koffi) {
  if (types.has(koffi)) return types.get(koffi);
  const RECT = koffi.struct('CU_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const POINT = koffi.struct('CU_POINT', { x: 'int32_t', y: 'int32_t' });
  const MONITORINFOEXW = koffi.struct('CU_MONITORINFOEXW', {
    cbSize: 'uint32_t', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32_t', szDevice: koffi.array('char16_t', 32, 'String'),
  });
  const MOUSEINPUT = koffi.struct('CU_MOUSEINPUT', {
    dx: 'int32_t', dy: 'int32_t', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('CU_KEYBDINPUT', {
    wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('CU_HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
  const INPUT = koffi.struct('CU_INPUT', { type: 'uint32_t', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
  const PROCESSENTRY32W = koffi.struct('CU_PROCESSENTRY32W', {
    dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32_t',
    cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t', dwFlags: 'uint32_t',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  });
  const MonitorEnumProc = koffi.proto('bool __stdcall CU_MonitorEnumProc(intptr_t hMonitor, intptr_t hdc, CU_RECT *rc, intptr_t lParam)');
  const defined = { RECT, POINT, MONITORINFOEXW, MOUSEINPUT, KEYBDINPUT, INPUT, PROCESSENTRY32W, MonitorEnumProc };
  types.set(koffi, defined);
  return defined;
}

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const DPI_PMV2 = -4;
const DPI_AWARENESS = { 0: 'unaware', 1: 'system', 2: 'per-monitor' };
const INPUT_DESKTOP_READ = 0x0001;
const UOI_NAME = 2;
const ERROR_ACCESS_DENIED = 5;
const WM_IME_CONTROL = 0x283, IMC_GETOPENSTATUS = 5, IMC_SETOPENSTATUS = 6, SMTO_ABORTIFHUNG = 0x2;
const GW_HWNDNEXT = 2;
const GW_CHILD = 5;
const GWL_EXSTYLE = -20;
const TH32CS_SNAPPROCESS = 0x2;

const text = (buf, chars) => buf.toString('utf16le', 0, Math.max(0, chars) * 2);

/** @param koffi require('koffi') */
function createWin32(koffi) {
  const t = defineTypes(koffi);
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const shcore = koffi.load('shcore.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const shell32 = koffi.load('shell32.dll');
  const version = koffi.load('version.dll');
  const imm32 = koffi.load('imm32.dll');
  const iphlpapi = koffi.load('iphlpapi.dll');
  const f = {
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    EnumDisplayMonitors: user32.func('bool __stdcall EnumDisplayMonitors(intptr_t hdc, void *clip, CU_MonitorEnumProc *cb, intptr_t lParam)'),
    GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(intptr_t hMonitor, _Inout_ CU_MONITORINFOEXW *info)'),
    GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ CU_POINT *pt)'),
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(CU_POINT pt)'),
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint32_t flags)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint8_t *buf, int max)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint8_t *buf, int max)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
    IsHungAppWindow: user32.func('bool __stdcall IsHungAppWindow(intptr_t hwnd)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ CU_RECT *rc)'),
    GetTopWindow: user32.func('intptr_t __stdcall GetTopWindow(intptr_t hwnd)'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)'),
    GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t hdc)'),
    ImmGetDefaultIMEWnd: imm32.func('intptr_t __stdcall ImmGetDefaultIMEWnd(intptr_t hwnd)'),
    SendMessageTimeoutW: user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32_t msg, intptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ intptr_t *result)'),
    OpenInputDesktop: user32.func('intptr_t __stdcall OpenInputDesktop(uint32_t flags, bool inherit, uint32_t access)'),
    CloseDesktop: user32.func('bool __stdcall CloseDesktop(intptr_t hDesktop)'),
    GetUserObjectInformationW: user32.func('bool __stdcall GetUserObjectInformationW(intptr_t h, int index, _Out_ uint8_t *buf, uint32_t len, _Out_ uint32_t *needed)'),
    SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t n, CU_INPUT *inputs, int size)'),
    MapVirtualKeyW: user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t type)'),
    VkKeyScanW: user32.func('int16_t __stdcall VkKeyScanW(char16_t ch)'),
    GetThreadDpiAwarenessContext: user32.func('intptr_t __stdcall GetThreadDpiAwarenessContext()'),
    SetThreadDpiAwarenessContext: user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t ctx)'),
    GetAwarenessFromDpiAwarenessContext: user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t ctx)'),
    AreDpiAwarenessContextsEqual: user32.func('bool __stdcall AreDpiAwarenessContextsEqual(intptr_t a, intptr_t b)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
    AttachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool attach)'),
    BringWindowToTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)'),
    PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    GetDpiForWindow: user32.func('uint32_t __stdcall GetDpiForWindow(intptr_t hwnd)'),
    GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
    CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int w, int h)'),
    SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t obj)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t obj)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32_t rop)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(intptr_t hdc, intptr_t bmp, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ uint8_t *bmi, uint32_t usage)'),
    GetDpiForMonitor: shcore.func('int32_t __stdcall GetDpiForMonitor(intptr_t hMonitor, int type, _Out_ uint32_t *x, _Out_ uint32_t *y)'),
    DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ uint32_t *value, uint32_t size)'),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint8_t *buf, _Inout_ uint32_t *len)'),
    GetApplicationUserModelId: kernel32.func('int32_t __stdcall GetApplicationUserModelId(intptr_t h, _Inout_ uint32_t *len, _Out_ uint8_t *buf)'),
    GetCurrentProcessId: kernel32.func('uint32_t __stdcall GetCurrentProcessId()'),
    GetCurrentProcess: kernel32.func('intptr_t __stdcall GetCurrentProcess()'),
    GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    CreateToolhelp32Snapshot: kernel32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
    Process32FirstW: kernel32.func('bool __stdcall Process32FirstW(intptr_t snap, _Inout_ uint8_t *entry)'),
    Process32NextW: kernel32.func('bool __stdcall Process32NextW(intptr_t snap, _Inout_ uint8_t *entry)'),
    OpenProcessToken: advapi32.func('bool __stdcall OpenProcessToken(intptr_t h, uint32_t access, _Out_ intptr_t *token)'),
    GetTokenInformation: advapi32.func('bool __stdcall GetTokenInformation(intptr_t token, int cls, _Out_ uint8_t *info, uint32_t len, _Out_ uint32_t *ret)'),
    GetExtendedTcpTable: iphlpapi.func('uint32_t __stdcall GetExtendedTcpTable(_Out_ uint8_t *table, _Inout_ uint32_t *size, bool order, uint32_t af, int cls, uint32_t reserved)'),
    ShellExecuteW: shell32.func('intptr_t __stdcall ShellExecuteW(intptr_t hwnd, const char16_t *verb, const char16_t *file, const char16_t *params, const char16_t *dir, int show)'),
    GetFileVersionInfoSizeW: version.func('uint32_t __stdcall GetFileVersionInfoSizeW(const char16_t *path, _Out_ uint32_t *handle)'),
    GetFileVersionInfoW: version.func('bool __stdcall GetFileVersionInfoW(const char16_t *path, uint32_t handle, uint32_t len, _Out_ uint8_t *data)'),
    VerQueryValueW: version.func('bool __stdcall VerQueryValueW(const uint8_t *data, const char16_t *sub, _Out_ void **value, _Out_ uint32_t *len)'),
  };

  const callAsync = (fn, ...args) => new Promise((resolve, reject) => fn.async(...args, (err, res) => (err ? reject(err) : resolve(res))));
  const num = v => Number(v);
  const lastError = () => f.GetLastError();

  function enterPerMonitorV2() {
    let before = null;
    try { before = f.SetThreadDpiAwarenessContext(DPI_PMV2); } catch { /* 古い Windows */ }
    return () => { if (before) { try { f.SetThreadDpiAwarenessContext(before); } catch { /* 戻せなくても続ける */ } } };
  }

  function dpiAwareness() {
    try {
      const ctx = f.GetThreadDpiAwarenessContext();
      return { awareness: DPI_AWARENESS[f.GetAwarenessFromDpiAwarenessContext(ctx)] ?? 'unknown', perMonitorV2: !!f.AreDpiAwarenessContextsEqual(ctx, DPI_PMV2) };
    } catch { return { awareness: 'unknown', perMonitorV2: false }; }
  }

  function monitors() {
    const out = [];
    const cb = (hMonitor, _hdc, _rc, _lParam) => {
      const info = { cbSize: koffi.sizeof(t.MONITORINFOEXW) };
      if (f.GetMonitorInfoW(hMonitor, info)) {
        const dx = [0], dy = [0];
        let dpi = 96;
        try { if (f.GetDpiForMonitor(hMonitor, 0, dx, dy) === 0 && dx[0] > 0) dpi = dx[0]; } catch { /* 96 のまま */ }
        const r = info.rcMonitor;
        out.push({ handle: num(hMonitor), device: String(info.szDevice ?? '').replace(/\0.*$/, ''), x: r.left, y: r.top,
          width: r.right - r.left, height: r.bottom - r.top, primary: (info.dwFlags & 1) === 1, dpi });
      }
      return true;
    };
    f.EnumDisplayMonitors(0, null, cb, 0);
    return out;
  }

  /** 物理の矩形をスクリーンの DC から写す。BGRA（上から下）。alpha は未定義なので、上の層で 255 にする */
  async function captureRect(rect, { sync = false } = {}) {
    const { x, y, width, height } = rect;
    const call = (fn, ...args) => (sync ? fn(...args) : callAsync(fn, ...args));
    const screen = f.GetDC(0);
    if (!screen) throw new Error('GetDC failed');
    let mem = 0, bmp = 0, old = 0;
    try {
      mem = f.CreateCompatibleDC(screen);
      bmp = f.CreateCompatibleBitmap(screen, width, height);
      if (!mem || !bmp) throw new Error('CreateCompatibleBitmap failed');
      old = f.SelectObject(mem, bmp);
      if (!await call(f.BitBlt, mem, 0, 0, width, height, screen, x, y, SRCCOPY | CAPTUREBLT)) throw new Error(`BitBlt failed (${lastError()})`);
      const bmi = Buffer.alloc(40);
      bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(width, 4); bmi.writeInt32LE(-height, 8); bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14);
      const bgra = Buffer.allocUnsafeSlow(width * height * 4);
      const lines = await call(f.GetDIBits, mem, bmp, 0, height, bgra, bmi, 0);
      if (lines !== height) throw new Error(`GetDIBits returned ${lines}`);
      return { width, height, bgra };
    } finally {
      if (old) f.SelectObject(mem, old);
      if (bmp) f.DeleteObject(bmp);
      if (mem) f.DeleteDC(mem);
      f.ReleaseDC(0, screen);
    }
  }

  function windowInfo(hwnd) {
    const pid = [0];
    f.GetWindowThreadProcessId(hwnd, pid);
    const hung = !!f.IsHungAppWindow(hwnd);
    let title = '', className = '';
    if (!hung) {
      const buf = Buffer.alloc(1024);
      title = text(buf, f.GetWindowTextW(hwnd, buf, 512));
    }
    const cbuf = Buffer.alloc(512);
    className = text(cbuf, f.GetClassNameW(hwnd, cbuf, 256));
    const cloaked = [0];
    let isCloaked = false;
    try { isCloaked = f.DwmGetWindowAttribute(hwnd, 14, cloaked, 4) === 0 && cloaked[0] !== 0; } catch { /* DWM が無ければ見えている扱い */ }
    const rc = {};
    const rect = f.GetWindowRect(hwnd, rc) ? { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom } : null;
    return { hwnd: num(hwnd), pid: pid[0], title, className, exStyle: Number(BigInt.asUintN(32, BigInt(f.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)))),
      visible: !!f.IsWindowVisible(hwnd), iconic: !!f.IsIconic(hwnd), cloaked: isCloaked, hung, rect };
  }

  function walk(first, step) {
    const out = [];
    for (let h = first, n = 0; h && n < 4000; h = step(h), n++) out.push(num(h));
    return out;
  }

  function withProcess(pid, access, fn) {
    const h = f.OpenProcess(access, false, pid);
    if (!h) return { opened: false, error: lastError() };
    try { return { opened: true, value: fn(h) }; } finally { f.CloseHandle(h); }
  }

  return {
    available: true,
    sizeOfInput: koffi.sizeof(t.INPUT),
    dpi: { get: dpiAwareness, enter: enterPerMonitorV2 },
    monitors,
    cursor() { const p = {}; if (!f.GetCursorPos(p)) throw new Error(`GetCursorPos failed (${lastError()})`); return { x: p.x, y: p.y }; },
    captureRect,
    windowAt: (x, y) => num(f.WindowFromPoint({ x, y })),
    rootOf: hwnd => num(f.GetAncestor(hwnd, 2)), // GA_ROOT
    foreground: () => num(f.GetForegroundWindow()),
    windowInfo,
    topLevelWindows: () => walk(f.GetTopWindow(0), h => f.GetWindow(h, GW_HWNDNEXT)),
    childWindows: hwnd => walk(f.GetWindow(hwnd, GW_CHILD), h => f.GetWindow(h, GW_HWNDNEXT)),
    currentPid: () => f.GetCurrentProcessId(),
    processPath(pid) {
      const r = withProcess(pid, 0x1000, h => {
        const buf = Buffer.alloc(2 * 1040), len = [1040];
        return f.QueryFullProcessImageNameW(h, 0, buf, len) ? text(buf, len[0]) : null;
      });
      return r.opened ? r.value : null;
    },
    /** true / false。開けない・読めないときは null（昇格しているか確かめられない） */
    processElevated(pid) {
      const r = withProcess(pid, 0x1000, h => {
        const token = [0];
        if (!f.OpenProcessToken(h, 0x0008, token)) return null;
        try {
          const info = Buffer.alloc(4), ret = [0];
          return f.GetTokenInformation(token[0], 20, info, 4, ret) ? info.readUInt32LE(0) !== 0 : null;
        } finally { f.CloseHandle(token[0]); }
      });
      return r.opened ? r.value : null;
    },
    selfElevated() {
      const token = [0];
      if (!f.OpenProcessToken(f.GetCurrentProcess(), 0x0008, token)) return false;
      try { const info = Buffer.alloc(4); return f.GetTokenInformation(token[0], 20, info, 4, [0]) ? info.readUInt32LE(0) !== 0 : false; }
      finally { f.CloseHandle(token[0]); }
    },
    processAumid(pid) {
      const r = withProcess(pid, 0x1000, h => {
        const buf = Buffer.alloc(2 * 256), len = [256];
        return f.GetApplicationUserModelId(h, len, buf) === 0 ? text(buf, len[0] - 1) : null;
      });
      return r.opened ? r.value : null;
    },
    /** pid → 親の pid（process32 のスナップショット） */
    processParents() {
      const snap = f.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      const map = new Map();
      if (!snap || snap === -1) return map;
      try {
        // 構造体のまま受けると 1000 件超で 70ms かかるので、Buffer で受けて必要な 2 項目だけ読む
        const entry = Buffer.alloc(koffi.sizeof(t.PROCESSENTRY32W));
        const pidAt = koffi.offsetof(t.PROCESSENTRY32W, 'th32ProcessID'), parentAt = koffi.offsetof(t.PROCESSENTRY32W, 'th32ParentProcessID');
        entry.writeUInt32LE(entry.length, 0);
        for (let ok = f.Process32FirstW(snap, entry); ok; ok = f.Process32NextW(snap, entry)) map.set(entry.readUInt32LE(pidAt), entry.readUInt32LE(parentAt));
      } finally { f.CloseHandle(snap); }
      return map;
    },
    /** 版の情報の FileDescription。固まりうるので別スレッド */
    async fileDescription(path) {
      const size = await callAsync(f.GetFileVersionInfoSizeW, path, [0]);
      if (!size) return null;
      const data = Buffer.alloc(size);
      if (!await callAsync(f.GetFileVersionInfoW, path, 0, size, data)) return null;
      const query = sub => {
        const value = [null], len = [0];
        return f.VerQueryValueW(data, sub, value, len) && value[0] ? { ptr: value[0], len: len[0] } : null;
      };
      const translations = query('\\VarFileInfo\\Translation');
      const pairs = [];
      if (translations) {
        const words = koffi.decode(translations.ptr, koffi.array('uint16_t', Math.min(8, Math.floor(translations.len / 2))));
        for (let i = 0; i + 1 < words.length; i += 2) pairs.push([words[i], words[i + 1]]);
      }
      pairs.push([0x0409, 0x04b0], [0x0411, 0x04b0], [0x0409, 0x04e4]);
      for (const [lang, page] of pairs) {
        const hex = n => n.toString(16).padStart(4, '0');
        const hit = query(`\\StringFileInfo\\${hex(lang)}${hex(page)}\\FileDescription`);
        if (hit && hit.len > 1) return koffi.decode(hit.ptr, 'char16_t', hit.len - 1).toString().trim() || null;
      }
      return null;
    },
    /** 入力デスクトップの名前。取れないとき name は null と error（5 = アクセス拒否 = ロック画面など） */
    inputDesktop() {
      const h = f.OpenInputDesktop(0, false, INPUT_DESKTOP_READ);
      if (!h) return { name: null, error: lastError() };
      try {
        const buf = Buffer.alloc(512), needed = [0];
        if (!f.GetUserObjectInformationW(h, UOI_NAME, buf, 512, needed)) return { name: null, error: lastError() };
        return { name: buf.toString('utf16le').replace(/\0.*$/s, ''), error: 0 };
      } finally { f.CloseDesktop(h); }
    },
    /**
     * 前面の窓の IME が開いている（日本語入力がオン）なら閉じて、元に戻す関数を返す。開いていない・IME が無い・答えないときは null。
     * IME が開いていると KEYEVENTF_UNICODE の仮名が変換中の文字列に取り込まれ、後の文字より遅れて確定する（順序が崩れる。2026-10-01、本物で確認）
     */
    imeClose() {
      const fg = num(f.GetForegroundWindow());
      if (!fg) return null;
      const ime = num(f.ImmGetDefaultIMEWnd(fg));
      if (!ime) return null;
      const out = [0];
      const ask = (wParam, lParam) => (f.SendMessageTimeoutW(ime, WM_IME_CONTROL, wParam, lParam, SMTO_ABORTIFHUNG, 200, out) ? Number(out[0]) : null);
      if (!ask(IMC_GETOPENSTATUS, 0)) return null; // 閉じている・答えない
      if (ask(IMC_SETOPENSTATUS, 0) === null) return null;
      return () => { ask(IMC_SETOPENSTATUS, 1); };
    },
    ERROR_ACCESS_DENIED,
    /** inputs: { type, ki?: {wVk,wScan,dwFlags,time,dwExtraInfo}, mi?: {dx,dy,mouseData,dwFlags,time,dwExtraInfo} }[] */
    sendInput(inputs) {
      if (!inputs.length) return { sent: 0, error: 0 };
      const events = inputs.map(i => ({ type: i.type, u: i.ki ? { ki: i.ki } : { mi: i.mi } }));
      const sent = f.SendInput(events.length, events, koffi.sizeof(t.INPUT));
      return { sent, error: sent === events.length ? 0 : lastError() };
    },
    mapVirtualKey: (vk, kind = 4) => f.MapVirtualKeyW(vk, kind), // 4 = MAPVK_VK_TO_VSC_EX（拡張キーの前置 0xE0 が付く）
    vkKeyScan: ch => f.VkKeyScanW(ch.charCodeAt(0)),
    /** 起動済みの窓を前に出す（できる範囲で）。前に出たかは保証しない */
    activate(hwnd) {
      if (f.IsIconic(hwnd)) f.ShowWindow(hwnd, 9); // SW_RESTORE
      return !!f.SetForegroundWindow(hwnd);
    },
    // ---- Chrome の確認の窓の操作（desktop/chrome-os/win32.cjs が使う。koffi を読むのはこのファイルだけ）
    /** 窓を前に出す 1 手。前に出たかは foreground() で確かめる */
    setForeground: hwnd => !!f.SetForegroundWindow(hwnd),
    showWindow: (hwnd, cmd) => !!f.ShowWindow(hwnd, cmd),
    bringToTop: hwnd => !!f.BringWindowToTop(hwnd),
    /** 窓を作ったスレッドの id */
    windowThread: hwnd => f.GetWindowThreadProcessId(hwnd, [0]),
    currentThread: () => f.GetCurrentThreadId(),
    attachThreadInput: (from, to, attach) => !!f.AttachThreadInput(from, to, attach),
    /** 所有している窓（GW_OWNER）。無ければ 0 */
    ownerOf: hwnd => num(f.GetWindow(hwnd, 4)),
    dpiForWindow(hwnd) { try { return f.GetDpiForWindow(hwnd) || 96; } catch { return 96; } },
    postMessage: (hwnd, msg, wParam = 0, lParam = 0) => !!f.PostMessageW(hwnd, msg, wParam, lParam),
    /** IPv4 の待ち受けのポート（127.0.0.1 など）を持つプロセスの pid。待ち受けが無い・読めないときは null */
    listenerPid(port) {
      const AF_INET = 2, TCP_TABLE_OWNER_PID_LISTENER = 3, ROW = 24;
      let size = [4096], buf = Buffer.alloc(size[0]);
      for (let attempt = 0; attempt < 3; attempt++) {
        const rc = f.GetExtendedTcpTable(buf, size, false, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if (rc === 0) {
          const rows = buf.readUInt32LE(0);
          for (let i = 0; i < rows && 4 + (i + 1) * ROW <= buf.length; i++) {
            const at = 4 + i * ROW, raw = buf.readUInt32LE(at + 8);   // dwLocalPort は下位 16 bit がネットワーク順
            if ((((raw & 0xff) << 8) | ((raw >> 8) & 0xff)) === port) return buf.readUInt32LE(at + 20);
          }
          return null;
        }
        if (rc !== 122) return null;   // ERROR_INSUFFICIENT_BUFFER 以外は読めない
        buf = Buffer.alloc(size[0] + 1024);
        size = [buf.length];
      }
      return null;
    },
    /** ShellExecute で開く。引数は渡さない。成功は戻り値 > 32 */
    async shellOpen(target, dir = null) {
      const code = num(await callAsync(f.ShellExecuteW, 0, 'open', target, null, dir, 1));
      return { ok: code > 32, code };
    },
  };
}

function loadWin32() {
  if (process.platform !== 'win32') throw Object.assign(new Error('not windows'), { reason: 'platform' });
  let koffi;
  try { koffi = require('koffi'); } catch (e) { throw Object.assign(new Error(`koffi: ${e.message}`), { reason: 'native' }); }
  try { return createWin32(koffi); } catch (e) { throw Object.assign(new Error(`win32: ${e.message}`), { reason: 'native' }); }
}

module.exports = { createWin32, defineTypes, loadWin32 };
