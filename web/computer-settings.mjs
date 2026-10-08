// 設定 › コンピューターの操作（docs/computer-use.md「設定と会話のデータ」、docs/design-system.md「設定 › コンピューターの操作」）。
// 全体のスイッチ・すべてのアプリを許可・常に許可したアプリ（消せる）・操作できないアプリ（読み取りのみ）。
// 保存は setPref { key: 'computerUse', value } に全体を渡す。使えない起動（Electron でない・Windows でない）ではスイッチを止めて理由を書く。
// wait_until の問い（決定モデル pplx-decider。ADR 0165）に使う OpenRouter のキーは、通話と同じ部品で選ぶ（setApiKeyUse の computer:decider）。選ぶまで画面は送らない。
import { t } from './i18n.mjs';
import { el, svgEl } from './dom.mjs';
import { computerUsePrefs } from './computer-prefs.mjs';
import { apiKeyList, keySelect, registerForm, statusLine, manageLink } from './api-key-ui.mjs';

// 操作できないアプリの分類（core/computer-use/apps.mjs の固定の一覧の見出し。画面は読み取りのみ）
const FORBIDDEN = ['terminal', 'password', 'security', 'system', 'agent'];

function appIcon() {
  const svg = svgEl('svg', { class: 'cu-appic', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(svgEl('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }), svgEl('path', { d: 'M1.5 5.5h13' }));
  return svg;
}

/** 行に出す所在。パッケージアプリは AUMID（パスが無い） */
export function appLocation(row) {
  return row.path || row.id.replace(/^(exe|aumid):/, '');
}

function switchRow(id, label) {
  const sw = el('button', 'cx-sw'); sw.type = 'button'; sw.id = id; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', label);
  const head = el('div', 'rm-switch cu-switch'); const text = el('label', 'rm-switch-label', label); text.htmlFor = id;
  head.append(text, sw);
  return { head, sw };
}

export function setupComputerSettings({ cmd, getPrefs, getHostCaps = () => null, openPage = () => {} }) {
  const $ = id => document.getElementById(id);
  const root = $('computerPanel');

  const main = switchRow('computerEnabled', t('settings.computer.enable'));
  const mainNote = el('p', 'rm-state', t('settings.computer.enableNote'));
  const unsupported = el('p', 'rm-state rm-strong cu-unsupported'); unsupported.setAttribute('role', 'status');
  const all = switchRow('computerAllowAll', t('settings.computer.allowAll'));
  const allNote = el('p', 'rm-state', t('settings.computer.allowAllNote'));
  const agyNote = el('p', 'rm-state', t('settings.computer.antigravity'));
  const listHead = el('h4', 'cu-h'); listHead.id = 'computerAllowedTitle';
  const listTitle = el('span', null, t('settings.computer.allowedTitle'));
  const tag = el('span', 'cu-tag', t('settings.computer.allowedAll')); tag.hidden = true;
  listHead.append(listTitle, tag);
  const list = el('div', 'cu-apps'); list.setAttribute('role', 'list'); list.setAttribute('aria-labelledby', listHead.id);
  const deny = el('details', 'cu-deny'); deny.id = 'computerForbidden';
  deny.append(el('summary', null, t('settings.computer.forbiddenTitle')));
  const table = el('div', 'cu-deny-rows'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', t('settings.computer.forbiddenTitle'));
  for (const kind of FORBIDDEN) {
    const row = el('div', 'cu-deny-row'); row.setAttribute('role', 'row');
    // i18n-dynamic: settings.computer.forbidden.
    const name = el('span', 'cu-deny-name', t(`settings.computer.forbidden.${kind}.name`)); name.setAttribute('role', 'rowheader');
    // i18n-dynamic: settings.computer.forbidden.
    const apps = el('span', 'cu-deny-apps', t(`settings.computer.forbidden.${kind}.apps`)); apps.setAttribute('role', 'cell');
    row.append(name, apps); table.append(row);
  }
  deny.append(table);
  const keyBox = el('div');
  const body = el('div', 'cu-body');
  body.append(all.head, allNote, agyNote, listHead, list, deny, keyBox);
  const error = el('p', 'rm-state rm-strong'); error.setAttribute('role', 'status');
  root.replaceChildren(main.head, mainNote, unsupported, body, error);

  let saving = Promise.resolve();
  function save(patch) {
    error.textContent = '';
    // 続けて押しても順に保存し、そのたびに最新の保存済みの値へ重ねる（旧い一覧で上書きしない）
    saving = saving.then(() => cmd('setPref', { key: 'computerUse', value: { ...computerUsePrefs(getPrefs()), ...patch } }))
      .catch(e => { error.textContent = t('settings.computer.saveFailed', { error: e.message }); paint(); });
    return saving;
  }
  const toggle = (sw, key) => { sw.onclick = () => { if (!sw.disabled) save({ [key]: sw.getAttribute('aria-checked') !== 'true' }); }; };
  toggle(main.sw, 'enabled');
  toggle(all.sw, 'allowAllApps');

  // wait_until の問いに使うキー。取れなければ選ぶ欄だけ出さない（ほかの設定は見せる）
  let keys = null, keyBusy = false, registering = false, keyMessage = '', focusKey = null;
  async function loadKeys() {
    keys = await apiKeyList(cmd).catch(() => null);
    paintKeys();
  }
  async function keyCommand(run, done) {
    if (keyBusy) return;
    keyBusy = true; focusKey = 'sel:decider';
    try { await run(); keyMessage = done; }
    catch (e) { keyMessage = t('settings.computer.saveFailed', { error: e?.message ?? String(e) }); }
    keyBusy = false;
    await loadKeys();
  }
  const chooseKey = id => keyCommand(() => cmd('setApiKeyUse', { use: 'computer:decider', id }), id ? t('apiKeys.computer.chosen') : t('apiKeys.computer.unchosen'));
  /** その場で登録して、wait_until の問いに使う（登録先は API キー）。登録の直後に確かめる（キーそのもの。料金はかからない） */
  const registerKey = value => keyCommand(async () => {
    const { id } = await cmd('setApiKey', { provider: 'openrouter', label: '', key: value });
    await cmd('setApiKeyUse', { use: 'computer:decider', id });
    registering = false;
    await cmd('invoke', { op: 'apiKeys.check', args: { id } }).catch(() => null);
  }, t('apiKeys.computer.registered'));

  function paintKeys() {
    const focused = keyBox.contains(document.activeElement) ? document.activeElement : null;
    const keepFk = focusKey ?? focused?.dataset?.fk ?? null;
    focusKey = null;
    const sec = el('section', 'nf-section');
    sec.append(el('h4', null, t('apiKeys.computer.title')));
    const card = el('div', 'nf-card');
    const row = el('div', 'mp-row');
    const info = el('div', 'mp-card-info');
    info.append(el('strong', null, t('apiKeys.useKey')));
    const openrouter = (keys?.keys ?? []).filter(k => k.provider === 'openrouter');
    const current = openrouter.find(k => k.id === keys?.uses?.['computer:decider']) ?? null;
    const deferred = keys?.migration?.state === 'deferred';
    if (deferred) info.append(el('small', null, t('apiKeys.deferredShort')));
    else if (current) { const small = statusLine(current); small.append(' · ', manageLink(openPage)); info.append(small); }
    else info.append(el('small', null, t('apiKeys.computer.unset')));
    row.append(info);
    // 移行を保留している間は選べない（古い置き場を持たない割り当てなので、移行が済むまで問いは使わない）
    if (keys && !deferred) {
      const actions = el('div', 'mp-card-actions ak-sels');
      actions.append(keySelect({ keys: openrouter, current: current?.id ?? null, label: t('apiKeys.computer.selectLabel'), focusKey: 'sel:decider', provider: 'openrouter', choose: chooseKey,
        register: () => { registering = true; focusKey = 'regin:decider'; paintKeys(); } }).element);
      row.append(actions);
    }
    card.append(row);
    if (registering && keys && !deferred) card.append(registerForm({ provider: 'openrouter', label: t('apiKeys.computer.title'), storage: keys.storage, focusKey: 'regin:decider', onSubmit: registerKey,
      onCancel: () => { registering = false; focusKey = 'sel:decider'; paintKeys(); } }));
    sec.append(card);
    if (!deferred) sec.append(el('p', 'mp-note', t('apiKeys.computer.note')));
    const line = el('p', 'rm-state', keyMessage); line.setAttribute('role', 'status');
    sec.append(line);
    keyBox.replaceChildren(sec);
    if (keepFk) keyBox.querySelector(`[data-fk="${CSS.escape(keepFk)}"]`)?.focus({ preventScroll: true });
  }
  $('computerTab')?.addEventListener('click', () => { keyMessage = ''; loadKeys(); });

  function paint() {
    const prefs = computerUsePrefs(getPrefs());
    const caps = getHostCaps();
    // 使えるかは hostCapabilities が届くまで分からない。届く前は使えるものとして描き、届いたら描き直す
    const supported = caps?.computerUse ? caps.computerUse.supported !== false : true;
    main.sw.setAttribute('aria-checked', String(prefs.enabled));
    main.sw.disabled = !supported;
    unsupported.hidden = supported;
    // i18n-dynamic: settings.computer.unsupported.
    unsupported.textContent = supported ? '' : t(`settings.computer.unsupported.${caps.computerUse.reason ?? 'desktop'}`);
    mainNote.hidden = !supported;
    body.hidden = !supported || !prefs.enabled;
    all.sw.setAttribute('aria-checked', String(prefs.allowAllApps));
    tag.hidden = !prefs.allowAllApps;
    list.classList.toggle('dim', prefs.allowAllApps);
    list.setAttribute('aria-disabled', String(prefs.allowAllApps));
    const rows = prefs.alwaysAllowed;
    if (!rows.length) { const empty = el('div', 'cu-empty', t('settings.computer.empty')); list.replaceChildren(empty); return; }
    list.replaceChildren(...rows.map(row => {
      const line = el('div', 'cu-app'); line.setAttribute('role', 'listitem');
      const where = el('span', 'cu-app-path', appLocation(row)); where.title = appLocation(row);
      const remove = el('button', 'btn', t('settings.computer.remove')); remove.type = 'button';
      remove.setAttribute('aria-label', t('settings.computer.removeApp', { name: row.name }));
      remove.disabled = prefs.allowAllApps;
      remove.onclick = () => save({ alwaysAllowed: computerUsePrefs(getPrefs()).alwaysAllowed.filter(r => r.id !== row.id) });
      line.append(appIcon(), el('span', 'cu-app-name', row.name), where, remove);
      return line;
    }));
  }
  paint();
  paintKeys();
  return {
    paint,
    /** apiKeysChanged が届いたとき。開いているときだけ取り直す */
    event(ev) { if (!root.hidden && ev?.type === 'apiKeysChanged') loadKeys(); },
  };
}
