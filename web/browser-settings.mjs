// Browser settings and confirmation preferences (docs/inapp-browser.md, ADR 0042).
// External resources can be confirmed on every screen; agent access needs the desktop browser.
import { t } from './i18n.mjs';
import { el } from './dom.mjs';
import { LINK_OPEN_VALUES, linkOpenPref } from './browser-address.mjs';
import { modifierKey } from './link-open.mjs';
import { blockedPreviewOrigins, onBlockedPreviewOrigins } from './preview-confirm.mjs';
const AGENT_BROWSER_VERSION = '0.38.1';

export function setupBrowserSettings({ available, cmd, getPrefs, getAgentLabel = id => id }) {
  const $ = id => document.getElementById(id);
  const tab = $('browserTab'), root = $('browserPanel');
  tab.hidden = false;
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
  // 近道の説明。修飾キーの名前は <kbd> にする（辞書の {{key}} の所に入れる）
  const shortcuts = el('p', 'browser-setting-note');
  const [before, after = ''] = t('settings.browser.linkOpen.shortcuts', { key: '\u0000' }).split('\u0000');
  shortcuts.append(...[before && el('span', null, before), el('kbd', null, modifierKey()), after && el('span', null, after)].filter(Boolean));
  // どの画面でも効く範囲を書く。リンクの開き先はホストの画面だけなので、ほかの画面にはその理由を一言（docs/inapp-browser.md）
  root.replaceChildren(el('p', null, available ? t('settings.browser.description') : t('settings.browser.descriptionRemote')), row, el('p', 'browser-setting-note', t('settings.browser.linkOpen.note')), shortcuts, error);
  if (!available) { row.remove(); agentSection.remove(); root.querySelectorAll('.browser-setting-note').forEach(n => n.remove()); }
  const confirmation = el('section', 'browser-confirm-settings');
  error.remove(); root.append(confirmation); if (available) root.append(agentSection); root.append(error);
  async function save(key, value) {
    error.textContent = '';
    try { await cmd('setPref', { key, value }); }
    catch (e) { error.textContent = t('settings.browser.saveFailed', { error: e.message }); }
  }
  function siteRow(key, site, pending = false) {
    const row = el('div', 'browser-setting browser-site');
    row.append(el('span', 'browser-site-name', site.agent ? `${getAgentLabel(site.agent)} · ${site.origin}` : site.origin));
    const update = mode => {
      const rows = (getPrefs()[key] ?? []).filter(item => item.origin !== site.origin || item.agent !== site.agent);
      if (mode) rows.push({ ...site, mode });
      return save(key, rows);
    };
    if (pending) {
      const allow = el('button', 'btn', t('settings.browser.confirm.permit'));
      allow.onclick = () => update('always'); row.append(allow);
    } else {
      const seg = el('div', 'seg sec'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', site.origin);
      for (const mode of ['always', 'ask']) {
        // i18n-dynamic: settings.browser.confirm.
        const button = el('button', null, t(`settings.browser.confirm.${mode}`)); button.type = 'button';
        button.setAttribute('aria-pressed', String(site.mode === mode)); button.classList.toggle('on', site.mode === mode);
        button.onclick = () => update(mode); seg.append(button);
      }
      const remove = el('button', 'btn btn-quiet', t('settings.browser.confirm.remove'));
      remove.onclick = () => update(null); row.append(seg, remove);
    }
    return row;
  }
  function paintConfirmation() {
    const prefs = getPrefs();
    confirmation.replaceChildren(el('h3', null, t('settings.browser.confirm.title')));
    for (const [key, labelKey] of [['confirmExternalLoads', 'external'], ...(available ? [['confirmAgentSites', 'agent']] : [])]) {
      if (key === 'confirmAgentSites') confirmation.append(el('h3', null, t('settings.browser.confirm.agentTitle')));
      const row = el('label', 'browser-setting');
      // i18n-dynamic: settings.browser.confirm.
      const label = el('span', null, t(`settings.browser.confirm.${labelKey}`));
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = prefs[key] === true;
      toggle.onchange = () => save(key, toggle.checked); row.append(label, toggle); confirmation.append(row);
      // 外部の読み込みの確認が効く範囲（プレビューと、内蔵ブラウザーで開いた PC のファイル）
      if (key === 'confirmExternalLoads') confirmation.append(el('p', 'browser-setting-note', available ? t('settings.browser.confirm.scope') : t('settings.browser.confirm.scopeRemote')));
    }
    if (!prefs.confirmExternalLoads && !(available && prefs.confirmAgentSites)) return;
    const allowed = el('h3', null, t('settings.browser.confirm.sites')); allowed.id = 'browserAllowedSites'; allowed.tabIndex = -1; confirmation.append(allowed);
    if (prefs.confirmExternalLoads) {
      const sites = prefs.externalSitePermissions ?? [];
      const pending = blockedPreviewOrigins().filter(origin => !sites.some(site => site.origin === origin && site.mode === 'always'));
      if (pending.length) {
        confirmation.append(el('h4', null, t('settings.browser.confirm.stopped')));
        for (const origin of pending) confirmation.append(siteRow('externalSitePermissions', { origin }, true));
      }
      // 一覧が空のときは小見出しも出さない（中身の無い見出しが「許可したサイト」の下に残らない）
      if (sites.length) confirmation.append(el('h4', null, t('settings.browser.confirm.externalList')));
      for (const site of sites) confirmation.append(siteRow('externalSitePermissions', site));
    }
    if (available && prefs.confirmAgentSites) {
      const agentSites = prefs.agentSitePermissions ?? [];
      if (agentSites.length) confirmation.append(el('h4', null, t('settings.browser.confirm.agentList')));
      for (const site of agentSites) confirmation.append(siteRow('agentSitePermissions', site));
    }
  }
  onBlockedPreviewOrigins(paintConfirmation);

  function paint() {
    const value = linkOpenPref(getPrefs());
    for (const b of buttons) { b.classList.toggle('on', b.dataset.linkOpen === value); b.setAttribute('aria-pressed', String(b.dataset.linkOpen === value)); }
    paintConfirmation();
  }
  paint();
  return { paint };
}
