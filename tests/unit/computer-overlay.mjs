// コンピューターの操作中のオーバーレイと Esc（docs/computer-use.md「core と main」、ADR 0072・0073）の、Electron を起こさずに確かめられる部分。
//   - main（desktop/computer-overlay.cjs）を偽の electron で: 窓の作り・撮影から外す・6 秒のフェード・ターンの終わりですぐ消す・承認待ちで消す・
//     Esc は出ている間だけ握る・登録に失敗したらヒントを出さない・注入の前後で外して戻す・止めました 1.2 秒・倍率の違うモニターの座標
//   - 描画の部品（desktop/computer-overlay-view.cjs）: イージング・カーソルの経路と時間
// OS のキー入力は送らない。globalShortcut も偽物。
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createComputerOverlay, attachComputerOverlay, cutTitle } = require('../../desktop/computer-overlay.cjs');
const view = require('../../desktop/computer-overlay-view.cjs');

export const name = 'computer-overlay';
export const title = 'computer use のオーバーレイと Esc: 窓・フェード・Esc の登録と解除・止める流れ・座標（偽の electron）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 実タイマーで確かめるので短くする（AGENTS.md: unref だけのタイマーに頼らない）
const FAST = { idleMs: 60, stopMs: 50, tailMs: 20, exitMs: 10, rmExitMs: 4, marginMs: 6, keepMs: 400, escapeWaitMs: 80 };

