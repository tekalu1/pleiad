// リンクの開き先のシート（docs/inapp-browser.md「リモートから見る」、docs/design-system.md「リンクの開き先のシート」）。
// ホストの画面ではない端末（リモートの窓・モバイル版・LAN のブラウザー）で、会話のリンク・プレビューのリンク・可視化の
// 「ブラウザーで開く」を押したとき、下からのシートで「この端末で開く / PC のブラウザーで見る」を選ぶ。
//   - localhost と PC のファイル（可視化の写し）は「PC のブラウザーで見る」だけ（端末で開くと端末自身を指す）
//   - ホストに内蔵ブラウザーが無い（デスクトップ版でない npm start）ならシートを出さない（今までどおり端末で開くか、知らせる）
//   - ホストの画面（state.osActions）ではシートを出さない
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { isHostOnlyUrl } from './host-only-links.mjs';

const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON_PHONE = svg('<path d="M7 2h10v20H7Z"/><path d="M11 18h2"/>');
const ICON_SCREEN = svg('<path d="M3 4h18v12H3z"/><path d="M8 20h8M12 16v4"/>');
const ICON_CLOSE = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const ICON_CHEVRON = svg('<path d="m9 5 7 7-7 7"/>');

/**
 * 出す選択肢。null ならシートを出さない（呼び出し側が今までどおりに扱う）。
 * kind: 'url'（http・https のリンク）・'snapshot'（可視化の写し。端末でも開ける）・'file'（PC のファイル。端末では開けない）
 */
export function linkChoices({ url, kind = 'url', pageOrigin, hostScreen = false, pcBrowser = false }) {
  if (hostScreen || !pcBrowser) return null;
  const pcOnly = kind === 'file' || (kind === 'url' && isHostOnlyUrl(url, pageOrigin));
  return { device: !pcOnly, pc: true, pcOnly };
}

let sheet = null;
function build() {
  const wrap = el('div', 'link-sheet-wrap'); wrap.hidden = true;
  const veil = el('div', 'link-sheet-veil');
  const box = el('section', 'link-sheet');
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
  const title = el('h3', null, t('timeline.link.openSheet')); title.id = 'linkSheetTitle';
  box.setAttribute('aria-labelledby', title.id);
  const close = el('button', 'btn btn-icon'); close.type = 'button';
  close.innerHTML = ICON_CLOSE; close.title = t('timeline.link.close'); close.setAttribute('aria-label', close.title);
  const head = el('div', 'link-sheet-head'); head.append(title, close);
  const url = el('div', 'link-sheet-url mono');
  const note = el('p', 'link-sheet-note small weak', t('timeline.link.pcOnly'));
  const destination = (icon, label, sub, chevron) => {
    const b = el('button', 'link-sheet-dest'); b.type = 'button';
    const text = el('span', 'link-sheet-dest-text', label);
    const small = el('small', null, sub); text.append(small);
    b.innerHTML = icon; b.append(text);
    if (chevron) { b.append(el('span', 'grow')); b.insertAdjacentHTML('beforeend', ICON_CHEVRON); }
    return { b, small };
  };
  const device = destination(ICON_PHONE, t('timeline.link.openOnDevice'), t('timeline.link.openOnDeviceSub'));
  const pc = destination(ICON_SCREEN, t('timeline.link.openOnPc'), '', true);
  pc.small.classList.add('mono');
  box.append(el('div', 'link-sheet-handle'), head, url, note, device.b, pc.b);
  wrap.append(veil, box);
  document.body.append(wrap);
  let current = null, returnFocus = null;
  const hide = () => {
    if (wrap.hidden) return;
    wrap.hidden = true; current = null;
    returnFocus?.focus?.({ preventScroll: true }); returnFocus = null;
  };
  const pick = which => { const action = current?.[which]; hide(); action?.(); };
  close.onclick = hide; veil.onclick = hide;
  device.b.onclick = () => pick('onDevice');
  pc.b.onclick = () => pick('onPc');
  wrap.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } });
  return {
    wrap,
    show({ label, choices, hostName, onDevice, onPc }) {
      current = { onDevice, onPc };
      returnFocus = document.activeElement;
      url.textContent = label;
      device.b.hidden = !choices.device;
      note.hidden = !choices.pcOnly;
      pc.small.textContent = hostName || '';
      pc.small.hidden = !hostName;
      wrap.hidden = false;
      (choices.device ? device.b : pc.b).focus({ preventScroll: true });
    },
    hide,
  };
}

/** シートを出す。choices は linkChoices の戻り値 */
export function showLinkSheet(options) {
  sheet ??= build();
  sheet.show(options);
}
export function hideLinkSheet() { sheet?.hide(); }
