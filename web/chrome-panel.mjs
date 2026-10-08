// 右パネル「Chrome の窓」（docs/inapp-browser.md「リモートから見る」、ADR 0148「右パネルは見るだけの映像」）。
// 会話の専用の Chrome の窓（エージェントが操作する、画面の外の見えない窓）の「今のタブ」の映像を、WS の screencast（source: 'chrome'）で受けて映す。
// 見るだけ: 映像に押す・打つと「見るだけ · 操作は引き継いでから」を出すだけで、何も送らない（タッチでは常に出す）。
// 右パネルの枠は web/file-preview.mjs の openPanel（git パネルと同じ）。ここは中身だけを作る。
//   - 状態の一行の差し込み口（.cp-slot）: web/chrome-control.mjs が mountStatus で差し込む（「Claude が操作中」「止める」「引き継ぐ」など）。空の間は場所を取らない。
//     映像の上の層（押した位置の輪）は mountOverlay で映像の箱へ重ねる。輪の位置に要る映像の元の大きさは frameSize（フレームの metadata）
//   - 映像: 名前は「{{name}} の Chrome の窓の映像（見るだけ）」。撮影を断っている間（state.suspended）は薄い幕
//   - 映像の描画と ack は web/screencast-frame.mjs（内蔵ブラウザーを見る全面の表示と共有）
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { notify } from './file-actions.mjs';
import { createFrameSink } from './screencast-frame.mjs';

const KEY = 'chrome-window';
const HINT_MS = 2600;
/** 表示の箱がこれ以上（CSS px）変わったら、映像の大きさを取り直す */
const RESIZE_STEP = 24;

/** 会話の Chrome の窓の知らせ（サーバーの chromeWindow イベント）を会話ごとに覚える。入口の表示と弧が読む */
export function createWindowTable() {
  const rows = new Map();   // sessionId -> { windows, operating }
  return {
    /** イベントを当てる。変わったら true */
    apply(ev) {
      const id = ev?.sessionId;
      if (typeof id !== 'string' || !id) return false;
      const before = rows.get(id);
      if (!(ev.windows > 0)) { rows.delete(id); return Boolean(before); }
      const next = { windows: Number(ev.windows), operating: ev.operating === true };
      rows.set(id, next);
      return !before || before.windows !== next.windows || before.operating !== next.operating;
    },
    has: id => (rows.get(id)?.windows ?? 0) > 0,
    operating: id => rows.get(id)?.operating === true,
    clear() { rows.clear(); },
  };
}

/**
 * @param cmd       WS のコマンド
 * @param preview   web/file-preview.mjs の返り値（openPanel・close・panelOpen）
 * @param session   今の会話の id
 * @param getAgentName エージェントの名前（映像の名前に入れる）
 */
