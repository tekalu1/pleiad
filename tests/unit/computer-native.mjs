// computer use の main 側の土台（desktop/computer/*、docs/computer-use.md「core と main」）を、偽の Win32 の表で確かめる。
// 本物の入力は一切送らない（koffi の関数の代わりに偽の表を差し込み、SendInput に渡るはずの INPUT の中身を記録して比べる）。
//   - キー名の解釈（xdotool の形・Windows キーの拒否）・SendInput の絶対座標の往復
//   - input: クリック・修飾キー・ドラッグ・スクロール・文字（サロゲート）・キー（スキャンコード）・Esc の解除と再登録
//   - releaseAll は押したものだけを離す・途中で失敗しても離す
//   - capture: 縮小の倍率・alpha を不透明にする・region の切り出し
//   - apps: AppInfo（exe・AUMID・UWP の枠・自分の窓・昇格）・名前の検索・起動
//   - service: 直列の列・上限時間・locked・stopped・arm と番犬・Esc・displays の版
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createInput, toAbsolute } = require('../../desktop/computer/input.cjs');
const { parseCombo, keyName } = require('../../desktop/computer/keymap.cjs');
const { createCapture, fitScale } = require('../../desktop/computer/capture.cjs');
const { createApps, normalizePath } = require('../../desktop/computer/apps.cjs');
const { createDesktopState } = require('../../desktop/computer/desktop-state.cjs');
const { listDisplays, virtualBounds, containsPoint, pickDisplay } = require('../../desktop/computer/displays.cjs');
const { createComputerService, withPerMonitorDpi } = require('../../desktop/computer/service.cjs');
const { ComputerError } = require('../../desktop/computer/errors.cjs');
const win32mod = require('../../desktop/computer/win32.cjs');

export const name = 'computer-native';
export const title = 'computer use の main 側: キーの解釈・SendInput の中身・releaseAll・撮影の縮小・アプリの特定・service の列と止め方（偽の Win32）';

// ---- 偽の Win32 の表 ----
const US_SCAN = { 0x11: 0x1d, 0x10: 0x2a, 0x12: 0x38, 0x53: 0x1f, 0x41: 0x1e, 0x0d: 0x1c, 0x1b: 0x01, 0x74: 0x3f, 0x09: 0x0f, 0x25: 0xe04b, 0x2e: 0xe053 };
function vkKeyScan(ch) {
  if (/[a-z]/.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/[A-Z0-9]/.test(ch)) return ch.charCodeAt(0) | (/[A-Z]/.test(ch) ? 0x100 : 0);
  return ({ '+': 0xbb | 0x100, '-': 0xbd, '!': 0x31 | 0x100, '@': 0x32 | 0x100, '.': 0xbe, ',': 0xbc, '/': 0xbf, ';': 0xba })[ch] ?? -1;
}

function fakeWin32(over = {}) {
  const sent = []; // SendInput に渡った INPUT（1 回の呼び出し = 1 つの配列）
  const calls = [];
  const w = {
    available: true,
    sent, calls,
    failSendWhen: null,
    monitors: () => [
      { handle: 1, device: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true, dpi: 96 },
      { handle: 2, device: '\\\\.\\DISPLAY2', x: -1280, y: -100, width: 1280, height: 1024, primary: false, dpi: 144 },
    ],
    dpi: { get: () => ({ awareness: 'per-monitor', perMonitorV2: true }), enter: () => () => {} },
    cursor: () => w.cursorPos ?? { x: 10, y: 20 },
    sendInput(inputs) {
      sent.push(inputs);
      if (w.failSendWhen?.(inputs)) return { sent: 0, error: 5 };
      return { sent: inputs.length, error: 0 };
    },
    mapVirtualKey: vk => US_SCAN[vk] ?? 0,
    vkKeyScan,
    inputDesktop: () => w.desktop ?? { name: 'Default', error: 0 },
    ERROR_ACCESS_DENIED: 5,
    selfElevated: () => false,
    currentPid: () => 100,
    processParents: () => new Map(),
    processPath: () => null, processElevated: () => false, processAumid: () => null,
    windowAt: () => 0, rootOf: h => h, foreground: () => 0, topLevelWindows: () => [], childWindows: () => [],
    windowInfo: hwnd => ({ hwnd, pid: 0, title: '', className: '', exStyle: 0, visible: true, iconic: false, cloaked: false, hung: false, rect: null }),
    fileDescription: async () => null,
    captureRect: async rect => ({ width: rect.width, height: rect.height, bgra: Buffer.alloc(rect.width * rect.height * 4) }),
    shellOpen: async () => ({ ok: true, code: 33 }),
    activate: () => true,
    // Chrome の OS の層（desktop/chrome-os）が使う表の関数（tests/unit/chrome-os.mjs が状態つきの偽物で動かす）
    setForeground: () => true, showWindow: () => true, bringToTop: () => true, windowThread: () => 0, currentThread: () => 1,
    attachThreadInput: () => true, ownerOf: () => 0, dpiForWindow: () => 96, postMessage: () => true,
    ...over,
  };
  return w;
}

const flat = w => w.sent.flat();
const kb = e => e.ki;
const names = w => flat(w).map(e => (e.ki ? `k${e.ki.dwFlags & 2 ? '-' : '+'}${(e.ki.wScan ?? 0).toString(16)}` : `m${e.mi.dwFlags.toString(16)}`));
const noSleep = async () => {};
const display2 = { x: -1920, y: 0, width: 1920 + 1920, height: 1080 }; // 左に 1920 のモニターがある仮想デスクトップ

function makeInput(w, extra = {}) {
  return createInput({ win32: w, sleep: noSleep, virtualBounds: () => display2, ...extra });
}

