import { createRequire } from 'node:module';
import { parentPortChromeOs, unsupportedChromeOs } from '../../core/chrome/os.mjs';

const require = createRequire(import.meta.url);
const { createWin32ChromeOs, WM_CLOSE } = require('../../desktop/chrome-os/win32.cjs');
const { createChromeOs, attachChromeOs } = require('../../desktop/chrome-os/index.cjs');

export const name = 'chrome-os';
export const title = 'Chrome への接続の OS の層（Windows）: 確認の窓の見つけ方・前面化・返す・閉じる・使えない OS（偽の Win32 の表。本物の窓には触らない。ADR 0153）';

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
    showWindow(hwnd, cmd) { calls.push(['showWindow', hwnd, cmd]); if (cmd === 9) windows.get(hwnd).iconic = false; return true; },
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
        && os.raise({ id: '1' }).ok === false && os.yieldForeground({ id: '1' }, {}) === false && os.foreground() === null && os.close({ id: '1' }) === false);
    }
    const win = createChromeOs({ platform: 'win32', win32: fakeWin32() });
    t.ok('Windows と win32 の表があれば supported（今ある機能は dialog・raise）', win.capabilities().supported === true && win.capabilities().features.dialog === true && win.capabilities().features.raise === true && win.capabilities().features.launch === false);
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
    toWorker.forEach(fn => fn({ type: 'chrome-os', id: 'x1', action: 'launchWindow', args: {} }));
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
}