/** 主モニター（倍率 1）+ 右の副モニター（倍率 1.5。物理 1920×1080 = DIP 1280×720）。bounds は DIP */
const D1 = { id: 11, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const D2 = { id: 22, scaleFactor: 1.5, bounds: { x: 1920, y: 0, width: 1280, height: 720 } };
const PHYS = { 11: { x: 0, y: 0, width: 1920, height: 1080 }, 22: { x: 1920, y: 0, width: 1920, height: 1080 } };

function fakeElectron({ registerOk = true, displays = [D1, D2] } = {}) {
  const wins = [], shortcuts = [], screenHandlers = {};
  const shortcut = { registered: new Map(), ok: registerOk };
  class Win {
    constructor(opts) {
      this.opts = opts; this.calls = []; this.sent = []; this.destroyed = false; this.visible = false; this.bounds = { ...opts };
      this.contentProtection = undefined; this.ignoreMouse = undefined; this.alwaysOnTopLevel = undefined; this.file = null;
      const once = {};
      this.webContents = {
        send: (channel, payload) => this.sent.push({ channel, payload }),
        setWindowOpenHandler: fn => { this.openHandler = fn; },
        on: (event, fn) => { (this.wcOn ??= {})[event] = fn; },
        once: (event, fn) => { once[event] = fn; },
      };
      this.fireLoaded = () => once['did-finish-load']?.();
      this.on = (event, fn) => { (this.winOn ??= {})[event] = fn; };
      wins.push(this);
    }
    loadFile(file) { this.file = file; return Promise.resolve().then(() => this.fireLoaded()); }
    setAlwaysOnTop(flag, level) { this.alwaysOnTopLevel = level; this.calls.push(`alwaysOnTop:${level}`); }
    setIgnoreMouseEvents(flag) { this.ignoreMouse = flag; }
    setContentProtection(flag) { this.contentProtection = flag; }
    setBounds(b) { this.bounds = { ...b }; this.calls.push('setBounds'); }
    getBounds() { return this.bounds; }
    showInactive() { this.visible = true; this.calls.push('showInactive'); }
    hide() { this.visible = false; this.calls.push('hide'); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; this.calls.push('destroy'); }
    get ops() { return this.sent.map(s => s.payload.op); }
  }
  const globalShortcut = {
    register(key, cb) { shortcuts.push(`register:${key}:${shortcut.ok}`); if (!shortcut.ok) return false; shortcut.registered.set(key, cb); return true; },
    unregister(key) { shortcuts.push(`unregister:${key}`); shortcut.registered.delete(key); },
    isRegistered: key => shortcut.registered.has(key),
  };
  const screen = {
    getAllDisplays: () => displays,
    dipToScreenRect: (_win, rect) => PHYS[displays.find(d => d.bounds === rect)?.id] ?? rect,
    screenToDipPoint: p => (p.x >= 1920 ? { x: 1920 + (p.x - 1920) / 1.5, y: p.y / 1.5 } : { x: p.x, y: p.y }),
    on: (event, fn) => { screenHandlers[event] = fn; },
    removeListener: event => { delete screenHandlers[event]; },
  };
  return { electron: { BrowserWindow: Win, globalShortcut, screen }, wins, shortcuts, shortcut, screenHandlers };
}

const dict = {
  'computer.overlay.who': ({ agent }) => `${agent} が操作中`,
  'computer.overlay.title': ({ title }) => `「${title}」`,
  'computer.overlay.hint': () => 'Esc で止める',
  'computer.overlay.stopped': () => '止めました',
};
const tr = (key, vars) => dict[key](vars);

function setup(options = {}) {
  const fake = fakeElectron(options.electron);
  const posted = [], logs = [], escapes = [];
  const overlay = createComputerOverlay({
    electron: fake.electron, post: m => posted.push(m), t: tr, timing: { ...FAST, ...options.timing }, log: (...a) => logs.push(a.join(' ')),
    onEscape: options.onEscape ?? (owner => { escapes.push(owner); }), reducedMotion: options.reducedMotion, contentProtection: options.contentProtection,
  });
  const send = m => overlay.handleMessage(m);
  const activity = (extra = {}) => send({ type: 'computer-overlay', owner: 'o1', state: 'activity', display: { id: 11, index: 1, bounds: PHYS[11], scale: 1 },
    agent: { id: 'claude', label: 'Claude' }, title: '請求書の入力', ...extra });
  return { ...fake, overlay, posted, logs, escapes, send, activity, win: i => fake.wins[i] };
}

const pressEsc = h => h.shortcut.registered.get('Escape')?.();
const lastPayload = (win, op) => [...win.sent].reverse().find(s => s.payload.op === op)?.payload;

export default async function (t) {
  // ---------------------------------------------------------------- 純粋な部品
  t.ok('cutTitle: 16 字まではそのまま、越えたら 16 字と …', cutTitle('あ'.repeat(16)) === 'あ'.repeat(16) && cutTitle('あ'.repeat(17)) === `${'あ'.repeat(16)}…`);
  t.ok('cutTitle: 改行・連続の空白は 1 つの空白にする。undefined は空', cutTitle('a\n  b') === 'a b' && cutTitle(undefined) === '');
  t.ok('cutTitle: サロゲートペアを割らない', cutTitle('😀'.repeat(17)) === `${'😀'.repeat(16)}…`);
  t.ok('カーソルの移動時間: 近いと 320ms、遠いと 900ms に丸める（280 + 0.35 × 距離）',
    view.pathDuration(10) === 320 && view.pathDuration(2000) === 900 && Math.abs(view.pathDuration(600) - 490) < 1e-9);
  const p0 = view.pathPoint(10, 20, 410, 220, 0), p1 = view.pathPoint(10, 20, 410, 220, 1), pm = view.pathPoint(0, 0, 400, 0, .5);
  t.ok('経路: 始点で始まり終点で終わる', p0.x === 10 && p0.y === 20 && Math.abs(p1.x - 410) < 1e-9 && Math.abs(p1.y - 220) < 1e-9);
  t.ok('経路: 制御点が距離の 15% だけ横へずれ、途中は右へ進むと下へ膨らむ（最大でも 400 の 7.5% = 30）', pm.y > 0 && pm.y <= 30 + 1e-9 && view.pathPoint(0, 0, 400, 0, 1).y === 0, `y=${pm.y}`);
  const ease = view.easeOrganic;
  t.ok('easeOrganic: 0→0・1→1・単調増加', ease(0) === 0 && ease(1) === 1 && [0.1, 0.3, 0.5, 0.7, 0.9].every((x, i, a) => i === 0 || ease(x) > ease(a[i - 1])));

  // ---------------------------------------------------------------- 窓
  {
    const h = setup();
    t.ok('最初の便りの前は窓も Esc も無い', h.wins.length === 0 && h.shortcuts.length === 0);
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity();
    const w = h.win(0);
    t.ok('操作中のディスプレイに 1 枚だけ窓を作る', h.wins.length === 1 && w.opts.x === 0 && w.opts.width === 1920 && w.opts.height === 1080);
    t.ok('透明・枠なし・フォーカスを奪わない・タスクバーに出ない・最前面', w.opts.transparent && w.opts.frame === false && w.opts.focusable === false && w.opts.skipTaskbar && w.opts.alwaysOnTop && w.opts.hasShadow === false);
    t.ok('クリックを通す・screen-saver の高さ', w.ignoreMouse === true && w.alwaysOnTopLevel === 'screen-saver');
    t.ok('オーバーレイの窓は撮影から外す（setContentProtection(true)）', w.contentProtection === true);
    t.ok('描画は sandbox・contextIsolation の preload だけ', w.opts.webPreferences.sandbox && w.opts.webPreferences.contextIsolation && !w.opts.webPreferences.nodeIntegration && path.basename(w.opts.webPreferences.preload) === 'computer-overlay-preload.cjs');
    t.ok('computer-overlay.html を読む', path.basename(w.file) === 'computer-overlay.html');
    t.ok('フォーカスを奪わずに出す（showInactive）', w.visible && w.calls.includes('showInactive') && !w.calls.includes('show'));
    await sleep(5);
    const show = lastPayload(w, 'show');
    t.ok('読み込みが済んでから show を送る。ピルは「Claude が操作中」「請求書の入力」· Esc で止める', show?.pill?.who === 'Claude が操作中' && show.pill.title === '「請求書の入力」' && show.pill.hint === 'Esc で止める' && w.sent[0].channel === 'ply:computer-overlay');
    t.ok('Shift・Ctrl・Alt を押したままの Esc も握る（RegisterHotKey は修飾キーまで合わないと反応しない）。Ctrl+Shift+Esc（タスクマネージャー）は奪わない',
      ['Shift+Escape', 'Control+Escape', 'Alt+Escape'].every(k => h.shortcut.registered.has(k)) && !h.shortcut.registered.has('Control+Shift+Escape'));
    t.ok('Esc を握る（出ている間だけ）', h.overlay.snapshot().escapeRegistered && h.shortcuts.filter(s => s.startsWith('register:Escape:')).length === 1);
    h.activity({ title: 'あ'.repeat(20) });
    await sleep(2);
    t.ok('タイトルは 16 字で切る。変わったら pill だけ送り、窓も Esc も作り直さない', lastPayload(w, 'pill')?.pill.title === `「${'あ'.repeat(16)}…」` && h.wins.length === 1 && h.shortcuts.filter(s => s.startsWith('register:Escape:')).length === 1);
    h.overlay.close();
  }

  {
    const h = setup({ contentProtection: false });
    h.activity(); t.ok('contentProtection:false は確認のときだけ撮影に写す', h.win(0).contentProtection === undefined);
    h.overlay.close();
  }

  // ---------------------------------------------------------------- 座標（倍率の違うモニター）
  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity({ display: { id: 22, index: 2, bounds: PHYS[22], scale: 1.5 }, cursor: { x: 1920 + 300, y: 150, pressed: true } });
    await sleep(5);
    const w = h.win(0), cur = lastPayload(w, 'cursor');
    t.ok('副モニター（倍率 1.5）: 窓は DIP の bounds に置く', w.opts.x === 1920 && w.opts.width === 1280 && w.opts.height === 720);
    t.ok('物理座標のカーソルを、その窓の中の DIP にする（(300,150) → (200,100)）。押した印も渡す', cur && cur.x === 200 && cur.y === 100 && cur.pressed === true, JSON.stringify(cur));
    h.activity({ display: { id: 22, bounds: PHYS[22] }, cursor: { x: 1920 + 600, y: 300 } });
    t.ok('pressed が無ければ押していない', lastPayload(h.win(0), 'cursor').pressed === false);
    // bounds が無くても id で引ける・番号（1 から）でも引ける
    h.send({ type: 'computer-turn-ended', owner: 'o1' }); await sleep(40);
    h.activity({ display: 22 }); t.ok('id（番号）だけでも対象のディスプレイを決められる', h.wins.length === 1 && h.win(0).visible);
    h.send({ type: 'computer-turn-ended', owner: 'o1' }); await sleep(40);
    h.activity({ display: { index: 1 } }); t.ok('index（1 から）でも決められる（id が合わなくても）', h.wins.length === 2 && h.win(1).opts.x === 0);
    h.send({ type: 'computer-turn-ended', owner: 'o1' }); await sleep(40);
    h.activity({ display: { id: 999, bounds: { x: 9000, y: 0, width: 10, height: 10 } } });
    t.ok('分からないディスプレイは出さずにログへ 1 行', h.logs.length === 1 && !h.overlay.snapshot().phase);
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.activity({ display: { id: 22, bounds: PHYS[22] } }); await sleep(2);
    t.ok('switch_display: 光る場所が移る。新しい窓が出て、前の窓へは hide が行く', h.wins.length === 2 && h.win(1).visible && lastPayload(h.win(0), 'hide')?.kind === 'now');
    t.ok('Esc の登録は 1 つのまま', h.shortcuts.filter(s => s.startsWith('register:Escape:')).length === 1 && h.overlay.snapshot().escapeRegistered);
    await sleep(40);
    t.ok('前の窓は消え終わったら隠す', !h.win(0).visible && h.win(1).visible);
    h.overlay.close();
  }

  // ---------------------------------------------------------------- 6 秒のフェード・すぐ消す・承認待ち
  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(35);
    h.activity(); await sleep(35);
    t.ok('activity が来るたびに数え直す（最初から 70ms 経っても残る）', h.win(0).visible && !h.win(0).ops.includes('hide'));
    await sleep(60);
    t.ok('最後の操作から idleMs で縁を引く（kind: idle）', lastPayload(h.win(0), 'hide')?.kind === 'idle');
    t.ok('フェードに入ったら Esc を離す（ほかのアプリの Esc を奪わない）', !h.overlay.snapshot().escapeRegistered && h.shortcuts.at(-1) === 'unregister:Escape');
    await sleep(30);
    t.ok('消え終わったら窓を隠す', !h.win(0).visible && h.overlay.snapshot().phase === null);
    t.ok('ターンは続いている: 次の操作で同じ窓を使って戻り、Esc も握り直す', (h.activity(), h.wins.length === 1 && h.win(0).visible && h.overlay.snapshot().escapeRegistered));
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.send({ type: 'computer-turn-ended', owner: 'o2' });
    t.ok('別の持ち主のターン終わりでは消さない', h.win(0).visible && !h.win(0).ops.includes('hide'));
    h.send({ type: 'computer-turn-ended', owner: 'o1' });
    t.ok('ターンの終わりですぐ消す（6 秒を待たない）。Esc も離す', lastPayload(h.win(0), 'hide')?.kind === 'now' && !h.overlay.snapshot().escapeRegistered);
    await sleep(30);
    t.ok('そして窓を隠す', !h.win(0).visible);
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.send({ type: 'computer-overlay', owner: 'o1', state: 'hide' });
    t.ok('承認を待つ間（hide）は何も出さない。Esc も離す', lastPayload(h.win(0), 'hide') && !h.overlay.snapshot().escapeRegistered);
    await sleep(30);
    h.activity();
    t.ok('承認の後の操作で戻る', h.win(0).visible && h.overlay.snapshot().escapeRegistered && h.overlay.snapshot().phase === 'active');
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.send({ type: 'computer-arm', owner: 'o2' });
    t.ok('持ち主が変わったら前の持ち主の表示を消す', lastPayload(h.win(0), 'hide')?.kind === 'now');
    h.activity();
    t.ok('前の持ち主の便りは捨てる', h.overlay.snapshot().owner !== 'o1' || h.overlay.snapshot().phase === 'exiting');
    h.send({ type: 'computer-overlay', owner: 'o2', state: 'activity', display: { id: 11, bounds: PHYS[11] }, agent: 'Codex', title: 't' });
    t.ok('新しい持ち主の操作は出る。agent は文字列でも受ける', h.overlay.snapshot().owner === 'o2' && lastPayload(h.win(0), 'show').pill.who === 'Codex が操作中');
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.send({ type: 'computer-arm', owner: null });
    h.activity();
    t.ok('持ち主がいない（arm: null）ときの操作は出さない', h.wins.length === 0);
    h.overlay.close();
  }

  // ---------------------------------------------------------------- Esc
  {
    const order = [];
    const h = setup({ onEscape: async owner => { order.push(`release:${owner}`); await sleep(10); order.push('released'); } });
    const post = h.posted.push.bind(h.posted);
    h.posted.push = m => { order.push(`post:${m.type}`); return post(m); };
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    t.ok('Esc は出ている間 Escape キーに登録されている', h.shortcut.registered.has('Escape'));
    pressEsc(h);
    const w = h.win(0);
    t.ok('Esc を拾ったらピルを「止めました」にする（stop）', lastPayload(w, 'stop')?.pill.stopped === '止めました');
    t.ok('すぐ Esc を離す（拾った後の Esc はほかのアプリへ届く）', !h.shortcut.registered.has('Escape') && h.overlay.snapshot().phase === 'stopping');
    await sleep(25);
    t.ok('入力を離す（onEscape）→ computer-escape の順。owner を付けて core へ', order.join(',') === 'release:o1,released,post:computer-escape' && h.posted.length === 1 && h.posted[0].owner === 'o1');
    t.ok('止めました は 1.2 秒（stopMs）残す。その間は窓を隠さない', w.visible);
    h.send({ type: 'computer-turn-ended', owner: 'o1' });
    h.send({ type: 'computer-arm', owner: null });
    t.ok('止めた直後のターンの終わり・arm: null で「止めました」を切らない', w.visible && h.overlay.snapshot().phase === 'stopping');
    h.activity();
    t.ok('止めた後の古い activity では戻らない', h.overlay.snapshot().phase === 'stopping' && w.ops.filter(o => o === 'show').length === 1);
    await sleep(FAST.stopMs + FAST.tailMs + 30);
    t.ok('見せ切ったら窓を隠す', !w.visible && h.overlay.snapshot().phase === null);
    t.ok('computer-escape は 1 回だけ', h.posted.length === 1);
    h.overlay.close();
  }

  {
    const h = setup({ onEscape: () => new Promise(() => {}) });
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    pressEsc(h);
    await sleep(FAST.escapeWaitMs + 40);
    t.ok('onEscape が固まっても computer-escape は必ず送る', h.posted.length === 1 && h.posted[0].type === 'computer-escape');
    h.overlay.close();
  }

  {
    const h = setup({ onEscape: () => { throw new Error('boom'); } });
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    pressEsc(h); await sleep(20);
    t.ok('onEscape が例外でも computer-escape は送り、ログに残す', h.posted.length === 1 && h.logs.some(l => l.includes('boom')));
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.send({ type: 'computer-stop', owner: 'o2' });
    t.ok('別の持ち主の computer-stop は無視する', h.overlay.snapshot().phase === 'active');
    h.send({ type: 'computer-stop', owner: 'o1' });
    t.ok('computer-stop も Esc と同じ見た目（止めました）。Esc は離す', lastPayload(h.win(0), 'stop') && !h.overlay.snapshot().escapeRegistered);
    await sleep(20);
    t.ok('computer-stop では computer-escape も onEscape も呼ばない（core が止めた側）', h.posted.length === 0 && h.escapes.length === 0);
    await sleep(FAST.stopMs + FAST.tailMs + 30);
    t.ok('消える', !h.win(0).visible);
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.send({ type: 'computer-overlay', owner: 'o1', state: 'stopped' });
    t.ok('state: stopped も止めました（core 起点の表示）', lastPayload(h.win(0), 'stop') && h.posted.length === 0);
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    const cb = h.shortcut.registered.get('Escape');
    h.send({ type: 'computer-turn-ended', owner: 'o1' });
    cb();
    await sleep(15);
    t.ok('消えた後に残った Esc のコールバックでは止めない', h.posted.length === 0 && h.escapes.length === 0);
    h.overlay.close();
  }

  {
    const h = setup({ electron: { registerOk: false } });
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    t.ok('Esc を登録できなければピルに「Esc で止める」を出さない', lastPayload(h.win(0), 'show').pill.hint === '' && lastPayload(h.win(0), 'show').pill.who === 'Claude が操作中');
    t.ok('ログに 1 行残す。登録できていないので解除もしない', h.logs.length === 1 && h.logs[0].includes('Esc') && !h.shortcuts.includes('unregister:Escape') && !h.overlay.snapshot().escapeRegistered);
    h.send({ type: 'computer-turn-ended', owner: 'o1' });
    t.ok('それでも消える', !!lastPayload(h.win(0), 'hide') && !h.shortcuts.includes('unregister:Escape'));
    h.overlay.close();
  }

  // ---------------------------------------------------------------- 自分の Esc の注入
  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    const before = h.shortcuts.length;
    const resume = h.overlay.suspendEscape();
    t.ok('Esc を注入する前に外す', !h.shortcut.registered.has('Escape') && h.shortcuts.slice(before).at(-1) === 'unregister:Escape' && !h.shortcut.registered.has('Shift+Escape'));
    const resume2 = h.overlay.suspendEscape();
    resume();
    t.ok('入れ子: 外側が戻るまでは握り直さない', !h.shortcut.registered.has('Escape'));
    resume2(); resume2();
    t.ok('注入の後に戻す（二重に戻しても 1 回）', h.shortcut.registered.has('Escape') && h.shortcuts.filter(s => s.startsWith('register:Escape:')).length === 2);
    let ran = false;
    await h.overlay.withEscapeSuspended(async () => { ran = !h.shortcut.registered.has('Escape'); await sleep(2); });
    t.ok('withEscapeSuspended: 中は外れ、終われば戻る', ran && h.shortcut.registered.has('Escape'));
    await h.overlay.withEscapeSuspended(async () => { throw new Error('x'); }).catch(() => {});
    t.ok('注入が例外でも戻す', h.shortcut.registered.has('Escape'));
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    // 出ていないときに外して戻しても、握らない
    const resume = h.overlay.suspendEscape(); resume();
    t.ok('オーバーレイが出ていないときは、戻しても握らない', h.shortcuts.length === 0);
    h.activity(); await sleep(5);
    const resume2 = h.overlay.suspendEscape();
    h.send({ type: 'computer-turn-ended', owner: 'o1' });
    resume2();
    t.ok('注入の間に消えたら、戻しても握らない', !h.shortcut.registered.has('Escape') && !h.overlay.snapshot().escapeRegistered);
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    const resume = h.overlay.suspendEscape();
    h.shortcut.ok = false;
    resume();
    t.ok('注入の後に握り直せなければ、ピルのヒントを引っ込める', lastPayload(h.win(0), 'pill')?.pill.hint === '' && h.logs.length === 1);
    h.overlay.close();
  }

  // ---------------------------------------------------------------- 動きを減らす・後始末
  {
    const h = setup({ reducedMotion: () => true });
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    t.ok('動きを減らす設定は show に載せる（描画側は呼吸と経路を止める）', lastPayload(h.win(0), 'show').rm === true);
    h.overlay.close();
    const h2 = setup();
    h2.activity(); await sleep(5);
    t.ok('指定が無ければ描画側が OS の設定を読む（rm は undefined）', lastPayload(h2.win(0), 'show').rm === undefined);
    h2.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.send({ type: 'computer-turn-ended', owner: 'o1' });
    await sleep(FAST.keepMs + 40);
    t.ok('隠した窓はしばらく使わなければ破棄する', h.win(0).destroyed && h.overlay.snapshot().windows === 0);
    h.overlay.close();
  }

  {
    const h = setup();
    h.send({ type: 'computer-arm', owner: 'o1' });
    h.activity(); await sleep(5);
    h.screenHandlers['display-removed']?.({}, D1);
    t.ok('ディスプレイが外れたら、その窓を破棄して Esc も離す', h.win(0).destroyed && !h.overlay.snapshot().escapeRegistered && h.overlay.snapshot().phase === null);
    h.activity({ display: { id: 22, bounds: PHYS[22] } });
    h.screenHandlers['display-metrics-changed']?.({}, { ...D2, bounds: { x: 1920, y: 0, width: 1600, height: 900 } });
    t.ok('構成が変わったら bounds を合わせ直す', h.win(1).bounds.width === 1600);
    h.overlay.hideAll();
    t.ok('hideAll: 全部消して Esc も離す', h.win(1).destroyed && !h.shortcut.registered.has('Escape'));
    h.overlay.close();
    t.ok('close: 画面の変更の購読も外す', Object.keys(h.screenHandlers).length === 0);
    assert.doesNotThrow(() => h.send({ type: 'computer-overlay', owner: 'o1', state: 'activity', display: 11 }));
    t.ok('close の後は何もしない', h.wins.length === 2 && h.overlay.handleMessage({ type: 'computer-turn-ended', owner: 'o1' }) === false);
  }

  {
    const h = setup();
    t.ok('知らない type は扱わない（false）', h.overlay.handleMessage({ type: 'agent-browser-x' }) === false && h.overlay.handleMessage(null) === false);
    t.ok('computer-heartbeat は何もしない', h.overlay.handleMessage({ type: 'computer-heartbeat', owner: 'o1' }) === false);
    h.overlay.close();
  }

  {
    // attach: worker のメッセージにつなぎ、終了で全部消す
    const fake = fakeElectron(), handlers = {}, sent = [];
    const worker = { on: (e, f) => { handlers[e] = f; }, once: (e, f) => { handlers[`once:${e}`] = f; }, postMessage: m => sent.push(m) };
    const overlay = attachComputerOverlay(worker, { electron: fake.electron, t: tr, timing: FAST });
    handlers.message({ type: 'computer-arm', owner: 'o1' });
    handlers.message({ type: 'computer-overlay', owner: 'o1', state: 'activity', display: { id: 11, bounds: PHYS[11] }, agent: 'Claude', title: 'x' });
    await sleep(5);
    t.ok('attach: worker の computer-* を受けて窓を出す', fake.wins.length === 1 && fake.wins[0].visible && fake.shortcut.registered.has('Escape'));
    pressEsc({ shortcut: fake.shortcut });
    await sleep(15);
    t.ok('attach: Esc は worker へ computer-escape を送る', sent.length === 1 && sent[0].type === 'computer-escape' && sent[0].owner === 'o1');
    overlay.setOnEscape(owner => { sent.push({ released: owner }); });
    handlers.message({ type: 'computer-turn-ended', owner: 'o1' });
    await sleep(FAST.stopMs + FAST.tailMs + 20);
    handlers.message({ type: 'computer-overlay', owner: 'o1', state: 'activity', display: { id: 11, bounds: PHYS[11] } });
    pressEsc({ shortcut: fake.shortcut }); await sleep(15);
    t.ok('attach: setOnEscape で A の後始末をつなげる（呼ばれてから computer-escape）', sent.at(-2)?.released === 'o1' && sent.at(-1)?.type === 'computer-escape');
    handlers['once:exit']();
    t.ok('attach: core が終わったら窓と Esc を片付ける', fake.wins.every(w => w.destroyed) && !fake.shortcut.registered.has('Escape'));
    overlay.close();
  }
}
