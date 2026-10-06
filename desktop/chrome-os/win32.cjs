'use strict';
// Chrome への接続の OS の層（Windows）。core/chrome/os.mjs の口の実装（docs/inapp-browser.md「OS ごとの層」、ADR 0149）。
// koffi は desktop/computer/win32.cjs の表（createWin32 の戻り値）だけが読む。ここは表の関数を呼ぶだけで、テストは偽の表で動かす。
//
// WindowRef = { id: string }（窓のハンドルの 10 進）。自分が出した ref だけを Map で覚え、知らない値には何もしない
// （ほかのアプリの窓を前に出す・閉じることが起きない）。閉じてよいのは、確認の窓として出した ref だけ。

const BROWSER_CLASS = 'Chrome_WidgetWin_1';   // Electron のアプリも同じクラスなので、実行ファイルでも絞る
const BROWSER_EXES = new Set(['chrome.exe', 'msedge.exe']);
// 確認の窓の題。言語で変わるので「見つけ方の補助」でしかない（ja は実機で確認。en は未確認）
const DIALOG_TITLE = /リモート\s*デバッグ|remote debugging/i;
const MAX_DIALOG_DIP = { width: 1000, height: 700 };
const SW_RESTORE = 9;
const WM_CLOSE = 0x0010;
const MAX_REFS = 200;

const FEATURES = Object.freeze({ dialog: true, raise: true, launch: false, watch: false, bounds: false });

const exeName = path => (typeof path === 'string' && path ? path.split(/[\\/]/).pop().toLowerCase() : null);

/**
 * @param {object} deps
 * @param deps.win32 desktop/computer/win32.cjs の表（偽物でもよい）
 */
