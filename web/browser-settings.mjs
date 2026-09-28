// 設定 › ブラウザー（docs/inapp-browser.md、ADR 0041）。今は「リンクの開き先」の 2 択だけ。
// 値はサーバーの prefs.json の linkOpen（inapp | external。無ければ inapp）。変えた結果は prefs イベントで届く（ほかの画面にも）。
// 内蔵ブラウザーはデスクトップ版のホストの画面だけなので、それ以外の画面では設定の脇の項目ごと出さない。
import { t } from './i18n.mjs';
import { el } from './dom.mjs';
import { LINK_OPEN_VALUES, linkOpenPref } from './browser-address.mjs';
const AGENT_BROWSER_VERSION = '0.38.1';

export function setupBrowserSettings({ available, cmd, getPrefs }) {
  const $ = id => document.getElementById(id);
  const tab = $('browserTab'), root = $('browserPanel');
  tab.hidden = !available;
  if (!available) { root.replaceChildren(); return { paint() {} }; }
  const row = el('div', 'browser-setting');
  const label = el('strong', null, t('settings.browser.linkOpen.title')); label.id = 'browserLinkOpenLabel';
  const seg = el('div', 'seg sec browser-link-open'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-labelledby', label.id);
  const buttons = LINK_OPEN_VALUES.map(value => {
    // i18n-dynamic: settings.browser.linkOpen.
    const b = el('button', null, t(`settings.browser.linkOpen.${value}`)); b.type = 'button'; b.dataset.linkOpen = value;
    b.onclick = () => {
      if (value === linkOpenPref(getPrefs())) return;
      error.textContent = '';
      cmd('setPref', { key: 'linkOpen', value }).catch(e => { error.textContent = t('settings.browser.saveFailed', { error: e.message }); });
    };
    return b;
  });
  seg.append(...buttons);
  row.append(label, seg);
  const error = el('p', 'browser-setting-error'); error.setAttribute('role', 'status');
  const agentSection = el('div', 'browser-agent-setting');
  agentSection.append(el('strong', null, t('settings.browser.agentOperation.title')), el('p', null, t('settings.browser.agentOperation.bundled', { version: AGENT_BROWSER_VERSION })));
  root.replaceChildren(el('p', null, t('settings.browser.description')), row, el('p', 'browser-setting-note', t('settings.browser.linkOpen.note')), agentSection, error);
  function paint() {
    const value = linkOpenPref(getPrefs());
    for (const b of buttons) { b.classList.toggle('on', b.dataset.linkOpen === value); b.setAttribute('aria-pressed', String(b.dataset.linkOpen === value)); }
  }
  paint();
  return { paint };
}
