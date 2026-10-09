// 右パネル「Chrome の窓」（docs/inapp-browser.md「リモートから見る」、ADR 0148「右パネルは見るだけの映像」）。
// 会話の専用の Chrome の窓（エージェントが操作する、画面の外の見えない窓）の「今のタブ」の映像を、WS の screencast（source: 'chrome'）で受けて映す。
// 見るだけ: 映像に押す・打つと「見るだけ · 操作は引き継いでから」を出すだけで、何も送らない（タッチでは常に出す）。
// 端末から操作する（第 7 段。setOperating(true)。リモートの端末で by: 'device' の一時停止の間だけ）: タップ・ドラッグのスクロール・ホイール・文字・少数のキーを
// browserScreencastInput（source: 'chrome'）で送る（座標の変換は web/remote-browser.mjs と同じ）。文字の欄と「パスワード管理・パスキーは使えない」の添え書きを出す。
// ページの大きさは measure() が返す映像の箱の大きさ（「この端末で操作する」がサーバーへ渡し、Emulation.setDeviceMetricsOverride で合わせる）
// 右パネルの枠は web/file-preview.mjs の openPanel（git パネルと同じ）。ここは中身だけを作る。
//   - 状態の一行の差し込み口（.cp-slot）: web/chrome-control.mjs が mountStatus で差し込む（「Claude が操作中」「止める」「引き継ぐ」など）。空の間は場所を取らない。
//     映像の上の層（押した位置の輪）は mountOverlay で映像の箱へ重ねる。輪の位置に要る映像の元の大きさは frameSize（フレームの metadata）
//   - 映像: 名前は「{{name}} の Chrome の窓の映像（見るだけ）」。撮影を断っている間（state.suspended）は薄い幕
//   - 見るウィンドウ: 2 つ以上あるときだけ、映像の上に番号のチップの列（web/chrome-window-switch.mjs）。押すとそのウィンドウを固定する（会話に 1 つ。サーバーの chromePinWindow）。
//     固定の間は映像の左上に印。エージェントが別のウィンドウへ移っても映像は動かず、そのチップの印だけが移る。「エージェントを追う」で固定を外す
//     見ているウィンドウが閉じたら、映像を薄くして約 1 秒おいてから追う側へ戻る。引き継ぎ中は切り替えない
//   - 映像の描画と ack は web/screencast-frame.mjs（内蔵ブラウザーを見る全面の表示と共有）
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { notify } from './file-actions.mjs';
import { createFrameSink } from './screencast-frame.mjs';
import { containRect, toPageCoords, toPageDelta } from './remote-browser.mjs';
import { childWindowItems } from './task-chrome.mjs';
import { createWindowSwitch, createCloseDialog, pinIcon } from './chrome-window-switch.mjs';

const KEY = 'chrome-window';
const HINT_MS = 2600;
/** 表示の箱がこれ以上（CSS px）変わったら、映像の大きさを取り直す */
const RESIZE_STEP = 24;
const TAP_SLOP = 10;   // これより動いたらスクロール（web/remote-browser.mjs と同じ）
const SCROLL_MS = 60;
/** 見るウィンドウを替えるときの溶かす長さ（--dur と同じ）と、見ているウィンドウが閉じたあと追う側へ戻るまで */
const FADE_MS = 240;
const HOLD_MS = 1000;
/** 端末から操作するときにページへ送るキー（core/chrome/input.mjs の KEYS のうち、欄の外で打つもの。Tab・Escape は画面の移動に残す） */
const SEND_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);

