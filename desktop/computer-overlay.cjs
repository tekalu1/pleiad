// コンピューターの操作中のオーバーレイと Esc（docs/computer-use.md「core と main」、ADR 0072・0073）。
//
// 操作中のディスプレイだけを覆う、透明・最前面・クリック透過・フォーカスを奪わない窓を出す（縁のグロー・上端のピル・霧のカーソル）。
// 描くのは desktop/computer-overlay.html（数値は ADR 0073）。この main 側は窓の出し入れ・時間・Esc だけを持つ。
//   - computer-overlay { owner, state, display, agent, title, cursor? } … activity で出す・6 秒を数え直す／hide・stopped
//     6 秒たってもロックの持ち主のままなら、消さずに「使用中」の薄い縁とピルにする（ADR 0129）。消すのはターンの終わり・持ち主の変更・hide
//   - computer-arm { owner } … ロックの持ち主。変わったら前の持ち主の表示を消す。前に出したことのある持ち主へ戻ったら（委譲の子から返った）「使用中」で出す
//   - computer-stop { owner } … 会話の「止める」。Esc と同じ見た目の後始末（computer-escape は返さない）
//   - computer-turn-ended { owner } … すぐ消す
//   - 物理の Esc … 操作中（active）の間だけ globalShortcut を持つ。「使用中」の間は持たない（長く続くので、人の Esc を奪わない）。
//     拾ったら onEscape（A: 押したままの入力を離す）→ 止めました → computer-escape
// オーバーレイの窓だけを setContentProtection(true) で撮影から外す。Pleiad 本体の窓には掛けない（契約）。
const path = require('node:path');

// idleMs: 最後の操作からフェードまで。stopMs: 「止めました」を残す時間（tailMs はその後のピルのフェード）。exitMs / rmExitMs: 縁の引き（描画側の値と揃える）。
// keepMs: 隠した窓を使い回すために残す時間（過ぎたら破棄する）
const TIMING = { idleMs: 6000, stopMs: 1200, tailMs: 300, exitMs: 600, rmExitMs: 150, marginMs: 80, keepMs: 60_000, escapeWaitMs: 3000 };
const TITLE_MAX = 16;
// 「使用中」で出し直すために覚えておく持ち主の数（ターンの終わりで消す。中断で終わりが届かない分の上限）
const KNOWN_MAX = 16;

