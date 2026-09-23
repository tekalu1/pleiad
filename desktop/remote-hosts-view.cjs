// ほかのホストにつなぐ窓（desktop/remote-hosts.html）の画面。ふつうの script として読む（file: ではモジュールを読めないため）。
// Node（tests/unit/desktop-remote.mjs）から require したときは、描く前の純粋な部品だけを返す。
(function () {
  /** 辞書を引く。キーは desktop の名前空間の中の道（remote.hosts.open。HTML の data-i18n は desktop: を付けて書く）。{{name}} を埋める。無ければキー */
  function translator(strings) {
    return function t(key, vars) {
      const value = String(key).replace(/^desktop:/, '').split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), strings);
      if (typeof value !== 'string') return key;
      return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => (vars && vars[name] != null ? String(vars[name]) : ''));
    };
  }

  /** 一覧の 1 行に出すもの。host は desktop/remote-windows.cjs の hostRow */
  function hostLine(host, t, formatDate) {
    const state = ['connected', 'connecting', 'offline', 'host-offline', 'revoked', 'closed', 'stopped'].includes(host.state) ? host.state : 'closed';
    // i18n-dynamic: remote.hosts.state.
    const stateText = t(`remote.hosts.state.${state}`);
    const parts = [stateText];
    if (host.windowOpen) parts.push(t('remote.hosts.windowOpen'));
    else if (host.lastConnectedAt) parts.push(t('remote.hosts.lastConnected', { when: formatDate(host.lastConnectedAt) }));
    else if (state !== 'revoked') parts.push(t('remote.hosts.neverConnected'));
    return {
      name: host.name || host.hostId,
      detail: parts.join(' · '),
      // 色だけに意味を持たせない: 丸（オンライン）/ 中抜き（それ以外）と文字の両方
      dot: state === 'connected' ? 'on' : 'off',
      canOpen: state !== 'revoked',
      revoked: state === 'revoked',
      relay: host.relay || '',
    };
  }

  const api = { translator, hostLine };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  // ---------------------------------------------------------------- 画面
  const bridge = window.plyHosts;
  const $ = id => document.getElementById(id);
  let t = translator({}), lang = 'en', hosts = [], editing = null, confirming = null, busy = new Set();
  const formatDate = iso => {
    try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return String(iso); }
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (text, cls, onclick) => { const b = el('button', cls || 'btn', text); b.type = 'button'; b.onclick = onclick; return b; };

  function applyStrings() {
    document.documentElement.lang = lang;
    for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const n of document.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
    for (const n of document.querySelectorAll('[data-i18n-aria-label]')) n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel));
    document.title = t('remote.hosts.windowTitle');
  }

  function render() {
    const list = $('hosts');
    list.replaceChildren(...hosts.map(host => {
      const line = hostLine(host, t, formatDate);
      const li = el('li', 'host');
      li.dataset.hostId = host.hostId;
      const info = el('div', 'info');
      const st = el('div', 'st');
      st.append(el('span', 'dot ' + line.dot), el('span', null, line.detail));
      info.append(el('div', 'nm', line.name), st);
      if (line.relay) info.title = line.relay;
      const acts = el('div', 'acts');
      const open = button(busy.has(host.hostId) ? t('remote.hosts.opening') : t('remote.hosts.open'), 'btn btn-quiet', () => openHost(host.hostId));
      open.disabled = !line.canOpen || busy.has(host.hostId);
      acts.append(open,
        button(t('remote.hosts.rename'), 'btn', () => { editing = host.hostId; confirming = null; render(); }),
        button(t('remote.hosts.remove'), 'btn', () => { confirming = host.hostId; editing = null; render(); }));
      li.append(info, acts);
      if (line.revoked) li.append(el('p', 'weak sub', t('remote.hosts.revokedHint')));
      if (editing === host.hostId) li.append(renameLine(host, line.name));
      if (confirming === host.hostId) li.append(removeLine(host, line.name));
      return li;
    }));
    $('empty').hidden = hosts.length > 0;
    const input = list.querySelector('.sub input');
    if (input) { input.focus(); input.select(); }
  }

  function renameLine(host, name) {
    const box = el('div', 'sub');
    const input = el('input');
    input.value = host.label || name;
    input.setAttribute('aria-label', t('remote.hosts.renameLabel'));
    input.maxLength = 80;
    const save = async () => {
      const r = await bridge.rename(host.hostId, input.value.trim());
      if (!r.ok) { $('loadError').textContent = r.message; $('loadError').hidden = false; }
      editing = null; await refresh();
    };
    input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } if (e.key === 'Escape') { editing = null; render(); } };
    box.append(input, button(t('remote.hosts.renameSave'), 'btn btn-quiet', save), button(t('remote.hosts.cancel'), 'btn', () => { editing = null; render(); }));
    return box;
  }

  function removeLine(host, name) {
    const box = el('div', 'sub');
    box.append(el('p', null, t('remote.hosts.removeConfirm', { host: name })),
      button(t('remote.hosts.removeYes'), 'btn btn-quiet', async () => {
        const r = await bridge.remove(host.hostId);
        if (!r.ok) { $('loadError').textContent = r.message; $('loadError').hidden = false; }
        confirming = null; await refresh();
      }),
      button(t('remote.hosts.cancel'), 'btn', () => { confirming = null; render(); }));
    return box;
  }

  async function openHost(hostId) {
    busy.add(hostId); render();
    const r = await bridge.open(hostId);
    busy.delete(hostId);
    $('loadError').hidden = r.ok;
    if (!r.ok) $('loadError').textContent = r.message;
    await refresh();
  }

  async function refresh() {
    const r = await bridge.list();
    if (r.ok) { hosts = r.hosts; $('loadError').hidden = true; }
    render();
  }

  function pairing(active) {
    $('pairCard').hidden = !active;
    $('pairSubmit').disabled = active;
    $('payload').disabled = active;
    if (active) { $('pairStatus').textContent = t('remote.hosts.add.connecting'); $('codeBox').hidden = true; $('code').textContent = ''; }
  }

  $('pairForm').onsubmit = async e => {
    e.preventDefault();
    const payload = $('payload').value.trim();
    if (!payload) { $('payload').focus(); return; }
    $('pairResult').textContent = '';
    pairing(true);
    const r = await bridge.pair(payload);
    pairing(false);
    if (r.ok) {
      $('payload').value = '';
      $('pairResult').textContent = t('remote.hosts.add.done', { host: r.host.name });
      await refresh();
    } else if (r.code !== 'aborted') {
      $('pairResult').textContent = r.message;
    }
    $('payload').focus();
  };
  $('cancelPair').onclick = () => { bridge.cancelPair(); };
  bridge.onCode(code => {
    $('pairStatus').textContent = t('remote.hosts.add.waiting');
    $('code').textContent = code;
    $('codeBox').hidden = false;
  });
  bridge.onChange(list => { hosts = list; render(); });

  bridge.init().then(r => {
    t = translator(r.strings || {});
    lang = r.lang || 'en';
    applyStrings();
    if (r.ok) { hosts = r.hosts; $('storage').hidden = r.encrypted !== false; }
    else { $('loadError').textContent = t('remote.hosts.loadFailed', { error: r.message }); $('loadError').hidden = false; }
    render();
    $('payload').focus();
  });
})();