function createWin32ChromeOs({ win32, log = () => {} }) {
  const refs = new Map();   // id -> { hwnd, kind: 'dialog' | 'foreign' }
  const remember = (hwnd, kind) => {
    const id = String(hwnd);
    const known = refs.get(id);
    // いちど確認の窓として出した ref を、前面の窓として出し直しても、閉じてよい印は落とさない
    refs.set(id, { hwnd, kind: known?.kind === 'dialog' ? 'dialog' : kind });
    if (refs.size > MAX_REFS) refs.delete(refs.keys().next().value);
    return { id };
  };
  const known = ref => (ref && typeof ref.id === 'string' ? refs.get(ref.id) : undefined);

  /** 今あるブラウザー（chrome.exe・msedge.exe）の最上位の窓 */
  function browserWindows() {
    const exes = new Map();   // pid -> 実行ファイル名（1 回の列挙の中だけ覚える）
    const exeOf = pid => { if (!exes.has(pid)) { let path = null; try { path = win32.processPath(pid); } catch { /* 開けない窓は対象外 */ } exes.set(pid, exeName(path)); } return exes.get(pid); };
    const out = [];
    let handles = [];
    try { handles = win32.topLevelWindows(); } catch { return out; }
    for (const hwnd of handles) {
      let info;
      try { info = win32.windowInfo(hwnd); } catch { continue; }
      if (info.className !== BROWSER_CLASS) continue;
      const exe = exeOf(info.pid);
      if (!exe || !BROWSER_EXES.has(exe)) continue;
      out.push({ hwnd, info, exe });
    }
    return out;
  }

  const dipSize = (hwnd, rect) => {
    if (!rect) return null;
    const scale = 96 / (win32.dpiForWindow?.(hwnd) || 96);
    return { width: (rect.right - rect.left) * scale, height: (rect.bottom - rect.top) * scale };
  };

  function snapshotWindows() {
    return browserWindows().map(w => String(w.hwnd));
  }

  /**
   * 「リモート デバッグを許可しますか？」の確認の窓。since に無い・見えている・小さい（外形が 1000×700 DIP 以下）ブラウザーの窓。
   * 題が既知の文言なら優先し、無ければ「ブラウザーの窓に所有された」新しい窓が 1 つだけのときに限る
   * （実機の確認の窓は WS_POPUP でブラウザーの窓が持ち主。ふつうの窓は持ち主が無い）
   */
  function findPermissionDialog({ since = [] } = {}) {
    const before = new Set((Array.isArray(since) ? since : []).map(String));
    const candidates = browserWindows().filter(({ hwnd, info }) => {
      if (before.has(String(hwnd)) || !info.visible || info.iconic || info.cloaked) return false;
      const size = dipSize(hwnd, info.rect);
      return size && size.width <= MAX_DIALOG_DIP.width && size.height <= MAX_DIALOG_DIP.height;
    });
    const titled = candidates.filter(w => DIALOG_TITLE.test(w.info.title));
    let pick = titled[0] ?? null;
    if (!pick) {
      const owned = candidates.filter(w => { try { return win32.ownerOf(w.hwnd) !== 0; } catch { return false; } });
      if (owned.length === 1) pick = owned[0];
    }
    return pick ? remember(pick.hwnd, 'dialog') : null;
  }

  /** 前面を取る 1 手。取れたかは foreground() で確かめる */
  function bring(hwnd) {
    if (win32.windowInfo(hwnd).iconic) win32.showWindow(hwnd, SW_RESTORE);
    win32.setForeground(hwnd);
    if (win32.foreground() === hwnd) return 'direct';
    // 前面のスレッドに入力をつなぐ（Pleiad が前面でも、ほかのアプリが前面でも通る。実機で確認）
    const front = win32.foreground();
    const frontThread = front ? win32.windowThread(front) : 0;
    const me = win32.currentThread();
    const attached = frontThread && frontThread !== me ? win32.attachThreadInput(me, frontThread, true) : false;
    try {
      win32.bringToTop(hwnd);
      win32.setForeground(hwnd);
    } finally {
      if (attached) win32.attachThreadInput(me, frontThread, false);
    }
    return win32.foreground() === hwnd ? 'attach' : 'failed';
  }

  function raise(ref) {
    const entry = known(ref);
    if (!entry) return { ok: false, method: 'unknown' };
    try {
      const method = bring(entry.hwnd);
      log(`raise method=${method}`);
      return { ok: method !== 'failed', method };
    } catch (error) {
      log(`raise failed: ${error.message}`);
      return { ok: false, method: 'failed' };
    }
  }

  /** ref が前面を取っていたら、to（直前の前面）へ返す。ref が前面でなければ何もしない */
  function yieldForeground(ref, { to } = {}) {
    const entry = known(ref), target = known(to);
    if (!entry || !target) return false;
    try {
      if (win32.foreground() !== entry.hwnd) return false;
      return bring(target.hwnd) !== 'failed';
    } catch { return false; }
  }

  function foreground() {
    let hwnd = 0;
    try { hwnd = win32.foreground(); } catch { return null; }
    if (!hwnd) return null;
    let browser = false;
    try {
      const info = win32.windowInfo(hwnd);
      browser = info.className === BROWSER_CLASS && BROWSER_EXES.has(exeName(win32.processPath(info.pid)));
    } catch { /* ブラウザーかどうかが分からなければ、ブラウザーではない扱い */ }
    return { ...remember(hwnd, 'foreign'), browser };
  }

  /** 確認の窓として出した ref だけを、まだ同じ実行ファイルの窓のときに限って WM_CLOSE で閉じる */
  function close(ref) {
    const entry = known(ref);
    if (!entry || entry.kind !== 'dialog') return false;
    try {
      const info = win32.windowInfo(entry.hwnd);
      if (info.className !== BROWSER_CLASS || !BROWSER_EXES.has(exeName(win32.processPath(info.pid)))) { refs.delete(ref.id); return false; }
      return win32.postMessage(entry.hwnd, WM_CLOSE, 0, 0) === true;
    } catch { return false; }
  }

  return {
    capabilities: () => ({ supported: true, reason: null, features: FEATURES }),
    snapshotWindows, findPermissionDialog, raise, yieldForeground, foreground, close,
  };
}

module.exports = { createWin32ChromeOs, BROWSER_EXES, DIALOG_TITLE, WM_CLOSE };