/** 会話のタイトルをピルに出す長さ（16 字、越えたら …）に切る */
function cutTitle(title) {
  const chars = [...String(title ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : chars.join('');
}

function agentLabel(agent) {
  if (agent && typeof agent === 'object') return String(agent.label ?? agent.name ?? agent.id ?? '');
  return String(agent ?? '');
}

/**
 * @param {object} options
 * @param {{ BrowserWindow, globalShortcut, screen }} options.electron
 * @param {(message: object) => void} options.post  core へ送る（worker.postMessage）
 * @param {(key: string, vars?: object) => string} options.t  desktop の辞書
 * @param {(owner: string|null) => any} [options.onEscape]  物理の Esc を拾った。押したままの入力を離し、以後の input を stopped にする（desktop/computer の担当）
 * @param {() => boolean|undefined} [options.reducedMotion]  true / false で描画側の判定を上書き（確認用）。undefined なら描画側が OS の設定を読む
 * @param {boolean} [options.contentProtection]  オーバーレイの窓を撮影から外す（既定 true。確認で写したいときだけ false）
 */
function createComputerOverlay({ electron, post, t, onEscape, reducedMotion, contentProtection = true, timing, log = (...args) => console.warn('[computer-overlay]', ...args),
  page = path.join(__dirname, 'computer-overlay.html'), preload = path.join(__dirname, 'computer-overlay-preload.cjs') }) {
  const { BrowserWindow, globalShortcut, screen } = electron;
  const T = { ...TIMING, ...timing };
  let handler = onEscape;
  let armed; // undefined = まだ便りが無い / null = 持ち主なし / 文字列 = 持ち主
  // 今見えている（か、消えつつある）操作 { owner, entry, agent, title, phase, escOk, timers }。
  // phase: active = 操作中 / held = 操作の合間（ロックは持ったまま。薄い縁とピル） / exiting = 消えつつある / stopping = 止めました
  let cur = null;
  let escRegistered = false, suspended = 0, closed = false;
  const entries = new Map(); // display.id → { display, win, loaded, queue, destroyTimer }
  const known = new Map(); // owner → { display, agent, title }。最後に出した場所と名前（委譲の子から返ったときに「使用中」で出す）

  // ------------------------------------------------------------------ 窓
  function send(entry, payload) {
    if (!entry.win || entry.win.isDestroyed?.()) return;
    if (!entry.loaded) { entry.queue.push(payload); return; }
    entry.win.webContents.send('ply:computer-overlay', payload);
  }

  function createEntry(display) {
    const win = new BrowserWindow({
      ...display.bounds, show: false, transparent: true, backgroundColor: '#00000000', frame: false, thickFrame: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    const entry = { display, win, loaded: false, queue: [], destroyTimer: null };
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    if (contentProtection) win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.once('did-finish-load', () => {
      entry.loaded = true;
      for (const payload of entry.queue.splice(0)) send(entry, payload);
    });
    win.webContents.on('render-process-gone', () => dropEntry(entry));
    win.on('closed', () => { if (entries.get(entry.display.id) === entry) entries.delete(entry.display.id); });
    win.loadFile(page).catch(error => log('load failed:', error?.message ?? error));
    return entry;
  }

  function entryFor(display) {
    let entry = entries.get(display.id);
    if (entry?.win.isDestroyed?.()) { entries.delete(display.id); entry = null; }
    if (!entry) { entry = createEntry(display); entries.set(display.id, entry); }
    entry.display = display;
    clearTimeout(entry.destroyTimer);
    return entry;
  }

  function dropEntry(entry) {
    clearTimeout(entry.destroyTimer);
    if (entries.get(entry.display.id) === entry) entries.delete(entry.display.id);
    if (cur?.entry === entry) { clearTimers(cur); cur = null; releaseEscape(); }
    try { if (!entry.win.isDestroyed()) entry.win.destroy(); } catch { /* 破棄済み */ }
  }

  function park(entry) {
    // 次の操作で使い回す。しばらく使わなければ破棄する（窓 1 つにつき描画のプロセスが 1 つ付く）
    try { if (!entry.win.isDestroyed()) entry.win.hide(); } catch { /* 破棄済み */ }
    clearTimeout(entry.destroyTimer);
    entry.destroyTimer = setTimeout(() => dropEntry(entry), T.keepMs);
    entry.destroyTimer.unref?.();
  }

  /** 縁が引き終わってから隠す。同じ窓をすぐ使い直したら（entryFor）取り消す */
  function parkLater(entry, ms) {
    clearTimeout(entry.destroyTimer);
    entry.destroyTimer = setTimeout(() => park(entry), ms);
  }

  function place(entry) {
    // 倍率の違うモニターでは、作った直後の bounds が主モニターの倍率で丸められることがある。出す前に決め、出した後にもう一度合わせる
    const { bounds } = entry.display;
    entry.win.setBounds(bounds);
    entry.win.showInactive();
    entry.win.setAlwaysOnTop(true, 'screen-saver');
    const now = entry.win.getBounds?.();
    if (now && (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height)) entry.win.setBounds(bounds);
  }

  // ------------------------------------------------------------------ ディスプレイと座標
  /** core の display（{ id, index, bounds(物理), scale } か番号）を Electron の display にする */
  function findDisplay(spec) {
    const all = screen.getAllDisplays();
    if (spec && typeof spec === 'object' && spec.bounds) {
      const cx = spec.bounds.x + spec.bounds.width / 2, cy = spec.bounds.y + spec.bounds.height / 2;
      for (const d of all) {
        const r = screen.dipToScreenRect(null, d.bounds);
        if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) return d;
      }
    }
    const id = spec && typeof spec === 'object' ? spec.id : spec;
    const index = spec && typeof spec === 'object' ? spec.index : spec;
    return all.find(d => d.id === id) ?? (Number.isInteger(index) ? all[index - 1] : undefined) ?? null;
  }

  /** 物理の仮想デスクトップ座標 → その窓の中の DIP */
  function toLocal(entry, point) {
    const dip = screen.screenToDipPoint ? screen.screenToDipPoint({ x: point.x, y: point.y }) : { x: point.x / (entry.display.scaleFactor || 1), y: point.y / (entry.display.scaleFactor || 1) };
    return { x: dip.x - entry.display.bounds.x, y: dip.y - entry.display.bounds.y };
  }

  // ------------------------------------------------------------------ Esc
  // RegisterHotKey は修飾キーまで一致しないと反応しない。エージェントが Shift・Ctrl・Alt を押したままにしている最中（hold_key・keyDown）は
  // 素の Esc が合わず、止めたいときに限って止まらない（2026-10-01 に本物で確認）。修飾キーつきの Esc も同じ手で握る。
  // Ctrl+Shift+Esc はタスクマネージャーの起動なので奪わない
  const ESC_WITH_MODIFIERS = ['Shift+Escape', 'Control+Escape', 'Alt+Escape', 'Control+Alt+Escape', 'Alt+Shift+Escape'];
  const extraEsc = new Set();
  function onKey() {
    if (!cur || cur.phase !== 'active') return;
    stop({ escape: true });
  }

  /** オーバーレイが出ている間だけ握る。握れたか（pill に「Esc で止める」を出せるか）を返す */
  function ensureEscape() {
    if (!cur || cur.phase !== 'active') return false;
    if (suspended || escRegistered) return true; // 注入の間だけ外している。戻すときにもう一度握る
    let ok = false;
    try { ok = globalShortcut.register('Escape', onKey); } catch (error) { log('could not register Escape:', error?.message ?? error); }
    if (ok) {
      escRegistered = true;
      for (const accelerator of ESC_WITH_MODIFIERS) { // 握れなくても（ほかのアプリが持っている）素の Esc があれば足りる
        try { if (globalShortcut.register(accelerator, onKey)) extraEsc.add(accelerator); } catch { /* 無視 */ }
      }
      return true;
    }
    log('could not register Escape (another app holds it); the pill omits the Esc hint and only the conversation Stop works');
    return false;
  }

  function releaseEscape() {
    if (!escRegistered) return;
    escRegistered = false;
    for (const accelerator of extraEsc) { try { globalShortcut.unregister(accelerator); } catch { /* 解除済み */ } }
    extraEsc.clear();
    try { globalShortcut.unregister('Escape'); } catch { /* 解除済み */ }
  }

  /**
   * 自分で注入する Esc で止まらないように、送る前に外し、送った後に戻す（desktop/computer が key / keyDown の Escape の前後で使う）。
   * 戻す関数を返す。入れ子でも数える
   */
  function suspendEscape() {
    suspended++;
    releaseEscape();
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      suspended--;
      if (suspended || !cur || cur.phase !== 'active') return;
      const ok = ensureEscape();
      if (!ok && cur.escOk) { cur.escOk = false; send(cur.entry, { op: 'pill', pill: pillOf(cur) }); }
    };
  }

  async function withEscapeSuspended(fn) {
    const resume = suspendEscape();
    try { return await fn(); } finally { resume(); }
  }

  // ------------------------------------------------------------------ 流れ
  function clearTimers(c) { clearTimeout(c.idleTimer); clearTimeout(c.exitTimer); c.idleTimer = c.exitTimer = null; }

  function pillOf(c) {
    return {
      who: c.phase === 'held' ? t('computer.overlay.held', { agent: agentLabel(c.agent) }) : t('computer.overlay.who', { agent: agentLabel(c.agent) }),
      title: c.title ? t('computer.overlay.title', { title: c.title }) : '',
      hint: c.escOk ? t('computer.overlay.hint') : '',
      stopped: t('computer.overlay.stopped'),
    };
  }

  function motion() {
    const rm = reducedMotion?.();
    return typeof rm === 'boolean' ? rm : undefined;
  }

  /** 消え終わるまで（描画側のフェードの長さ + 余裕）。この後で窓を隠す */
  function exitMs(kind) {
    if (kind === 'esc') return T.stopMs + T.tailMs;
    return (motion() === true ? T.rmExitMs : T.exitMs) + T.marginMs;
  }

  function finish(c) {
    if (cur !== c) return;
    cur = null;
    releaseEscape();
    park(c.entry);
  }

  /** 前の表示が別のディスプレイなら引っ込める（switch_display・持ち主の交代）。同じ窓なら消えかけを取り消して使い回す */
  function takeOver(entry) {
    if (!cur) return;
    clearTimers(cur);
    if (cur.entry === entry) return;
    send(cur.entry, { op: 'hide', kind: 'now' }); parkLater(cur.entry, exitMs('now')); cur = null;
  }

  function remember(owner, info) {
    if (!owner) return;
    known.delete(owner);
    known.set(owner, info);
    if (known.size > KNOWN_MAX) known.delete(known.keys().next().value);
  }

  function activity(message) {
    const display = findDisplay(message.display);
    if (!display) { log('unknown display for the overlay:', JSON.stringify(message.display)); return; }
    if (cur?.phase === 'stopping') {
      if (cur.owner === message.owner) return; // 止めた後の古い便り
      clearTimers(cur); const old = cur; cur = null; park(old.entry);
    }
    const entry = entryFor(display);
    const title = cutTitle(message.title);
    const agent = agentLabel(message.agent);
    remember(message.owner, { display: message.display, agent, title });
    const show = !cur || cur.phase !== 'active' || cur.entry !== entry;
    if (cur && cur.entry !== entry) takeOver(entry); // 操作するディスプレイが移った（switch_display）。前の窓は引っ込める
    if (!cur) cur = { owner: message.owner, entry, agent, title, phase: 'active', escOk: true, idleTimer: null, exitTimer: null };
    clearTimeout(cur.exitTimer);
    const changed = cur.owner !== message.owner || cur.agent !== agent || cur.title !== title;
    Object.assign(cur, { owner: message.owner, agent, title, phase: 'active' });
    if (show) {
      cur.escOk = ensureEscape();
      place(entry);
      send(entry, { op: 'show', pill: pillOf(cur), rm: motion() });
    } else if (changed) send(entry, { op: 'pill', pill: pillOf(cur) });
    if (message.cursor && Number.isFinite(message.cursor.x) && Number.isFinite(message.cursor.y)) {
      send(entry, { op: 'cursor', ...toLocal(entry, message.cursor), pressed: message.cursor.pressed === true });
    }
    clearTimeout(cur.idleTimer);
    const c = cur;
    c.idleTimer = setTimeout(() => idle(c), T.idleMs);
    c.idleTimer.unref?.();
  }

  /** 最後の操作から 6 秒。まだロックの持ち主なら「使用中」にする。持ち主が分からない・別なら消す */
  function idle(c) {
    if (cur !== c || c.phase !== 'active') return;
    if (armed !== undefined && armed === c.owner) hold(c);
    else hide('idle');
  }

  /** 操作の合間（held）。縁を薄くし、ピルを「使用中」にする。Esc は離す（長く続くので、人の Esc を奪わない） */
  function hold(c) {
    clearTimers(c);
    c.phase = 'held';
    c.escOk = false;
    releaseEscape();
    send(c.entry, { op: 'rest', pill: pillOf(c), rm: motion() });
  }

  /** 委譲の子から持ち主が戻った。前に出した場所へ「使用中」で出す（次の操作で操作中に戻る） */
  function holdKnown(owner) {
    const info = known.get(owner);
    const display = info && findDisplay(info.display);
    if (!display) return;
    const entry = entryFor(display);
    takeOver(entry);
    cur = { owner, entry, agent: info.agent, title: info.title, phase: 'held', escOk: false, idleTimer: null, exitTimer: null };
    place(entry);
    send(entry, { op: 'rest', pill: pillOf(cur), rm: motion() });
  }

  /** 消す。止めている最中なら「止めました」を最後まで見せる（ターンの終わりはそのすぐ後に来る） */
  function hide(kind = 'now') {
    const c = cur;
    if (!c || (c.phase !== 'active' && c.phase !== 'held')) return;
    clearTimers(c);
    c.phase = 'exiting';
    releaseEscape();
    send(c.entry, { op: 'hide', kind });
    c.exitTimer = setTimeout(() => finish(c), exitMs(kind));
    c.exitTimer.unref?.();
  }

  /** Esc か「止める」。Esc のときだけ onEscape → computer-escape。見た目は同じ（止めました → 消す） */
  function stop({ escape }) {
    const c = cur;
    if (!c || c.phase === 'stopping') return;
    clearTimers(c);
    c.phase = 'stopping';
    releaseEscape();
    send(c.entry, { op: 'stop', pill: pillOf(c) });
    c.exitTimer = setTimeout(() => finish(c), exitMs('esc'));
    c.exitTimer.unref?.();
    if (!escape) return;
    const owner = c.owner;
    // 先に入力を離す（A）。固まっても core への知らせは必ず送る
    const released = Promise.resolve().then(() => handler?.(owner)).catch(error => log('onEscape:', error?.message ?? error));
    const wait = new Promise(resolve => { const timer = setTimeout(resolve, T.escapeWaitMs); timer.unref?.(); });
    Promise.race([released, wait]).then(() => post({ type: 'computer-escape', owner }));
  }

  /** core からの便り。扱ったら true */
  function handleMessage(message) {
    if (closed || !message || typeof message.type !== 'string') return false;
    switch (message.type) {
      case 'computer-overlay': {
        if (armed !== undefined && armed !== message.owner) return true; // 持ち主でない便りは捨てる
        if (message.state === 'activity') activity(message);
        else if (message.state === 'stopped') { if (cur && cur.owner === message.owner) stop({ escape: false }); }
        else if (message.state === 'hide') { if (cur && cur.owner === message.owner) hide('now'); }
        return true;
      }
      case 'computer-arm': {
        const owner = message.owner ?? null;
        armed = owner;
        if (cur && cur.owner !== owner) { // 持ち主が変わった。止めている最中の「止めました」は見せ切る
          if (cur.phase === 'stopping') return true;
          hide('now');
        }
        if (owner && known.has(owner) && (!cur || cur.owner !== owner)) holdKnown(owner);
        return true;
      }
      case 'computer-stop': if (cur && cur.owner === message.owner) stop({ escape: false }); return true;
      case 'computer-turn-ended':
        known.delete(message.owner);
        if (cur && cur.owner === message.owner) hide('now');
        return true;
      default: return false;
    }
  }

  function onDisplayRemoved(_event, display) {
    const entry = entries.get(display.id);
    if (entry) dropEntry(entry);
  }
  function onMetricsChanged(_event, display) {
    const entry = entries.get(display.id);
    if (!entry) return;
    entry.display = display;
    if (!entry.win.isDestroyed()) entry.win.setBounds(display.bounds);
  }
  screen.on?.('display-removed', onDisplayRemoved);
  screen.on?.('display-metrics-changed', onMetricsChanged);

  /** 全部消す（core の終了・アプリの終了）。押したままの入力は desktop/computer 側が離す */
  function hideAll() {
    if (cur) { clearTimers(cur); cur = null; }
    known.clear();
    releaseEscape();
    for (const entry of [...entries.values()]) dropEntry(entry);
  }

  function close() {
    if (closed) return;
    hideAll();
    closed = true;
    screen.removeListener?.('display-removed', onDisplayRemoved);
    screen.removeListener?.('display-metrics-changed', onMetricsChanged);
  }

  return {
    handleMessage, suspendEscape, withEscapeSuspended, hideAll, close,
    setOnEscape(fn) { handler = fn; },
    /** 確認と単体テスト用 */
    snapshot: () => ({ armed, owner: cur?.owner ?? null, phase: cur?.phase ?? null, escapeRegistered: escRegistered, windows: entries.size }),
  };
}

/** main.cjs から。worker（core の utilityProcess）のメッセージをつなぐ */
function attachComputerOverlay(worker, options = {}) {
  const electron = options.electron ?? require('electron');
  const t = options.t ?? require('./i18n.cjs').t;
  const overlay = createComputerOverlay({ ...options, electron, t, post: message => worker.postMessage(message) });
  worker.on('message', message => { overlay.handleMessage(message); });
  worker.once('exit', () => overlay.hideAll());
  return overlay;
}

module.exports = { createComputerOverlay, attachComputerOverlay, cutTitle, TIMING };