/** 会話の Chrome の窓の知らせ（サーバーの chromeWindow イベント）を会話ごとに覚える。入口の表示と弧が読む */
export function createWindowTable() {
  const rows = new Map();   // sessionId -> { windows, operating, windowIds, currentWindowId, pinnedWindowId, numbers, counter }
  return {
    /** イベントを当てる。変わったら true */
    apply(ev) {
      const id = ev?.sessionId;
      if (typeof id !== 'string' || !id) return false;
      const before = rows.get(id);
      if (!(ev.windows > 0)) { rows.delete(id); return Boolean(before); }
      const windowIds = Array.isArray(ev.windowIds) ? ev.windowIds.filter(Number.isSafeInteger) : [];
      // ウィンドウの番号は、見え始めた順に付けて変えない（途中のウィンドウが閉じても、残りの番号は動かない）。全部閉じたら 1 から
      const numbers = new Map(before?.numbers ?? []);
      let counter = before?.counter ?? 0;
      for (const windowId of windowIds) if (!numbers.has(windowId)) numbers.set(windowId, ++counter);
      for (const windowId of [...numbers.keys()]) if (!windowIds.includes(windowId)) numbers.delete(windowId);
      const next = { windows: Number(ev.windows), operating: ev.operating === true, windowIds,
        currentWindowId: Number.isSafeInteger(ev.currentWindowId) ? ev.currentWindowId : null,
        pinnedWindowId: Number.isSafeInteger(ev.pinnedWindowId) && windowIds.includes(ev.pinnedWindowId) ? ev.pinnedWindowId : null,
        numbers, counter };
      rows.set(id, next);
      return !before || before.windows !== next.windows || before.operating !== next.operating ||
        before.currentWindowId !== next.currentWindowId || before.pinnedWindowId !== next.pinnedWindowId || before.windowIds.join(',') !== next.windowIds.join(',');
    },
    has: id => (rows.get(id)?.windows ?? 0) > 0,
    count: id => rows.get(id)?.windows ?? 0,
    /** ウィンドウの並び（windowId は Chrome のウィンドウの id。知らされていなければ null）。current は今エージェントが操作するウィンドウ */
    list(id) {
      const row = rows.get(id);
      if (!row) return [];
      const ids = row.windowIds.length ? row.windowIds : Array.from({ length: row.windows }, () => null);
      return ids.map((windowId, index) => ({ number: windowId === null ? index + 1 : row.numbers.get(windowId) ?? index + 1, windowId,
        current: windowId !== null && windowId === row.currentWindowId, pinned: windowId !== null && windowId === row.pinnedWindowId }));
    },
    ids: id => rows.get(id)?.windowIds ?? [],
    /** エージェントが今操作するウィンドウ（なければ null） */
    current: id => rows.get(id)?.currentWindowId ?? null,
    /** 人が固定しているウィンドウ（なければ null） */
    pinned: id => rows.get(id)?.pinnedWindowId ?? null,
    numberOf: (id, windowId) => rows.get(id)?.numbers.get(windowId) ?? null,
    operating: id => rows.get(id)?.operating === true,
    clear() { rows.clear(); },
  };
}

/**
 * @param cmd       WS のコマンド
 * @param preview   web/file-preview.mjs の返り値（openPanel・close・panelOpen）
 * @param session   今の会話の id
 * @param children  () → browser.chromeWindows の行（この会話と直接の子の窓）。⋯ の一覧に子の窓の行を足す
 * @param openChild (子の会話の id) → 子の会話を開いて、その Chrome の窓を見る
 * @param getAgentName エージェントの名前（映像の名前に入れる）
 * @param paused    (会話の id) → 引き継ぎ中か。引き継ぎ中はウィンドウを切り替えられない
 */
