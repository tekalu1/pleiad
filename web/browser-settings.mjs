// Browser settings and confirmation preferences (docs/inapp-browser.md, ADR 0042).
// External resources can be confirmed on every screen; agent access needs the desktop browser.
import { t } from './i18n.mjs';
import { el } from './dom.mjs';
import { LINK_OPEN_VALUES, linkOpenPref } from './browser-address.mjs';
import { modifierKey } from './link-open.mjs';
import { blockedPreviewOrigins, onBlockedPreviewOrigins } from './preview-confirm.mjs';
import { profileList, profileName, defaultProfile, newProfileRule, newProfileId, monogram, siteProfile, MAIN_PROFILE, MAX_PROFILES, NAME_MAX, MEMO_MAX } from './browser-profiles.mjs';
import { formatBytes } from './folder-upload.mjs';
import { notify } from './file-actions.mjs';
const AGENT_BROWSER_VERSION = '0.38.1';

export function setupBrowserSettings({ available, cmd, getPrefs, getAgentLabel = id => id, showMenu = () => {}, onProfilesChanged = () => {},
  bridge = typeof window !== 'undefined' ? window.plyDesktop?.browser : null }) {
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
  root.replaceChildren(...(available ? [el('p', null, t('settings.browser.description'))] : []), row, el('p', 'browser-setting-note', t('settings.browser.linkOpen.note')), shortcuts, error);
  if (!available) { row.remove(); agentSection.remove(); root.querySelectorAll('.browser-setting-note').forEach(n => n.remove()); }
  const confirmation = el('section', 'browser-confirm-settings');
  // プロフィール（ADR 0078）。内蔵ブラウザーのある画面（デスクトップ版のホストの画面）だけ
  const profiles = available ? setupProfiles() : null;
  error.remove(); if (profiles) root.append(profiles.section); root.append(confirmation); if (available) root.append(agentSection); root.append(error);
  async function save(key, value) {
    error.textContent = '';
    try { await cmd('setPref', { key, value }); }
    catch (e) { error.textContent = t('settings.browser.saveFailed', { error: e.message }); }
  }
  function siteRow(key, site, pending = false) {
    const row = el('div', 'browser-setting browser-site');
    // エージェントの利用はプロフィールごとに覚える。プロフィールが 2 つ以上あるときだけ名前を添える（ADR 0078）
    const list = profileList(getPrefs());
    const profile = list.length > 1 && site.agent ? profileName(list.find(p => p.id === siteProfile(site)) ?? { id: siteProfile(site) }, t('browser.profiles.main')) : null;
    row.append(el('span', 'browser-site-name', site.agent ? [getAgentLabel(site.agent), profile, site.origin].filter(Boolean).join(' · ') : site.origin));
    const update = mode => {
      const rows = (getPrefs()[key] ?? []).filter(item => item.origin !== site.origin || item.agent !== site.agent || (site.agent && siteProfile(item) !== siteProfile(site)));
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
      const row = el('label', 'browser-setting');
      // i18n-dynamic: settings.browser.confirm.
      const label = el('span', null, t(`settings.browser.confirm.${labelKey}`));
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.checked = prefs[key] === true;
      toggle.onchange = () => save(key, toggle.checked); row.append(label, toggle); confirmation.append(row);
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
      confirmation.append(el('h4', null, t('settings.browser.confirm.externalList')));
      for (const site of sites) confirmation.append(siteRow('externalSitePermissions', site));
    }
    if (available && prefs.confirmAgentSites) {
      confirmation.append(el('h4', null, t('settings.browser.confirm.agentList')));
      for (const site of prefs.agentSitePermissions ?? []) confirmation.append(siteRow('agentSitePermissions', site));
    }
  }
  onBlockedPreviewOrigins(paintConfirmation);

  // ---- プロフィール（docs/design-system.md「内蔵ブラウザー」、ADR 0078）。1 行ずつ: モノグラム・名前・弱い字の「既定」・用途のメモ・大きさ・⋯
  function setupProfiles() {
    const section = el('section', 'browser-confirm-settings browser-profile-settings');
    const title = el('h3', null, t('settings.browser.profiles.title')); title.id = 'browserProfilesTitle'; title.tabIndex = -1;
    const list = el('div', 'pf-list');
    const add = el('button', 'btn pf-add'); add.type = 'button';
    add.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    add.append(el('span', null, t('settings.browser.profiles.add')));
    add.onclick = () => startAdd();
    const ruleRow = el('div', 'browser-setting pf-new');
    const ruleLabel = el('span', null, t('settings.browser.profiles.newConversation')); ruleLabel.id = 'browserNewProfileLabel';
    const ruleSeg = el('div', 'seg sec pf-new-seg'); ruleSeg.setAttribute('role', 'group'); ruleSeg.setAttribute('aria-labelledby', ruleLabel.id);
    const ruleButtons = [['last', 'newLast'], ['default', 'newDefault']].map(([value, key]) => {
      // i18n-dynamic: settings.browser.profiles.new
      const b = el('button', null, t(`settings.browser.profiles.${key}`)); b.type = 'button'; b.dataset.rule = value;
      b.onclick = () => { if (newProfileRule(getPrefs()) !== value) save('browserNewProfile', value); };
      return b;
    });
    ruleSeg.append(...ruleButtons); ruleRow.append(ruleLabel, ruleSeg);
    section.append(title, el('h4', null, 'Pleiad'), list, add, ruleRow);
    // 左のメニューで開いたとき（ページを出す処理の後に数える）
    tab.addEventListener?.('click', () => setTimeout(refreshSizes));
    // editing: { id, field: name|memo, isNew }。入力欄を出している行
    let editing = null, sizes = {}, sizing = false;
    const mainName = () => t('browser.profiles.main');
    const nameOf = row => profileName(row, mainName());
    const rows = () => profileList(getPrefs());
    /** 一覧を保存用の形にする（名前を付けていないメインは name を持たない） */
    const stored = list => list.map(row => ({ id: row.id, ...(row.name ? { name: row.name } : {}), ...(row.memo ? { memo: row.memo } : {}) }));
    async function saveList(next) { await save('browserProfiles', stored(next)); onProfilesChanged(); }
    // 大きさは main がディレクトリを数える。設定 › ブラウザーが見えている間だけ数え直す
    function refreshSizes() {
      if (!bridge || sizing || root.hidden) return;
      sizing = true;
      bridge.command('profileSizes').then(r => { sizes = r?.sizes ?? {}; paintList(); }).catch(() => {}).finally(() => { sizing = false; });
    }
    function startAdd() {
      if (rows().length >= MAX_PROFILES) { error.textContent = t('settings.browser.profiles.tooMany', { max: MAX_PROFILES }); return; }
      editing = { id: newProfileId(), field: 'name', isNew: true };
      paintList();
    }
    function field(row) {
      const memo = editing.field === 'memo';
      const input = el('input', 'pf-field'); input.type = 'text';
      input.maxLength = memo ? MEMO_MAX : NAME_MAX;
      input.placeholder = memo ? t('settings.browser.profiles.memoPlaceholder') : t('settings.browser.profiles.namePlaceholder');
      input.setAttribute('aria-label', memo ? t('settings.browser.profiles.memoLabel') : t('settings.browser.profiles.nameLabel'));
      input.value = memo ? row?.memo ?? '' : row?.name ?? (row?.id === MAIN_PROFILE ? mainName() : '');
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true;
        const value = input.value.trim(), target = editing;
        editing = null;
        if (!commit || (!value && target.field === 'name')) { paintList(); return; }
        const list = rows();
        if (target.isNew) list.push({ id: target.id, name: value });
        else {
          const item = list.find(p => p.id === target.id);
          if (item && target.field === 'name') item.name = item.id === MAIN_PROFILE && value === mainName() ? undefined : value;
          if (item && target.field === 'memo') item.memo = value || undefined;
        }
        paintList();
        saveList(list);
      };
      input.onkeydown = event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      };
      input.onblur = () => finish(true);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return input;
    }
    function rowMenu(row, anchor) {
      const prefs = getPrefs(), isDefault = row.id === defaultProfile(prefs), name = nameOf(row);
      const confirm = (text, label, act) => {
        const r = anchor.getBoundingClientRect();
        showMenu(r.right, r.bottom + 4, [
          { label: t('settings.browser.profiles.cancel'), onClick: () => {} },
          { label, onClick: act },
        ], { text, wrap: true }, { alignRight: true });
      };
      const r = anchor.getBoundingClientRect();
      const cannot = isDefault ? t('settings.browser.profiles.defaultCannotDelete') : row.id === MAIN_PROFILE ? t('settings.browser.profiles.mainCannotDelete') : null;
      showMenu(r.right, r.bottom + 4, [
        { label: t('settings.browser.profiles.rename'), onClick: () => { editing = { id: row.id, field: 'name' }; paintList(); } },
        { label: t('settings.browser.profiles.editMemo'), onClick: () => { editing = { id: row.id, field: 'memo' }; paintList(); } },
        ...(isDefault ? [] : [{ label: t('settings.browser.profiles.makeDefault'), onClick: () => save('browserDefaultProfile', row.id) }]),
        { label: t('settings.browser.profiles.clear'), onClick: () => confirm(t('settings.browser.profiles.confirmClear', { name }), t('settings.browser.profiles.clear'), async () => {
          const r = await bridge?.command('clearProfile', { profile: row.id }).catch(() => null);
          notify(r?.ok ? t('settings.browser.profiles.cleared', { name }) : t('browser.failed'));
          refreshSizes();
        }) },
        { sep: true },
        cannot ? { label: t('settings.browser.profiles.delete'), disabled: true, note: cannot }
          : { label: t('settings.browser.profiles.delete'), onClick: () => confirm(t('settings.browser.profiles.confirmDelete', { name }), t('settings.browser.profiles.delete'), async () => {
            const r = await bridge?.command('deleteProfile', { profile: row.id }).catch(() => null);
            if (!r?.ok) { notify(t('browser.failed')); return; }
            await saveList(rows().filter(p => p.id !== row.id));
            notify(t('settings.browser.profiles.deleted', { name }));
          }) },
      ], name, { alignRight: true });
    }
    function paintList() {
      const prefs = getPrefs(), def = defaultProfile(prefs);
      const items = rows();
      if (editing?.isNew) items.push({ id: editing.id, name: '' });
      list.replaceChildren(...items.map(row => {
        const item = el('div', 'pf-row'); item.dataset.profile = row.id;
        const mono = el('span', 'browser-profile-mono lg'); mono.setAttribute('aria-hidden', 'true');
        mono.textContent = monogram(row.name || (row.id === MAIN_PROFILE ? mainName() : t('settings.browser.profiles.namePlaceholder')));
        item.append(mono);
        if (editing?.id === row.id && editing.field === 'name') { item.append(field(row)); return item; }
        const text = el('span', 'pf-text');
        const head = el('span', 'pf-name');
        head.append(el('span', 'pf-label', nameOf(row)));
        if (row.id === def) head.append(el('span', 'pf-tag', t('settings.browser.profiles.default')));
        text.append(head);
        if (editing?.id === row.id && editing.field === 'memo') text.append(field(row));
        else if (row.memo) text.append(el('span', 'pf-memo', row.memo));
        item.append(text);
        if (Number.isFinite(sizes[row.id])) item.append(el('span', 'pf-size', formatBytes(sizes[row.id])));
        const more = el('button', 'btn btn-icon pf-more'); more.type = 'button';
        more.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';
        const label = t('settings.browser.profiles.actions', { name: nameOf(row) });
        more.title = label; more.setAttribute('aria-label', label); more.setAttribute('aria-haspopup', 'menu');
        more.onclick = () => rowMenu(row, more);
        item.append(more);
        return item;
      }));
      add.disabled = !!editing?.isNew;
      const rule = newProfileRule(prefs);
      for (const b of ruleButtons) { b.classList.toggle('on', b.dataset.rule === rule); b.setAttribute('aria-pressed', String(b.dataset.rule === rule)); }
    }
    return {
      section,
      paint() { if (!editing) paintList(); refreshSizes(); },
      /** 右パネルのメニューから来た: 節の見出しへ。add なら名前の欄を出す */
      show({ add: adding = false } = {}) {
        refreshSizes();
        title.scrollIntoView?.({ block: 'start' });
        if (adding) startAdd(); else title.focus({ preventScroll: true });
      },
    };
  }

  function paint() {
    const value = linkOpenPref(getPrefs());
    for (const b of buttons) { b.classList.toggle('on', b.dataset.linkOpen === value); b.setAttribute('aria-pressed', String(b.dataset.linkOpen === value)); }
    profiles?.paint();
    paintConfirmation();
  }
  paint();
  return { paint, showProfiles: options => profiles?.show(options) };
}
