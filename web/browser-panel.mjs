// 内蔵ブラウザーの右パネル（docs/inapp-browser.md、ADR 0041）。ページそのものはデスクトップ版の main が
// 右パネルの本文の枠の位置に重ねる WebContentsView（desktop/browser-panel.cjs）で、ここは枠の部品と位置の報告だけを持つ。
//   - 使えるのはデスクトップ版のホストの画面（ローカルの窓）だけ。ブラウザーで開いた Pleiad とリモートの窓では
//     browserPanelAvailable() が false で、openInBrowserPanel() は何もしない（false を返す）
//   - ネイティブの View は DOM より上に描かれる。メニュー・ダイアログ・知らせが本文の枠に重なる間は、
//     main に写した画像をもらって同じ位置に置き、View を外す（freeze / unfreeze）
// 部品を並べるのは右パネルの枠（web/side-panel.mjs の browserSlots と applySlots）。ここでは作るだけ。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { closeIcon, backIcon, moreIcon } from './icons.mjs';
import { normalizeAddress, addressParts, tabLabel } from './browser-address.mjs';
import { notify } from './file-actions.mjs';
import { noteBlockedOrigins, openPreviewSettings } from './preview-confirm.mjs';

const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  forward: svg('<path d="M9 5l7 7-7 7"/>'),
  reload: svg('<path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.3 5.7"/>'),
  stop: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  external: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>'),
  secure: svg('<path d="M7 11V8a5 5 0 0 1 10 0v3"/><path d="M5 11h14v10H5z"/>'),
  local: svg('<path d="M3 4h18v12H3z"/><path d="M8 20h8M12 16v4"/>'),
  insecure: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/>'),
  file: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4"/>'),
  blank: svg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>'),
};

/** デスクトップ版のホストの画面（ローカルの窓）か。リモートの窓の preload は browser を出さない */
export function browserPanelAvailable() {
  return typeof window !== 'undefined' && !!window.plyDesktop?.browser && !window.plyRemote;
}

let opener = null;
/**
 * 内蔵ブラウザーで URL を開く（右パネルをブラウザーにして、今のタブで開く。newTab なら新しいタブ）。
 * url を省くと空の新しいタブ。使えない画面・開けない URL では何もせず false。
 * reuse: 同じ実体のファイル（可視化の写しは同じ記録）のタブがこの会話にあれば、新しく作らず前に出して読み直す。
 * source: 画面が開いた PC のファイル・可視化の写しの印（⋯ のファイルの操作とアドレス欄の見せ方。desktop/browser-panel.cjs の cleanSource）
 */
export function openInBrowserPanel(url, { newTab = false, reuse = false, source = null } = {}) {
  if (!browserPanelAvailable() || !opener) return false;
  if (url != null && url !== '') {
    const target = normalizeAddress(url);
    if (!target) return false;
    opener({ url: target, newTab, reuse, source });
  } else opener({ url: '', newTab: true });
  return true;
}

const button = (icon, label, action, className = 'btn btn-icon') => {
  const b = el('button', className); b.type = 'button';
  b.innerHTML = icon; b.title = label; b.setAttribute('aria-label', label);
  b.onclick = action;
  return b;
};

/**
 * 部品を作る。bridge は window.plyDesktop.browser。showMenu は右クリックメニュー（web/client.mjs）。
 * getSessionId は今開いている会話（タブがどの会話から開かれたかを main が覚える）。
 * openPanel は右パネルをブラウザーのモードにする関数（web/file-preview.mjs が後から入れる）。onEmpty は同じ会話のまま最後のタブが無くなったとき
 * （タブの無い会話へ移っただけなら呼ばず、パネルは開いたまま）。
 * onChange は main から状態（タブ・エージェントの操作）が届いて描き直した後（頭の行のボタンの操作中の印。web/header-entries.mjs）
 */