export function setupChromePanel({ cmd, preview, browser = null, showMenu = null, session = () => null, getAgentName = () => 'Claude', windows = createWindowTable(), touch = null, closeRisk = () => null, paused = () => false, children = () => [], openChild = () => {} } = {}) {
  let root = null, parts = null, sessionId = null, state = null, frameMeta = null, quality = 'auto', ended = false, connecting = false, hintTimer = 0, observer = null, lastBox = null, resizeTimer = 0;
  let opener = null, openListeners = new Set(), notifyOpenChange = open => { for (const fn of openListeners) { try { fn(open); } catch {} } }, operating = false, waiting = null, closing = false, optimistic = null, hold = null, holdTimer = 0, fadeTimer = 0, fadePending = false, lastShown, lastAgent, switchSig = '';   // optimistic: 押した直後（サーバーの知らせの前）の固定。hold: 閉じたウィンドウを薄くして残している間。waiting: ⋯「Chrome で開く」で、窓ができるのを待っている会話と字
  const alwaysHint = touch ?? (() => { try { return matchMedia('(hover: none), (pointer: coarse)').matches; } catch { return false; } });

  function build() {
    const slot = el('div', 'cp-slot'); slot.dataset.slot = 'status';
    const veil = el('div', 'cp-veil'); veil.hidden = true;
    const veilText = el('span', 'cp-veil-text'); veil.append(veilText);
    const img = el('img', 'cp-frame'); img.alt = ''; img.draggable = false;
    const hint = el('div', 'cp-hint'); hint.setAttribute('role', 'status');
    const ghost = el('img', 'cp-ghost'); ghost.alt = ''; ghost.draggable = false; ghost.setAttribute('aria-hidden', 'true');   // ウィンドウを替える間、前の絵を重ねて溶かす
    const pinMark = el('span', 'cp-pin'); pinMark.setAttribute('role', 'img'); pinMark.setAttribute('aria-label', t('browser.chromeWindow.pinned')); pinMark.title = t('browser.chromeWindow.pinned'); pinMark.append(pinIcon());
    const screen = el('div', 'cp-screen'); screen.tabIndex = 0; screen.setAttribute('role', 'img');
    screen.append(img, ghost, pinMark, veil, hint);
    const switcher = createWindowSwitch({ t, getName: () => nameOf(), onPick: pick, onFollow: () => followAgent() });
    const dialog = createCloseDialog({ t });
    const empty = el('div', 'cp-empty'); empty.hidden = true;
    const foot = el('div', 'cp-foot weak small');
    const status = el('span', 'cp-fps');
    switcher.follow.onclick = () => followAgent();
    foot.append(status);
    // 第 10 段のプロフィール pill をここへ差し込む。空の間は幅を取らない。
    const profileSlot = el('div', 'cp-profile-slot'); profileSlot.dataset.slot = 'chrome-profile';
    const windowMenu = el('button', 'btn btn-icon cp-window-menu', '⋯'); windowMenu.type = 'button';
    windowMenu.setAttribute('aria-label', t('browser.chromeWindow.windowActions'));
    windowMenu.title = t('browser.chromeWindow.windowActions');
    windowMenu.setAttribute('aria-haspopup', 'menu');
    windowMenu.onclick = () => {
      const r = windowMenu.getBoundingClientRect();
      const items = [];
      // 委譲の子の窓（browser.chromeWindows）。子の窓の映像は子の会話で見るので、押すとその会話を開く
      const kids = childWindowItems(children(), { open: openChild, t });
      if (kids.length) items.push(...kids, { sep: true });
      // 映像に映っているウィンドウ（固定していればそれ）を、いつも確かめてから閉じる
      items.push({ label: t('browser.chromeWindow.closeShown'), disabled: !windows.list(sessionId).length || closing, onClick: () => askClose(windowMenu) });
      showMenu?.(r.left, r.bottom + 4, items, t('browser.chromeWindow.windowActions'));
    };
    // 端末から操作する間の文字の欄と添え書き
    const text = el('div', 'cp-text'); text.hidden = true;
    const textInput = el('input'); textInput.setAttribute('aria-label', t('browser.remote.textLabel')); textInput.placeholder = t('browser.remote.textPlaceholder');
    textInput.setAttribute('enterkeyhint', 'send');
    const textSend = el('button', 'btn', t('browser.remote.textSend')); textSend.type = 'button';
    text.append(textInput, textSend);
    const note = el('p', 'cp-note weak small', t('browser.chromeWindow.deviceNote')); note.hidden = true;
    const node = el('div', 'cp');
    node.append(switcher.root, screen, empty, text, note, foot, dialog.root);
    const sink = createFrameSink({ img, onAck: seq => { if (sessionId) cmd('browserScreencastAck', { sessionId, source: 'chrome', seq }).catch(() => {}); } });
    const fit = metadata => {
      // 映像の箱を窓の縦横比に合わせる（余白のない映像にする）。最初のフレームと、窓の形が変わったときだけ
      const w = Number(metadata?.deviceWidth), h = Number(metadata?.deviceHeight);
      if (w > 0 && h > 0) { const ratio = `${Math.round(w)} / ${Math.round(h)}`; if (screen.style.aspectRatio !== ratio) screen.style.aspectRatio = ratio; }
    };

    // 見るだけ: 押す・打つ（タッチでは常に）で案内を出す。何も送らない。端末から操作する間は、ページへ送る
    let down = null, lastScroll = 0, pendingDx = 0, pendingDy = 0, at = null;
    const rect = () => containRect(img.getBoundingClientRect(), { width: img.naturalWidth, height: img.naturalHeight });
    const flushScroll = () => {
      if (!at || (!pendingDx && !pendingDy)) return;
      const r = rect();
      const dx = toPageDelta(pendingDx, r, sink.frame?.metadata), dy = toPageDelta(pendingDy, r, sink.frame?.metadata);
      pendingDx = pendingDy = 0; lastScroll = performance.now();
      send({ type: 'scroll', x: at.x, y: at.y, dx, dy });
    };
    screen.addEventListener('pointerdown', event => {
      if (!operating) { if (event.pointerType === 'touch') parts.touched = true; showHint(); return; }
      if (!sink.frame || event.button > 0) return;
      down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, id: event.pointerId };
      try { screen.setPointerCapture(event.pointerId); } catch {}
    });
    screen.addEventListener('pointermove', event => {
      if (!operating || !down || event.pointerId !== down.id) return;
      if (!down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < TAP_SLOP) return;
      if (!down.moved) { down.moved = true; at = toPageCoords(down, rect(), sink.frame?.metadata) ?? { x: 0, y: 0 }; }
      // 指を上へ動かすとページは下へ（端末の触り方と同じ向き）
      pendingDx += down.lastX - event.clientX; pendingDy += down.lastY - event.clientY;
      down.lastX = event.clientX; down.lastY = event.clientY;
      if (performance.now() - lastScroll > SCROLL_MS) flushScroll();
    });
    const finish = event => {
      if (!down || event.pointerId !== down.id) return;
      const was = down; down = null;
      if (!operating) return;
      if (was.moved) { flushScroll(); return; }
      if (event.type === 'pointercancel') return;
      const point = toPageCoords({ x: event.clientX, y: event.clientY }, rect(), sink.frame?.metadata);
      if (point) send({ type: 'tap', ...point });
    };
    screen.addEventListener('pointerup', finish);
    screen.addEventListener('pointercancel', finish);
    screen.addEventListener('wheel', event => {
      if (!operating) { showHint(); return; }
      if (!sink.frame) return;
      event.preventDefault();
      const point = toPageCoords({ x: event.clientX, y: event.clientY }, rect(), sink.frame.metadata);
      if (!point) return;
      at = point; pendingDx += event.deltaX; pendingDy += event.deltaY;
      if (performance.now() - lastScroll > SCROLL_MS) flushScroll();
    }, { passive: false });
    screen.addEventListener('keydown', event => {
      if (event.key === 'Tab' || event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!operating) { showHint(); return; }
      if (event.isComposing) return;
      if (SEND_KEYS.has(event.key)) { event.preventDefault(); send({ type: 'key', key: event.key }); }
      else if (event.key.length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }); }
    });
    const sendText = withEnter => {
      const value = textInput.value;
      textInput.value = '';
      if (value) send({ type: 'text', text: value });
      if (withEnter) send({ type: 'key', key: 'Enter' });
    };
    textSend.onclick = () => sendText(false);
    textInput.addEventListener('keydown', event => {
      if (event.isComposing) return;
      // 空の欄の Backspace はページの 1 文字を消す。Enter は入力してから Enter を送る
      if (event.key === 'Enter') { event.preventDefault(); sendText(true); }
      else if (event.key === 'Backspace' && !textInput.value) { event.preventDefault(); send({ type: 'key', key: 'Backspace' }); }
    });
    return { node, slot, profileSlot, windowMenu, screen, img, ghost, pinMark, switcher, dialog, veil, veilText, hint, empty, text, textInput, note, foot, status, sink, fit, touched: false };
  }

  const nameOf = () => getAgentName() || 'Claude';
  /** 端末から操作する間の入力を送る（順を保つため、前の送信の後に送る）。断られたら（戻した・ほかで引き継いだ）知らせる */
  let sending = Promise.resolve();
  function send(input) {
    const id = sessionId;
    if (!operating || !id || ended) return;
    sending = sending.then(() => cmd('browserScreencastInput', { sessionId: id, source: 'chrome', input })).catch(error => {
      if (operating && id === sessionId) notify(error?.message || t('browser.chromeWindow.inputFailed'));
    });
  }
  const isOpen = () => preview.panelOpen(KEY);

  // ---- 見るウィンドウ ----
  /** 固定しているウィンドウ（押した直後は、サーバーの知らせを待たず押した方）。なければ null */
  function pinnedNow() {
    const ids = windows.ids(sessionId);
    const pin = optimistic?.sessionId === sessionId ? optimistic.windowId : windows.pinned(sessionId);
    return pin != null && ids.includes(pin) ? pin : null;
  }
  /** 映像に映っているウィンドウ。閉じたウィンドウを薄くして残している間は、それ */
  function shownNow() {
    if (hold) return hold.windowId;
    return pinnedNow() ?? windows.current(sessionId) ?? windows.ids(sessionId)[0] ?? null;
  }
  const switchDisabled = () => operating || paused(sessionId) === true;

  function pick(windowId) {
    const id = sessionId;
    if (!id || !Number.isSafeInteger(windowId) || switchDisabled() || hold || !windows.ids(id).includes(windowId)) return;
    sendPin(id, windowId);
  }
  /** 「エージェントを追う」。追っている間に押すと、今映っているウィンドウを固定する（承認済みのモックと同じ） */
  function followAgent() {
    const id = sessionId;
    if (!id || switchDisabled() || hold) return;
    if (pinnedNow() != null) { sendPin(id, null); parts?.switcher.flashFollow(); }
    else { const shown = shownNow(); if (shown != null) sendPin(id, shown); }
  }
  function sendPin(id, windowId) {
    optimistic = { sessionId: id, windowId };
    paint();
    cmd('chromePinWindow', { sessionId: id, windowId })
      .catch(error => notify(error?.message || t('browser.chromeWindow.pinFailed')))
      .finally(() => { if (optimistic?.sessionId === id && optimistic.windowId === windowId) { optimistic = null; if (sessionId === id) paint(); } });
  }

  /** 前の絵を重ね、新しい絵が来たら溶かして消す（動きを減らす設定では CSS が出し入れだけにする） */
  function startFade() {
    if (!parts?.img.getAttribute?.('src')) return;
    parts.ghost.setAttribute('src', parts.img.getAttribute('src'));
    parts.ghost.classList.remove('out'); parts.ghost.dataset.on = '';
    fadePending = true;
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(endFade, 1500);
  }
  function fadeOutGhost() {
    if (!fadePending || !parts) return;
    fadePending = false;
    parts.ghost.classList.add('out');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(endFade, FADE_MS + 40);
  }
  function endFade() {
    clearTimeout(fadeTimer); fadePending = false;
    if (!parts) return;
    parts.ghost.removeAttribute('src'); parts.ghost.classList.remove('out'); delete parts.ghost.dataset.on;
  }

  /** 見ているウィンドウが閉じた。映像を薄くして残し、約 1 秒おいてから追う側へ戻る */
  function startHold(windowId, number, index) {
    clearTimeout(holdTimer);
    hold = { windowId, number, index };
    holdTimer = setTimeout(() => { hold = null; if (parts) paint(); }, HOLD_MS);
  }

  /** 閉じる前の確かめ（いつも出す）。映像に映っているウィンドウを閉じる */
  function askClose(trigger) {
    const id = sessionId;
    if (!id || !windows.has(id) || closing || !parts) return;
    const shown = shownNow();
    const rows = windows.list(id);
    const number = shown != null ? windows.numberOf(id, shown) : rows.length === 1 ? rows[0].number : null;
    parts.dialog.ask({ number, many: windows.count(id) > 1, agent: shown != null && shown === windows.current(id), running: windows.operating(id),
      risk: closeRisk(id), trigger, run: () => closeShown(id, shown) });
  }
  async function closeShown(id, windowId) {
    if (closing) return;
    closing = true;
    try {
      const result = await cmd('chromeCloseWindow', windowId != null && windows.count(id) > 1 ? { sessionId: id, windowId } : { sessionId: id });
      if (result?.failed) notify(t('browser.chromeWindow.closeFailed'));
    } catch (error) { notify(error?.message || t('browser.chromeWindow.closeFailed')); }
    finally { closing = false; }
  }

  function paintSwitch() {
    if (!parts) return;
    const id = sessionId;
    const rows = id ? windows.list(id) : [];
    const known = rows.length > 0 && rows.every(row => row.windowId !== null);
    const shown = shownNow(), agentId = id ? windows.current(id) : null, pin = id ? pinnedNow() : null;
    const items = known ? rows.map(row => ({ windowId: row.windowId, number: row.number, selected: row.windowId === shown, agent: row.windowId === agentId, ghost: false })) : [];
    if (known && hold) items.splice(Math.min(hold.index, items.length), 0, { windowId: hold.windowId, number: hold.number, selected: true, agent: false, ghost: true });
    const running = id ? windows.operating(id) : false;
    // 映像が替わるとき（見るウィンドウが変わった）は前の絵を重ねて溶かす。最初の描画・閉じたウィンドウの保持中は溶かさない
    if (lastShown !== undefined && shown !== lastShown && lastShown != null && shown != null && parts.sink.frame) startFade();
    lastShown = shown;
    // エージェントが別のウィンドウへ移ったら、そのチップの印が移って 1 回光る（固定している間も映像は動かない）
    const flashId = lastAgent !== undefined && agentId !== lastAgent && agentId != null ? agentId : null;
    lastAgent = agentId;
    const args = { items, agentRunning: running, pinned: pin != null, away: pin != null && pin !== agentId, disabled: switchDisabled(), flashId };
    const sig = JSON.stringify([items, args.agentRunning, args.pinned, args.away, args.disabled]);
    if (sig !== switchSig || flashId != null) { switchSig = sig; parts.switcher.paint(args); }
    parts.screen.toggleAttribute('data-pinned', pin != null);
  }

  function showHint() {
    if (!parts || operating) return;
    clearTimeout(hintTimer);
    parts.hint.textContent = t('browser.chromeWindow.viewOnly');
    parts.hint.dataset.shown = '';
    if (!pinned()) hintTimer = setTimeout(hideHint, HINT_MS);
  }
  function hideHint() { if (!parts || pinned()) return; delete parts.hint.dataset.shown; parts.hint.textContent = ''; }
  const pinned = () => parts?.touched || alwaysHint();
  /** タッチでは常に出す。それ以外は押したときだけ（フレームのたびの描き直しで、出している案内を消さない） */
  function paintHint() {
    if (operating && parts) { clearTimeout(hintTimer); delete parts.hint.dataset.shown; parts.hint.textContent = ''; return; }
    if (!parts || !pinned()) return;
    parts.hint.textContent = t('browser.chromeWindow.viewOnly'); parts.hint.dataset.shown = '';
  }

  function paint() {
    if (!parts) return;
    const name = nameOf();
    parts.screen.setAttribute('aria-label', operating ? t('browser.chromeWindow.screenOperating', { name }) : t('browser.chromeWindow.screen', { name }));
    parts.screen.toggleAttribute('data-operating', operating);
    parts.text.hidden = !operating; parts.note.hidden = !operating;
    parts.veil.hidden = !state?.suspended || ended;
    parts.veilText.textContent = t('browser.chromeWindow.suspended');
    parts.screen.classList.toggle('ended', ended || hold !== null);
    const noWindow = !windows.has(sessionId) && !connecting;
    parts.screen.hidden = noWindow; parts.empty.hidden = !noWindow;
    parts.empty.textContent = waiting?.sessionId === sessionId ? waiting.text : t('browser.chromeWindow.none');
    if (ended) parts.status.textContent = t('browser.chromeWindow.ended');
    else if (!parts.sink.frame) parts.status.textContent = connecting || windows.has(sessionId) ? t('browser.chromeWindow.connecting') : '';
    else parts.status.textContent = state?.suspended ? '' : t('browser.chromeWindow.fps', { fps: parts.sink.fps() });
    paintHint();
    paintSwitch();
  }

  async function start() {
    if (!sessionId) return;
    const box = parts.screen.getBoundingClientRect();
    lastBox = { width: box.width, height: box.height };
    connecting = true;
    // 映像の高さは窓の形で決まる（箱は映像の縦横比に合わせる）ので、高さで縛らないよう、画面の高さまで許す
    const result = await cmd('browserScreencast', {
      sessionId, source: 'chrome', quality,
      width: Math.round(box.width) || 480, height: Math.max(Math.round(box.height), Math.round(window.innerHeight * 0.9)) || 320,
      scale: window.devicePixelRatio || 1,
    });
    connecting = false; ended = false;
    if (result?.state) state = result.state;
    paint();
  }

  function watchSize() {
    observer?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      if (!isOpen() || !sessionId || !lastBox) return;
      const box = parts.screen.getBoundingClientRect();
      if (Math.abs(box.width - lastBox.width) < RESIZE_STEP && Math.abs(box.height - lastBox.height) < RESIZE_STEP) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (isOpen() && !ended) start().catch(() => { connecting = false; }); }, 350);
    });
    observer.observe(parts.screen);
  }

  function stopWatching() {
    waiting = null;
    observer?.disconnect(); observer = null;
    clearTimeout(resizeTimer); clearTimeout(hintTimer); clearTimeout(holdTimer);
    hold = null; optimistic = null; lastShown = undefined; lastAgent = undefined; switchSig = '';
    endFade(); parts?.dialog.dismiss(false);
    if (sessionId) cmd('browserScreencastStop', { sessionId, source: 'chrome' }).catch(() => {});
    sessionId = null; state = null; frameMeta = null; ended = false; connecting = false; lastBox = null;
    parts?.sink.reset();
  }

  function show(id, element) {
    if (!parts) { parts = build(); root = parts.node; }
    if (sessionId && sessionId !== id) stopWatching();
    sessionId = id; state = null; frameMeta = null; ended = false;
    hold = null; optimistic = null; lastShown = undefined; lastAgent = undefined; switchSig = '';
    clearTimeout(holdTimer); endFade();
    parts.sink.reset();
    opener = element;
    const label = t('browser.chromeWindow.panel');
    preview.openPanel({ key: KEY, title: label, subtitle: '', label, element, body: root, wide: true,
      toolbar: [parts.slot, parts.profileSlot, parts.windowMenu],
      onClose: () => { stopWatching(); opener?.setAttribute?.('aria-expanded', 'false'); notifyOpenChange(false); } });
    notifyOpenChange(true);
  }

  function open(element = null) {
    const id = session();
    if (!id || (!browser && !windows.has(id))) return;
    // 同じ会話の映像をもう見ているなら（選んでいるタブをもう一度押した）、映像を最初からにしない
    if (isOpen() && sessionId === id && !ended && (connecting || parts?.sink.frame)) return;
    show(id, element);
    connecting = windows.has(id);   // 窓がまだ無いなら接続中にしない（窓ができたら windowEvent が見始める）
    paint();
    if (connecting) watch(id);
  }

  /** 映像を受け始める（パネルを開いた次の描画で、箱の大きさが決まってから） */
  function watch(id) {
    requestAnimationFrame(() => {
      if (!isOpen() || sessionId !== id) return;
      watchSize();
      start().catch(error => {
        connecting = false;
        if (error?.code === 'no-window') { paint(); return; }
        notify(error?.message || t('browser.chromeWindow.failed'));
        close();
      });
    });
  }

  /**
   * ⋯「Chrome で開く」: 窓がまだ無い（Chrome の許可を待つ・開いている途中）会話でもパネルを開き、text を出しておく。
   * 窓ができた（chromeWindow イベント）ら映像に切り替える。窓があればそのまま開く
   */
  function openWaiting(text, element = null) {
    const id = session();
    if (!id) return;
    if (windows.has(id)) { open(element); return; }
    show(id, element);
    waiting = { sessionId: id, text };
    connecting = false;
    paint();
  }

  function close() { if (isOpen()) preview.close(true); }
  function toggle(element) { if (isOpen()) close(); else open(element); }

  return {
    open, toggle, close, isOpen, openWaiting,
    /** ⋯「Chrome で開く」が失敗した。待っていたパネルは閉じる */
    cancelWaiting() { if (waiting && isOpen() && waiting.sessionId === sessionId) close(); waiting = null; },
    /** 状態の一行を差し込む口。第 6 段が自分の部品（role=status の一行とボタン）を渡す。null で空に戻す */
    mountStatus(node) {
      if (!parts) { parts = build(); root = parts.node; }
      parts.slot.replaceChildren(...(node ? [node] : []));
    },
    /** 映像の上に重ねる層（web/chrome-control.mjs の overlay）。映像の箱（position: relative）の中へ置く。null で外す */
    mountOverlay(node) {
      if (!parts) { parts = build(); root = parts.node; }
      parts.screen.querySelector('[data-slot="overlay"]')?.remove();
      if (node) { node.dataset.slot = 'overlay'; parts.screen.append(node); }
    },
    /** 映像の元のページの大きさ（CSS 画素。最後のフレームの metadata）。まだ無ければ null */
    frameSize() {
      const width = Number(frameMeta?.deviceWidth), height = Number(frameMeta?.deviceHeight);
      return width > 0 && height > 0 ? { width, height } : null;
    },
    get statusSlot() { if (!parts) { parts = build(); root = parts.node; } return parts.slot; },
    /** 第 10 段がプロフィール pill を差し込む口。Chrome のタブの道具の列に置く */
    get profileSlot() { if (!parts) { parts = build(); root = parts.node; } return parts.profileSlot; },
    windows,
    /** サーバーの chromeWindow イベント。表示中の会話の窓が無くなったら閉じた表示にする */
    windowEvent(ev) {
      const watching = isOpen() && ev?.sessionId === sessionId && Boolean(parts);
      const before = watching ? { shown: shownNow(), ids: windows.ids(sessionId), number: windows.numberOf(sessionId, shownNow()) } : null;
      const changed = windows.apply(ev);
      if (watching && ev.windows > 0) {
        const ids = windows.ids(sessionId);
        if (optimistic?.windowId != null && !ids.includes(optimistic.windowId)) optimistic = null;
        // 見ていたウィンドウが閉じた: 映像を薄くして残し、約 1 秒おいて追う側へ戻る
        if (!hold && before.shown != null && before.ids.includes(before.shown) && ids.length && !ids.includes(before.shown) && parts.sink.frame) {
          startHold(before.shown, before.number, before.ids.indexOf(before.shown));
        }
      }
      if (watching && changed) paint();
      if (changed && isOpen() && ev.sessionId === sessionId && !(ev.windows > 0)) {
        // ビューアの無い端末では、窓が無くなると入口のボタンも消えて開き直せない。パネルだけ残さず閉じる
        if (!browser) close(); else { ended = true; paint(); }
      }
      else if (isOpen() && ev.sessionId === sessionId && ev.windows > 0 && (ended || !parts?.sink.frame) && !connecting) {
        // 窓ができた（最初の窓・閉じた後の新しい窓）。残っている古いフレームを捨てて見直す
        waiting = null; ended = false; connecting = true; parts?.sink.reset(); frameMeta = null; paint(); watch(sessionId);
      }
      return changed;
    },
    /** WS の screencast メッセージ（source: 'chrome'）。ほかは無視 */
    onMessage(message) {
      if (message.source !== 'chrome' || !isOpen() || message.sessionId !== sessionId) return;
      if (message.type === 'frame' && typeof message.data === 'string' && hold) {
        // 閉じたウィンドウを薄く残している間は、新しい絵を映さない（届いたことだけ返して、次を止めない）
        cmd('browserScreencastAck', { sessionId, source: 'chrome', seq: message.seq }).catch(() => {});
      }
      else if (message.type === 'frame' && typeof message.data === 'string') { fadeOutGhost(); frameMeta = message.metadata ?? null; parts.fit(message.metadata); parts.sink.push(message); ended = false; connecting = false; paint(); }
      else if (message.type === 'state') { state = message.state; paint(); }
      else if (message.type === 'ended') { ended = true; paint(); }
    },
    /**
     * 「この端末で操作する」: パネルを開き（開けなければ null）、映像の箱の大きさ（CSS px と倍率）を返す。
     * ページの大きさはこの箱にする（高さは窓の形で箱が決まるので、画面の高さから取る）
     */
    async measure(element = null) {
      if (!isOpen()) open(element);
      if (!isOpen() || !parts) return null;
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const box = parts.screen.getBoundingClientRect();
      const width = Math.round(box.width) || 390;
      return { width, height: Math.max(240, Math.round(window.innerHeight * 0.7)), scale: window.devicePixelRatio || 1 };
    },
    /** 端末から操作する（by: 'device' の一時停止で、この端末がリモート）間だけ true。入力を送り、文字の欄と添え書きを出す */
    setOperating(on) {
      const next = Boolean(on);
      if (next === operating) return;
      operating = next;
      if (!parts) return;
      if (!operating) parts.textInput.value = '';
      paint();
    },
    get operating() { return operating; },
    /** 引き継ぎの状態など、外の状態が変わった。描き直す */
    refresh() { if (parts && isOpen()) paint(); },
    /** 接続し直したら見続ける（サーバーは接続が切れた端末を外している） */
    reconnected() { if (isOpen() && sessionId) start().catch(() => { ended = true; paint(); }); },
    /** 別の会話へ移った・会話を閉じた。開いているパネルは閉じる */
    reset() { if (isOpen() && session() !== sessionId) close(); },
    onOpenChange(fn) { if (typeof fn === 'function') openListeners.add(fn); },
    /** テスト用 */
    get sessionId() { return sessionId; },
  };
}
