// 文中の URL・名前付きのリンクの、行き先の一行と右クリックのメニュー（docs/design-system.md「文中の URL」）。
//   - ホバー・キーボードのフォーカスで、会話の左下に「どこで開くか」と URL の一行を出す。Ctrl/⌘ を押している間は既定のブラウザー
//   - 右クリック・長押し・Shift+F10 で「内蔵ブラウザーで開く / 既定のブラウザーで開く / リンクをコピー」（リモートの画面はシートと同じ語）
// 押した後は web/link-open.mjs の openExternalLink に集まる。行き先の判定は押したときと同じ規則（linkChoices・linkOpenTarget）
import { el, icon } from './dom.mjs';
import { t } from './i18n.mjs';
import { browserPanelAvailable } from './browser-panel.mjs';
import { linkOpenTarget } from './browser-address.mjs';
import { linkChoices } from './link-sheet.mjs';
import { appLinkOf, openExternalLink, modifierKey } from './link-open.mjs';
import { notify } from './file-actions.mjs';

/**
 * 押したときの行き先。'inapp'・'external'（ホストの画面）、'choose'（リモートの画面。端末か PC かをシートで選ぶ）、
 * 'pc'（リモートの localhost。PC のブラウザーだけ）。ctrl は Ctrl/⌘ を押しているか（ホストの画面では既定のブラウザー）
 */
export function linkDestination({ href, ctrl = false, prefs, inAppAvailable = false, hostScreen = false, pcBrowser = false, pageOrigin }) {
  const choices = linkChoices({ url: href, pageOrigin, hostScreen, pcBrowser });
  if (choices) return choices.pcOnly ? 'pc' : 'choose';
  if (ctrl) return 'external';
  return linkOpenTarget({ available: inAppAvailable, prefs });
}

