'use strict';
// Chrome への接続の OS の層（Windows）。core/chrome/os.mjs の口の実装（docs/inapp-browser.md「OS ごとの層」、ADR 0153・0154）。
// koffi は desktop/computer/win32.cjs の表（createWin32 の戻り値）だけが読む。ここは表の関数を呼ぶだけで、テストは偽の表で動かす。
//
// WindowRef = { id: string }（窓のハンドルの 10 進）。自分が出した ref だけを Map で覚え、知らない値には何もしない
// （ほかのアプリの窓を前に出す・閉じる・隠すことが起きない）。閉じてよいのは確認の窓として出した ref だけ、隠す・戻すのは
// エージェントの窓（題の nonce か窓の大きさで見つけた窓）として出した ref だけ。

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BROWSER_CLASS = 'Chrome_WidgetWin_1';   // Electron のアプリも同じクラスなので、実行ファイルでも絞る
const BROWSER_EXES = new Set(['chrome.exe', 'msedge.exe']);
// 確認の窓の題。言語で変わるので「見つけ方の補助」でしかない（ja は実機で確認。en は未確認）
const DIALOG_TITLE = /リモート\s*デバッグ|remote debugging/i;
const MAX_DIALOG_DIP = { width: 1000, height: 700 };
const SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_RESTORE = 9, SW_SHOWNA = 8;
const WM_CLOSE = 0x0010;
const MAX_REFS = 200;
const MAX_AGENT_REFS = 64;

// 画面の外へ置いた窓のスタイル（ADR 0154）。タスクバーと Alt+Tab から外し、透明度 0 で見えなくし、マウスを素通しにする
const WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_LAYERED = 0x80000;
const STYLE_BITS = WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_APPWINDOW | WS_EX_LAYERED;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
/** 仮想デスクトップの右の端からの余白（物理画素）。窓がどのモニターにも入らない */
const HIDDEN_MARGIN = 1000;
const HIDDEN_X_MAX = 30000;
const GUARD_MS = 150;

