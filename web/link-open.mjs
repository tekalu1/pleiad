// Shared destination for external links from the app (conversation, work dialog, side panel documents) and preview frames.
// On the desktop host screen the setting "リンクの開き先" (docs/inapp-browser.md, ADR 0041) sends them to the
// in-app browser; Ctrl/⌘+click and middle click always go to the default browser.
// Elsewhere the browser opens a tab; Electron's setWindowOpenHandler routes https to the OS browser.
import { browserPanelAvailable, openInBrowserPanel } from './browser-panel.mjs';
import { linkOpenTarget } from './browser-address.mjs';

let getPrefs = () => ({});
let chooseRemote = () => false;
/**
 * client.mjs passes the current prefs (linkOpen) and, for screens other than the host's, the chooser that shows
 * "open on this device / view in the PC's browser" (web/link-sheet.mjs). It returns true when it took the link.
 */
export function configureLinkOpen({ getPrefs: read, chooseRemote: choose } = {}) {
  if (typeof read === 'function') getPrefs = read;
  if (typeof choose === 'function') chooseRemote = choose;
}

/**
 * external: 既定のブラウザーへ（Ctrl/⌘+クリック・中クリック・右クリックのメニュー）。inapp: 設定によらず内蔵ブラウザーへ（右クリックのメニュー）。
 * どちらも無いときは設定に従う
 */
export function openExternalLink(url, { newWindow = true, external = false, inapp = false, direct = false } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  // direct: the chooser already picked this device
  if (!direct && chooseRemote(parsed.href, () => openExternalLink(parsed.href, { newWindow, external, inapp, direct: true }))) return true;
  const available = browserPanelAvailable();
  if (!external && (inapp ? available : linkOpenTarget({ available, prefs: getPrefs() }) === 'inapp') &&
      openInBrowserPanel(parsed.href, { newTab: true })) return true;
  // The desktop window refuses new windows and only passes https on; the browser bridge also takes http (localhost).
  if (available) {
    window.plyDesktop.browser.command('openExternal', { url: parsed.href }).catch(() => {});
    return true;
  }
  const link = document.createElement('a');
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow';
  document.body.append(link);
  try { link.click(); } finally { link.remove(); }
  return true;
}

/** 近道の説明に出す修飾キーの名前（macOS は ⌘） */
export const modifierKey = () => (typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl');

/** 押すと今の設定で内蔵ブラウザーに開くか（external は Ctrl/⌘+クリック・中クリック）。内蔵ブラウザーの無い画面・リモートの画面は false */
export function opensInApp({ external = false } = {}) {
  return !external && linkOpenTarget({ available: browserPanelAvailable(), prefs: getPrefs() }) === 'inapp';
}

/** アプリの中の外部リンク（http/https）。文中の URL・名前付きのリンク・取得の見出し。ファイルリンクは含まない（target が無い） */
export const APP_LINK = 'a.md-link[target="_blank"]';
export function appLinkOf(node) {
  const link = node?.closest?.(APP_LINK);
  return link && /^https?:\/\//i.test(link.getAttribute('href') || '') ? link : null;
}

export function handlePreviewLinkMessage(event) {
  if (event.data?.type !== 'ply-preview-open-link' || typeof event.data.url !== 'string' ||
      typeof event.data.newWindow !== 'boolean') return false;
  for (const frame of document.querySelectorAll('iframe.visualize-frame, iframe.file-preview-frame')) {
    if (frame.contentWindow === event.source) {
      return openExternalLink(event.data.url, { newWindow: event.data.newWindow, external: event.data.external === true });
    }
  }
  return false;
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('message', handlePreviewLinkMessage);
  const conversationLink = event => {
    // Already handled (e.g. web/host-only-links.mjs stops localhost links on remote screens)
    if (event.defaultPrevented) return null;
    return appLinkOf(event.target);
  };
  document.addEventListener('click', event => {
    const link = conversationLink(event);
    if (!link) return;
    event.preventDefault();
    const external = event.ctrlKey || event.metaKey;
    // The work dialog is modal: close it before the side panel takes the page (same as file links)
    if (opensInApp({ external })) link.closest('dialog[open]')?.close();
    openExternalLink(link.href, { newWindow: true, external });
  });
  // Middle click fires auxclick, not click
  document.addEventListener('auxclick', event => {
    if (event.button !== 1) return;
    const link = conversationLink(event);
    if (!link) return;
    event.preventDefault();
    openExternalLink(link.href, { newWindow: true, external: true });
  });
}