export function setupChromePanel({ cmd, preview, session = () => null, getAgentName = () => 'Claude', windows = createWindowTable(), touch = null } = {}) {
  let root = null, parts = null, sessionId = null, state = null, frameMeta = null, quality = 'auto', ended = false, connecting = false, hintTimer = 0, observer = null, lastBox = null, resizeTimer = 0;
  let opener = null, onOpenChange = () => {};
  const alwaysHint = touch ?? (() => { try { return matchMedia('(hover: none), (pointer: coarse)').matches; } catch { return false; } });

  function build() {
    const slot = el('div', 'cp-slot'); slot.dataset.slot = 'status';
    const veil = el('div', 'cp-veil'); veil.hidden = true;
    const veilText = el('span', 'cp-veil-text'); veil.append(veilText);
    const img = el('img', 'cp-frame'); img.alt = ''; img.draggable = false;
    const hint = el('div', 'cp-hint'); hint.setAttribute('role', 'status');
    const screen = el('div', 'cp-screen'); screen.tabIndex = 0; screen.setAttribute('role', 'img');
    screen.append(img, veil, hint);
    const empty = el('div', 'cp-empty'); empty.hidden = true;
    const foot = el('div', 'cp-foot weak small');
    const status = el('span', 'cp-fps');
    foot.append(status);
    const node = el('div', 'cp');
    node.append(slot, screen, empty, foot);
    const sink = createFrameSink({ img, onAck: seq => { if (sessionId) cmd('browserScreencastAck', { sessionId, source: 'chrome', seq }).catch(() => {}); } });
    const fit = metadata => {
      // 映像の箱を窓の縦横比に合わせる（余白のない映像にする）。最初のフレームと、窓の形が変わったときだけ
      const w = Number(metadata?.deviceWidth), h = Number(metadata?.deviceHeight);
      if (w > 0 && h > 0) { const ratio = `${Math.round(w)} / ${Math.round(h)}`; if (screen.style.aspectRatio !== ratio) screen.style.aspectRatio = ratio; }
    };

    // 見るだけ: 押す・打つ（タッチでは常に）で案内を出す。何も送らない
    screen.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') parts.touched = true; showHint(); });
    screen.addEventListener('wheel', () => showHint(), { passive: true });
    screen.addEventListener('keydown', event => { if (event.key === 'Tab' || event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return; showHint(); });
    return { node, slot, screen, img, veil, veilText, hint, empty, foot, status, sink, fit, touched: false };
  }

  const nameOf = () => getAgentName() || 'Claude';
  const isOpen = () => preview.panelOpen(KEY);

  function showHint() {
    if (!parts) return;
    clearTimeout(hintTimer);
    parts.hint.textContent = t('browser.chromeWindow.viewOnly');
    parts.hint.dataset.shown = '';
    if (!pinned()) hintTimer = setTimeout(hideHint, HINT_MS);
  }
  function hideHint() { if (!parts || pinned()) return; delete parts.hint.dataset.shown; parts.hint.textContent = ''; }
  const pinned = () => parts?.touched || alwaysHint();
  /** タッチでは常に出す。それ以外は押したときだけ（フレームのたびの描き直しで、出している案内を消さない） */
  function paintHint() {
    if (!parts || !pinned()) return;
    parts.hint.textContent = t('browser.chromeWindow.viewOnly'); parts.hint.dataset.shown = '';
  }

  function paint() {
    if (!parts) return;
    const name = nameOf();
    parts.screen.setAttribute('aria-label', t('browser.chromeWindow.screen', { name }));
    parts.veil.hidden = !state?.suspended || ended;
    parts.veilText.textContent = t('browser.chromeWindow.suspended');
    parts.screen.classList.toggle('ended', ended);
    const noWindow = !windows.has(sessionId) && !connecting;
    parts.screen.hidden = noWindow; parts.empty.hidden = !noWindow;
    parts.empty.textContent = t('browser.chromeWindow.none');
    if (ended) parts.status.textContent = t('browser.chromeWindow.ended');
    else if (!parts.sink.frame) parts.status.textContent = connecting || windows.has(sessionId) ? t('browser.chromeWindow.connecting') : '';
    else parts.status.textContent = state?.suspended ? '' : t('browser.chromeWindow.fps', { fps: parts.sink.fps() });
    paintHint();
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
    observer?.disconnect(); observer = null;
    clearTimeout(resizeTimer); clearTimeout(hintTimer);
    if (sessionId) cmd('browserScreencastStop', { sessionId, source: 'chrome' }).catch(() => {});
    sessionId = null; state = null; frameMeta = null; ended = false; connecting = false; lastBox = null;
    parts?.sink.reset();
  }

  function open(element = null) {
    const id = session();
    if (!id || !windows.has(id)) return;
    if (!parts) { parts = build(); root = parts.node; }
    if (sessionId && sessionId !== id) stopWatching();
    sessionId = id; state = null; frameMeta = null; ended = false; connecting = true;
    parts.sink.reset();
    opener = element;
    const label = t('browser.chromeWindow.panel');
    preview.openPanel({ key: KEY, title: label, subtitle: '', label, element, body: root, wide: true, onClose: () => { stopWatching(); opener?.setAttribute?.('aria-expanded', 'false'); onOpenChange(false); } });
    onOpenChange(true);
    paint();
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

  function close() { if (isOpen()) preview.close(true); }
  function toggle(element) { if (isOpen()) close(); else open(element); }

  return {
    open, toggle, close, isOpen,
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
    windows,
    /** サーバーの chromeWindow イベント。表示中の会話の窓が無くなったら閉じた表示にする */
    windowEvent(ev) {
      const changed = windows.apply(ev);
      if (changed && isOpen() && ev.sessionId === sessionId && !(ev.windows > 0)) { ended = true; paint(); }
      return changed;
    },
    /** WS の screencast メッセージ（source: 'chrome'）。ほかは無視 */
    onMessage(message) {
      if (message.source !== 'chrome' || !isOpen() || message.sessionId !== sessionId) return;
      if (message.type === 'frame' && typeof message.data === 'string') { frameMeta = message.metadata ?? null; parts.fit(message.metadata); parts.sink.push(message); ended = false; connecting = false; paint(); }
      else if (message.type === 'state') { state = message.state; paint(); }
      else if (message.type === 'ended') { ended = true; paint(); }
    },
    /** 接続し直したら見続ける（サーバーは接続が切れた端末を外している） */
    reconnected() { if (isOpen() && sessionId) start().catch(() => { ended = true; paint(); }); },
    /** 別の会話へ移った・会話を閉じた。開いているパネルは閉じる */
    reset() { if (isOpen() && session() !== sessionId) close(); },
    onOpenChange(fn) { onOpenChange = fn; },
    /** テスト用 */
    get sessionId() { return sessionId; },
  };
}
