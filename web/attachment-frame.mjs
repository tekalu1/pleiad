// 送った直後の添付画像（docs/design-system.md「送った直後の添付画像」、ADR 0067）。
// 送った瞬間の吹き出しに、入力欄の添付を仮の添付（provisional）として渡し、本文の印の位置に画像の枠を置く。パスの字は一度も出さない。
// 枠の寸法は先に取る（入力欄で読めた縦横。分からなければ 240 × 144 = 5:3 で取り、読めたら実寸へ 240ms で動く）。
// 0〜150ms は無地の枠、150ms を越えたら光（1.6 秒で左から右へ）、読めたら 240ms のフェードで差し替える。
// 読めなかったら同じ枠の大きさのまま「読み込めませんでした」と「もう一度」。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';

/** 縮小の最大（style.css の .msg-att-zoom img と同じ。700px 以下は 220px） */
const MAX_H = 144;
const maxWidth = () => (typeof matchMedia === 'function' && matchMedia('(max-width:700px)').matches ? 220 : 240);
export const SLOW_MS = 150;

/** 縦横から枠の大きさ。縮小の最大に収め、拡大はしない。分からなければ 5:3 の最大 */
export function frameSize(width, height, max = maxWidth()) {
  const w = Number(width), h = Number(height);
  if (!(w > 0 && h > 0)) return { width: max, height: Math.round(max * MAX_H / 240), known: false };
  const k = Math.min(1, max / w, MAX_H / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), known: true };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 仮の画像 1 件の HTML（枠と名前）。中身は hydrateFrames が読み込む */
export function pendingImageHtml({ name, src, path, width, height }) {
  const size = frameSize(width, height);
  const label = esc(t('chat.attach.imageLoading', { name }));
  return `<figure class="msg-att msg-att-img msg-att-pending"><span class="att-frame" role="img" aria-label="${label}" data-src="${esc(src)}"` +
    ` data-name="${esc(name)}" data-path="${esc(path)}" data-known="${size.known ? 1 : 0}" style="width:${size.width}px;height:${size.height}px">` +
    `<span class="att-glint" aria-hidden="true"></span></span><figcaption>${esc(name)}</figcaption></figure>`;
}

function failGlyph() {
  const s = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.append(svgEl('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }), svgEl('path', { d: 'M3 16l5-5 4 4M14 13l2-2 5 5' }), svgEl('path', { d: 'M4 3l16 18' }));
  return s;
}

/** 枠を読み込む。読めたら画像に差し替え、読めなかったら「もう一度」 */
function load(frame, attempt = 0) {
  const { src, name, path } = frame.dataset;
  const label = t('chat.attach.imageLoading', { name });
  frame.classList.remove('failed', 'slow');
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', label);
  frame.querySelector('.att-fail')?.remove();
  const timer = setTimeout(() => { if (frame.isConnected && !frame.classList.contains('loaded')) frame.classList.add('slow'); }, SLOW_MS);
  const img = new Image();
  img.alt = name;
  if (path) img.dataset.filePath = path;
  img.onload = () => {
    clearTimeout(timer);
    if (!frame.isConnected) return;
    const button = el('button', 'msg-att-zoom');
    button.type = 'button';
    const zoom = t('chat.attach.enlarge', { name });
    button.setAttribute('aria-label', zoom);
    button.title = zoom;
    button.append(img);
    frame.append(button);
    // 縦横が分からなかった枠だけ、実寸へ動かす（分かっていたものは、最初から実寸）
    if (frame.dataset.known !== '1') {
      const size = frameSize(img.naturalWidth, img.naturalHeight);
      frame.style.width = `${size.width}px`;
      frame.style.height = `${size.height}px`;
      frame.dataset.known = '1';
    }
    // 1 コマ置いてからフェードさせる（付けた瞬間の不透明度 0 から動かすため）
    requestAnimationFrame(() => {
      frame.classList.add('loaded');
      frame.classList.remove('slow');
      frame.removeAttribute('role');
      frame.removeAttribute('aria-label');
    });
  };
  img.onerror = () => {
    clearTimeout(timer);
    if (!frame.isConnected) return;
    frame.classList.remove('slow');
    frame.classList.add('failed');
    const text = t('chat.attach.imageFailed');
    frame.setAttribute('aria-label', text);
    const box = el('span', 'att-fail');
    const retry = el('button', 'att-retry', t('chat.attach.imageRetry'));
    retry.type = 'button';
    retry.onclick = (e) => {
      e.stopPropagation();
      // 同じ URL だと読めなかった結果が使い回されることがあるので、印を変えて取り直す
      frame.dataset.base ||= src;
      frame.dataset.src = `${frame.dataset.base}${frame.dataset.base.includes('?') ? '&' : '?'}r=${attempt + 1}`;
      load(frame, attempt + 1);
    };
    box.append(failGlyph(), el('span', 'att-fail-text', text), retry);
    frame.append(box);
  };
  img.src = src;
}

/** root の中の、まだ読んでいない仮の枠を読み込む。すでに読み込みを始めた枠は触らない */
export function hydrateFrames(root) {
  for (const frame of root.querySelectorAll('.att-frame[data-src]:not([data-started])')) {
    frame.dataset.started = '1';
    load(frame);
  }
}
