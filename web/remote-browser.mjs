// PC のブラウザーを見る全面の表示（docs/inapp-browser.md「リモートから見る」、docs/design-system.md「PC のブラウザーを見る画面」）。
// ホストの内蔵ブラウザーのタブの画面（JPEG）を WS の screencast で受けて描き、タップ・スクロール・文字の入力・少数のキーを送り返す。
// 上にアドレス欄・戻る・再読み込み、下に接続の状態・画質・文字入力。内蔵ブラウザーは人のものなので、入力はいつでも通る。
// ページの大きさは端末の表示の大きさ（ホストがビューポートをこの大きさにする）。座標はフレームの metadata で変換する。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { backIcon } from './icons.mjs';
import { normalizeAddress, addressParts } from './browser-address.mjs';
import { notify } from './file-actions.mjs';
import { createFrameSink, framesPerSecond } from './screencast-frame.mjs';

const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  reload: svg('<path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.3 5.7"/>'),
  stop: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  secure: svg('<path d="M7 11V8a5 5 0 0 1 10 0v3"/><path d="M5 11h14v10H5z"/>'),
  local: svg('<path d="M3 4h18v12H3z"/><path d="M8 20h8M12 16v4"/>'),
  insecure: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/>'),
  file: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/>'),
  blank: svg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>'),
};
const TAP_SLOP = 10;   // これより動いたらスクロール