/** 行き先の一行の字。[行き先, URL（スキームを省く）, 近道の案内（ホストの画面で設定が内蔵ブラウザーのときだけ）] */
export function statusParts({ href, dest, key = 'Ctrl', ctrl = false, inAppSetting = false, hostScreen = false }) {
  const label = dest === 'inapp' ? t('timeline.link.openInApp')
    : dest === 'choose' ? t('timeline.link.chooseDest')
    : dest === 'pc' ? t('timeline.link.openOnPc') : t('browser.openExternal');
  const hint = hostScreen && inAppSetting && !ctrl ? t('timeline.link.ctrlHint', { key }) : '';
  return [label, href.replace(/^https?:\/\//i, ''), hint];
}

/**
 * 右クリックのメニューの項目（web/context-menu.mjs の形）。null なら奪わず、ブラウザーの標準メニューに任せる
 * （内蔵ブラウザーの無い画面・PC のブラウザーを見られないリモート）。act は { openInApp, openExternal, openHere, openOnPc, copy }
 */
export function linkMenuItems({ href, prefs, inAppAvailable = false, hostScreen = false, pcBrowser = false, pageOrigin, key = 'Ctrl', act }) {
  const copy = { label: t('timeline.link.copy'), onClick: act.copy };
  const choices = linkChoices({ url: href, pageOrigin, hostScreen, pcBrowser });
  if (choices) {
    return [
      ...(choices.device ? [{ label: t('timeline.link.openOnDevice'), onClick: act.openHere }] : []),
      { label: t('timeline.link.openOnPc'), onClick: act.openOnPc, ...(choices.pcOnly ? { note: t('timeline.link.pcOnly') } : {}) },
      { sep: true }, copy,
    ];
  }
  if (!inAppAvailable) return null;
  // 今の設定のほうに「クリック」、もう一方に「Ctrl+クリック」を添える（近道を覚えられるように）。外部の設定では内蔵に近道は無い
  const inApp = linkOpenTarget({ available: true, prefs }) === 'inapp';
  return [
    { label: t('timeline.link.openInApp'), ...(inApp ? { hint: t('timeline.link.clickHint') } : {}), onClick: act.openInApp },
    { label: t('browser.openExternal'), hint: inApp ? t('timeline.link.ctrlClickHint', { key }) : t('timeline.link.clickHint'), onClick: act.openExternal },
    { sep: true }, copy,
  ];
}

/** メニューの題は URL。長ければ先頭を省く（見たいのは末尾） */
export const menuTitle = href => (href.length > 44 ? `…${href.slice(-43)}` : href);

/**
 * 配線する。showMenu は web/client.mjs の右クリックメニュー、screen() は今の画面（ホストの画面か・PC のブラウザーを見られるか）、
 * openOnPc(url) はリモートの画面で PC のブラウザーを見る口
 */
export function setupLinkMenu({ showMenu, getPrefs, screen, openOnPc, doc = document, pageOrigin = () => location.origin }) {
  const context = () => ({ prefs: getPrefs(), inAppAvailable: browserPanelAvailable(), pageOrigin: pageOrigin(), ...screen(), key: modifierKey() });
  let status = null, hovered = null, ctrl = false;

  function ensureStatus() {
    if (status) return status;
    const box = el('div', 'url-status'); box.setAttribute('aria-hidden', 'true');
    box.append(icon('M14 4h6v6M20 4l-9 9M18 14v5H5V6h5'), el('span', 'dest'), el('span', 'u'), el('span', 'k'));
    (doc.querySelector('main') ?? doc.body).append(box);
    status = box;
    return box;
  }
  function paint(link) {
    // 会話の列の中だけ。ほかの面（右パネル・ダイアログ）には左下の場所が無い
    if (!link.closest('#log')) return;
    const c = context(), href = link.href;
    const dest = linkDestination({ href, ctrl, ...c });
    // 内蔵ブラウザーの無い画面（ブラウザーで開いた Pleiad）は新しいタブで開くだけ。ブラウザー自身が行き先を出す
    if (dest === 'external' && !c.inAppAvailable) return hide();
    const [label, url, hint] = statusParts({ href, dest, key: c.key, ctrl, inAppSetting: linkOpenTarget({ available: c.inAppAvailable, prefs: c.prefs }) === 'inapp', hostScreen: c.hostScreen });
    const box = ensureStatus();
    box.querySelector('.dest').textContent = label;
    box.querySelector('.u').textContent = url;
    box.querySelector('.k').textContent = hint;
    box.querySelector('.k').hidden = !hint;
    // 入力欄の上に置く（入力欄の高さは複数行で変わる）
    const composer = doc.getElementById('composer'), main = box.parentElement;
    if (composer && main?.getBoundingClientRect) box.style.bottom = `${Math.max(0, main.getBoundingClientRect().bottom - composer.getBoundingClientRect().top) + 8}px`;
    box.classList.add('on');
  }
  const hide = () => { hovered = null; status?.classList.remove('on'); };
  const enter = link => { hovered = link; paint(link); };
  const leave = link => { if (hovered === link) hide(); };

  doc.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const link = appLinkOf(e.target);
    if (link) enter(link);
  });
  doc.addEventListener('pointerout', e => {
    const link = appLinkOf(e.target);
    if (link && !link.contains(e.relatedTarget)) leave(link);
  });
  doc.addEventListener('focusin', e => { const link = appLinkOf(e.target); if (link && e.target.matches?.(':focus-visible')) enter(link); });
  doc.addEventListener('focusout', e => { const link = appLinkOf(e.target); if (link) leave(link); });
  doc.addEventListener('click', hide, true);
  doc.addEventListener('scroll', () => { if (hovered) hide(); }, true);
  const setCtrl = on => { if (ctrl === on) return; ctrl = on; if (hovered) paint(hovered); };
  addEventListener('keydown', e => { if (e.key === 'Control' || e.key === 'Meta') setCtrl(true); });
  addEventListener('keyup', e => { if (e.key === 'Control' || e.key === 'Meta') setCtrl(false); });
  addEventListener('blur', () => setCtrl(false));

  /** マウスなら押した位置、キーボード（ContextMenu キー・Shift+F10）なら要素の左下 */
  function pointAt(e, link) {
    if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
    const r = link.getBoundingClientRect();
    return { x: r.left + 8, y: r.bottom + 4 };
  }
  doc.addEventListener('contextmenu', e => {
    if (e.defaultPrevented) return;
    const link = appLinkOf(e.target);
    // モーダルのダイアログの中は、メニュー（本体の上に出る面）が下に隠れる。標準のままにする
    if (!link || link.closest('dialog[open]')) return;
    const href = link.href;
    const c = context();
    const items = linkMenuItems({ href, ...c, act: {
      openInApp: () => openExternalLink(href, { inapp: true }),
      openExternal: () => openExternalLink(href, { external: true }),
      openHere: () => openExternalLink(href, { direct: true }),
      openOnPc: () => openOnPc(href),
      copy: () => navigator.clipboard.writeText(href).then(() => notify(t('timeline.link.copied')), () => notify(t('timeline.link.copyFailed'))),
    } });
    if (!items) return;
    e.preventDefault();
    hide();
    const at = pointAt(e, link);
    showMenu(at.x, at.y, items, menuTitle(href));
  });
}
