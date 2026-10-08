import { createRequire } from 'node:module';
import { parentPortChromeOs, unsupportedChromeOs } from '../../core/chrome/os.mjs';

const require = createRequire(import.meta.url);
const { createWin32ChromeOs, WM_CLOSE, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW, WS_EX_LAYERED } = require('../../desktop/chrome-os/win32.cjs');
const { createChromeOs, attachChromeOs } = require('../../desktop/chrome-os/index.cjs');

export const name = 'chrome-os';
export const title = 'Chrome への接続の OS の層（Windows）: 確認の窓の見つけ方・前面化・返す・閉じる・使えない OS、エージェントの窓（ブラウザーの場所・chrome.exe の起こし方・窓の見つけ方・隠す／戻す・前面の見張り。偽の Win32 の表と偽の spawn。本物の窓には触らない。ADR 0153・0154）';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CODE = 'C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';

/** 状態を持つ偽の Win32 の表。物理画素 = 150%（dpi 144）の画面 */
function fakeWin32({ directForeground = true } = {}) {
  const calls = [];
  const windows = new Map();
  const exes = new Map([[10, CHROME], [11, CHROME], [20, CODE], [30, NOTEPAD], [40, EDGE]]);
  const w = {
    calls, windows,
    fg: 0,
    attached: false,
    directForeground,
    add(hwnd, props) {
      windows.set(hwnd, { hwnd, pid: 10, title: '', className: 'Chrome_WidgetWin_1', visible: true, iconic: false, cloaked: false, owner: 0, dpi: 144, thread: hwnd,
        rect: { left: 0, top: 0, right: 1040, bottom: 531 }, exStyle: 0, hung: false, ...props });
      return hwnd;
    },
    topLevelWindows: () => [...windows.keys()],
    windowInfo(hwnd) { const x = windows.get(hwnd); if (!x) throw new Error('no window'); return { ...x }; },
    processPath: pid => exes.get(pid) ?? null,
    dpiForWindow: hwnd => windows.get(hwnd)?.dpi ?? 96,
    ownerOf: hwnd => windows.get(hwnd)?.owner ?? 0,
    foreground: () => w.fg,
    setForeground(hwnd) { calls.push(['setForeground', hwnd, w.attached]); if (w.directForeground || w.attached) { w.fg = hwnd; return true; } return false; },
    showWindow(hwnd, cmd) { calls.push(['showWindow', hwnd, cmd]); if (cmd === 9) windows.get(hwnd).iconic = false; if (cmd === 0) windows.get(hwnd).visible = false; if (cmd === 8 || cmd === 4) windows.get(hwnd).visible = true; return true; },
    isWindow: hwnd => windows.has(hwnd),
    setExStyle(hwnd, value) { calls.push(['setExStyle', hwnd, value]); windows.get(hwnd).exStyle = value >>> 0; return true; },
    setWindowPos(hwnd, x, y, cx, cy, flags) {
      calls.push(['setWindowPos', hwnd, x, y, cx, cy, flags]);
      const wnd = windows.get(hwnd), width = wnd.rect.right - wnd.rect.left, height = wnd.rect.bottom - wnd.rect.top;
      const left = flags & 0x2 ? wnd.rect.left : x, top = flags & 0x2 ? wnd.rect.top : y;
      const nw = flags & 0x1 ? width : cx, nh = flags & 0x1 ? height : cy;
      wnd.rect = { left, top, right: left + nw, bottom: top + nh };
      return true;
    },
    setLayeredAlpha(hwnd, alpha) { calls.push(['setLayeredAlpha', hwnd, alpha]); windows.get(hwnd).alpha = alpha; return true; },
    displays: [{ handle: 1, x: 0, y: 0, width: 2560, height: 1440, primary: true, dpi: 144 }, { handle: 2, x: 2560, y: 0, width: 1920, height: 1080, primary: false, dpi: 96 }],
    monitors: () => w.displays.map(d => ({ ...d })),
    listenerPid: port => (port === 9222 ? 10 : null),   // つないだ Chrome（pid 10）がポート 9222 を待ち受けている
    registry: {},
    registryString: (hive, subkey, name) => w.registry[`${hive}|${subkey}|${name}`] ?? null,
    bringToTop(hwnd) { calls.push(['bringToTop', hwnd]); return true; },
    windowThread: hwnd => windows.get(hwnd)?.thread ?? 0,
    currentThread: () => 1,
    attachThreadInput(from, to, on) { calls.push(['attachThreadInput', from, to, on]); w.attached = on; return true; },
    postMessage(hwnd, msg, wp, lp) { calls.push(['postMessage', hwnd, msg, wp, lp]); return true; },
  };
  return w;
}

/** 実機の確認の窓の形（694×354 物理画素・dpi 144・ブラウザーの窓が持ち主・題は日本語） */
const DIALOG = { title: 'リモート デバッグを許可しますか？', rect: { left: 100, top: 100, right: 794, bottom: 454 }, owner: 900 };
const callNames = w => w.calls.map(c => c[0]).join();