/** object-fit: contain で箱に収めた画像の、実際に描かれた範囲 */
export function containRect(box, natural) {
  if (!natural.width || !natural.height || !box.width || !box.height) return { left: box.left, top: box.top, width: 0, height: 0 };
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale, height = natural.height * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** 表示上の点（clientX/Y）をページの CSS px へ。画像の外なら null。metadata はフレームの deviceWidth / deviceHeight / offsetTop */
export function toPageCoords(point, rect, metadata) {
  if (!rect.width || !rect.height || !metadata?.deviceWidth || !metadata?.deviceHeight) return null;
  const rx = (point.x - rect.left) / rect.width, ry = (point.y - rect.top) / rect.height;
  if (rx < 0 || ry < 0 || rx > 1 || ry > 1) return null;
  const top = Number(metadata.offsetTop) || 0;
  return { x: Math.round(rx * metadata.deviceWidth), y: Math.round(ry * (metadata.deviceHeight + top) - top) };
}

/** 表示上の移動量（px）をページの CSS px へ */
export function toPageDelta(delta, rect, metadata) {
  if (!rect.width || !metadata?.deviceWidth) return 0;
  return delta * metadata.deviceWidth / rect.width;
}

export { framesPerSecond };

const button = (html, label, className = 'btn btn-icon') => {
  const b = el('button', className); b.type = 'button';
  b.innerHTML = html; b.title = label; b.setAttribute('aria-label', label);
  return b;
};

/**
 * @param cmd WS のコマンド。getSessionId は今の会話。getHostName はホストの名前
 */
export function createRemoteBrowser({ cmd, getSessionId, getHostName = () => '' }) {
  let view = null, sessionId = null, state = null, quality = 'auto', ended = false;

  function build() {
    const root = el('section', 'rb'); root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', t('browser.remote.title'));
    const close = button(backIcon, t('browser.remote.backToChat'));
    const titles = el('div', 'rb-titles');
    const host = el('div', 'rb-host mono');
    titles.append(el('strong', null, t('browser.remote.title')), host);
    const head = el('header', 'rb-head'); head.append(close, titles);

    const back = button(backIcon, t('browser.back'));
    const address = el('button', 'rb-address'); address.type = 'button'; address.title = t('browser.remote.editAddress');
    const mark = el('span', 'rb-address-mark'), shown = el('span', 'rb-address-text');
    address.append(mark, shown);
    const input = el('input', 'rb-address-input'); input.hidden = true;
    input.type = 'url'; input.setAttribute('aria-label', t('browser.remote.address')); input.placeholder = t('browser.addressPlaceholder');
    input.autocapitalize = 'off'; input.spellcheck = false; input.setAttribute('enterkeyhint', 'go');
    const reload = button(ICON.reload, t('browser.reload'));
    const bar = el('div', 'rb-bar'); bar.append(back, address, input, reload);

    const screen = el('div', 'rb-screen'); screen.setAttribute('aria-label', t('browser.remote.screen'));
    const img = el('img', 'rb-frame'); img.alt = ''; img.draggable = false;
    screen.append(img);
    const sink = createFrameSink({ img, onAck: seq => { if (sessionId) cmd('browserScreencastAck', { sessionId, seq }).catch(() => {}); } });

    const status = el('span', 'rb-status weak', t('browser.remote.connecting'));
    const qualityButton = el('button', 'btn rb-tool'); qualityButton.type = 'button';
    const textButton = el('button', 'btn rb-tool', t('browser.remote.textInput')); textButton.type = 'button';
    textButton.setAttribute('aria-expanded', 'false');
    const toolRow = el('div', 'rb-tool-row'); toolRow.append(qualityButton, textButton);
    const tools = el('div', 'rb-tools'); tools.append(status, toolRow);

    const text = el('div', 'rb-text'); text.hidden = true;
    const textInput = el('input'); textInput.setAttribute('aria-label', t('browser.remote.textLabel')); textInput.placeholder = t('browser.remote.textPlaceholder');
    textInput.setAttribute('enterkeyhint', 'send');
    const textSend = el('button', 'btn primary', t('browser.remote.textSend')); textSend.type = 'button';
    text.append(textInput, textSend);

    root.append(head, bar, screen, tools, text);
    document.body.append(root);

    close.onclick = () => closeView();
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!input.hidden) { endAddress(); return; }
      event.preventDefault(); closeView();
    });
    back.onclick = () => nav('back');
    reload.onclick = () => nav(state?.loading ? 'stop' : 'reload');
    address.onclick = () => {
      address.hidden = true; input.hidden = false;
      input.value = state?.url ?? '';
      input.focus(); input.select();
    };
    const endAddress = () => { input.hidden = true; address.hidden = false; };
    input.addEventListener('blur', () => setTimeout(endAddress, 0));
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      const url = normalizeAddress(input.value);
      if (!url || !/^https?:/.test(url)) { notify(t('browser.invalid')); return; }
      endAddress();
      nav('open', url);
    });
    qualityButton.onclick = () => { quality = quality === 'auto' ? 'low' : 'auto'; paintTools(); start({}).catch(failed); };
    textButton.onclick = () => {
      text.hidden = !text.hidden; textButton.setAttribute('aria-expanded', String(!text.hidden));
      if (!text.hidden) textInput.focus();
    };
    const sendText = async (withEnter) => {
      if (blocked()) return;
      const value = textInput.value;
      if (value) await send({ type: 'text', text: value });
      textInput.value = '';
      if (withEnter) await send({ type: 'key', key: 'Enter' });
    };
    textSend.onclick = () => sendText(false).catch(() => {});
    textInput.addEventListener('keydown', event => {
      if (event.isComposing) return;
      // 空の欄の Backspace はページの 1 文字を消す。Enter は入力してから Enter を送る
      if (event.key === 'Enter') { event.preventDefault(); sendText(true).catch(() => {}); }
      else if (event.key === 'Backspace' && !textInput.value) { event.preventDefault(); if (!blocked()) send({ type: 'key', key: 'Backspace' }).catch(() => {}); }
    });

    // ---- 画面への入力: タップ・ドラッグでスクロール・ホイール
    let down = null, lastScroll = 0, pendingDy = 0, pendingDx = 0, at = null;
    const rect = () => containRect(img.getBoundingClientRect(), { width: img.naturalWidth, height: img.naturalHeight });
    screen.addEventListener('pointerdown', event => {
      if (!sink.frame || event.button > 0) return;
      down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, id: event.pointerId };
      try { screen.setPointerCapture(event.pointerId); } catch {}
    });
    const flushScroll = () => {
      if (!at || (!pendingDx && !pendingDy)) return;
      const r = rect();
      const dx = toPageDelta(pendingDx, r, sink.frame?.metadata), dy = toPageDelta(pendingDy, r, sink.frame?.metadata);
      pendingDx = pendingDy = 0; lastScroll = performance.now();
      if (!blocked()) send({ type: 'scroll', x: at.x, y: at.y, dx, dy }).catch(() => {});
    };
    screen.addEventListener('pointermove', event => {
      if (!down || event.pointerId !== down.id) return;
      if (!down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < TAP_SLOP) return;
      if (!down.moved) { down.moved = true; at = toPageCoords(down, rect(), sink.frame?.metadata) ?? { x: 0, y: 0 }; }
      // 指を上へ動かすとページは下へ（端末の触り方と同じ向き）
      pendingDx += down.lastX - event.clientX; pendingDy += down.lastY - event.clientY;
      down.lastX = event.clientX; down.lastY = event.clientY;
      if (performance.now() - lastScroll > 60) flushScroll();
    });
    const finish = event => {
      if (!down || event.pointerId !== down.id) return;
      const was = down; down = null;
      if (was.moved) { flushScroll(); return; }
      if (event.type === 'pointercancel') return;
      const point = toPageCoords({ x: event.clientX, y: event.clientY }, rect(), sink.frame?.metadata);
      if (!point || blocked()) return;
      send({ type: 'tap', ...point }).catch(() => {});
    };
    screen.addEventListener('pointerup', finish);
    screen.addEventListener('pointercancel', finish);
    screen.addEventListener('wheel', event => {
      if (!sink.frame) return;
      event.preventDefault();
      const point = toPageCoords({ x: event.clientX, y: event.clientY }, rect(), sink.frame.metadata);
      if (!point || blocked()) return;
      at = point; pendingDx += event.deltaX; pendingDy += event.deltaY;
      if (performance.now() - lastScroll > 60) flushScroll();
    }, { passive: false });

    return { root, host, back, address, mark, shown, input, reload, screen, img, sink, status, qualityButton, textButton, text };
  }

  const failed = error => notify(error?.message || t('browser.remote.failed'));
  const blocked = () => ended;
  async function send(input) {
    if (!sessionId) return;
    await cmd('browserScreencastInput', { sessionId, input });
  }
  function nav(action, url) {
    if (!sessionId || blocked()) return;
    cmd('browserScreencastNav', { sessionId, action, ...(url ? { url } : {}) }).catch(failed);
  }
  function paintAddress() {
    const url = state?.url ?? '';
    const parts = addressParts(url);
    view.mark.innerHTML = url ? ICON[parts.kind] ?? ICON.blank : ICON.blank;
    view.shown.replaceChildren();
    if (!url) view.shown.append(el('span', 'weak', t('browser.addressPlaceholder')));
    else if (parts.kind === 'file') view.shown.append(el('b', null, t('browser.kind.file')));
    else view.shown.append(el('b', null, parts.host || url), el('span', 'weak', parts.host ? parts.rest ?? '' : ''));
    view.address.title = url || t('browser.remote.editAddress');
    view.back.disabled = !state?.canGoBack || ended;
    view.reload.disabled = ended;
    const loading = !!state?.loading;
    view.reload.innerHTML = loading ? ICON.stop : ICON.reload;
    view.reload.title = loading ? t('browser.stop') : t('browser.reload'); view.reload.setAttribute('aria-label', view.reload.title);
  }
  function paintTools() {
    view.qualityButton.textContent = t('browser.remote.quality', { level: quality === 'auto' ? t('browser.remote.qualityAuto') : t('browser.remote.qualityLow') });
    if (ended) { view.status.textContent = t('browser.remote.ended'); return; }
    if (!view.sink.frame) { view.status.textContent = t('browser.remote.connecting'); return; }
    view.status.textContent = t('browser.remote.connectedFps', { fps: view.sink.fps() });
  }
  function paint() { paintAddress(); paintTools(); }

  async function start(target) {
    // 見ている箱の大きさ（CSS px）をページの大きさにする。端末の画素の倍率は画質で上限を決める（ホストが丸める）
    const box = view.screen.getBoundingClientRect();
    const result = await cmd('browserScreencast', {
      sessionId, ...target, quality,
      width: Math.round(box.width) || window.innerWidth, height: Math.round(box.height) || window.innerHeight,
      scale: window.devicePixelRatio || 1,
    });
    ended = false;
    if (result?.state) state = result.state;
    paint();
  }

  /** 開く。target は { url } か { visualization: { id?, at? } } か {}（今のタブを見る） */
  async function open(target = {}) {
    view ??= build();
    sessionId = getSessionId();
    state = null; ended = false;
    view.sink.reset();
    view.host.textContent = getHostName() ? `⇄ ${getHostName()}` : '';
    view.root.hidden = false;
    document.body.classList.add('rb-open');
    paint();
    view.address.focus({ preventScroll: true });
    await new Promise(resolve => requestAnimationFrame(resolve));
    try { await start(target); }
    catch (error) { failed(error); closeView(); }
  }

  function closeView() {
    if (!view || view.root.hidden) return;
    if (sessionId) cmd('browserScreencastStop', { sessionId }).catch(() => {});
    view.root.hidden = true;
    document.body.classList.remove('rb-open');
    sessionId = null; view.sink.reset();
  }

  function onMessage(message) {
    // エージェントの Chrome の窓の映像（source: 'chrome'）は右パネル（web/chrome-panel.mjs）のもの
    if (!view || view.root.hidden || message.sessionId !== sessionId || message.source === 'chrome') return;
    if (message.type === 'frame' && typeof message.data === 'string') {
      view.sink.push(message);
      paintTools();
    } else if (message.type === 'state') {
      state = message.state; paint();
    } else if (message.type === 'ended') {
      ended = true; paint();
    }
  }

  /** 接続し直したら見続ける（サーバーは接続が切れた端末を外している） */
  function reconnected() {
    if (!view || view.root.hidden || !sessionId) return;
    start({}).catch(() => { ended = true; paint(); });
  }

  return { open, close: closeView, onMessage, reconnected, get isOpen() { return !!view && !view.root.hidden; } };
}