export function createBrowserPanel({ bridge = window.plyDesktop?.browser, showMenu, getSessionId = () => null, getAgentName = () => 'Agent', onChange = () => {} } = {}) {
  let state = { tabs: [], current: null, agent: null, sessionId: null };
  let shown = false, covered = false, freezing = null, editing = false;
  // tabMenu(tab): ⋯ の先頭に足すファイルの操作（PC のファイル・可視化の写しのタブだけ。web/file-preview.mjs）。
  // rewriteSnapshot(rewrite): 写しの「読み込む」で、一時の許可付きの写しを書き直して同じタブで開く。onPaint(state): 状態が変わった
  let hooks = { openPanel: () => {}, onEmpty: () => {}, tabMenu: () => [], rewriteSnapshot: async () => {}, onPaint: () => {} };
  const current = () => state.tabs.find(tab => tab.id === state.current) ?? null;
  const run = (action, args) => bridge.command(action, args).then(next => { if (next?.tabs) paint(next); return next; });
  const failed = () => notify(t('browser.failed'));

  // ---- タブの列（小さく。閉じる・新しいタブ）
  const tabsRow = el('div', 'browser-tabs'); tabsRow.hidden = true;
  const tabList = el('div', 'browser-tab-list'); tabList.setAttribute('role', 'tablist'); tabList.setAttribute('aria-label', t('browser.tabs'));
  const newTab = button(ICON.plus, t('browser.newTab'), () => run('newTab').then(() => focusAddress()).catch(failed), 'btn btn-icon browser-new-tab');
  tabsRow.append(tabList, newTab);
  const agentRow = el('div', 'browser-agent-row'); agentRow.hidden = true;
  const agentStatus = el('span', 'browser-agent-status');
  const agentStop = el('button', 'btn', t('browser.agent.stop')); agentStop.type = 'button';
  agentStop.onclick = () => run('agentStop').catch(failed);
  const agentTakeOver = el('button', 'btn', t('browser.agent.takeOver')); agentTakeOver.type = 'button';
  agentTakeOver.onclick = () => run('agentTakeOver').catch(failed);
  agentRow.append(agentStatus, agentStop, agentTakeOver);

  // ---- 止めた件数の一行（画面が開いた PC のファイルのタブで、外部の読み込みの確認が ON のとき。プレビューと同じ語彙）。
  // ページ（ネイティブの View）の上ではなく、道具の列とページの間の DOM に置く
  const guardRow = el('div', 'preview-blocked browser-blocked'); guardRow.hidden = true;
  const guardLabel = el('span'); guardLabel.setAttribute('role', 'status');
  const guardLoad = el('button'); guardLoad.type = 'button'; guardLoad.textContent = t('settings.browser.confirm.load');
  guardLoad.onclick = () => allowOnce();
  const guardSettings = el('button'); guardSettings.type = 'button'; guardSettings.textContent = t('settings.browser.confirm.settings');
  guardSettings.onclick = () => openPreviewSettings();
  guardRow.append(guardLabel, guardLoad, guardSettings);
  /** 「読み込む」: このタブだけ一時的に通して読み直す。写しは一時の許可付きで書き直す */
  async function allowOnce() {
    const tab = current();
    if (!tab) return;
    try {
      const next = await run('allowOnce', { id: tab.id });
      if (next?.rewrite) await hooks.rewriteSnapshot(next.rewrite);
    } catch { failed(); }
  }
  function paintGuard() {
    const tab = current(), guard = tab?.guard;
    const show = shown && !!guard && guard.blocked > 0;
    guardRow.hidden = !show;
    if (!show) return;
    guardLabel.textContent = t('settings.browser.confirm.blocked', { count: guard.blocked });
    guardLoad.hidden = !guard.origins.length;   // 読み込めるのは https だけ。http だけのときは件数と設定だけ
  }

  // ---- 道具の列: 戻る・進む・再読み込み・アドレス欄・既定のブラウザーで開く・⋯
  const back = button(backIcon, t('browser.back'), () => run('back').catch(failed));
  const forward = button(ICON.forward, t('browser.forward'), () => run('forward').catch(failed));
  const reload = button(ICON.reload, t('browser.reload'), () => run(current()?.loading ? 'stop' : 'reload').catch(failed));
  const address = el('div', 'browser-address');
  const mark = el('span', 'browser-address-mark');
  const input = el('input'); input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off';
  input.setAttribute('aria-label', t('browser.address')); input.placeholder = t('browser.addressPlaceholder');
  // 触れていない間は、スキームと残りを弱く・ホスト名を強くした文字を入力欄に重ねて見せる
  const shownText = el('span', 'browser-address-text'); shownText.setAttribute('aria-hidden', 'true');
  address.append(mark, input, shownText);
  const openExternal = button(ICON.external, t('browser.openExternal'), () => run('external').then(r => { if (r && r.ok === false) notify(r.reason === 'too-many' ? t('browser.externalTooMany') : t('browser.externalUnavailable')); }).catch(failed));
  const more = button(moreIcon, t('browser.actions'), () => {
    const r = more.getBoundingClientRect(), tab = current();
    const fileItems = tab ? hooks.tabMenu(tab) : [];
    showMenu?.(r.left, r.bottom + 4, [
      ...(fileItems.length ? [...fileItems, { sep: true }] : []),
      { label: t('browser.menu.devtools'), disabled: !tab?.url, onClick: () => run('devtools').catch(failed) },
      { label: t('browser.menu.detach'), disabled: !tab?.url, onClick: () => run('detach').catch(failed) },
      { sep: true },
      { label: t('browser.menu.clearSiteData'), disabled: !/^https?:/.test(tab?.url ?? ''), onClick: () => run('clearSiteData').then(res => notify(res?.ok ? t('browser.siteDataCleared') : t('browser.failed'))).catch(failed) },
    ], tab?.url ? addressParts(tab.url).host || tabLabel(tab) : t('browser.panel'));
  });
  more.setAttribute('aria-haspopup', 'menu');

  input.onfocus = () => { editing = true; address.classList.add('editing'); input.select(); };
  input.onblur = () => { editing = false; address.classList.remove('editing'); paintAddress(); };
  input.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); input.value = current()?.url ?? ''; input.blur(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const url = normalizeAddress(input.value);
    if (!url) { notify(t('browser.invalid')); return; }
    run('open', { url }).then(() => input.blur()).catch(failed);
  };

  // ---- 本文の枠。ここにネイティブの View が重なる。空のタブと重なりの間の写しは DOM で出す
  const body = el('div', 'browser-viewport');
  const empty = el('div', 'browser-empty');
  empty.append(el('h3', null, t('browser.empty.title')), el('p', null, t('browser.empty.hint')));
  const still = el('img', 'browser-still'); still.alt = ''; still.hidden = true;
  body.append(empty, still);

  function focusAddress() { requestAnimationFrame(() => { input.focus(); input.select(); }); }

  function paintAddress() {
    const tab = current();
    const parts = addressParts(tab?.url);
    mark.innerHTML = ICON[parts.kind] ?? ICON.blank;
    // i18n-dynamic: browser.kind.
    mark.title = parts.kind === 'blank' ? '' : t(`browser.kind.${parts.kind}`);
    address.dataset.kind = parts.kind;
    if (!editing) input.value = tab?.url ?? '';
    shownText.replaceChildren();
    // PC のファイルは作業ディレクトリからの相対（画面が開いたとき label を渡す）。可視化の写しはデータ置き場のパスを見せず「可視化 · 題」
    if (tab?.snapshot) shownText.append(el('b', null, t('timeline.present.kind.visualization')), el('span', 'weak', ` · ${tab.snapshot.title || t('filePreview.visual.title')}`));
    else if (parts.kind === 'file') shownText.append(el('b', null, t('browser.kind.file')), el('span', 'weak', ` · ${tab?.file?.label || parts.rest}`));
    else if (parts.kind !== 'blank') shownText.append(el('span', 'weak', parts.scheme), el('b', null, parts.host), el('span', 'weak', parts.rest));
  }

  /** 使い回したタブを一瞬だけ輪で知らせる（動きを減らす設定では CSS が止める） */
  function flashTab(id) {
    requestAnimationFrame(() => {
      const node = tabList.querySelector(`[data-tab="${id}"]`);
      if (!node) return;
      node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
      node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
    });
  }
  function paintTabs() {
    tabList.replaceChildren(...state.tabs.map(tab => {
      const selected = tab.id === state.current;
      const label = tabLabel(tab) || t('browser.untitled');
      const item = el('div', 'browser-tab' + (selected ? ' on' : '')); item.dataset.tab = tab.id;
      const pick = el('button', 'browser-tab-pick'); pick.type = 'button';
      pick.setAttribute('role', 'tab'); pick.setAttribute('aria-selected', String(selected)); pick.tabIndex = selected ? 0 : -1;
      pick.title = tab.url ? `${label}\n${tab.url}` : label;
      const ic = el('span', 'browser-tab-mark');
      if (state.agent?.tabId === tab.id) ic.append(runMark(t('browser.agent.working')));
      else if (tab.loading) ic.append(runMark(t('browser.loading'))); else ic.innerHTML = ICON[addressParts(tab.url).kind] ?? ICON.blank;
      pick.append(ic, el('span', 'browser-tab-name', label));
      pick.onclick = () => run('select', { id: tab.id }).catch(failed);
      pick.onkeydown = event => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const index = state.tabs.findIndex(x => x.id === tab.id);
        const next = state.tabs[(index + step + state.tabs.length) % state.tabs.length];
        run('select', { id: next.id }).then(() => tabList.querySelector('[aria-selected=true]')?.focus()).catch(failed);
      };
      const close = button(closeIcon, t('browser.closeTab', { title: label }), () => run('close', { id: tab.id }).catch(failed), 'btn btn-icon browser-tab-close');
      close.tabIndex = -1;
      item.append(pick, close);
      return item;
    }));
  }

  function paint(next) {
    const before = state;
    state = { tabs: Array.isArray(next?.tabs) ? next.tabs : [], current: next?.current ?? null, agent: next?.agent ?? null, sessionId: next?.sessionId ?? null };
    const active = !!state.agent && state.agent.sessionId === getSessionId();
    agentRow.hidden = !active;
    agentStatus.replaceChildren();
    if (active) {
      agentStatus.append(runMark(t('browser.agent.working')), document.createTextNode(t('browser.agent.status', { name: getAgentName() })));
      if (!shown) hooks.openPanel();
    }
    const tab = current();
    back.disabled = !tab?.canGoBack; forward.disabled = !tab?.canGoForward;
    reload.disabled = !tab?.url;
    const loading = !!tab?.loading;
    reload.innerHTML = loading ? ICON.stop : ICON.reload;
    reload.title = loading ? t('browser.stop') : t('browser.reload'); reload.setAttribute('aria-label', reload.title);
    // 押せるかは main が決める（http・https と、画面が明示して開いた file: の HTML。desktop/browser-panel.cjs）
    openExternal.disabled = !tab?.external;
    empty.hidden = !!tab?.url;
    paintTabs(); paintAddress(); paintGuard();
    // 止めた https の出どころは、設定 › ブラウザーの「止めた出どころ」にも並べる
    for (const entry of state.tabs) if (entry.guard?.origins?.length) noteBlockedOrigins(entry.guard.origins);
    // 重なりの間に今のタブが替わったら、前のページの写しを残さず撮り直す（空のタブなら写しは出さない）
    if (covered && before.current !== state.current) refreeze();
    // 最後のタブを閉じたらパネルごと閉じる。タブの無い会話へ移っただけなら閉じない（一覧は会話ごと。desktop/browser-panel.cjs）
    if (before.tabs.length && !state.tabs.length && shown && before.sessionId === state.sessionId) hooks.onEmpty();
    onChange(state); hooks.onPaint(state);
  }

  // ---- 位置の報告と重なり
  const OVERLAYS = 'dialog[open], .pop:not([hidden]), .file-toast:not([hidden]), .rm-dialog:not([hidden]), .fu-drop:not([hidden])';
  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  function overlayOn(r) {
    for (const node of document.querySelectorAll(OVERLAYS)) {
      if (node.matches('dialog') && node.matches(':modal')) return true;   // モーダルは幕ごと上に出る
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden') continue;
      if (intersects(box, r)) return true;
    }
    return false;
  }
  let frame = 0, lastSent = '';
  function sync() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; report(); });
  }
  function report() {
    const r = body.getBoundingClientRect();
    const visible = shown && body.isConnected && r.width > 0 && r.height > 0;
    const radius = parseFloat(getComputedStyle(body.parentElement ?? body).borderTopLeftRadius) || 0;
    const message = { visible, rect: visible ? { x: r.left, y: r.top, width: r.width, height: r.height } : null, radius };
    const key = JSON.stringify(message);
    if (key !== lastSent) { lastSent = key; bridge.layout(message); }
    setCovered(visible && overlayOn(r));
  }
  function refreeze() {
    still.hidden = true; still.removeAttribute('src');
    const run = freezing = bridge.command('freeze').then(res => {
      if (freezing !== run || !covered) return;
      if (res?.image) { still.src = res.image; still.hidden = false; }
    }).catch(() => {});
  }
  function setCovered(value) {
    if (covered === value) return;
    covered = value;
    if (value) {
      const run = freezing = bridge.command('freeze').then(res => {
        if (freezing !== run || !covered) return;
        if (res?.image) { still.src = res.image; still.hidden = false; }
      }).catch(() => {});
    } else {
      freezing = null;
      bridge.command('unfreeze').catch(() => {}).finally(() => { if (!covered) { still.hidden = true; still.removeAttribute('src'); } });
    }
  }
  const resize = new ResizeObserver(sync);
  // 重なる部品は body の直下に足される（メニュー）か、hidden・open の出し入れで出る
  const added = new MutationObserver(sync), toggled = new MutationObserver(sync);
  function watch(on) {
    if (on) {
      resize.observe(body); resize.observe(document.body);
      added.observe(document.body, { childList: true });
      toggled.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
      addEventListener('resize', sync);
    } else {
      resize.disconnect(); added.disconnect(); toggled.disconnect();
      removeEventListener('resize', sync);
    }
  }

  bridge.onState(paint);
  bridge.command('state').then(paint).catch(() => {});

  const api = {
    buttons: { back, forward, reloadPage: reload, address, openExternal, browserMore: more },
    tabsRow, agentRow, guardRow, body,
    /** file-preview がパネルを開く関数と、最後のタブを閉じたときの関数を入れる */
    connect(next) { hooks = { ...hooks, ...next }; },
    /** パネルがブラウザーのモードで見えるようになった・隠れた */
    show() {
      if (shown) return sync();
      shown = true; lastSent = ''; watch(true);
      agentRow.hidden = !(state.agent && state.agent.sessionId === getSessionId());
      paintGuard();
      bridge.command('context', { sessionId: getSessionId() }).then(paint).catch(() => {});
      sync();
    },
    hide() {
      if (!shown) return;
      shown = false; watch(false); paintGuard();
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      covered = false; freezing = null; still.hidden = true; still.removeAttribute('src');
      lastSent = ''; bridge.layout({ visible: false, rect: null });
    },
    /** 位置を測り直す（パネルの幅・広げる・狭い画面の全面表示のあと） */
    sync,
    /** 今開いている会話が変わった（これから開くタブがどの会話のものかを main が覚える） */
    sessionChanged(sessionId) { bridge.command('context', { sessionId: sessionId ?? null }).then(paint).catch(() => {}); },
    async open({ url = '', newTab: fresh = false, reuse = false, source = null } = {}) {
      hooks.openPanel();
      if (url) {
        const next = await run('open', { url, newTab: fresh, ...(reuse ? { reuse } : {}), ...(source ? { source } : {}) }).catch(failed);
        // 同じファイルのタブを使い回して読み直した: そのタブを一瞬だけ光らせて知らせる
        if (next?.reused) { flashTab(next.reused); notify(t('browser.reloaded')); }
      }
      else if (fresh || !state.tabs.length) { await run('newTab').catch(failed); focusAddress(); }
      if (!state.tabs.length) { await run('newTab').catch(failed); focusAddress(); }
    },
    get state() { return state; },
  };
  opener = options => api.open(options);
  return api;
}