export default async function (t) {
  // ===== findPermissionDialog =====
  {
    const w = fakeWin32();
    w.add(900, { title: 'ふつうの Chrome の窓', rect: { left: 0, top: 0, right: 3840, bottom: 2160 } });
    w.add(901, { title: 'Pleiad', pid: 20, rect: { left: 0, top: 0, right: 1000, bottom: 600 } });   // Electron のアプリ（同じクラス）
    w.add(902, { title: 'メモ帳', className: 'Notepad', pid: 30 });
    const os = createWin32ChromeOs({ win32: w });
    const snap = os.snapshotWindows();
    t.ok('snapshotWindows は chrome.exe・msedge.exe のブラウザーの窓だけ（Electron のアプリ・ほかのクラスは入らない）', JSON.stringify(snap) === JSON.stringify(['900']), JSON.stringify(snap));
    t.ok('新しい窓が無ければ null', os.findPermissionDialog({ since: snap }) === null);

    w.add(910, DIALOG);
    const hit = os.findPermissionDialog({ since: snap });
    t.ok('写しに無い・小さい・ブラウザーの窓の確認（題が既知）を返す', hit?.id === '910', JSON.stringify(hit));

    t.ok('写しに入っている窓は返さない（since で除く）', os.findPermissionDialog({ since: [...snap, '910'] }) === null);
    w.add(911, { title: 'ふつうの新しい Chrome の窓', rect: { left: 0, top: 0, right: 3000, bottom: 1800 } });
    w.add(912, { title: 'リモート デバッグを許可しますか？', pid: 20, rect: DIALOG.rect, owner: 900 });
    w.add(913, { title: 'リモート デバッグを許可しますか？', ...{ rect: DIALOG.rect, owner: 900 }, visible: false });
    w.add(914, { title: 'リモート デバッグを許可しますか？', ...{ rect: DIALOG.rect, owner: 900 }, iconic: true });
    const again = os.findPermissionDialog({ since: [...snap, '910'] });
    t.ok('大きな新しい窓・ほかの実行ファイルの窓・見えない窓・最小化の窓は返さない', again === null, JSON.stringify(again));

    // 外形は DIP で見る: 150% で 1500×1000 物理画素 = 1000×667 DIP は小さい、1600 物理画素 = 1067 DIP は大きい
    const d2 = fakeWin32(); const os2 = createWin32ChromeOs({ win32: d2 });
    d2.add(920, { ...DIALOG, rect: { left: 0, top: 0, right: 1500, bottom: 1000 } });
    t.ok('外形は DIP で比べる（150% で 1500×1000 物理画素 = 1000×667 DIP は確認の大きさに入る）', os2.findPermissionDialog({ since: [] })?.id === '920');
    d2.windows.get(920).rect = { left: 0, top: 0, right: 1600, bottom: 1000 };
    t.ok('1600 物理画素（約 1067 DIP）は大きすぎる', os2.findPermissionDialog({ since: [] }) === null);

    // 題が知らない言語でも、ブラウザーの窓が持ち主の窓が 1 つだけなら確認とみなす。持ち主が無い・複数あるときは返さない
    const d3 = fakeWin32(); const os3 = createWin32ChromeOs({ win32: d3 });
    d3.add(930, { ...DIALOG, title: 'Autoriser le débogage à distance ?' });
    t.ok('題が未知の言語でも、持ち主のある新しい小さな窓が 1 つなら確認', os3.findPermissionDialog({ since: [] })?.id === '930');
    d3.add(931, { ...DIALOG, title: 'Autre chose' });
    t.ok('題が未知で候補が 2 つなら返さない（取り違えて閉じない）', os3.findPermissionDialog({ since: [] }) === null);
    const d4 = fakeWin32(); const os4 = createWin32ChromeOs({ win32: d4 });
    d4.add(940, { ...DIALOG, title: 'Un petit popup', owner: 0 });
    t.ok('題が未知で持ち主も無い小さな窓（利用者のポップアップ）は返さない', os4.findPermissionDialog({ since: [] }) === null);
    d4.add(941, { ...DIALOG, title: 'Remote debugging prompt', owner: 0 });
    t.ok('英語の題（remote debugging）は題で見つける', os4.findPermissionDialog({ since: [] })?.id === '941');

    // 別の User Data の Chrome（同じ chrome.exe・同じクラス）が同時に動いていても、ポートの持ち主の窓だけを見る。
    // pid 10 = 利用者の Chrome、pid 11 = 確かめ専用の Chrome（ポート 9222 を待ち受ける）
    const d5 = fakeWin32(); const os5 = createWin32ChromeOs({ win32: d5 });
    d5.listenerPid = port => (port === 9222 ? 11 : null);
    d5.add(950, { ...DIALOG, pid: 10 });
    t.ok('ポートの持ち主でない Chrome の確認の窓（題が一致していても）は返さない', os5.findPermissionDialog({ since: [], port: 9222 }) === null);
    d5.add(951, { ...DIALOG, pid: 11 });
    t.ok('ポートの持ち主の Chrome の窓だけを返す', os5.findPermissionDialog({ since: [], port: 9222 })?.id === '951');
    t.ok('port が無ければ今までどおり絞らない（先に見つかる題が一致の窓）', os5.findPermissionDialog({ since: [] })?.id === '950');
    t.ok('持ち主が分からないポート（待ち受けが無い）は絞らない', os5.findPermissionDialog({ since: [], port: 9333 })?.id === '950');
    d5.listenerPid = () => { throw new Error('iphlpapi'); };
    t.ok('持ち主を引けなくても投げない（絞らない）', os5.findPermissionDialog({ since: [], port: 9222 })?.id === '950');
    t.ok('不正な port（文字列・範囲外）は無視する', os5.findPermissionDialog({ since: [], port: '9222' })?.id === '950' && os5.findPermissionDialog({ since: [], port: 70000 })?.id === '950');
    const d6 = fakeWin32(); const os6 = createWin32ChromeOs({ win32: d6 });
    d6.add(960, { ...DIALOG, pid: 10 });
    t.ok('listenerPid の無い表（古い層）でも動く', os6.findPermissionDialog({ since: [], port: 9222 })?.id === '960');
  }

  // ===== raise =====
  {
    const w = fakeWin32({ directForeground: true });
    w.add(1, { title: 'メモ帳', className: 'Notepad', pid: 30, thread: 77 });
    w.add(910, DIALOG);
    w.fg = 1;
    const os = createWin32ChromeOs({ win32: w });
    const ref = os.findPermissionDialog({ since: [] });
    const r = os.raise(ref);
    t.ok('SetForegroundWindow で前面が変われば direct。AttachThreadInput は使わない', r.ok && r.method === 'direct' && w.fg === 910 && !callNames(w).includes('attachThreadInput'), callNames(w));

    const a = fakeWin32({ directForeground: false });
    a.add(1, { title: 'メモ帳', className: 'Notepad', pid: 30, thread: 77 });
    a.add(910, DIALOG);
    a.fg = 1;
    const osA = createWin32ChromeOs({ win32: a });
    const refA = osA.findPermissionDialog({ since: [] });
    const rA = osA.raise(refA);
    const order = a.calls.map(c => c[0] === 'attachThreadInput' ? `attach(${c[3]})` : c[0]).join();
    t.ok('前面が変わらなければ AttachThreadInput(自分, 前面のスレッド, true) → BringWindowToTop → SetForegroundWindow → AttachThreadInput(…, false) の順で attach',
      rA.ok && rA.method === 'attach' && a.fg === 910 && order === 'setForeground,attach(true),bringToTop,setForeground,attach(false)', order);
    t.ok('attach の相手は前面の窓のスレッド', a.calls.find(c => c[0] === 'attachThreadInput')?.slice(1, 3).join() === '1,77');

    const f = fakeWin32({ directForeground: false });
    f.add(910, DIALOG); f.fg = 910;   // 前面が自分と同じスレッド: attach できない（同じなら attach しない）
    f.add(2, { title: 'x', thread: 1, pid: 30, className: 'Notepad' });
    f.fg = 2;
    f.attachThreadInput = () => false;
    f.setForeground = () => false;
    const osF = createWin32ChromeOs({ win32: f });
    t.ok('どの手でも前面にならなければ failed（投げない）', osF.raise(osF.findPermissionDialog({ since: [] })).method === 'failed');

    const m = fakeWin32();
    m.add(910, { ...DIALOG, iconic: true });
    const osM = createWin32ChromeOs({ win32: m });
    // 最小化の窓は findPermissionDialog が返さないので、前面の窓として出た ref（最小化）を raise する
    m.fg = 910;
    const fg = osM.foreground();
    m.fg = 0;
    osM.raise({ id: fg.id });
    t.ok('最小化の窓は SW_RESTORE（9）で戻してから前面にする', m.calls[0].join() === 'showWindow,910,9' && m.fg === 910, JSON.stringify(m.calls));
    t.ok('知らない ref には何もしない', osM.raise({ id: '12345' }).method === 'unknown' && osM.raise(null).ok === false && osM.raise({ id: 5 }).ok === false);
  }

  // ===== yieldForeground =====
  {
    const w = fakeWin32({ directForeground: true });
    w.add(1, { title: 'メモ帳', className: 'Notepad', pid: 30, thread: 77 });
    w.add(910, DIALOG);
    w.fg = 1;
    const os = createWin32ChromeOs({ win32: w });
    const notes = os.foreground();
    const dialog = os.findPermissionDialog({ since: [] });
    t.ok('確認が前面でなければ何もしない', os.yieldForeground(dialog, { to: notes }) === false && w.calls.length === 0);
    w.fg = 910;
    t.ok('確認が前面なら、直前の前面（foreground() で出した ref）へ raise と同じ手順で返す', os.yieldForeground(dialog, { to: notes }) === true && w.fg === 1, JSON.stringify(w.calls));
    t.ok('知らない to には返さない', os.yieldForeground(dialog, { to: { id: '999' } }) === false);
  }

  // ===== foreground =====
  {
    const w = fakeWin32();
    w.add(1, { title: 'メモ帳', className: 'Notepad', pid: 30 });
    w.add(2, { title: 'Chrome', pid: 10 });
    const os = createWin32ChromeOs({ win32: w });
    w.fg = 1;
    t.ok('foreground() はブラウザーの窓かを添える（メモ帳は false）', JSON.stringify(os.foreground()) === JSON.stringify({ id: '1', browser: false }));
    w.fg = 2;
    t.ok('ブラウザーの窓は browser: true', os.foreground()?.browser === true);
    w.fg = 0;
    t.ok('前面が無ければ null', os.foreground() === null);
  }

  // ===== close =====
  {
    const w = fakeWin32();
    w.add(1, { title: 'メモ帳', className: 'Notepad', pid: 30 });
    w.add(910, DIALOG);
    w.fg = 1;
    const os = createWin32ChromeOs({ win32: w });
    const user = os.foreground();
    t.ok('foreground() で出した ref（利用者の窓）には PostMessageW を呼ばない', os.close(user) === false && !callNames(w).includes('postMessage'));
    t.ok('出していない ref には呼ばない', os.close({ id: '910' }) === false && os.close({ id: '777' }) === false && os.close(null) === false);
    const dialog = os.findPermissionDialog({ since: [] });
    t.ok('確認の ref には WM_CLOSE（0x0010）', os.close(dialog) === true && w.calls.at(-1).join() === `postMessage,910,${WM_CLOSE},0,0` && WM_CLOSE === 0x0010, JSON.stringify(w.calls.at(-1)));
    // 確認の窓が前面の窓として出し直されても、閉じてよい印は落ちない
    w.fg = 910;
    os.foreground();
    t.ok('確認が前面の窓として ref を出し直されても閉じられる', os.close(dialog) === true);
    // 窓のハンドルが別のアプリに再利用されたら閉じない
    w.windows.get(910).pid = 30; w.windows.get(910).className = 'Notepad';
    const before = w.calls.length;
    t.ok('同じハンドルが別のアプリの窓になっていたら閉じない', os.close(dialog) === false && w.calls.length === before);
  }

  // ===== index.cjs: 使えない OS・parentPort の往復 =====
  {
    for (const [platform, win32, reason, expect] of [['darwin', null, 'native', 'platform'], ['linux', {}, 'native', 'platform'], ['win32', null, 'native', 'native'], ['win32', null, 'platform', 'platform']]) {
      const os = createChromeOs({ platform, win32, reason });
      const caps = os.capabilities();
      t.ok(`${platform}${win32 ? '' : '（win32 の表なし）'} → supported: false / ${expect}、どの口も null・false で投げない`,
        caps.supported === false && caps.reason === expect && os.snapshotWindows() === null && os.findPermissionDialog({ since: [] }) === null
        && os.raise({ id: '1' }).ok === false && os.yieldForeground({ id: '1' }, {}) === false && os.foreground() === null && os.close({ id: '1' }) === false
        && os.locateBrowser({}) === null && os.launchWindow({}).ok === false && os.findWindowByNonce('a') === null && os.findWindowByBounds({}) === null
        && os.hiddenSpot() === null && os.conceal({ id: '1' }) === false && os.reveal({ id: '1' }) === false && os.release({ id: '1' }) === false && os.reconceal() === 0);
    }
    const win = createChromeOs({ platform: 'win32', win32: fakeWin32() });
    const features = win.capabilities().features;
    t.ok('Windows と win32 の表があれば supported（機能は dialog・raise・launch・conceal・watch・bounds）', win.capabilities().supported === true
      && ['dialog', 'raise', 'launch', 'conceal', 'watch', 'bounds'].every(name => features[name] === true), JSON.stringify(features));
  }
  {
    // core の parentPortChromeOs ⇄ main の attachChromeOs ⇄ 偽の Win32
    const w = fakeWin32();
    w.add(1, { title: 'メモ帳', className: 'Notepad', pid: 30 });
    w.fg = 1;
    const toWorker = [], toPort = [];
    const worker = { on: (type, fn) => toWorker.push(fn), postMessage: m => queueMicrotask(() => toPort.forEach(fn => fn({ data: m }))) };
    const port = { on: (type, fn) => toPort.push(fn), postMessage: m => queueMicrotask(() => toWorker.forEach(fn => fn(m))) };
    const logs = [];
    const core = parentPortChromeOs(port, { timeoutMs: 200, readyWaitMs: 200 });
    t.ok('main の層が付く前は pending（supported: false）', core.capabilities().supported === false && core.capabilities().reason === 'pending');
    attachChromeOs(worker, { chromeOs: createChromeOs({ platform: 'win32', win32: w }), log: l => logs.push(l) });
    const caps = await core.ready();
    t.ok('chrome-os-ready を受けて supported になる', caps.supported === true && core.capabilities().features.raise === true);
    w.add(910, DIALOG);
    const dialog = await core.findPermissionDialog({ since: (await core.snapshotWindows()).filter(id => id !== '910') });
    t.ok('依頼と応答が往復する（snapshotWindows・findPermissionDialog）', dialog?.id === '910', JSON.stringify(dialog));
    const fg = await core.foreground();
    t.ok('foreground の往復', fg?.id === '1' && fg.browser === false);
    t.ok('raise の往復（ref を JSON で渡す）', (await core.raise(dialog)).method === 'direct' && w.fg === 910);
    t.ok('yieldForeground の往復', await core.yieldForeground(dialog, { to: fg }) === true && w.fg === 1);
    t.ok('close の往復', await core.close(dialog) === true && w.calls.at(-1)[0] === 'postMessage');
    // 知らない action は断る（口の外のものは呼ばない）
    const raw = [];
    toPort.push(m => raw.push(m.data));
    worker.postMessage = m => queueMicrotask(() => toPort.forEach(fn => fn({ data: m })));
    toWorker.forEach(fn => fn({ type: 'chrome-os', id: 'x1', action: 'minimizeAll', args: {} }));
    toWorker.forEach(fn => fn({ type: 'chrome-os', id: 'x2', action: '__proto__', args: {} }));
    await new Promise(r => setTimeout(r, 20));
    t.ok('知らない action は ok: false で断る', raw.filter(m => m.type === 'chrome-os-result').every(m => m.ok === false) && raw.filter(m => m.type === 'chrome-os-result').length === 2, JSON.stringify(raw));
  }
  {
    // 使えない層・port が無い・main が答えない
    const none = parentPortChromeOs(null);
    t.ok('port が無い（Electron でない）→ no-desktop の口で、どの口も null・false', none.capabilities().supported === false && none.capabilities().reason === 'no-desktop' && await none.snapshotWindows() === null && await none.close({ id: '1' }) === false);
    const sent = [];
    const silent = parentPortChromeOs({ on() {}, postMessage: m => sent.push(m) }, { readyWaitMs: 20, timeoutMs: 20 });
    const caps = await silent.ready();
    t.ok('main が chrome-os-ready を返さなければ、待った後に supported: false（no-desktop）', caps.supported === false && caps.reason === 'no-desktop');
    t.ok('起動時に chrome-os-ready-request を送る', sent[0]?.type === 'chrome-os-ready-request');
    const uns = unsupportedChromeOs('platform');
    t.ok('unsupportedChromeOs はテスト・ほかの OS の既定（supported: false）', uns.capabilities().supported === false && (await uns.ready()).reason === 'platform');
    // ready の後に main が unsupported を返した → 呼び出しは送らず fallback
    const posts = [];
    let handler;
    const port2 = { on: (type, fn) => { handler = fn; }, postMessage: m => posts.push(m) };
    const core2 = parentPortChromeOs(port2);
    handler({ data: { type: 'chrome-os-ready', supported: false, reason: 'platform' } });
    t.ok('unsupported を受けたら、依頼を main へ送らず null・false を返す', await core2.findPermissionDialog({ since: [] }) === null && posts.every(m => m.type !== 'chrome-os'));
  }

  // ===== エージェントの窓（ADR 0154）: ブラウザーの場所・chrome.exe の起こし方 =====
  const NONCE = '0123456789abcdef';
  const NONCE_URL = `data:text/html,<title>PLY-${NONCE}</title>`;
  const APP_PATHS = 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';
  const ENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
  const fakeSpawn = () => {
    const spawned = [];
    const spawn = (exe, args, options) => { spawned.push({ exe, args, options }); return { on() {}, unref() {}, pid: 77 }; };
    return { spawned, spawn };
  };
  {
    const w = fakeWin32();
    const present = new Set();
    const { spawned, spawn } = fakeSpawn();
    const os = createWin32ChromeOs({ win32: w, env: ENV, exists: p => present.has(p), spawn });
    const exeOf = browser => { os.launchWindow({ browser, profileDir: 'Default', url: NONCE_URL, nonce: NONCE }); return spawned.at(-1)?.exe; };
    t.ok('どこにも無ければ locateBrowser は null', os.locateBrowser({}) === null && os.locateBrowser({ product: 'firefox' }) === null);
    const hklm = 'D:\\Chrome\\hklm\\chrome.exe', hkcu = 'D:\\Chrome\\hkcu\\chrome.exe';
    w.registry[`HKLM|${APP_PATHS}|`] = hklm; present.add(hklm);
    t.ok('レジストリの App Paths（HKLM）の chrome.exe を見つける', exeOf(os.locateBrowser({})) === hklm);
    w.registry[`HKCU|${APP_PATHS}|`] = `"${hkcu}"`; present.add(hkcu);
    t.ok('HKCU を HKLM より先に見る（引用符つきの値も読む）', exeOf(os.locateBrowser({})) === hkcu);
    present.delete(hkcu);
    t.ok('ファイルが無い候補は飛ばして、次の候補を使う', exeOf(os.locateBrowser({})) === hklm);
    w.registry[`HKCU|${APP_PATHS}|`] = 'C:\\Windows\\System32\\notepad.exe'; present.add('C:\\Windows\\System32\\notepad.exe');
    delete w.registry[`HKLM|${APP_PATHS}|`];
    t.ok('chrome.exe でない実行ファイルは使わない（レジストリが書き換えられていても）', os.locateBrowser({}) === null);
    delete w.registry[`HKCU|${APP_PATHS}|`];
    const fallback = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    present.add(fallback); present.add('C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
    t.ok('レジストリに無ければ既定の 3 か所（Program Files → Program Files (x86) → LOCALAPPDATA の順）', exeOf(os.locateBrowser({})) === fallback);
    const browser = os.locateBrowser({});
    t.ok('locateBrowser は実行ファイルのパスを渡さず、層が出した id だけを返す', typeof browser.id === 'string' && browser.product === 'chrome' && !JSON.stringify(browser).includes('chrome.exe'));
  }
  {
    const w = fakeWin32();
    const { spawned, spawn } = fakeSpawn();
    const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const os = createWin32ChromeOs({ win32: w, env: ENV, exists: p => p === exe, spawn });
    const browser = os.locateBrowser({});
    const base = { browser, profileDir: 'Profile 1', url: NONCE_URL, nonce: NONCE };
    const result = os.launchWindow({ ...base, userDataDir: 'C:\\Users\\x\\dev\\pleiad-chrome-test', position: { x: 5480, y: 0 }, size: { width: 1100, height: 720 } });
    const call = spawned.at(-1);
    t.ok('chrome.exe を --user-data-dir・--profile-directory・--new-window・--window-position・--window-size・URL の順の引数で起こす', result.ok === true && call.exe === exe
      && JSON.stringify(call.args) === JSON.stringify(['--user-data-dir=C:\\Users\\x\\dev\\pleiad-chrome-test', '--profile-directory=Profile 1', '--new-window', '--window-position=5480,0', '--window-size=1100,720', NONCE_URL]), JSON.stringify(call));
    t.ok('切り離して起こす（detached・stdio なし）', call.options.detached === true && call.options.stdio === 'ignore');
    os.launchWindow(base);
    t.ok('userDataDir が無ければ --user-data-dir を付けない（既定の User Data）', spawned.at(-1).args.every(a => !a.startsWith('--user-data-dir')) && spawned.at(-1).args.includes('--profile-directory=Profile 1'));
    const before = spawned.length;
    const rejects = [
      ['層が出していない browser', { ...base, browser: { id: 'b999' } }], ['browser の id でないもの', { ...base, browser: { id: 'C:\\Windows\\notepad.exe' } }],
      ['親の道を含むプロフィール', { ...base, profileDir: '..\\Default' }], ['ハイフンで始まるプロフィール（引数の注入）', { ...base, profileDir: '--evil' }], ['空のプロフィール', { ...base, profileDir: '' }],
      ['短い nonce', { ...base, nonce: 'abc' }], ['nonce を含まない URL', { ...base, url: 'data:text/html,<title>x</title>' }], ['data: でない URL', { ...base, url: `https://example.com/${NONCE}` }],
      ['相対の userDataDir', { ...base, userDataDir: 'relative\\dir' }], ['改行を含む userDataDir', { ...base, userDataDir: 'C:\\a\nb' }],
    ];
    const failed = rejects.filter(([, args]) => os.launchWindow(args).ok !== false).map(([name]) => name);
    t.ok('入力が不正なら chrome.exe を起こさない', failed.length === 0 && spawned.length === before, failed.join());
    const throwing = createWin32ChromeOs({ win32: w, env: ENV, exists: p => p === exe, spawn: () => { throw new Error('spawn EACCES'); } });
    t.ok('起こせなくても投げず ok: false', throwing.launchWindow({ ...base, browser: throwing.locateBrowser({}) }).ok === false);
  }

  // ===== エージェントの窓: 窓の見つけ方（題の nonce・外形） =====
  {
    const w = fakeWin32();
    w.add(500, { title: `PLY-${NONCE} - Google Chrome`, rect: { left: 0, top: 0, right: 1650, bottom: 1080 } });
    w.add(501, { title: `PLY-${NONCE} - Pleiad`, pid: 20 });                          // Electron のアプリ（同じクラス）
    w.add(502, { title: `PLY-fedcba9876543210 - Google Chrome` });
    const os = createWin32ChromeOs({ win32: w });
    t.ok('findWindowByNonce は題に nonce を持つブラウザーの窓（Electron のアプリの窓・別の nonce の窓は除く）', os.findWindowByNonce(NONCE)?.id === '500');
    t.ok('nonce が無い・形が違うときは null', os.findWindowByNonce('0000000000000000') === null && os.findWindowByNonce('PLY') === null && os.findWindowByNonce(null) === null);
    // 外形（DIP）: 150% で 486×447 物理画素 = 324×298 DIP の popup が左上に出た
    const b = fakeWin32();
    b.add(600, { title: 'about:blank - Google Chrome', rect: { left: 0, top: 0, right: 486, bottom: 447 } });
    const ob = createWin32ChromeOs({ win32: b });
    const popup = ob.findWindowByBounds({ port: 9222, bounds: { left: 0, top: 0, width: 324, height: 298 } });
    t.ok('findWindowByBounds は外形（DIP。150% の物理画素を換算）が合う窓を返す', popup?.id === '600');
    t.ok('すでにエージェントの窓として出した窓は、もう返さない', ob.findWindowByBounds({ port: 9222, bounds: { left: 0, top: 0, width: 324, height: 298 } }) === null);
    b.add(601, { title: 'a', rect: { left: 0, top: 0, right: 486, bottom: 447 } });
    b.add(602, { title: 'b', rect: { left: 3, top: 3, right: 489, bottom: 450 } });
    t.ok('合う窓が 2 つあれば曖昧なので null', ob.findWindowByBounds({ port: 9222, bounds: { left: 0, top: 0, width: 324, height: 298 } }) === null);
    b.windows.get(601).visible = false; b.windows.get(602).iconic = true;
    t.ok('見えない窓・最小化の窓は候補にしない', ob.findWindowByBounds({ port: 9222, bounds: { left: 0, top: 0, width: 324, height: 298 } }) === null);
    b.windows.get(601).visible = true;
    t.ok('許容は 16 DIP（外れていれば見つけない）', ob.findWindowByBounds({ port: 9222, bounds: { left: 100, top: 100, width: 324, height: 298 } }) === null && ob.findWindowByBounds({ port: 9222, bounds: { left: 0, top: 0, width: 324, height: 298 } })?.id === '601');
    t.ok('bounds が数でなければ null', ob.findWindowByBounds({ port: 9222, bounds: { left: 'a' } }) === null && ob.findWindowByBounds({}) === null);
  }

  // ===== エージェントの窓: 隠す・戻す・置き直し・解放 =====
  const WS_NOREDIRECTION = 0x200000;
  const winWith = () => {
    const w = fakeWin32();
    w.add(500, { title: `PLY-${NONCE} - Google Chrome`, exStyle: WS_NOREDIRECTION, rect: { left: 100, top: 100, right: 1700, bottom: 1180 } });
    w.add(700, { title: 'メモ帳', className: 'Notepad', pid: 30, rect: { left: 2600, top: 100, right: 3400, bottom: 700 } });
    w.fg = 700;
    return w;
  };
  {
    const w = winWith();
    const intervals = [], cleared = [];
    const timers = { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: id => cleared.push(id) };
    const os = createWin32ChromeOs({ win32: w, timers, guardMs: 150 });
    const ref = os.findWindowByNonce(NONCE);
    t.ok('hiddenSpot は仮想デスクトップ（全モニター）の右の外', JSON.stringify(os.hiddenSpot()) === JSON.stringify({ x: 5480, y: 0 }), JSON.stringify(os.hiddenSpot()));
    t.ok('conceal は true を返す', os.conceal(ref) === true);
    const win = w.windows.get(500);
    t.ok('窓を仮想デスクトップの右の外へ動かす（大きさは変えない）', win.rect.left === 5480 && win.rect.top === 0 && win.rect.right - win.rect.left === 1600 && win.rect.bottom - win.rect.top === 1080, JSON.stringify(win.rect));
    t.ok('WS_EX_TOOLWINDOW・WS_EX_LAYERED・WS_EX_TRANSPARENT を付け、WS_EX_APPWINDOW は外す（元のスタイルは残す）',
      (win.exStyle & WS_EX_TOOLWINDOW) && (win.exStyle & WS_EX_LAYERED) && (win.exStyle & WS_EX_TRANSPARENT) && !(win.exStyle & WS_EX_APPWINDOW) && (win.exStyle & WS_NOREDIRECTION), win.exStyle.toString(16));
    t.ok('透明度は 0', win.alpha === 0);
    const showCmds = w.calls.filter(c => c[0] === 'showWindow' && c[1] === 500).map(c => c[2]);
    t.ok('タスクバーの札を替えるため、隠して出し直す（SW_HIDE → SW_SHOWNA）。最小化（SW_MINIMIZE）はしない', showCmds.join() === '0,8', showCmds.join());
    t.ok('どの SetWindowPos も SWP_NOACTIVATE を付ける・前面は取らない', w.calls.filter(c => c[0] === 'setWindowPos').every(c => c[6] & 0x10) && !w.calls.some(c => c[0] === 'setForeground'));
    const callsBefore = w.calls.length;
    t.ok('もう一度かけても、スタイルが同じなら隠して出し直さない（置き直しだけ）', os.conceal(ref) === true && w.calls.slice(callsBefore).every(c => c[0] !== 'showWindow' && c[0] !== 'setExStyle'));

    // 層が出した agent の ref 以外には何もしない
    const fg = os.foreground();
    const dialogW = fakeWin32(); dialogW.add(910, DIALOG); const dialogOs = createWin32ChromeOs({ win32: dialogW });
    const dialog = dialogOs.findPermissionDialog({ since: [] });
    const n = w.calls.length;
    t.ok('前面の窓の ref・確認の窓の ref・知らない ref は conceal も reveal もしない', os.conceal(fg) === false && os.reveal(fg) === false && dialogOs.conceal(dialog) === false && os.conceal({ id: '12345' }) === false && os.conceal(null) === false
      && w.calls.length === n && dialogW.calls.length === 0);

    // 前面の見張り
    t.ok('隠している間は見張りが 1 つ動く（150 ms ごと）', intervals.length === 1 && intervals[0].ms === 150);
    w.fg = 700; os.guardTick();
    w.fg = 500;
    os.guardTick();
    t.ok('隠した窓が前面を取ったら、直前の前面（メモ帳）へすぐ返す', w.fg === 700, String(w.fg));
    w.windows.get(700).iconic = true; w.fg = 500; os.guardTick();
    t.ok('直前の前面が最小化されていたら、勝手に戻さない', w.fg === 500 && !w.calls.some(c => c[0] === 'showWindow' && c[1] === 700 && c[2] === 9));
    w.windows.get(700).iconic = false; w.fg = 700; os.guardTick();

    // 戻す
    const near = os.foreground();   // 前面の窓（メモ帳。2 つ目のモニター）
    const beforeReveal = w.calls.length;
    t.ok('reveal は true を返す', os.reveal(ref, { near }) === true);
    t.ok('元のスタイルに戻す（付けた 3 つを外し、元からあるものは残す）・透明度 255', w.windows.get(500).exStyle === WS_NOREDIRECTION && w.windows.get(500).alpha === 255, w.windows.get(500).exStyle.toString(16));
    const r = w.windows.get(500).rect;
    t.ok('near のあるモニター（2 つ目: x 2560〜4480）の中へ戻す・前には出さない', r.left >= 2560 && r.right <= 4480 && r.top >= 0 && !w.calls.slice(beforeReveal).some(c => c[0] === 'setForeground') && w.fg === 700, JSON.stringify(r));
    w.fg = 500; os.guardTick();
    t.ok('戻した窓は見張らない（引き継いで前面にあってよい）', w.fg === 500);
    const afterReveal = w.calls.length;
    t.ok('戻した窓を release したあとは、conceal も reveal もしない', os.release(ref) === true && os.conceal(ref) === false && os.reveal(ref) === false && w.calls.length === afterReveal);
    t.ok('release は窓には触らない・知らない ref には false', os.release(ref) === false);
    os.guardTick();
    t.ok('隠している窓が無くなれば見張りを止める', cleared.length >= 1, JSON.stringify(cleared));
  }
  {
    // 画面の構成が変わったときの置き直し・閉じた窓
    const w = winWith();
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    const ref = os.findWindowByNonce(NONCE);
    os.conceal(ref);
    w.displays = [{ handle: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true, dpi: 96 }];   // 2 つ目のモニターを外した
    w.windows.get(500).rect = { left: 400, top: 300, right: 2000, bottom: 1380 };                  // Windows が画面の中へ寄せた
    t.ok('reconceal は隠している窓を置き直す（新しい右の外へ）', os.reconceal() === 1 && w.windows.get(500).rect.left === 2920 && w.windows.get(500).rect.top === 0, JSON.stringify(w.windows.get(500).rect));
    t.ok('置き直しても透明度 0 のまま', w.windows.get(500).alpha === 0 && (w.windows.get(500).exStyle & WS_EX_TOOLWINDOW) !== 0);
    w.windows.delete(500);
    t.ok('窓が閉じていたら置き直さず、記録も捨てる（投げない）', os.reconceal() === 0 && os.conceal(ref) === false);
    const w2 = winWith();
    const none = createWin32ChromeOs({ win32: { ...w2, monitors: () => [] } });
    t.ok('モニターの一覧が取れないときの右の外は固定の位置', none.hiddenSpot().x === 20000);
  }
  {
    // 層が出した ref を MAX_REFS で押し出さない（隠している窓の ref が、前面の窓の記録で消えない）
    const w = winWith();
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    const ref = os.findWindowByNonce(NONCE);
    os.conceal(ref);
    for (let i = 0; i < 300; i += 1) { w.add(1000 + i, { title: `x${i}`, pid: 30, className: 'Notepad' }); w.fg = 1000 + i; os.foreground(); }
    t.ok('前面の窓の記録が溢れても、隠している窓の ref は残る', os.reveal(ref) === true);
  }

  {
    // 前面の見張り: まだ隠していない新しい窓（popup）が先に前面を取り、見張りがそれを見た後に隠した → その窓の直前の前面（利用者の窓）へ返す
    // （直前の前面を「今の前面」と覚えると、隠した窓自身を直前と取り違えて返せなかった。実機: 2026-10-07）
    const w = winWith();
    w.add(501, { title: 'about:blank - Google Chrome', rect: { left: 0, top: 0, right: 486, bottom: 447 } });   // popup（150%: 324×298 DIP）
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    os.conceal(os.findWindowByNonce(NONCE));
    w.fg = 700; os.guardTick();
    w.fg = 501; os.guardTick();   // popup が前面を取った。まだ隠していないので見張りは何もしない
    t.ok('隠していない窓が前面を取っただけでは、見張りは返さない', w.fg === 501);
    const popup = os.findWindowByBounds({ port: 9222, bounds: { left: 0, top: 0, width: 324, height: 298 } });
    t.ok('popup の窓を隠すと、その窓が前面なら直前の前面（メモ帳）へすぐ返す（次の周期を待たない）', os.conceal(popup) === true && w.fg === 700, String(w.fg));
    // 見張りが前面を取った窓を一度も見ないまま隠した場合も、その窓が前面になる前の前面（最後に見た前面）へ返す
    w.add(502, { title: 'about:blank - Google Chrome', rect: { left: 10, top: 10, right: 496, bottom: 457 } });
    w.fg = 502;
    const second = os.findWindowByBounds({ port: 9222, bounds: { left: 7, top: 7, width: 324, height: 298 } });
    t.ok('見張りが前面の移り変わりを見る前に隠した窓も、直前の前面へ返す', os.conceal(second) === true && w.fg === 700, String(w.fg));
    // 直前の前面が隠した窓なら、その前までさかのぼる
    w.fg = 500; os.guardTick();   // 隠した窓同士の移り変わり（700 → 500）
    t.ok('隠した窓が前面を取れば返す（さかのぼる先は隠していない窓）', w.fg === 700);
  }

  {
    // 隠した窓が持ち主の窓（翻訳の確認・権限の確認などの吹き出し）も隠す。実機で、翻訳の確認が画面に出て前面を取った（2026-10-07）
    const w = winWith();
    w.add(520, { title: 'このページを翻訳しますか？', owner: 500, rect: { left: 300, top: 150, right: 900, bottom: 400 } });   // 持ち主 = 隠す窓
    w.add(521, { title: 'ほかの Chrome の吹き出し', owner: 700, rect: { left: 400, top: 150, right: 900, bottom: 400 } });   // 持ち主が隠す窓でない
    w.add(522, { title: 'IME', className: 'IME', owner: 500 });                                                          // ブラウザーの窓でない
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    os.conceal(os.findWindowByNonce(NONCE));
    const bubble = w.windows.get(520);
    t.ok('持ち主が隠した窓のブラウザーの窓（吹き出し）も、隠した直後の見張りで隠す（画面の外・透明・タスクバーから外す）', bubble.rect.left === 5480 && bubble.alpha === 0 && (bubble.exStyle & WS_EX_TOOLWINDOW) && (bubble.exStyle & WS_EX_LAYERED) && (bubble.exStyle & WS_EX_TRANSPARENT), JSON.stringify(bubble.rect));
    t.ok('持ち主が隠した窓でない窓・ブラウザーの窓でない窓は触らない', w.windows.get(521).rect.left === 400 && w.windows.get(521).alpha === undefined && w.windows.get(522).alpha === undefined);
    w.add(523, { title: '権限の確認', owner: 500, rect: { left: 350, top: 200, right: 800, bottom: 400 } });
    os.guardTick();
    t.ok('後から出た吹き出しも、次の周期で隠す', w.windows.get(523).rect.left === 5480 && w.windows.get(523).alpha === 0);
    w.displays = [{ handle: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true, dpi: 96 }];
    t.ok('置き直し（reconceal）は吹き出しの窓も対象（親の窓と合わせて 3 つ）', os.reconceal() === 3 && w.windows.get(520).rect.left === 2920);
  }

  // ===== 見直しの修正（第 6 段）: 引き継ぎで窓を戻すとき、隠していた吹き出し（持ち主つきの窓）も見える形に戻す。Pleiad 自身の窓を引ける =====
  {
    const w = winWith();
    w.add(520, { title: 'このページを翻訳しますか？', owner: 500, rect: { left: 300, top: 150, right: 900, bottom: 400 } });   // 持ち主 = 隠す窓
    w.add(521, { title: 'ほかの Chrome の吹き出し', owner: 700, rect: { left: 400, top: 150, right: 900, bottom: 400 } });   // 持ち主が隠す窓でない
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} }, appHwnd: () => 700 });
    const ref = os.findWindowByNonce(NONCE);
    os.conceal(ref);
    t.ok('前提: 吹き出しは隠れている', w.windows.get(520).alpha === 0 && w.windows.get(520).rect.left === 5480);
    const app = os.appWindow();
    t.ok('appWindow は Pleiad の窓の ref（層が覚えた窓。知らない値には何もしない）', app?.id === '700' && os.raise({ id: '999' }).method === 'unknown');
    t.ok('reveal の near に appWindow を渡せる（その窓のあるモニターの中へ戻す）', os.reveal(ref, { near: app }) === true && w.windows.get(500).rect.left >= 2560);
    const bubble = w.windows.get(520);
    t.ok('隠していた吹き出しも見える形に戻す（不透明・タスクバー・マウスを受ける）。画面の中へ', bubble.alpha === 255 && !(bubble.exStyle & WS_EX_TOOLWINDOW) && !(bubble.exStyle & WS_EX_TRANSPARENT) && bubble.rect.left < 5480, JSON.stringify(bubble.rect));
    t.ok('持ち主が隠す窓でない窓は触らない', w.windows.get(521).alpha === undefined && w.windows.get(521).rect.left === 400);
    os.guardTick();
    t.ok('見えている間は、見張りが吹き出しをまた隠さない', bubble.alpha === 255 && bubble.rect.left < 5480);
    t.ok('戻すと、親の窓と一緒に吹き出しもまた隠す', os.conceal(ref) === true && (os.guardTick(), bubble.alpha === 0 && bubble.rect.left === 5480));
    os.stopGuard();
    const none = createWin32ChromeOs({ win32: winWith(), timers: { setInterval: () => 1, clearInterval: () => {} } });
    t.ok('appHwnd が無ければ appWindow は null', none.appWindow() === null);
    const gone = createWin32ChromeOs({ win32: winWith(), timers: { setInterval: () => 1, clearInterval: () => {} }, appHwnd: () => 424242 });
    t.ok('窓がもう無ければ appWindow は null（投げない）', gone.appWindow() === null);
    const bad = createWin32ChromeOs({ win32: winWith(), timers: { setInterval: () => 1, clearInterval: () => {} }, appHwnd: () => { throw new Error('boom'); } });
    t.ok('appHwnd が投げても appWindow は null', bad.appWindow() === null);
  }


  // ===== 見直しの修正: 外形で窓を探すときの絞り込み（つないだ Chrome のプロセス・開く前の写し・許容） =====
  {
    const BOUNDS = { left: 0, top: 0, width: 324, height: 298 };
    const RECT = { left: 0, top: 0, right: 486, bottom: 447 };   // 150%: 324×298 DIP
    const make = () => {
      const w = fakeWin32();
      w.add(600, { title: 'つないだ Chrome の窓', pid: 10, rect: RECT });
      w.add(601, { title: '別の Chrome（別の User Data）の窓', pid: 11, rect: RECT });
      w.add(602, { title: 'Edge の窓', pid: 40, rect: RECT });
      return { w, os: createWin32ChromeOs({ win32: w }) };
    };
    {
      const { os } = make();
      t.ok('port が無ければ採用しない（つないだ Chrome のプロセスが分からない。取り違えて隠さない）', os.findWindowByBounds({ bounds: BOUNDS }) === null);
    }
    {
      const { os } = make();
      t.ok('port の持ち主が分からなければ（待ち受けが無い）採用しない', os.findWindowByBounds({ bounds: BOUNDS, port: 9333 }) === null);
    }
    {
      const { w, os } = make();
      w.listenerPid = () => { throw new Error('iphlpapi'); };
      t.ok('持ち主の引きが失敗しても投げず、採用しない', os.findWindowByBounds({ bounds: BOUNDS, port: 9222 }) === null);
    }
    {
      const { os } = make();
      const hit = os.findWindowByBounds({ bounds: BOUNDS, port: 9222 });
      t.ok('つないだ Chrome のプロセスの窓だけを見る（別の chrome.exe・Edge の窓が同じ外形でも、曖昧にならず選ばない）', hit?.id === '600', JSON.stringify(hit));
    }
    {
      const { os } = make();
      t.ok('呼び出しの前の写し（since）に入っている窓は選ばない', os.findWindowByBounds({ bounds: BOUNDS, port: 9222, since: ['600'] }) === null);
      t.ok('写しに別の窓の印があっても、ほかの窓は選べる', os.findWindowByBounds({ bounds: BOUNDS, port: 9222, since: ['601', '602'] })?.id === '600');
    }
    {
      const { w, os } = make();
      w.windows.get(600).rect = { left: 15, top: 15, right: 501, bottom: 462 };   // 10 DIP ずれた
      t.ok('許容を狭めると（tolerance 2）、少しずれた窓は選ばない', os.findWindowByBounds({ bounds: BOUNDS, port: 9222, tolerance: 2 }) === null);
      t.ok('許容の既定は 16 DIP（同じずれでも選ぶ）。16 を超える値は 16 に丸める', os.findWindowByBounds({ bounds: BOUNDS, port: 9222, tolerance: 500 })?.id === '600');
    }
    {
      // 確認の窓は、エージェントの窓にしない（題や外形が偶然合っても、隠す・見張る対象にならない）
      const w = fakeWin32();
      const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
      w.add(910, { ...DIALOG, title: `リモート デバッグを許可しますか？ PLY-${NONCE}` });
      const dialog = os.findPermissionDialog({ since: [] });
      t.ok('前提: 確認の窓が見つかる', dialog?.id === '910');
      t.ok('確認の窓は、題に nonce があっても findWindowByNonce で返さない・conceal もしない', os.findWindowByNonce(NONCE) === null && os.conceal(dialog) === false && !w.calls.some(c => c[0] === 'setWindowPos' || c[0] === 'setExStyle'));
      const rect = w.windows.get(910).rect;
      const scale = 96 / 144;
      t.ok('確認の窓は、外形で合っても findWindowByBounds で返さない', os.findWindowByBounds({ port: 9222, bounds: { left: rect.left * scale, top: rect.top * scale, width: (rect.right - rect.left) * scale, height: (rect.bottom - rect.top) * scale } }) === null);
      t.ok('確認の窓は、そのまま閉じられる', os.close(dialog) === true && w.calls.some(c => c[0] === 'postMessage' && c[1] === 910 && c[2] === WM_CLOSE));
    }
  }

  // ===== 見直しの修正: 隠した窓の持ち主の吹き出しを隠すとき、確認の窓は隠さない =====
  {
    const w = winWith();
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    os.conceal(os.findWindowByNonce(NONCE));
    // 隠した窓が持ち主になった確認の窓（題が既知）
    w.add(530, { ...DIALOG, owner: 500 });
    os.guardTick();
    const dialogWin = w.windows.get(530);
    t.ok('持ち主が隠した窓でも、確認の窓（題が既知で小さい）は隠さない（利用者が見て、Pleiad が閉じる）', dialogWin.alpha === undefined && dialogWin.rect.left === 100 && !(dialogWin.exStyle & WS_EX_TOOLWINDOW));
    // 題が未知の言語の確認の窓: 層が確認として出していれば、隠さない
    w.add(531, { ...DIALOG, title: 'Autoriser le débogage à distance ?', owner: 500 });
    const ref = os.findPermissionDialog({ since: ['500', '700', '530'] });
    t.ok('前提: 題が未知の確認の窓も、層が確認の窓として出す', ref?.id === '531', JSON.stringify(ref));
    os.guardTick();
    t.ok('層が確認の窓として出した窓は、題が未知でも隠さない', w.windows.get(531).alpha === undefined && w.windows.get(531).rect.left === 100);
    t.ok('確認の窓の ref は、そのまま閉じられる', os.close(ref) === true && w.calls.some(c => c[0] === 'postMessage' && c[1] === 531 && c[2] === WM_CLOSE));
    // ふつうの吹き出し（翻訳）は今までどおり隠す
    w.add(532, { title: 'このページを翻訳しますか？', owner: 500, rect: { left: 300, top: 150, right: 900, bottom: 400 } });
    os.guardTick();
    t.ok('ふつうの吹き出し（確認でない）は、今までどおり隠す', w.windows.get(532).alpha === 0 && w.windows.get(532).rect.left === 5480);
  }

  // ===== 見直しの修正: 見張りの周期は、投げても止まらない =====
  {
    const w = winWith();
    const intervals = [], logs = [];
    const os = createWin32ChromeOs({ win32: w, log: line => logs.push(line), timers: { setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {} } });
    os.conceal(os.findWindowByNonce(NONCE));
    w.add(520, { title: '翻訳の確認', owner: 500, rect: { left: 300, top: 150, right: 900, bottom: 400 } });
    const processPath = w.processPath;
    w.processPath = pid => { if (w.boom) throw new Error('boom'); return processPath(pid); };
    w.boom = true;
    let threw = null;
    try { intervals[0](); } catch (error) { threw = error; }
    t.ok('setInterval から直に呼ばれる見張りは、中で投げても外へ出さない（ログに残す）', threw === null && logs.some(line => line.includes('guard failed')), String(threw?.message));
    w.boom = false;
    intervals[0]();
    t.ok('投げた次の周期も動く（見張りは止まらず、吹き出しを隠せる）', w.windows.get(520).alpha === 0);
  }

  // ===== 見直しの修正: reveal は、隠していない窓には何もしない =====
  {
    const w = winWith();
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    const ref = os.findWindowByNonce(NONCE);   // 見つけただけで隠していない
    const before = JSON.stringify(w.windows.get(500)), n = w.calls.length;
    t.ok('隠していない窓に reveal しても何もしない（元のスタイルを 0 扱いで壊さない）', os.reveal(ref) === false && w.calls.length === n && JSON.stringify(w.windows.get(500)) === before);
    os.conceal(ref);
    t.ok('隠した窓には、今までどおり reveal できる', os.reveal(ref) === true && w.windows.get(500).exStyle === 0x200000 && w.windows.get(500).alpha === 255);
    t.ok('戻した後にもう一度 reveal しても何もしない', (() => { const m = w.calls.length; return os.reveal(ref) === false && w.calls.length === m; })());
  }

  // ===== 見直しの修正: エージェントの窓を閉じる（closeAgent）・隠している窓を全部片付ける（closeAllAgents） =====
  {
    let clock = 1000;
    const noTimers = () => { const cleared = []; return { cleared, timers: { setInterval: () => 1, clearInterval: id => cleared.push(id) } }; };
    const closes = w => w.calls.filter(c => c[0] === 'postMessage' && c[2] === WM_CLOSE).map(c => c[1]);
    {
      const w = winWith();
      const { timers } = noTimers();
      const logs = [];
      const os = createWin32ChromeOs({ win32: w, timers, now: () => clock, log: line => logs.push(line) });
      const ref = os.findWindowByNonce(NONCE);
      os.conceal(ref);
      t.ok('closeAgent は隠した窓へ WM_CLOSE を出して true（エージェント専用の窓は、残すより閉じる）', os.closeAgent(ref) === true && closes(w).join() === '500');
      t.ok('依頼を出した窓は、窓が無くなるまで隠したまま・記録も残す（見張りが続ける）', w.windows.get(500).alpha === 0 && os.reveal(ref) === true && os.conceal(ref) === true);
      os.closeAgent(ref);
      clock += 1000; os.guardTick();
      t.ok('依頼の後 3 秒より前なら、まだ戻さない', w.windows.get(500).alpha === 0);
      clock += 2500; os.guardTick();
      t.ok('依頼を出したのに残っている窓（離れる確認など）は、3 秒後に見える形へ戻して記録を手放す（見えない窓のまま残さない）',
        w.windows.get(500).alpha === 255 && (w.windows.get(500).exStyle & WS_EX_TRANSPARENT) === 0 && os.conceal(ref) === false && logs.some(line => line.includes('close did not finish')), JSON.stringify(w.windows.get(500)));
    }
    {
      const w = winWith();
      const os = createWin32ChromeOs({ win32: w, timers: noTimers().timers, now: () => clock });
      const ref = os.findWindowByNonce(NONCE);
      os.conceal(ref);
      os.closeAgent(ref);
      w.windows.delete(500);   // 閉じた
      os.guardTick();
      t.ok('依頼で窓が閉じれば、見張りが記録を捨てる（戻さない）', os.reveal(ref) === false && os.conceal(ref) === false);
    }
    {
      const w = winWith();
      const os = createWin32ChromeOs({ win32: w, timers: noTimers().timers });
      const ref = os.findWindowByNonce(NONCE);
      os.conceal(ref);
      w.windows.delete(500);   // Chrome が落ちて窓はもう無い
      t.ok('窓がもう無ければ WM_CLOSE は出さず、記録を捨てて true', os.closeAgent(ref) === true && closes(w).length === 0 && os.conceal(ref) === false);
    }
    {
      const w = winWith();
      const os = createWin32ChromeOs({ win32: w, timers: noTimers().timers });
      const ref = os.findWindowByNonce(NONCE);
      os.conceal(ref);
      w.postMessage = () => false;
      t.ok('閉じる依頼が出せなければ false を返し、見える形へ戻す（元のスタイル・透明度 255）。記録も手放す',
        os.closeAgent(ref) === false && w.windows.get(500).alpha === 255 && w.windows.get(500).exStyle === 0x200000 && os.conceal(ref) === false, JSON.stringify(w.windows.get(500)));
    }
    {
      const w = winWith();
      const os = createWin32ChromeOs({ win32: w, timers: noTimers().timers });
      const ref = os.findWindowByNonce(NONCE);
      os.conceal(ref);
      w.postMessage = () => { throw new Error('access denied'); };
      t.ok('postMessage が投げても投げず、見える形へ戻す', os.closeAgent(ref) === false && w.windows.get(500).alpha === 255);
    }
    {
      // conceal が途中で投げても（隠しかけの窓）、閉じられる・戻せる
      const w = winWith();
      const os = createWin32ChromeOs({ win32: w, timers: noTimers().timers });
      const ref = os.findWindowByNonce(NONCE);
      const setAlpha = w.setLayeredAlpha;
      w.setLayeredAlpha = () => { throw new Error('layered'); };
      t.ok('conceal が途中で失敗したら false', os.conceal(ref) === false);
      w.setLayeredAlpha = setAlpha;
      t.ok('途中まで隠した窓も、closeAgent で閉じられる（隠しかけの窓を誰にも戻せなくしない）', os.closeAgent(ref) === true && closes(w).join() === '500');
    }
    {
      // 隠していない窓（見つけただけ・戻した窓）と、層が出していない ref は閉じない
      const w = winWith();
      const os = createWin32ChromeOs({ win32: w, timers: noTimers().timers });
      const found = os.findWindowByNonce(NONCE);
      t.ok('隠していない窓は閉じない（記録だけ捨てる）', os.closeAgent(found) === false && closes(w).length === 0 && os.conceal(found) === false);
      const fg = os.foreground();
      const dialogW = fakeWin32(); dialogW.add(910, DIALOG); const dialogOs = createWin32ChromeOs({ win32: dialogW });
      const dialog = dialogOs.findPermissionDialog({ since: [] });
      t.ok('前面の窓の ref・確認の窓の ref・知らない ref・null は閉じない', os.closeAgent(fg) === false && dialogOs.closeAgent(dialog) === false && os.closeAgent({ id: '12345' }) === false && os.closeAgent(null) === false
        && closes(w).length === 0 && closes(dialogW).length === 0);
    }
    {
      // closeAllAgents: 隠している窓だけ。戻した窓（引き継いだ窓）には触らない
      const w = winWith();
      w.add(501, { title: `PLY-${NONCE.replace(/0/g, '1')} - Google Chrome`, rect: { left: 100, top: 100, right: 1700, bottom: 1180 } });
      w.add(502, { title: `PLY-${NONCE.replace(/0/g, '2')} - Google Chrome`, rect: { left: 100, top: 100, right: 1700, bottom: 1180 } });
      const { timers, cleared } = noTimers();
      const os = createWin32ChromeOs({ win32: w, timers });
      const r500 = os.findWindowByNonce(NONCE), r501 = os.findWindowByNonce(NONCE.replace(/0/g, '1')), r502 = os.findWindowByNonce(NONCE.replace(/0/g, '2'));
      os.conceal(r500); os.conceal(r501); os.conceal(r502);
      os.reveal(r502);   // 利用者が引き継いだ窓
      const count = os.closeAllAgents();
      t.ok('closeAllAgents は隠している窓を全部閉じる（引き継いだ窓・前面の窓・確認の窓には触らない）', count === 2 && closes(w).sort().join() === '500,501', JSON.stringify(closes(w)));
      t.ok('見張りを止める', cleared.length >= 1);
      t.ok('閉じられない窓があれば、それだけ見える形へ戻す（見えない窓を残さない）', (() => {
        const v = winWith();
        const o = createWin32ChromeOs({ win32: v, timers: noTimers().timers });
        const r = o.findWindowByNonce(NONCE);
        o.conceal(r);
        v.postMessage = () => false;
        return o.closeAllAgents() === 0 && v.windows.get(500).alpha === 255;
      })());
      t.ok('隠している窓が無ければ何もせず 0', createWin32ChromeOs({ win32: winWith() }).closeAllAgents() === 0);
    }
    {
      const unsupported = createChromeOs({ platform: 'linux' });
      t.ok('使えない OS の closeAgent・closeAllAgents は何もしない', unsupported.closeAgent({ id: '1' }) === false && unsupported.closeAllAgents() === 0);
    }
  }

  // ===== 引き継ぎの往復（ADR 0154。第 6 段）: 隠す → 戻して前に出す（見張りは返さない）→ 隠し直す（また見張る）=====
  {
    const w = winWith();
    const os = createWin32ChromeOs({ win32: w, timers: { setInterval: () => 1, clearInterval: () => {} } });
    const ref = os.findWindowByNonce(NONCE);
    os.conceal(ref);
    const pleiad = os.foreground();   // 押された直後の前面（メモ帳の代わり）
    w.fg = 700;
    t.ok('引き継ぐ: 戻す → 前に出す（直接の SetForegroundWindow が通れば direct）', os.reveal(ref, { near: pleiad }) === true && os.raise(ref).ok === true && w.fg === 500 && w.windows.get(500).alpha === 255);
    os.guardTick(); os.guardTick();
    t.ok('見えている間は見張りが前面を返さない（引き継いだ窓が前面のまま）', w.fg === 500, String(w.fg));
    w.fg = 700; os.guardTick(); w.fg = 500; os.guardTick();
    t.ok('人が窓を行き来しても返さない', w.fg === 500);
    w.fg = 700; os.guardTick();   // 人が Pleiad に戻った（「Claude に戻す」を押す）
    t.ok('戻す: 隠し直せる（スタイルを取り直しても元の状態に戻る）', os.conceal(ref) === true && w.windows.get(500).alpha === 0 && (w.windows.get(500).exStyle & WS_EX_TOOLWINDOW) !== 0 && w.windows.get(500).rect.left >= 5480);
    w.fg = 500; os.guardTick();
    t.ok('隠し直したあとは、また見張る（隠した窓が前面を取ったら返す）', w.fg === 700, String(w.fg));
    os.reveal(ref);
    t.ok('もう一度戻すと元のスタイル（APPWINDOW でなく元の拡張スタイル）へ戻る', w.windows.get(500).exStyle === WS_NOREDIRECTION && w.windows.get(500).alpha === 255, w.windows.get(500).exStyle.toString(16));
    os.stopGuard();
  }

  // ===== 往復（core ⇄ main ⇄ 偽の Win32）: エージェントの窓の口 =====
  {
    const w = winWith();
    const { spawned, spawn } = fakeSpawn();
    const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const toWorker = [], toPort = [];
    const worker = { on: (type, fn) => toWorker.push(fn), postMessage: m => queueMicrotask(() => toPort.forEach(fn => fn({ data: m }))) };
    const port = { on: (type, fn) => toPort.push(fn), postMessage: m => queueMicrotask(() => toWorker.forEach(fn => fn(m))) };
    const core = parentPortChromeOs(port, { timeoutMs: 500, readyWaitMs: 500 });
    attachChromeOs(worker, { chromeOs: createChromeOs({ platform: 'win32', win32: w, env: ENV, exists: p => p === exe, spawn, timers: { setInterval: () => 1, clearInterval: () => {} } }) });
    await core.ready();
    const browser = await core.locateBrowser({ product: 'chrome' });
    t.ok('locateBrowser の往復', browser?.product === 'chrome' && typeof browser.id === 'string');
    t.ok('appWindow の往復（Pleiad の窓の手がかりが無ければ null）', await core.appWindow() === null);
    const launched = await core.launchWindow({ browser, profileDir: 'Default', url: NONCE_URL, nonce: NONCE, userDataDir: 'C:\\t\\ud', position: { x: 1, y: 2 }, size: { width: 3, height: 4 } });
    t.ok('launchWindow の往復（引数が chrome.exe の引数になる）', launched.ok === true && spawned.at(-1).args.includes('--user-data-dir=C:\\t\\ud') && spawned.at(-1).args.includes('--window-position=1,2'));
    const ref = await core.findWindowByNonce(NONCE);
    t.ok('findWindowByNonce の往復', ref?.id === '500');
    t.ok('hiddenSpot・conceal の往復', (await core.hiddenSpot()).x === 5480 && await core.conceal(ref) === true && w.windows.get(500).alpha === 0);
    t.ok('reveal・release の往復', await core.reveal(ref, { near: null }) === true && w.windows.get(500).alpha === 255 && await core.release(ref) === true);
    t.ok('findWindowByBounds の往復（合う窓が無ければ null）', await core.findWindowByBounds({ bounds: { left: 1, top: 1, width: 1, height: 1 } }) === null);
    const again = await core.findWindowByNonce(NONCE);
    await core.conceal(again);
    t.ok('closeAgent の往復（WM_CLOSE が出る）', await core.closeAgent(again) === true && w.calls.some(c => c[0] === 'postMessage' && c[1] === 500 && c[2] === WM_CLOSE));
    w.add(650, { title: 'popup', pid: 10, rect: { left: 0, top: 0, right: 486, bottom: 447 } });
    const popupBounds = { left: 0, top: 0, width: 324, height: 298 };
    t.ok('findWindowByBounds の往復（port・since・tolerance が層へ届く）', await core.findWindowByBounds({ bounds: popupBounds, port: 9222, since: ['650'], tolerance: 2 }) === null
      && await core.findWindowByBounds({ bounds: popupBounds, tolerance: 2 }) === null && (await core.findWindowByBounds({ bounds: popupBounds, port: 9222, since: [], tolerance: 2 }))?.id === '650');
  }
}
