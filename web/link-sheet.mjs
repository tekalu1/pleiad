// リンクの開き先の選択シート（docs/inapp-browser.md「リモートでの表示」、モック E）。
// リモートの画面でリンクを押したとき、「この端末で開く / PC のブラウザーで見る」を選ぶ下からのシート。
// localhost と PC のファイルは「PC のブラウザーで見る」だけ。ホストの画面（デスクトップのローカルの窓）では出さない。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { isHostOnlyUrl } from './host-only-links.mjs';

const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON_PHONE = svg('<path d="M7 2h10v20H7Z"/><path d="M11 18h2"/>');
const ICON_SCREEN = svg('<path d="M3 4h18v13H3Z"/><path d="M8 21h8m-4-4v4"/>');
const ICON_CLOSE = svg('<path d="m6 6 12 12M18 6 6 18"/>');
const ICON_CHEVRON = svg('<path d="m9 5 7 7-7 7"/>');

/**
 * リンクの開き先のシートを作る。
 * @param {object} options
 *   hostName: ホストの名前（例: desktop-home）
 *   screencastAvailable: PC の内蔵ブラウザーが使えるか（デスクトップ版であるか）
 *   onDevice: (url) => void — この端末で開く
 *   onPc: (url) => void — PC のブラウザーで見る
 * @returns {{ show(url, pageOrigin), hide(), element }}
 */
export function createLinkSheet({ hostName = '', screencastAvailable = false, onDevice, onPc } = {}) {
  const veil = el('div', 'link-sheet-veil');
  const sheet = el('section', 'link-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', t('timeline.link.openSheet'));

  const handle = el('div', 'link-sheet-handle');
  const header = el('div', 'link-sheet-header');
  const title = el('h3', null, t('timeline.link.openSheet'));
  const closeBtn = el('button', 'btn btn-icon');
  closeBtn.type = 'button';
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.title = t('pending.cancel');
  closeBtn.setAttribute('aria-label', t('pending.cancel'));
  header.append(title, closeBtn);

  const urlLine = el('div', 'link-sheet-url');
  const note = el('p', 'link-sheet-note weak small');

  const deviceBtn = el('button', 'link-sheet-dest');
  deviceBtn.type = 'button';
  deviceBtn.innerHTML = `${ICON_PHONE}<span>${t('timeline.link.openOnDevice')}<small>${t('timeline.link.openOnDeviceSub')}</small></span>`;

  const pcBtn = el('button', 'link-sheet-dest');
  pcBtn.type = 'button';
  pcBtn.innerHTML = `${ICON_SCREEN}<span>${t('timeline.link.openOnPc')}<small>${t('timeline.link.openOnPcSub', { host: hostName || 'PC' })}</small></span><span class="grow"></span>${ICON_CHEVRON}`;

  sheet.append(handle, header, urlLine, note, deviceBtn, pcBtn);

  const wrapper = el('div', 'link-sheet-wrap');
  wrapper.hidden = true;
  wrapper.append(veil, sheet);

  let currentUrl = '';

  function show(url, pageOrigin) {
    currentUrl = url;
    urlLine.textContent = url;
    const hostOnly = isHostOnlyUrl(url, pageOrigin);

    // localhost / PC のファイルでは「この端末で開く」を出さない
    deviceBtn.hidden = hostOnly;
    note.textContent = hostOnly ? t('timeline.link.pcOnly') : '';
    note.hidden = !hostOnly;

    // PC のブラウザーが使えないなら選択肢を出さない
    pcBtn.hidden = !screencastAvailable;

    wrapper.hidden = false;
    // Focus trap
    requestAnimationFrame(() => {
      if (!hostOnly && !deviceBtn.hidden) deviceBtn.focus();
      else if (!pcBtn.hidden) pcBtn.focus();
      else closeBtn.focus();
    });
  }

  function hide() {
    wrapper.hidden = true;
    currentUrl = '';
  }

  closeBtn.onclick = hide;
  veil.onclick = hide;
  deviceBtn.onclick = () => {
    hide();
    onDevice?.(currentUrl);
  };
  pcBtn.onclick = () => {
    hide();
    onPc?.(currentUrl);
  };

  // Escape で閉じる
  wrapper.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); hide(); }
  });

  return {
    show,
    hide,
    get visible() { return !wrapper.hidden; },
    setHostName(name) { hostName = name; pcBtn.querySelector('small').textContent = t('timeline.link.openOnPcSub', { host: name || 'PC' }); },
    setScreencastAvailable(v) { screencastAvailable = v; },
    element: wrapper,
  };
}