export default async function (t) {
  // ===== キー名 =====
  {
    const w = fakeWin32();
    const k = combo => parseCombo(combo, w);
    t.ok('ctrl+s → Ctrl, S', JSON.stringify(k('ctrl+s').keys.map(x => x.vk)) === JSON.stringify([0x11, 0x53]));
    t.ok('Return・F5・Escape は名前の表から', k('Return').keys[0].vk === 0x0d && k('F5').keys[0].vk === 0x74 && k('Escape').keys[0].vk === 0x1b);
    t.ok('Escape を含む combo は escape = true（送る前に globalShortcut を外す印）', k('ctrl+Escape').escape === true && k('ctrl+s').escape === false);
    t.ok('大文字の 1 文字はシフトを足す（A → shift+a）', JSON.stringify(k('A').keys.map(x => x.vk)) === JSON.stringify([0x10, 0x41]));
    t.ok('ctrl+shift+A は shift を二重に足さない', k('ctrl+shift+A').keys.filter(x => x.vk === 0x10).length === 1);
    t.ok('ctrl++ は ctrl と +（シフトが要る配列では shift も）', k('ctrl++').keys.map(x => x.vk).includes(0xbb));
    t.ok('矢印・Delete は拡張キー', k('Left').keys[0].extended === true && k('Delete').keys[0].extended === true && k('ctrl+s').keys[1].extended === false);
    for (const combo of ['super+r', 'Win', 'meta+e', 'cmd+c', 'Super_L', 'windows+d', 'ctrl+lwin']) {
      let code = null;
      try { k(combo); } catch (e) { code = e.code; }
      t.ok(`Windows キーは拒む: ${combo}`, code === 'windows_key');
    }
    for (const combo of ['', 'ctrl+', 'nonsense', 'ctrl+日本']) {
      let code = null;
      try { k(combo); } catch (e) { code = e instanceof ComputerError ? e.code : 'other'; }
      t.ok(`解けない名前は failed: "${combo}"`, code === 'failed');
    }
    t.ok('releaseAll の報告の名前', keyName(0x11) === 'ctrl' && keyName(0x53) === 's' && keyName(0x70) === 'f1');
  }

  // ===== SendInput の絶対座標 =====
  {
    let allRoundTrip = true, firstBad = '';
    for (const [origin, size] of [[0, 1920], [-1920, 3840], [-1280, 5120], [0, 3840], [671, 2560], [0, 1]]) {
      for (let x = origin; x < origin + size; x += Math.max(1, Math.floor(size / 997)) ) {
        const abs = toAbsolute(x, origin, size);
        const back = Math.floor((abs * size) / 65536) + origin; // Windows が絶対座標を画素へ戻す式
        if (back !== x || abs < 0 || abs > 65535) { allRoundTrip = false; firstBad ||= `origin ${origin} size ${size} x ${x} abs ${abs} back ${back}`; }
      }
    }
    t.ok('絶対座標は往復で同じ画素に戻る（負の原点・複数モニター）', allRoundTrip, firstBad);
    t.ok('端の画素も 0..65535 に収まる', toAbsolute(1919, 0, 1920) <= 65535 && toAbsolute(0, 0, 1920) === 0);
  }

  // ===== input: クリック =====
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'click', x: 412, y: 238, button: 'left', count: 1 });
    const events = flat(w);
    t.ok('クリック = 移動（絶対・VIRTUALDESK）・左ダウン・左アップの 3 つ', events.length === 3 && events.every(e => e.type === 0));
    t.ok('移動の flags は MOVE|ABSOLUTE|VIRTUALDESK = 0xC001', events[0].mi.dwFlags === 0xc001, events[0].mi.dwFlags.toString(16));
    t.ok('移動の dx・dy は仮想デスクトップ（原点 -1920）の正規化', events[0].mi.dx === toAbsolute(412, -1920, 3840) && events[0].mi.dy === toAbsolute(238, 0, 1080));
    t.ok('左ダウン 0x0002・左アップ 0x0004', events[1].mi.dwFlags === 0x2 && events[2].mi.dwFlags === 0x4);
    t.ok('終わったら何も押したままではない', input.pressed().buttons.length === 0 && input.releaseAll().length === 0);
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'click', x: 5, y: 5, button: 'right', count: 1 });
    await input.perform({ type: 'click', button: 'middle', count: 1 });
    await input.perform({ type: 'click', x: 5, y: 5, button: 'left', count: 3 });
    const f = flat(w).map(e => e.mi.dwFlags);
    t.ok('右 0x8/0x10・中 0x20/0x40・座標なしのクリックは移動しない', f.slice(1, 3).join() === '8,16' && f.slice(3, 5).join() === '32,64', f.join());
    t.ok('triple は左のダウンアップを 3 回', f.slice(6).filter(x => x === 2).length === 3 && f.slice(6).filter(x => x === 4).length === 3);
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'click', x: 5, y: 5, button: 'left', count: 1, modifiers: ['ctrl', 'shift'] });
    const n = names(w);
    t.ok('修飾キー付きのクリックは Ctrl↓ Shift↓ → クリック → Shift↑ Ctrl↑（スキャンコード）', n.join() === 'mc001,k+1d,k+2a,m2,m4,k-2a,k-1d', n.join());
    const ev = flat(w).filter(e => e.ki);
    t.ok('キーは KEYEVENTF_SCANCODE（0x8）で wVk は 0', ev.every(e => (e.ki.dwFlags & 8) === 8 && e.ki.wVk === 0));
  }
  {
    // 途中の失敗でも押したままにしない（左ダウンが失敗 → 修飾キーは離す）
    const w = fakeWin32();
    w.failSendWhen = inputs => inputs.some(e => e.mi?.dwFlags === 0x2);
    const input = makeInput(w);
    let code = null;
    try { await input.perform({ type: 'click', x: 5, y: 5, button: 'left', count: 1, modifiers: ['ctrl'] }); } catch (e) { code = e.code; }
    const n = names(w);
    t.ok('SendInput が失敗したら failed', code === 'failed');
    t.ok('失敗の後に Ctrl を離している（finally）', n[n.length - 1] === 'k-1d' && input.pressed().keys.length === 0, n.join());
  }

  // ===== input: ドラッグ・スクロール =====
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'drag', from: { x: 100, y: 100 }, to: { x: 500, y: 300 } });
    const ev = flat(w);
    const down = ev.findIndex(e => e.mi.dwFlags === 2), up = ev.findIndex(e => e.mi.dwFlags === 4);
    t.ok('ドラッグ = 始点へ移動 → 左ダウン → 途中の移動 → 左アップ', down === 1 && up === ev.length - 1 && up - down > 5, `down ${down} up ${up}`);
    const last = ev[up - 1].mi;
    t.ok('最後の移動は終点', last.dx === toAbsolute(500, -1920, 3840) && last.dy === toAbsolute(300, 0, 1080));
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'scroll', x: 50, y: 60, direction: 'down', amount: 3 });
    await input.perform({ type: 'scroll', x: 50, y: 60, direction: 'left', amount: 1 });
    await input.perform({ type: 'scroll', x: 50, y: 60, direction: 'up', amount: 2 });
    const wheel = flat(w).filter(e => e.mi.dwFlags === 0x800 || e.mi.dwFlags === 0x1000);
    t.ok('下に 3 = WHEEL の -120 を 3 回（uint32 の補数）', wheel.slice(0, 3).every(e => e.mi.dwFlags === 0x800 && e.mi.mouseData === ((-120) >>> 0)));
    t.ok('左 = HWHEEL の -120、上 = WHEEL の +120', wheel[3].mi.dwFlags === 0x1000 && wheel[3].mi.mouseData === ((-120) >>> 0) && wheel[4].mi.mouseData === 120 && wheel.length === 6);
  }

  // ===== input: 文字 =====
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'text', text: 'aあ😀' });
    const ev = flat(w).filter(e => e.ki);
    t.ok('文字は KEYEVENTF_UNICODE（0x4）、wVk 0、キーダウンとアップの対', ev.every(e => (e.ki.dwFlags & 4) === 4 && e.ki.wVk === 0) && ev.length === 8, ev.length);
    t.ok('BMP の文字はそのままの UTF-16', ev[0].ki.wScan === 0x61 && ev[2].ki.wScan === 0x3042);
    t.ok('サロゲートペアは 2 つの単位（D83D DE00）', ev[4].ki.wScan === 0xd83d && ev[6].ki.wScan === 0xde00);
    t.ok('ダウンは 0、アップは KEYUP 付き', ev[0].ki.dwFlags === 4 && ev[1].ki.dwFlags === 6);
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'text', text: 'a\nb\tc\r\nd' });
    const n = names(w);
    t.ok('改行は Return、タブは Tab のキー（CRLF は 1 回）', n.filter(x => x === 'k+1c').length === 2 && n.filter(x => x === 'k+f').length === 1, n.join());
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'text', text: 'x'.repeat(100) });
    t.ok('長い文字列は 40 文字ずつの塊で送る', w.sent.length === 3 && w.sent[0].length === 80 && w.sent[2].length === 40, w.sent.map(s => s.length).join());
  }

  {
    // IME が開いていると仮名が変換中に取り込まれて順序が崩れる: 打つ間だけ閉じて、打ち終えたら戻す
    const order = [];
    const w = fakeWin32({ imeClose: () => { order.push('close'); return () => order.push('restore'); } });
    const origSend = w.sendInput;
    w.sendInput = inputs => { order.push('send'); return origSend(inputs); };
    const input = makeInput(w);
    await input.perform({ type: 'text', text: 'ひらがな' });
    t.ok('type: IME を閉じてから送り、送り終えてから戻す', order.join() === 'close,send,restore', order.join());
    const order2 = [];
    const ctl = new AbortController();
    const w2 = fakeWin32({ imeClose: () => { order2.push('close'); return () => order2.push('restore'); } });
    const send2 = w2.sendInput;
    w2.sendInput = inputs => { order2.push('send'); ctl.abort(); return send2(inputs); };
    await makeInput(w2).perform({ type: 'text', text: 'x'.repeat(100) }, ctl.signal).catch(() => {});
    t.ok('type が途中で止められても、IME は戻す', order2.join() === 'close,send,restore', order2.join());
    const w3 = fakeWin32({ imeClose: () => null });
    await makeInput(w3).perform({ type: 'text', text: 'a' });
    t.ok('IME が開いていなければ何もしない（そのまま送る）', w3.sent.length === 1);
    const w4 = fakeWin32({ imeClose: () => { throw new Error('imm'); } });
    await makeInput(w4).perform({ type: 'text', text: 'a' });
    t.ok('IME を触れなくても打つ', w4.sent.length === 1);
  }

  // ===== input: キー =====
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'key', combo: 'ctrl+s' });
    t.ok('ctrl+s = Ctrl↓ S↓ S↑ Ctrl↑', names(w).join() === 'k+1d,k+1f,k-1f,k-1d', names(w).join());
    t.ok('キーを押したままにしない', input.pressed().keys.length === 0);
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'key', combo: 'Left', repeat: 3 });
    const ev = flat(w);
    t.ok('repeat 3 = 押して離すを 3 回', ev.length === 6);
    t.ok('矢印は拡張キー（KEYEVENTF_EXTENDEDKEY = 1）。MapVirtualKey の 0xE0 前置でも付く', ev.every(e => (e.ki.dwFlags & 1) === 1) && ev[0].ki.wScan === 0x4b, JSON.stringify(ev[0].ki));
    await input.perform({ type: 'key', combo: 'Delete' });
    t.ok('Delete も拡張', (flat(w).at(-1).ki.dwFlags & 1) === 1);
  }
  {
    // スキャンコードが引けないキーは仮想キーで送る
    const w = fakeWin32({ mapVirtualKey: () => 0 });
    const input = makeInput(w);
    await input.perform({ type: 'key', combo: 'F5' });
    const ev = flat(w);
    t.ok('スキャンコードが無ければ wVk で送る（SCANCODE なし）', ev[0].ki.wVk === 0x74 && ev[0].ki.wScan === 0 && ev[0].ki.dwFlags === 0 && ev[1].ki.dwFlags === 2);
  }
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'keyDown', combo: 'shift' });
    t.ok('keyDown は押したまま（覚えている）', input.pressed().keys.join() === '16');
    await input.perform({ type: 'keyUp', combo: 'shift' });
    t.ok('keyUp で離して忘れる', input.pressed().keys.length === 0 && names(w).join() === 'k+2a,k-2a');
  }

  // ===== releaseAll =====
  {
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'keyDown', combo: 'ctrl+shift' });
    await input.perform({ type: 'down', x: 9, y: 9, button: 'left' });
    await input.perform({ type: 'down', button: 'right' });
    w.sent.length = 0;
    const released = input.releaseAll();
    t.ok('押したものだけを離す（ボタン → キーの逆順）', released.join() === 'right,left,shift,ctrl', released.join());
    t.ok('離す INPUT: 右アップ・左アップ・Shift↑・Ctrl↑ が 1 回の SendInput', w.sent.length === 1 && names(w).join() === 'm10,m4,k-2a,k-1d', names(w).join());
    w.sent.length = 0;
    t.ok('2 回目は何も送らず空', input.releaseAll().length === 0 && w.sent.length === 0);
  }
  {
    // 押していないものは離さない（keyUp / up の余計な離しを増やさない）
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'key', combo: 'a' });
    t.ok('key（押して離す）の後は releaseAll に何も残らない', input.releaseAll().length === 0);
  }
  {
    // hold の途中の失敗でも離す
    const w = fakeWin32();
    const input = makeInput(w);
    await input.perform({ type: 'keyDown', combo: 'a' });
    w.failSendWhen = () => true;
    let thrown = false;
    try { input.releaseAll(); } catch { thrown = true; }
    t.ok('離す送信が失敗しても、覚えは消す（次の releaseAll が空になる）', thrown && input.pressed().keys.length === 0);
  }

  // ===== Esc の globalShortcut の解除と再登録 =====
  {
    const w = fakeWin32();
    const log = [];
    w.sendInput = inputs => { log.push(`send${inputs.length}`); w.sent.push(inputs); return { sent: inputs.length, error: 0 }; };
    const input = makeInput(w, { escape: { suspend: () => { log.push('suspend'); return () => log.push('resume'); } } });
    await input.perform({ type: 'key', combo: 'Escape' });
    t.ok('Esc を送る前に解除し、送った後に戻す', log.join() === 'suspend,send1,send1,resume', log.join());
    log.length = 0;
    await input.perform({ type: 'key', combo: 'ctrl+s' });
    t.ok('Esc でないキーでは触らない', !log.includes('suspend'));
    log.length = 0;
    await input.perform({ type: 'keyDown', combo: 'Escape' });
    t.ok('Esc の keyDown は押している間は戻さない', log.join() === 'suspend,send1');
    await input.perform({ type: 'keyUp', combo: 'Escape' });
    t.ok('keyUp で戻す', log.at(-1) === 'resume');
    log.length = 0;
    await input.perform({ type: 'keyDown', combo: 'Escape' });
    input.releaseAll();
    t.ok('releaseAll でも戻す', log.at(-1) === 'resume');
  }

  // ===== validate・stopped =====
  {
    const w = fakeWin32();
    const input = makeInput(w);
    const inDisplay = (x, y) => containsPoint(listDisplays(w), x, y);
    const code = actions => { try { input.validate(actions, { inDisplay }); return 'ok'; } catch (e) { return e.code; } };
    t.ok('どのディスプレイにも入らない座標は outside', code([{ type: 'move', x: 5000, y: 5 }]) === 'outside' && code([{ type: 'drag', from: { x: 5, y: 5 }, to: { x: -9999, y: 5 } }]) === 'outside');
    t.ok('負の座標のモニター内は通る', code([{ type: 'click', x: -1000, y: -50 }]) === 'ok');
    t.ok('Windows キーが 1 つでもあれば全体を拒む', code([{ type: 'move', x: 5, y: 5 }, { type: 'key', combo: 'super+d' }]) === 'windows_key');
    t.ok('知らない動作・空の列は failed', code([{ type: 'nope' }]) === 'failed' && code([]) === 'failed');
    const aborted = new AbortController(); aborted.abort();
    let stoppedCode = null;
    try { await input.perform({ type: 'click', x: 5, y: 5 }, aborted.signal); } catch (e) { stoppedCode = e.code; }
    t.ok('signal が止まっていれば stopped（何も送らない）', stoppedCode === 'stopped' && w.sent.length === 0);
  }

  // ===== displays =====
  {
    const w = fakeWin32();
    const d = listDisplays(w);
    t.ok('主モニターが 1、残りは左から。id はデバイス名', d[0].index === 1 && d[0].primary && d[1].index === 2 && d[0].id === '\\\\.\\DISPLAY1');
    t.ok('倍率は dpi / 96', d[0].scale === 1 && d[1].scale === 1.5);
    t.ok('仮想デスクトップは負の原点を含む', JSON.stringify(virtualBounds(d)) === JSON.stringify({ x: -1280, y: -100, width: 3200, height: 1180 }));
    t.ok('pickDisplay: 番号・id・既定（主）', pickDisplay(d, 2).id === '\\\\.\\DISPLAY2' && pickDisplay(d, '\\\\.\\DISPLAY1').index === 1 && pickDisplay(d, undefined).primary && pickDisplay(d, 9) === null);
  }

  // ===== desktop-state =====
  {
    const w = fakeWin32();
    const check = d => { w.desktop = d; return createDesktopState({ win32: w }).check().locked; };
    t.ok('Default なら通常', check({ name: 'Default', error: 0 }) === false);
    t.ok('Winlogon（ロック画面・UAC）は locked', check({ name: 'Winlogon', error: 0 }) === true);
    t.ok('開けない（アクセス拒否）は locked', check({ name: null, error: 5 }) === true);
    t.ok('それ以外の失敗は止めない', check({ name: null, error: 87 }) === false);
  }

  // ===== capture =====
  {
    t.ok('1920×1080 の倍率は 1460×821 になる', (() => { const s = fitScale(1920, 1080, { maxPixels: 1_200_000, maxEdge: 1568 }); return Math.floor(1920 * s) === 1460 && Math.floor(1080 * s) === 821; })());
    t.ok('小さい画面は拡大しない（倍率 1）', fitScale(800, 600, { maxPixels: 1_200_000, maxEdge: 1568 }) === 1);
    t.ok('上限は長辺にも掛かる（3840×400 は 1568 まで）', Math.abs(fitScale(3840, 400, { maxPixels: 1_200_000, maxEdge: 1568 }) - 1568 / 3840) < 1e-9);
    t.ok('upscale は上限まで拡大する', fitScale(100, 100, { maxPixels: 1_200_000, maxEdge: 1568, upscale: true }) > 10);

    const w = fakeWin32();
    let bitmapSeen = null, resized = null, jpegQuality = null;
    const image = (w0, h0) => ({ resize: o => { resized = o; return image(o.width, o.height); }, toJPEG: q => { jpegQuality = q; return Buffer.from([0xff, 0xd8, w0 & 255, h0 & 255]); } });
    const nativeImage = { createFromBitmap: (buf, size) => { bitmapSeen = { buf, size }; return image(size.width, size.height); } };
    const capture = createCapture({ win32: w, nativeImage });
    const displays = listDisplays(w);
    const shot = await capture.screenshot({ display: 1, maxPixels: 1_200_000, maxEdge: 1568, quality: 75 }, { displays, displaysVersion: 7 });
    t.ok('縮小して返す: 幅・高さ・scale（画像 / 物理）・origin・版', shot.width === 1460 && shot.height === 821 && Math.abs(shot.scale - 1460 / 1920) < 1e-12 && shot.origin.x === 0 && shot.displaysVersion === 7);
    t.ok('縮小は nativeImage.resize（best）、JPEG の品質は 75', resized.width === 1460 && resized.height === 821 && resized.quality === 'best' && jpegQuality === 75);
    t.ok('jpeg は Uint8Array', shot.jpeg instanceof Uint8Array);
    t.ok('BitBlt の alpha は 255 にしてから渡す（0 のままだと JPEG が黒くなる）', bitmapSeen.buf.every((b, i) => i % 4 !== 3 || b === 255));
    const second = await capture.screenshot({ display: 2, maxPixels: 1_200_000, maxEdge: 1568, quality: 80 }, { displays, displaysVersion: 7 });
    t.ok('display 2 は負の原点のモニター（1280×1024 = 1.31MP は 1224×979 に縮む）', second.origin.x === -1280 && second.origin.y === -100 && second.width === 1224 && second.height === 979 && jpegQuality === 80, `${second.width}x${second.height}`);
    const zoom = await capture.screenshot({ display: 2, maxPixels: 1_200_000, maxEdge: 1568, quality: 75, region: { x: -1200, y: 0, width: 200, height: 100 }, upscale: true }, { displays, displaysVersion: 7 });
    t.ok('zoom: 物理の範囲を切り出し、上限まで拡大。origin は範囲の左上', zoom.origin.x === -1200 && zoom.origin.y === 0 && zoom.scale > 5 && zoom.width <= 1568, `${zoom.width}x${zoom.height} scale ${zoom.scale}`);
    const clamped = await capture.screenshot({ display: 2, maxPixels: 1_200_000, maxEdge: 1568, quality: 75, region: { x: -1400, y: -200, width: 400, height: 400 } }, { displays, displaysVersion: 7 });
    t.ok('範囲がモニターからはみ出したらモニターの内側に切る', clamped.origin.x === -1280 && clamped.origin.y === -100, JSON.stringify(clamped.origin));
    const err = async fn => { try { await fn(); return null; } catch (e) { return e.code; } };
    t.ok('存在しないディスプレイ・範囲が外なら outside', await err(() => capture.screenshot({ display: 9 }, { displays, displaysVersion: 1 })) === 'outside'
      && await err(() => capture.screenshot({ display: 1, region: { x: 5000, y: 5000, width: 10, height: 10 }, maxPixels: 1, maxEdge: 1 }, { displays, displaysVersion: 1 })) === 'outside');
    const defaulted = await capture.screenshot({ display: 1 }, { displays, displaysVersion: 1 });
    t.ok('上限を省くと既定（1.2MP・1568・75）', defaulted.width === 1460 && jpegQuality === 75);
    t.ok('region が数でなければ failed', await err(() => capture.screenshot({ display: 1, region: { x: 'a', y: 0, width: 5, height: 5 } }, { displays, displaysVersion: 1 })) === 'failed'
      && await err(() => capture.screenshot({ display: 1, region: { x: 0, y: 0, width: 0, height: 5 } }, { displays, displaysVersion: 1 })) === 'failed');
    t.ok('nativeImage が無ければ unsupported', await err(() => createCapture({ win32: w, nativeImage: null }).screenshot({ display: 1 }, { displays, displaysVersion: 1 })) === 'unsupported');
  }

  // ===== apps =====
  await appsTests(t);

  // ===== service =====
  await serviceTests(t);

  // ===== DPI: main が Per-Monitor でなければ、同期の呼び出しだけ PMv2 に切り替える =====
  {
    const log = [];
    const base = { dpi: { get: () => ({ awareness: 'unaware', perMonitorV2: false }), enter: () => { log.push('enter'); return () => log.push('restore'); } }, cursor: () => { log.push('cursor'); return { x: 1, y: 2 }; }, captureRect: async () => { log.push('capture'); return null; } };
    const wrapped = withPerMonitorDpi(base);
    wrapped.cursor(); await wrapped.captureRect();
    t.ok('unaware の main: 同期の呼び出しは enter → 呼ぶ → restore、別スレッドの撮影は切り替えない', log.join() === 'enter,cursor,restore,capture', log.join());
    const same = { dpi: { get: () => ({ awareness: 'per-monitor', perMonitorV2: false }), enter: () => { throw new Error('呼ばない'); } } };
    t.ok('Per-Monitor（V1 でも）なら包まない', withPerMonitorDpi(same) === same);
  }

  // ===== main.cjs の配線（読んで確かめる。Electron は起こさない）=====
  {
    const fs = require('node:fs');
    const main = fs.readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
    t.ok('main.cjs: service を worker につなぎ、Esc の登録の解除はオーバーレイの suspendEscape へ渡す', /attachComputerService\(worker,[\s\S]*?escape: \{ suspend: \(\) => computerOverlay\?\.suspendEscape\(\)/.test(main));
    t.ok('main.cjs: オーバーレイが Esc を拾ったら service.escape（computer-escape はオーバーレイが送る）', /attachComputerOverlay\(worker, \{ onEscape: owner => computerService\?\.escape\(\{ owner, notify: false \}\) \}\)/.test(main));
  }

  // ===== オーバーレイとつないだ Esc =====
  await overlayIntegrationTests(t);

  // ===== 本物の koffi の構造体の配置（Win32 を呼ばない。koffi が無い環境ではとばす）=====
  {
    let koffi = null;
    try { koffi = require('koffi'); } catch { /* optionalDependencies のバイナリが無い環境 */ }
    if (!koffi || process.arch === 'ia32') t.skip('koffi を読めない・32 ビットのため INPUT の配置の確認をとばす');
    else {
      const types = win32mod.defineTypes(koffi);
      t.ok('INPUT は 64 ビットで 40 バイト（SendInput の cbSize）', koffi.sizeof(types.INPUT) === 40, koffi.sizeof(types.INPUT));
      const buf = Buffer.alloc(40);
      koffi.encode(buf, 0, types.INPUT, { type: 1, u: { ki: { wVk: 0, wScan: 0x1f, dwFlags: 0x8 | 0x2, time: 0, dwExtraInfo: 0 } } });
      t.ok('キーボードの INPUT: type@0・wScan@10・dwFlags@12', buf.readUInt32LE(0) === 1 && buf.readUInt16LE(10) === 0x1f && buf.readUInt32LE(12) === 0xa, buf.toString('hex'));
      const mouse = Buffer.alloc(40);
      koffi.encode(mouse, 0, types.INPUT, { type: 0, u: { mi: { dx: 100, dy: 200, mouseData: 0xffffff88, dwFlags: 0xc001, time: 0, dwExtraInfo: 0 } } });
      t.ok('マウスの INPUT: dx@8・dy@12・mouseData@16・dwFlags@20', mouse.readInt32LE(8) === 100 && mouse.readInt32LE(12) === 200 && mouse.readUInt32LE(16) === 0xffffff88 && mouse.readUInt32LE(20) === 0xc001, mouse.toString('hex'));
      t.ok('PROCESSENTRY32W の pid・親 pid の位置（processParents が Buffer で読む）', koffi.offsetof(types.PROCESSENTRY32W, 'th32ProcessID') === 8 && koffi.offsetof(types.PROCESSENTRY32W, 'th32ParentProcessID') === 32);
    }
  }
}

// ---------------------------------------------------------------------------------------------
async function appsTests(t) {
  const SELF = 100;
  const windows = {
    10: { pid: 200, title: 'Untitled - Notepad', path: 'C:\\Windows\\System32\\notepad.exe', desc: 'メモ帳' },
    11: { pid: 201, title: 'Settings', path: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe', elevated: true, desc: '' },
    12: { pid: 300, title: 'Pleiad', path: 'C:\\Users\\u\\AppData\\Local\\Programs\\Ply\\Ply.exe', desc: 'Pleiad' },
    13: { pid: 301, title: 'child', path: 'C:\\Users\\u\\AppData\\Local\\Programs\\Ply\\Ply.exe', desc: 'Pleiad' },
    14: { pid: 302, title: 'Chromium', path: 'C:\\somewhere\\other.exe', desc: 'other' },
    20: { pid: 400, title: 'Calculator', path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', desc: 'Application Frame Host', children: [21] },
    21: { pid: 401, title: 'Calculator', path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_1\\CalculatorApp.exe', desc: '電卓', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    30: { pid: 500, title: 'overlay', path: 'C:\\x\\Ply.exe', desc: 'Pleiad', exStyle: 0x20 | 0x80000 },
    31: { pid: 501, title: 'Below', path: 'C:\\Program Files\\Below\\below.exe', desc: 'Below', rect: { left: 0, top: 0, right: 500, bottom: 500 } },
  };
  const w = fakeWin32({
    processParents: () => new Map([[200, 1], [201, 1], [300, 1], [301, 100], [302, 301], [400, 1], [401, 1], [500, 1], [501, 1]]),
    windowInfo: hwnd => { const x = windows[hwnd]; return { hwnd, pid: x?.pid ?? 0, title: x?.title ?? '', className: '', exStyle: x?.exStyle ?? 0, visible: true, iconic: false, cloaked: false, hung: false, rect: x?.rect ?? null }; },
    processPath: pid => Object.values(windows).find(x => x.pid === pid)?.path ?? null,
    processElevated: pid => Object.values(windows).find(x => x.pid === pid)?.elevated ?? false,
    processAumid: pid => Object.values(windows).find(x => x.pid === pid)?.aumid ?? null,
    fileDescription: async p => Object.values(windows).find(x => x.path === p)?.desc ?? null,
    childWindows: hwnd => windows[hwnd]?.children ?? [],
    topLevelWindows: () => [30, 31, 10, 20],
  });
  const apps = createApps({ win32: w, selfPid: SELF, selfExe: 'C:\\Users\\u\\AppData\\Local\\Programs\\Ply\\Ply.exe', listStartApps: async () => [], sleep: noSleep });
  const at = async hwnd => { w.windowAt = () => hwnd; return apps.appAt(0, 0); };

  const notepad = await at(10);
  t.ok('AppInfo: id は exe:小文字の / 区切り、name は FileDescription、昇格なし・自分ではない', notepad.id === 'exe:c:/windows/system32/notepad.exe' && notepad.kind === 'exe' && notepad.name === 'メモ帳' && notepad.pid === 200 && notepad.elevated === false && notepad.self === false, JSON.stringify(notepad));
  t.ok('normalizePath', normalizePath('C:\\A\\B.EXE') === 'c:/a/b.exe');
  const settings = await at(11);
  t.ok('FileDescription が無ければ窓のタイトル。昇格の印', settings.name === 'Settings' && settings.elevated === true);
  t.ok('自分の exe は self', (await at(12)).self === true);
  t.ok('Pleiad の子孫のプロセスは self（exe が違っても）', (await at(14)).self === true && (await at(13)).self === true);
  const calc = await at(20);
  t.ok('UWP は ApplicationFrameHost の枠ではなく中のプロセス: aumid:… と kind', calc.id === 'aumid:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' && calc.kind === 'aumid' && calc.pid === 401 && calc.name === '電卓', JSON.stringify(calc));
  t.ok('点の下がクリックを通す窓（透明 + 重ね）なら、Z 順で下の窓を返す', (await at(30)).id === 'exe:c:/program files/below/below.exe');
  w.windowAt = () => 0; w.topLevelWindows = () => [];
  t.ok('点の下に窓が無ければ null', (await apps.appAt(0, 0)) === null);
  w.foreground = () => 10; w.rootOf = h => h;
  t.ok('foreground', (await apps.foreground()).name === 'メモ帳');
  const insp = apps.inspectForeground();
  t.ok('inspect は名前を取らずに pid・昇格・self だけ返す', insp.pid === 200 && insp.elevated === false && insp.self === false);
  w.processElevated = () => null;
  t.ok('昇格を確かめられないプロセスは昇格とみなす（uipi を返す側）', apps.inspectForeground().elevated === true);

  // 検索と起動
  const started = [];
  const w2 = fakeWin32({
    windowInfo: hwnd => ({ hwnd, pid: hwnd === 10 ? 200 : 0, title: hwnd === 10 ? 'Untitled - Notepad' : '', className: '', exStyle: 0, visible: true, iconic: false, cloaked: false, hung: false, rect: null }),
    processPath: pid => (pid === 200 ? 'C:\\Windows\\System32\\notepad.exe' : null),
    fileDescription: async () => 'メモ帳',
    topLevelWindows: () => [10],
    shellOpen: async (target, dir) => { started.push({ target, dir }); return { ok: true, code: 33 }; },
    activate: h => { started.push({ activate: h }); return true; },
  });
  const startApps = [
    { name: '電卓', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    { name: 'Paint', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\mspaint.exe' },
    { name: 'Google Chrome', appId: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Docs', appId: 'Chrome._crx_abc' },
  ];
  let startCalls = 0;
  const apps2 = createApps({ win32: w2, selfPid: 1, selfExe: 'C:\\x\\Ply.exe', env: { SystemRoot: 'C:\\Windows' }, listStartApps: async () => { startCalls++; return startApps; },
    exists: p => /mspaint|chrome|notepad/i.test(p), sleep: noSleep });
  const names2 = async q => (await apps2.findApp(q)).map(a => a.name);
  t.ok('findApp: 表示名（日本語）・exe 名・AUMID・部分一致で当たる', (await names2('電卓')).join() === '電卓' && (await names2('mspaint.exe'))[0] === 'Paint' && (await names2('microsoft.windowscalculator'))[0] === '電卓' && (await names2('chro'))[0] === 'Google Chrome');
  const paint = (await apps2.findApp('paint'))[0];
  t.ok('スタートメニューの {GUID}\\x.exe は既知のフォルダーを展開して exe のアプリにする', paint.kind === 'exe' && paint.path === 'C:\\Windows\\System32\\mspaint.exe' && paint.id === 'exe:c:/windows/system32/mspaint.exe', JSON.stringify(paint));
  t.ok('動いているアプリが先（pid 付き）', (await apps2.findApp('メモ帳'))[0].pid === 200);
  t.ok('当たらない名前・空は空', (await apps2.findApp('zzzz')).length === 0 && (await apps2.findApp('')).length === 0);
  t.ok('スタートメニューの一覧は使い回す', startCalls === 1, startCalls);

  const err = async fn => { try { await fn(); return null; } catch (e) { return e.code; } };
  const calcApp = (await apps2.findApp('電卓'))[0];
  const launched = await apps2.launch(calcApp);
  t.ok('起動: AUMID は shell:AppsFolder\\<AUMID> を ShellExecute（引数なし）', launched.started === true && started.at(-1).target === 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' && started.at(-1).dir === null);
  const paintLaunch = await apps2.launch(paint);
  t.ok('exe はパスで起動し、作業ディレクトリはその場所', paintLaunch.started && started.at(-1).target === 'C:\\Windows\\System32\\mspaint.exe' && started.at(-1).dir === 'C:\\Windows\\System32');
  started.length = 0;
  const running = await apps2.launch((await apps2.findApp('メモ帳'))[0]);
  t.ok('既に動いているアプリは起こし直さず前に出す（alreadyRunning）', running.started === false && running.alreadyRunning === true && started.length === 1 && started[0].activate === 10);
  t.ok('存在しない exe・exe 以外・不正な AUMID・知らない種類は not_found', await err(() => apps2.launch({ kind: 'exe', path: 'C:\\nope\\x.exe', id: 'exe:x' })) === 'not_found'
    && await err(() => apps2.launch({ kind: 'exe', path: 'C:\\Windows\\System32\\notepad.bat', id: 'exe:y' })) === 'not_found'
    && await err(() => apps2.launch({ kind: 'aumid', aumid: 'a"b', id: 'aumid:a' })) === 'not_found'
    && await err(() => apps2.launch({ kind: 'x', id: 'z' })) === 'not_found' && await err(() => apps2.launch(null)) === 'not_found');
  w2.shellOpen = async () => ({ ok: false, code: 2 });
  t.ok('ShellExecute が 2（見つからない）なら not_found、他は failed', await err(() => apps2.launch(paint)) === 'not_found');
  w2.shellOpen = async () => ({ ok: false, code: 5 });
  t.ok('ShellExecute の他の失敗は failed', await err(() => apps2.launch(paint)) === 'failed');
}

// ---------------------------------------------------------------------------------------------
async function serviceTests(t) {
  const make = (over = {}, options = {}) => {
    const w = fakeWin32(over);
    const out = [];
    let clock = 1_000_000;
    const escape = { log: [], suspend() { this.log.push('suspend'); return () => this.log.push('resume'); } };
    const svc = createComputerService({ post: m => out.push(m), win32: w, nativeImage: { createFromBitmap: (b, s) => ({ resize: o => ({ toJPEG: () => Buffer.from([1, o.width & 255]) }), toJPEG: () => Buffer.from([1, s.width & 255]) }) },
      sleep: noSleep, escape, selfPid: 1, selfExe: 'C:\\x\\Ply.exe', now: () => clock, timeouts: { op: 60, launch: 120, watchdog: 30_000 }, ...options });
    const result = id => out.find(m => m.type === 'computer-result' && m.id === id);
    const waitFor = async id => { for (let i = 0; i < 400 && !result(id); i++) await new Promise(r => setTimeout(r, 5)); return result(id); };
    let n = 0;
    const call = async (op, args = {}, owner = 'o1') => { const id = ++n; svc.handleMessage({ type: 'computer-call', id, owner, op, args }); return waitFor(id); };
    return { w, out, svc, call, escape, tick: ms => { clock += ms; }, result };
  };
  const shotArgs = { display: 1, maxPixels: 1_200_000, maxEdge: 1568, quality: 75 };

  // ready と unsupported
  {
    const { out, svc } = make();
    svc.handleMessage({ type: 'computer-ready-request' });
    const ready = out.find(m => m.type === 'computer-ready');
    t.ok('computer-ready: supported・displays（物理の bounds・scale・index）・displaysVersion', ready.supported === true && ready.displays.length === 2 && ready.displays[0].bounds.width === 1920 && ready.displaysVersion === 1 && !('reason' in ready), JSON.stringify(ready).slice(0, 120));
  }
  for (const reason of ['platform', 'native']) {
    const out = [];
    const svc = createComputerService({ post: m => out.push(m), win32: null, reason });
    svc.handleMessage({ type: 'computer-ready-request' });
    svc.handleMessage({ type: 'computer-call', id: 1, owner: 'o', op: 'screenshot', args: {} });
    const ready = out.find(m => m.type === 'computer-ready'), res = out.find(m => m.type === 'computer-result');
    t.ok(`使えない（${reason}）: supported false と reason、呼び出しは unsupported`, ready.supported === false && ready.reason === reason && ready.displays.length === 0 && res.ok === false && res.error.code === 'unsupported');
  }

  // 基本の操作
  {
    const { call, w } = make();
    const d = await call('displays');
    t.ok('displays', d.ok && d.data.displays.length === 2 && d.data.displaysVersion === 1);
    const s = await call('screenshot', shotArgs);
    t.ok('screenshot: jpeg・width・height・scale・origin・displaysVersion', s.ok && s.data.jpeg instanceof Uint8Array && s.data.width === 1460 && s.data.origin.x === 0 && s.data.displaysVersion === 1, JSON.stringify(s).slice(0, 160));
    w.cursorPos = { x: 33, y: 44 };
    t.ok('cursor', (await call('cursor')).data.x === 33);
    const bad = await call('appAt', { x: 'a' });
    t.ok('appAt の引数が不正なら failed', bad.ok === false && bad.error.code === 'failed');
    const unknown = await call('nope');
    t.ok('知らない op は failed', unknown.ok === false && unknown.error.code === 'failed');
    const r = await call('releaseAll');
    t.ok('releaseAll op は released の一覧', r.ok && Array.isArray(r.data.released));
  }

  // input（成功・done・cursor）
  {
    const { call, w } = make();
    w.cursorPos = { x: 412, y: 238 };
    const r = await call('input', { actions: [{ type: 'click', x: 412, y: 238, button: 'left', count: 1 }, { type: 'key', combo: 'ctrl+s' }] });
    t.ok('input: done と cursor', r.ok && r.data.done === 2 && r.data.cursor.x === 412);
  }

  // 直列の列
  {
    const order = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const { call, svc, out } = make({ captureRect: async rect => { order.push('shot-start'); await gate; order.push('shot-end'); return { width: rect.width, height: rect.height, bgra: Buffer.alloc(rect.width * rect.height * 4) }; } }, { timeouts: { op: 5000, launch: 5000, watchdog: 30_000 } });
    svc.handleMessage({ type: 'computer-call', id: 1, owner: 'o1', op: 'screenshot', args: shotArgs });
    svc.handleMessage({ type: 'computer-call', id: 2, owner: 'o1', op: 'cursor', args: {} });
    await new Promise(r => setTimeout(r, 30));
    t.ok('操作は 1 本の列: 先の撮影が終わるまで次は走らない', order.join() === 'shot-start' && !out.some(m => m.id === 2));
    release();
    for (let i = 0; i < 100 && !out.some(m => m.id === 2); i++) await new Promise(r => setTimeout(r, 5));
    const ids = out.filter(m => m.type === 'computer-result').map(m => m.id);
    t.ok('終わったら届いた順に返る', ids.join() === '1,2', ids.join());
    void call;
  }

  // 上限時間
  {
    const { call, w } = make({ captureRect: () => new Promise(() => {}) });
    const hung = await call('screenshot', shotArgs);
    t.ok('固まった撮影は timeout で返す', hung.ok === false && hung.error.code === 'timeout');
    w.captureRect = async rect => ({ width: rect.width, height: rect.height, bgra: Buffer.alloc(rect.width * rect.height * 4) });
    const next = await call('cursor');
    t.ok('timeout の後も列は続く', next.ok === true);
  }

  // locked
  {
    const { call, w } = make();
    w.desktop = { name: 'Winlogon', error: 0 };
    const s = await call('screenshot', shotArgs);
    const i = await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] });
    t.ok('ロック画面: screenshot も input も locked（何も送らない）', s.error?.code === 'locked' && i.error?.code === 'locked' && w.sent.length === 0);
    t.ok('ロック中でも cursor・displays は返す', (await call('cursor')).ok);
    w.desktop = { name: 'Default', error: 0 };
    t.ok('解除されれば同じ呼び出しが通る（止めた印は付かない）', (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] })).ok);
  }

  // uipi と self と windows_key
  {
    const elevated = { pid: 777, path: 'C:\\Windows\\regedit.exe' };
    const { call, w } = make({
      windowAt: () => 5, rootOf: h => h, foreground: () => 5,
      windowInfo: hwnd => ({ hwnd, pid: elevated.pid, title: 't', className: '', exStyle: 0, visible: true, iconic: false, cloaked: false, hung: false, rect: null }),
      processPath: () => elevated.path, processElevated: () => true,
    });
    const click = await call('input', { actions: [{ type: 'click', x: 5, y: 5 }] });
    t.ok('昇格したアプリの上へのクリックは uipi（何も送らない）', click.error?.code === 'uipi' && w.sent.length === 0);
    const typed = await call('input', { actions: [{ type: 'text', text: 'x' }] });
    t.ok('前面が昇格したアプリへの文字入力も uipi', typed.error?.code === 'uipi');
  }
  {
    const { call } = make({
      windowAt: () => 5, rootOf: h => h,
      windowInfo: hwnd => ({ hwnd, pid: 777, title: 't', className: '', exStyle: 0, visible: true, iconic: false, cloaked: false, hung: false, rect: null }),
      processPath: () => 'C:\\Windows\\regedit.exe', processElevated: () => true, selfElevated: () => true,
    });
    t.ok('Pleiad 自身が昇格していれば uipi にしない', (await call('input', { actions: [{ type: 'click', x: 5, y: 5 }] })).ok === true);
  }
  {
    const { call, w } = make({
      foreground: () => 5, rootOf: h => h,
      windowInfo: hwnd => ({ hwnd, pid: 1, title: 'Pleiad', className: '', exStyle: 0, visible: true, iconic: false, cloaked: false, hung: false, rect: null }),
      processPath: () => 'C:\\x\\Ply.exe',
    });
    const typed = await call('input', { actions: [{ type: 'text', text: 'x' }] });
    const key = await call('input', { actions: [{ type: 'key', combo: 'Return' }] });
    t.ok('前面が Pleiad 自身なら text・key は self', typed.error?.code === 'self' && key.error?.code === 'self' && w.sent.length === 0);
    const up = await call('input', { actions: [{ type: 'keyUp', combo: 'shift' }] });
    t.ok('離す動作（keyUp）は止めない', up.ok === true);
    const win = await call('input', { actions: [{ type: 'key', combo: 'win+r' }] });
    t.ok('windows_key（送る前の検査）', win.error?.code === 'windows_key');
    const out = await call('input', { actions: [{ type: 'move', x: 99999, y: 0 }] });
    t.ok('outside', out.error?.code === 'outside');
    const partial = await call('input', { actions: [{ type: 'move', x: 5, y: 5 }, { type: 'text', text: 'y' }] });
    t.ok('途中の動作で断られたら done に終えた数を載せる', partial.error?.code === 'self' && partial.error.done === 1);
  }

  // stopped・arm・turn-ended
  {
    const { call, svc, w } = make();
    svc.handleMessage({ type: 'computer-arm', owner: 'o1' });
    svc.handleMessage({ type: 'computer-stop', owner: 'o1' });
    const stopped = await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'o1');
    t.ok('computer-stop の後の同じ owner の input は stopped', stopped.error?.code === 'stopped' && w.sent.length === 0);
    t.ok('screenshot・cursor は stopped でも通る', (await call('screenshot', shotArgs, 'o1')).ok && (await call('cursor', {}, 'o1')).ok);
    t.ok('別の owner は止まらない', (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'o2')).ok);
    svc.handleMessage({ type: 'computer-arm', owner: 'o1' });
    t.ok('次の computer-arm で解ける', (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'o1')).ok);
    svc.handleMessage({ type: 'computer-stop', owner: 'o1' });
    svc.handleMessage({ type: 'computer-turn-ended', owner: 'o1' });
    t.ok('computer-turn-ended でも解ける（その owner の分）', (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'o1')).ok);
  }
  {
    const { call, svc, w } = make();
    svc.handleMessage({ type: 'computer-arm', owner: 'a' });
    await call('input', { actions: [{ type: 'keyDown', combo: 'ctrl' }, { type: 'down', x: 5, y: 5, button: 'left' }] }, 'a');
    w.sent.length = 0;
    svc.handleMessage({ type: 'computer-arm', owner: 'b' });
    t.ok('持ち主が変わると前の持ち主の押したままを離す', names(w).join() === 'm4,k-1d', names(w).join());
    await call('input', { actions: [{ type: 'keyDown', combo: 'shift' }] }, 'b');
    w.sent.length = 0;
    svc.handleMessage({ type: 'computer-arm', owner: 'b' });
    t.ok('同じ持ち主の arm では離さない', w.sent.length === 0);
    svc.handleMessage({ type: 'computer-turn-ended', owner: 'b' });
    t.ok('computer-turn-ended で離す', names(w).join() === 'k-2a');
    await call('input', { actions: [{ type: 'down', button: 'right' }] }, 'b');
    w.sent.length = 0;
    svc.handleMessage({ type: 'computer-stop', owner: 'b' });
    t.ok('computer-stop で離す（computer-escape は返さない）', names(w).join() === 'm10');
  }
  {
    // 呼び出しの owner が替わったら、arm が無くても前の持ち主の分を離す
    const { call, w } = make();
    await call('input', { actions: [{ type: 'down', x: 5, y: 5, button: 'left' }] }, 'x');
    w.sent.length = 0;
    await call('cursor', {}, 'y');
    t.ok('computer-call の owner が変わったら離す', names(w).join() === 'm4');
  }
  {
    // core の作り直し（computer-ready-request）
    const { call, svc, w, out } = make();
    svc.handleMessage({ type: 'computer-arm', owner: 'a' });
    await call('input', { actions: [{ type: 'keyDown', combo: 'ctrl' }] }, 'a');
    svc.handleMessage({ type: 'computer-stop', owner: 'a' });
    w.sent.length = 0;
    svc.handleMessage({ type: 'computer-ready-request' });
    t.ok('core が作り直されたら押したままを離し、止めた印も消す', out.some(m => m.type === 'computer-ready') && (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'a')).ok);
  }

  // 番犬
  {
    const { call, svc, w, tick } = make();
    svc.handleMessage({ type: 'computer-arm', owner: 'a' });
    await call('input', { actions: [{ type: 'keyDown', combo: 'ctrl' }] }, 'a');
    w.sent.length = 0;
    tick(29_000); svc.watchdogTick();
    t.ok('29 秒では離さない', w.sent.length === 0);
    svc.handleMessage({ type: 'computer-heartbeat', owner: 'a' });
    tick(29_000); svc.watchdogTick();
    t.ok('heartbeat で数え直す', w.sent.length === 0);
    tick(2_000); svc.watchdogTick();
    t.ok('持ち主がいて 30 秒何も来なければ releaseAll', names(w).join() === 'k-1d', names(w).join());
    w.sent.length = 0;
    tick(60_000); svc.watchdogTick();
    t.ok('離した後は繰り返さない', w.sent.length === 0);
  }
  {
    const { svc, w, tick } = make();
    tick(120_000); svc.watchdogTick();
    t.ok('持ち主がいなければ番犬は動かない', w.sent.length === 0);
  }

  // Esc
  {
    const { call, svc, w, out } = make();
    svc.handleMessage({ type: 'computer-arm', owner: 'a' });
    await call('input', { actions: [{ type: 'down', x: 5, y: 5, button: 'left' }, { type: 'keyDown', combo: 'shift' }] }, 'a');
    w.sent.length = 0;
    const { owner } = svc.escape();
    t.ok('Esc: 押したままを離し（ボタン → キー）、止めた持ち主を返す', owner === 'a' && names(w).join() === 'm4,k-2a', names(w).join());
    t.ok('computer-escape { owner }', out.some(m => m.type === 'computer-escape' && m.owner === 'a'));
    t.ok('その後の input は stopped', (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'a')).error?.code === 'stopped');
    out.length = 0;
    svc.handleMessage({ type: 'computer-arm', owner: 'a' });
    svc.escape({ notify: false });
    t.ok('notify: false なら computer-escape は送らない（後から notifyEscape）', !out.some(m => m.type === 'computer-escape'));
    svc.notifyEscape('a');
    t.ok('notifyEscape で送る', out.some(m => m.type === 'computer-escape'));
    // オーバーレイの onEscape(owner)（desktop/main.cjs の配線）: owner を渡すと、その持ち主と今の持ち主の両方を止める
    out.length = 0;
    svc.handleMessage({ type: 'computer-arm', owner: 'lent-to' });
    const r = svc.escape({ owner: 'asker', notify: false });
    t.ok('escape({ owner }) はその持ち主を返し、computer-escape は送らない', r.owner === 'asker' && !out.some(m => m.type === 'computer-escape'));
    t.ok('渡した持ち主も今の持ち主（貸した先）も stopped', (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'asker')).error?.code === 'stopped'
      && (await call('input', { actions: [{ type: 'move', x: 5, y: 5 }] }, 'lent-to')).error?.code === 'stopped');
  }
  {
    // 実行中の列を Esc で打ち切る
    let gate;
    const wait = new Promise(r => { gate = r; });
    const { call, svc, out, w } = make({}, { sleep: async ms => { if (ms === 60) await wait; }, timeouts: { op: 5000, launch: 5000, watchdog: 30_000 } });
    svc.handleMessage({ type: 'computer-arm', owner: 'a' });
    svc.handleMessage({ type: 'computer-call', id: 900, owner: 'a', op: 'input', args: { actions: [{ type: 'drag', from: { x: 5, y: 5 }, to: { x: 400, y: 400 } }, { type: 'click', x: 9, y: 9 }] } });
    await new Promise(r => setTimeout(r, 20));
    svc.escape();
    gate();
    let res = null;
    for (let i = 0; i < 200 && !(res = out.find(m => m.id === 900)); i++) await new Promise(r => setTimeout(r, 5));
    t.ok('走っているドラッグは Esc で打ち切られ stopped を返す', res?.ok === false && res.error.code === 'stopped', JSON.stringify(res));
    const ev = flat(w);
    t.ok('左ボタンは離され、2 つ目のクリックは送られない', ev.filter(e => e.mi?.dwFlags === 4).length === 1 && !ev.some(e => e.mi?.dwFlags === 2 && e.mi.dx === toAbsolute(9, -1280, 3200)));
    void call;
  }

  // displays の版
  {
    const { svc, out, w, call } = make();
    svc.handleMessage({ type: 'computer-ready-request' });
    out.length = 0;
    svc.onDisplaysChanged();
    const changed = out.find(m => m.type === 'computer-displays-changed');
    t.ok('screen のイベントで版が 1 進み、computer-displays-changed を送る', changed?.displaysVersion === 2 && changed.displays.length === 2);
    const s = await call('screenshot', shotArgs);
    t.ok('撮影の結果の版は今の版', s.data.displaysVersion === 2);
    w.monitors = () => [{ handle: 1, device: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1280, height: 720, primary: true, dpi: 96 }];
    out.length = 0;
    const d = await call('displays');
    t.ok('構成が変わっていれば、次の呼び出しで版を進めて知らせる', d.data.displaysVersion === 3 && d.data.displays.length === 1 && out.some(m => m.type === 'computer-displays-changed' && m.displaysVersion === 3));
    const o = await call('input', { actions: [{ type: 'move', x: 1500, y: 100 }] });
    t.ok('縮んだ構成では以前の座標は outside', o.error?.code === 'outside');
  }

  // dispose
  {
    const { svc, call, w } = make();
    await call('input', { actions: [{ type: 'keyDown', combo: 'ctrl' }] });
    w.sent.length = 0;
    svc.dispose();
    t.ok('dispose（will-quit・worker の終了）で押したままを離す', names(w).join() === 'k-1d');
  }
}