const PRODUCTS = {
  chrome: {
    exe: 'chrome.exe',
    appPaths: 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    defaults: [['ProgramFiles', 'Google\\Chrome\\Application\\chrome.exe'], ['ProgramFiles(x86)', 'Google\\Chrome\\Application\\chrome.exe'], ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe']],
  },
};
const PROFILE_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const NONCE = /^[a-f0-9]{8,64}$/;
const NONCE_URL = /^data:text\/html[,;]/;

const FEATURES = Object.freeze({ dialog: true, raise: true, launch: true, conceal: true, watch: true, bounds: true });

const exeName = path_ => (typeof path_ === 'string' && path_ ? path_.split(/[\\/]/).pop().toLowerCase() : null);
const isInt = v => Number.isInteger(v) && Math.abs(v) < 100000;

/**
 * @param {object} deps
 * @param deps.win32 desktop/computer/win32.cjs の表（偽物でもよい）
 * @param [deps.spawn] chrome.exe を起こす（既定は child_process.spawn。テストは偽物）
 * @param [deps.env] 場所の既定の展開に使う環境変数
 * @param [deps.exists] ファイルがあるか（既定は fs.existsSync）
 * @param [deps.timers] 前面の見張りの周期（既定は setInterval / clearInterval）
 */
function createWin32ChromeOs({ win32, log = () => {}, spawn = childProcess.spawn, env = process.env, exists = fs.existsSync,
  timers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: handle => clearInterval(handle) }, guardMs = GUARD_MS }) {
  const refs = new Map();   // id -> { hwnd, kind: 'dialog' | 'foreign' | 'agent', ex0?, concealed? }
  const browsers = new Map();   // id -> { path, product }
  let browserSeq = 0;
  const remember = (hwnd, kind) => {
    const id = String(hwnd);
    const known = refs.get(id);
    // いちど確認の窓・エージェントの窓として出した ref を、前面の窓として出し直しても、印は落とさない
    const keep = known && known.kind !== 'foreign' ? known : null;
    refs.set(id, keep ?? { hwnd, kind });
    if (refs.size > MAX_REFS) {
      // エージェントの窓の ref は、窓がある間は見張りと戻す操作が要るので、古い順の掃除では消さない
      for (const [key, entry] of refs) { if (entry.kind !== 'agent') { refs.delete(key); break; } }
    }
    return { id };
  };
  const rememberAgent = hwnd => {
    const out = remember(hwnd, 'agent');
    const entry = refs.get(out.id);
    if (entry.kind !== 'agent') { entry.kind = 'agent'; }
    const agents = [...refs].filter(([, e]) => e.kind === 'agent');
    if (agents.length > MAX_AGENT_REFS) { const [key, old] = agents[0]; if (!old.concealed) refs.delete(key); }
    return out;
  };
  const known = ref => (ref && typeof ref.id === 'string' ? refs.get(ref.id) : undefined);
  const knownAgent = ref => { const entry = known(ref); return entry?.kind === 'agent' ? entry : undefined; };
  const alive = hwnd => { try { return win32.isWindow ? win32.isWindow(hwnd) : true; } catch { return false; } };

  /** 今あるブラウザー（chrome.exe・msedge.exe）の最上位の窓 */
  function browserWindows() {
    const exes = new Map();   // pid -> 実行ファイル名（1 回の列挙の中だけ覚える）
    const exeOf = pid => { if (!exes.has(pid)) { let path_ = null; try { path_ = win32.processPath(pid); } catch { /* 開けない窓は対象外 */ } exes.set(pid, exeName(path_)); } return exes.get(pid); };
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

  const dipScale = hwnd => 96 / (win32.dpiForWindow?.(hwnd) || 96);
  const dipSize = (hwnd, rect) => {
    if (!rect) return null;
    const scale = dipScale(hwnd);
    return { width: (rect.right - rect.left) * scale, height: (rect.bottom - rect.top) * scale };
  };

  function snapshotWindows() {
    return browserWindows().map(w => String(w.hwnd));
  }

  /**
   * 「リモート デバッグを許可しますか？」の確認の窓。since に無い・見えている・小さい（外形が 1000×700 DIP 以下）ブラウザーの窓。
   * 題が既知の文言なら優先し、無ければ「ブラウザーの窓に所有された」新しい窓が 1 つだけのときに限る
   * （実機の確認の窓は WS_POPUP でブラウザーの窓が持ち主。ふつうの窓は持ち主が無い）
   * port（DevToolsActivePort のポート）が分かれば、そのポートを待ち受けているプロセスの窓だけを見る。
   * 別の User Data の Chrome・Edge・別の chrome.exe が同時に動いていても、取り違えて閉じない。持ち主が分からなければ絞らない。
   */
  function findPermissionDialog({ since = [], port = null } = {}) {
    const before = new Set((Array.isArray(since) ? since : []).map(String));
    let ownerPid = null;
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      try { ownerPid = win32.listenerPid?.(port) || null; } catch { ownerPid = null; }
    }
    const candidates = browserWindows().filter(({ hwnd, info }) => {
      if (ownerPid && info.pid !== ownerPid) return false;
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

  // ---- エージェントの窓（ADR 0154） -----------------------------------------------------------------

  /** ブラウザーの場所。レジストリの App Paths（HKCU → HKLM）、無ければ既定の 3 か所。層が出した id だけが launchWindow に使える */
  function locateBrowser({ product = 'chrome' } = {}) {
    const spec = PRODUCTS[product];
    if (!spec) return null;
    const candidates = [];
    for (const hive of ['HKCU', 'HKLM']) {
      let value = null;
      try { value = win32.registryString?.(hive, spec.appPaths, '') ?? null; } catch { value = null; }
      if (typeof value === 'string' && value.trim()) candidates.push(value.trim().replace(/^"(.*)"$/, '$1'));
    }
    for (const [variable, rest] of spec.defaults) if (env[variable]) candidates.push(path.win32.join(env[variable], rest));
    for (const candidate of candidates) {
      if (exeName(candidate) !== spec.exe || !path.win32.isAbsolute(candidate)) continue;
      let present = false;
      try { present = exists(candidate) === true; } catch { present = false; }
      if (!present) continue;
      const id = `b${++browserSeq}`;
      browsers.set(id, { path: candidate, product });
      if (browsers.size > 8) browsers.delete(browsers.keys().next().value);
      return { id, product };
    }
    return null;
  }

  /**
   * 専用の窓を chrome.exe --profile-directory --new-window で開く。url は題に nonce を持つ data: のページ（findWindowByNonce が窓を見つける）。
   * userDataDir があるときは --user-data-dir を必ず付ける（付けないと利用者の既定の Chrome に窓が開く）。position（物理画素）・size（DIP）は、
   * 一瞬見えるのを避けるための --window-position・--window-size
   */
  function launchWindow({ browser, profileDir, url, nonce, userDataDir = null, position = null, size = null } = {}) {
    const found = browser && typeof browser.id === 'string' ? browsers.get(browser.id) : null;
    if (!found) return { ok: false, reason: 'unknown-browser' };
    if (typeof profileDir !== 'string' || !PROFILE_DIR.test(profileDir)) return { ok: false, reason: 'profile' };
    if (typeof nonce !== 'string' || !NONCE.test(nonce) || typeof url !== 'string' || !NONCE_URL.test(url) || !url.includes(nonce) || url.length > 400) return { ok: false, reason: 'url' };
    if (userDataDir !== null && (typeof userDataDir !== 'string' || !path.win32.isAbsolute(userDataDir) || /[\r\n\0]/.test(userDataDir))) return { ok: false, reason: 'user-data-dir' };
    const args = [];
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
    args.push(`--profile-directory=${profileDir}`, '--new-window');
    if (position && isInt(position.x) && isInt(position.y)) args.push(`--window-position=${position.x},${position.y}`);
    if (size && isInt(size.width) && isInt(size.height) && size.width > 0 && size.height > 0) args.push(`--window-size=${size.width},${size.height}`);
    args.push(url);
    try {
      const child = spawn(found.path, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on?.('error', error => log(`launch failed: ${error.message}`));
      child.unref?.();
      log('launch window');
      return { ok: true };
    } catch (error) {
      log(`launch failed: ${error.message}`);
      return { ok: false, reason: 'spawn' };
    }
  }

  /** 題に nonce を含むブラウザーの窓（launchWindow・createTarget が開いた、題が nonce のページの窓） */
  function findWindowByNonce(nonce) {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
    const hit = browserWindows().find(({ info }) => info.title.includes(nonce));
    return hit ? rememberAgent(hit.hwnd) : null;
  }

  /**
   * 外形が bounds（CDP の Browser.getWindowBounds の DIP）に合うブラウザーの窓。window.open の popup など、題で見つけられない窓用。
   * 位置・大きさとも 16 DIP の内で、見えていて、すでにエージェントの窓として出していない窓がちょうど 1 つのときだけ返す（曖昧なら null）
   */
  function findWindowByBounds({ bounds } = {}) {
    if (!bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)) return null;
    const tolerance = 16;
    const hits = browserWindows().filter(({ hwnd, info }) => {
      if (refs.get(String(hwnd))?.kind === 'agent' || !info.visible || info.iconic || info.cloaked || !info.rect) return false;
      const scale = dipScale(hwnd);
      const left = info.rect.left * scale, top = info.rect.top * scale;
      const width = (info.rect.right - info.rect.left) * scale, height = (info.rect.bottom - info.rect.top) * scale;
      return Math.abs(left - bounds.left) <= tolerance && Math.abs(top - bounds.top) <= tolerance
        && Math.abs(width - bounds.width) <= tolerance && Math.abs(height - bounds.height) <= tolerance;
    });
    return hits.length === 1 ? rememberAgent(hits[0].hwnd) : null;
  }

  /** 仮想デスクトップ（全モニター）の右の外。どのモニターにも入らない位置（物理画素） */
  function hiddenSpot() {
    let list = [];
    try { list = win32.monitors?.() ?? []; } catch { list = []; }
    if (!list.length) return { x: 20000, y: 0 };
    const right = Math.max(...list.map(m => m.x + m.width));
    const top = Math.min(...list.map(m => m.y));
    return { x: Math.min(right + HIDDEN_MARGIN, HIDDEN_X_MAX), y: top };
  }

  function refreshTaskbar(hwnd) {
    // 拡張スタイルのタスクバーの札は、隠して出し直すと反映される。画面の外・透明の窓なので見えない。前面は取らない
    win32.showWindow(hwnd, SW_HIDE);
    win32.showWindow(hwnd, SW_SHOWNA);
  }

  /**
   * 画面の外・タスクバーと Alt+Tab から外す・透明度 0・マウスの素通し。何度でもかけ直せる（画面の構成が変わったときの置き直し）。
   * エージェントの窓として出した ref だけ
   */
  function conceal(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    try {
      if (!alive(entry.hwnd)) { refs.delete(ref.id); return false; }
      const info = win32.windowInfo(entry.hwnd);
      if (!entry.concealed) entry.ex0 = info.exStyle;
      const spot = hiddenSpot();
      win32.setWindowPos(entry.hwnd, spot.x, spot.y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
      const next = ((info.exStyle | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT) & ~WS_EX_APPWINDOW) >>> 0;
      if (next !== info.exStyle) {
        win32.setExStyle(entry.hwnd, next);
        win32.setLayeredAlpha(entry.hwnd, 0);
        win32.setWindowPos(entry.hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if (info.visible && !info.iconic) refreshTaskbar(entry.hwnd);
      } else {
        win32.setLayeredAlpha(entry.hwnd, 0);
      }
      entry.concealed = true;
      startGuard();
      return true;
    } catch (error) {
      log(`conceal failed: ${error.message}`);
      return false;
    }
  }

  /** 見える形へ戻す（conceal の逆。第 6 段の「引き継ぐ」）。near（層が出した ref）のあるモニターの中へ動かす。前には出さない（raise は別） */
  function reveal(ref, { near = null } = {}) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    try {
      if (!alive(entry.hwnd)) { refs.delete(ref.id); return false; }
      const info = win32.windowInfo(entry.hwnd);
      entry.concealed = false;
      const original = entry.ex0 ?? 0;
      const next = (((info.exStyle & ~STYLE_BITS) | (original & STYLE_BITS)) >>> 0);
      win32.setLayeredAlpha(entry.hwnd, 255);
      if (next !== info.exStyle) win32.setExStyle(entry.hwnd, next);
      win32.setWindowPos(entry.hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      refreshTaskbar(entry.hwnd);
      // 画面の中へ。near の窓のあるモニター（無ければ最初のモニター）の中に収める
      let list = [];
      try { list = win32.monitors?.() ?? []; } catch { list = []; }
      const nearInfo = known(near) && alive(known(near).hwnd) ? win32.windowInfo(known(near).hwnd) : null;
      let monitor = list[0] ?? null;
      if (nearInfo?.rect && list.length) {
        const cx = (nearInfo.rect.left + nearInfo.rect.right) / 2, cy = (nearInfo.rect.top + nearInfo.rect.bottom) / 2;
        monitor = list.find(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ?? monitor;
      }
      if (monitor && info.rect) {
        const width = Math.min(info.rect.right - info.rect.left, monitor.width), height = Math.min(info.rect.bottom - info.rect.top, monitor.height);
        const x = monitor.x + Math.max(0, Math.round((monitor.width - width) / 2)), y = monitor.y + Math.max(0, Math.round((monitor.height - height) / 2));
        win32.setWindowPos(entry.hwnd, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
      }
      return true;
    } catch (error) {
      log(`reveal failed: ${error.message}`);
      return false;
    }
  }

  /** 窓の記録だけを捨てる（窓には触らない）。窓が閉じた・もう見張らない */
  function release(ref) {
    const entry = knownAgent(ref);
    if (!entry) return false;
    entry.concealed = false;
    refs.delete(ref.id);
    return true;
  }

  /** 画面の構成が変わった（モニターの増減・解像度・DPI・スリープ復帰）。隠している窓を置き直す。main が Electron の screen のイベントで呼ぶ */
  function reconceal() {
    let count = 0;
    for (const [id, entry] of [...refs]) {
      if (entry.kind !== 'agent' || !entry.concealed) continue;
      if (!alive(entry.hwnd)) { refs.delete(id); continue; }
      if (conceal({ id })) count += 1;
    }
    if (count) log(`reconceal windows=${count}`);
    return count;
  }

  // ---- 前面の見張り -------------------------------------------------------------------------------
  // 隠している窓が前面を取ったら（window.open・Chrome 自身の前面化）、すぐ直前の前面へ返す。隠している窓があるあいだだけ動く
  let guard = null;
  let lastForeground = 0;
  function guardTick() {
    let fg = 0;
    try { fg = win32.foreground(); } catch { return; }
    const hidden = [];
    for (const [id, entry] of [...refs]) {
      if (entry.kind !== 'agent' || !entry.concealed) continue;
      if (!alive(entry.hwnd)) { refs.delete(id); continue; }
      hidden.push(entry);
    }
    if (!hidden.length) { stopGuard(); return; }
    if (!fg) return;
    if (!hidden.some(entry => entry.hwnd === fg)) { lastForeground = fg; return; }
    // 隠した窓が前面を取った。直前の前面（隠した窓でも、最小化された窓でもない）へ返す
    const target = lastForeground;
    if (!target || target === fg || !alive(target)) return;
    try {
      if (win32.windowInfo(target).iconic) return;
      const method = bring(target);
      log(`guard yield method=${method}`);
    } catch (error) { log(`guard failed: ${error.message}`); }
  }
  function startGuard() {
    if (guard) return;
    try { lastForeground = win32.foreground(); } catch { lastForeground = 0; }
    guard = timers.setInterval(guardTick, guardMs);
    guard?.unref?.();
  }
  function stopGuard() {
    if (!guard) return;
    timers.clearInterval(guard);
    guard = null;
  }

  return {
    capabilities: () => ({ supported: true, reason: null, features: FEATURES }),
    snapshotWindows, findPermissionDialog, raise, yieldForeground, foreground, close,
    locateBrowser, launchWindow, findWindowByNonce, findWindowByBounds, hiddenSpot, conceal, reveal, release,
    reconceal,
    /** テスト用: 見張りを 1 回だけ回す・止める */
    guardTick, stopGuard,
  };
}

module.exports = { createWin32ChromeOs, BROWSER_EXES, DIALOG_TITLE, WM_CLOSE, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW, WS_EX_LAYERED };