// ---------------------------------------------------------------------------------------------
// オーバーレイ（desktop/computer-overlay.cjs）とつないだ Esc の流れ。desktop/main.cjs の配線と同じ形（偽の electron・偽の Win32）
async function overlayIntegrationTests(t) {
  const { createComputerOverlay } = require('../../desktop/computer-overlay.cjs');
  const registered = new Map();
  const log = [];
  class Win {
    constructor(opts) { this.bounds = { ...opts }; this.webContents = { send() {}, setWindowOpenHandler() {}, on() {}, once: (e, fn) => { this.loaded = fn; } }; this.on = () => {}; }
    loadFile() { return Promise.resolve().then(() => this.loaded?.()); }
    setAlwaysOnTop() {} setIgnoreMouseEvents() {} setContentProtection() {} setBounds(b) { this.bounds = { ...b }; } getBounds() { return this.bounds; }
    showInactive() {} hide() {} isDestroyed() { return false; } destroy() {}
  }
  const display = { id: 11, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const electron = {
    BrowserWindow: Win,
    globalShortcut: { register: (key, cb) => { registered.set(key, cb); return true; }, unregister: key => registered.delete(key) },
    screen: { getAllDisplays: () => [display], dipToScreenRect: (_w, r) => r, screenToDipPoint: p => p, on() {}, removeListener() {} },
  };
  const w = fakeWin32();
  w.sendInput = inputs => { w.sent.push(inputs); log.push(`send:${names({ sent: [inputs] }).join('+')}:esc=${registered.has('Escape')}`); return { sent: inputs.length, error: 0 }; };
  const posted = [];
  let overlay = null;
  const service = createComputerService({ post: m => posted.push(m), win32: w, sleep: noSleep, selfPid: 1, selfExe: 'C:\\x\\Ply.exe',
    escape: { suspend: () => overlay.suspendEscape() }, nativeImage: null, timeouts: { op: 2000, launch: 2000, watchdog: 30_000 } });
  overlay = createComputerOverlay({ electron, post: m => posted.push(m), t: key => key, timing: { idleMs: 500, stopMs: 40, tailMs: 10, exitMs: 10, rmExitMs: 4, marginMs: 4, keepMs: 200, escapeWaitMs: 200 },
    onEscape: owner => service.escape({ owner, notify: false }), log: () => {} });
  const both = m => { service.handleMessage(m); overlay.handleMessage(m); }; // main.cjs では、同じ worker のメッセージを両方が受ける
  const call = async (id, actions) => { service.handleMessage({ type: 'computer-call', id, owner: 'o1', op: 'input', args: { actions } }); for (let i = 0; i < 200 && !posted.some(m => m.id === id); i++) await new Promise(r => setTimeout(r, 5)); return posted.find(m => m.id === id); };

  both({ type: 'computer-arm', owner: 'o1' });
  overlay.handleMessage({ type: 'computer-overlay', owner: 'o1', state: 'activity', display: { id: 11, index: 1, bounds: display.bounds, scale: 1 }, agent: { id: 'claude', label: 'Claude' }, title: 't' });
  await new Promise(r => setTimeout(r, 20));
  t.ok('オーバーレイが出ている間だけ Esc を握る', registered.has('Escape'));

  await call(1, [{ type: 'key', combo: 'Escape' }]);
  const escSend = log.filter(l => l.startsWith('send:'));
  t.ok('自分の Esc の注入の間は globalShortcut を外し、送ったら戻す', escSend.length === 2 && escSend.every(l => l.endsWith('esc=false')) && registered.has('Escape'), log.join(' | '));

  await call(2, [{ type: 'keyDown', combo: 'ctrl' }, { type: 'down', x: 5, y: 5, button: 'left' }]);
  log.length = 0;
  registered.get('Escape')(); // 物理の Esc
  await new Promise(r => setTimeout(r, 60));
  t.ok('Esc: 押したままの入力を離す（ボタン → キー）', log.join(' | ').startsWith('send:m4+k-1d'), log.join(' | '));
  t.ok('Esc の後、オーバーレイは computer-escape { owner } を送る', posted.some(m => m.type === 'computer-escape' && m.owner === 'o1'));
  t.ok('computer-escape は 1 回だけ（service は notify: false）', posted.filter(m => m.type === 'computer-escape').length === 1);
  const after = await call(3, [{ type: 'move', x: 5, y: 5 }]);
  t.ok('その後の input は stopped', after.error?.code === 'stopped');
  service.dispose(); overlay.close();
}
