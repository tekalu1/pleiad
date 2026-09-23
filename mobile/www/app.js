// The shell's host list and pairing (docs/remote.md §8.2). Talks only to the native PleiadRemote plugin
// (mobile/android/.../PleiadRemotePlugin.kt) and the ML Kit barcode plugin. Plugins come from Capacitor's global proxy
// (no bundler): window.Capacitor.Plugins.X.
(function () {
  const { t, apply, ago } = window.shellI18n;
  const $ = id => document.getElementById(id);
  const Plugins = window.Capacitor?.Plugins ?? {};
  const Remote = Plugins.PleiadRemote;
  const Scanner = Plugins.BarcodeScanner;
  const hosts = new Map();      // hostId -> record (+ state)
  let pairingActive = false;
  let pairHostName = '';

  apply(document);

  function show(view) {
    $('list').hidden = view !== 'list';
    $('pair').hidden = view !== 'pair';
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function errorText(e) {
    const code = e?.code || 'internal';
    return t(`err.${code}`, { detail: e?.message ?? '' }) || t('err.internal', { detail: e?.message ?? code });
  }

  // ── host list ──

  function label(h) { return h.label || h.hostName || h.hostId.slice(0, 8); }

  function stateLine(h) {
    const st = h.state && h.state !== 'closed' && h.state !== 'stopped' ? t(`state.${h.state}`) : '';
    const when = h.lastConnectedAt ? t('hosts.lastUsed', { when: ago(h.lastConnectedAt) }) : t('hosts.neverUsed');
    return { st, when, on: h.state === 'connected' };
  }

  const DOTS = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';

  function render() {
    const box = $('hosts');
    box.replaceChildren();
    const list = [...hosts.values()].sort((a, b) => (b.lastConnectedAt ?? b.pairedAt ?? 0) - (a.lastConnectedAt ?? a.pairedAt ?? 0));
    $('empty').hidden = list.length > 0;
    box.hidden = list.length === 0;
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'host';
      row.setAttribute('role', 'listitem');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = label(h);
      const { st, when, on } = stateLine(h);
      const line = document.createElement('div');
      line.className = 'st';
      const dot = document.createElement('span');
      dot.className = `dot${on ? ' on' : ''}`;
      dot.hidden = !st;
      line.append(dot, document.createTextNode([st, when].filter(Boolean).join(' · ')));
      if (h.state === 'revoked') line.classList.add('warn');
      open.append(nm, line);
      open.onclick = () => openHost(h);
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ib more';
      more.innerHTML = DOTS;
      more.setAttribute('aria-label', t('hosts.more', { host: label(h) }));
      more.onclick = e => { e.stopPropagation(); hostMenu(h, more); };
      row.append(open, more);
      box.append(row);
    }
  }

  async function refresh() {
    if (!Remote) return;
    try {
      const { hosts: list } = await Remote.list();
      hosts.clear();
      for (const h of list) hosts.set(h.hostId, h);
      render();
    } catch (e) { toast(errorText(e)); }
  }

  async function openHost(h) {
    if (h.state === 'revoked') { startPair(); return; }
    try { await Remote.open({ hostId: h.hostId }); } catch (e) { toast(errorText(e)); }
  }

  function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }

  function hostMenu(h, anchor) {
    closeMenus();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    const item = (text, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = text;
      b.onclick = () => { closeMenus(); fn(); };
      menu.append(b);
    };
    item(t('hosts.rename'), async () => {
      const v = window.prompt(t('hosts.renamePrompt'), label(h));
      if (v == null) return;
      try { await Remote.rename({ hostId: h.hostId, label: v }); await refresh(); } catch (e) { toast(errorText(e)); }
    });
    item(t('hosts.remove'), async () => {
      if (!window.confirm(t('hosts.removeConfirm', { host: label(h) }))) return;
      try { await Remote.remove({ hostId: h.hostId }); await refresh(); } catch (e) { toast(errorText(e)); }
    });
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    document.body.append(menu);
    menu.querySelector('button')?.focus();
  }
  document.addEventListener('click', e => { if (!e.target.closest?.('.menu')) closeMenus(); });

  // ── pairing ──

  function pairStep(step) {
    $('pairStart').hidden = step !== 'start';
    $('pairConfirm').hidden = step !== 'confirm';
    $('pairWait').hidden = step !== 'wait';
  }

  function pairError(text) {
    const el = $('pairError');
    el.textContent = text || '';
    el.hidden = !text;
  }

  function startPair() {
    pairError('');
    $('code').value = '';
    $('scanNote').hidden = true;
    pairStep('start');
    show('pair');
  }

  async function scan() {
    pairError('');
    $('scanNote').hidden = true;
    if (!Scanner) { pairError(t('pair.scanFailed')); return; }
    try {
      const perm = await Scanner.requestPermissions();
      if (perm?.camera && perm.camera !== 'granted' && perm.camera !== 'limited') { pairError(t('pair.cameraDenied')); return; }
      const avail = await Scanner.isGoogleBarcodeScannerModuleAvailable().catch(() => ({ available: true }));
      if (!avail.available) {
        Scanner.installGoogleBarcodeScannerModule().catch(() => {});
        $('scanNote').textContent = t('pair.scanUnavailable');
        $('scanNote').hidden = false;
        return;
      }
      const { barcodes } = await Scanner.scan({ formats: ['QR_CODE'] });
      const text = barcodes?.[0]?.rawValue ?? barcodes?.[0]?.displayValue ?? '';
      if (!text) return;   // closed the scanner
      await confirmThenPair(text, { ask: false });
    } catch (e) {
      const msg = String(e?.message ?? '');
      if (/cancel/i.test(msg)) return;
      pairError(/module/i.test(msg) ? t('pair.scanUnavailable') : t('pair.scanFailed'));
    }
  }

  /** Check the payload; ask first when it came from outside the app (a link), then pair. */
  async function confirmThenPair(payload, { ask }) {
    pairError('');
    let info;
    try { info = await Remote.parse({ payload }); } catch (e) { pairStep('start'); show('pair'); pairError(errorText(e)); return; }
    pairHostName = info.hostName || info.hostId.slice(0, 8);
    if (!ask && !info.known) return pair(payload);
    $('confirmName').textContent = pairHostName;
    $('confirmRelay').textContent = info.relayUrl;
    $('confirmKnown').hidden = !info.known;
    $('confirmYes').onclick = () => pair(payload);
    pairStep('confirm');
    show('pair');
  }

  async function pair(payload) {
    if (pairingActive) return;
    pairingActive = true;
    pairError('');
    $('waitLead').textContent = t('pair.connecting');
    $('waitCode').textContent = '';
    $('waitNote').textContent = '';
    pairStep('wait');
    show('pair');
    try {
      const { host } = await Remote.pair({ payload });
      pairingActive = false;
      toast(t('pair.done', { host: host.label || host.hostName || pairHostName }));
      await refresh();
      show('list');
    } catch (e) {
      pairingActive = false;
      pairStep('start');
      if (e?.code !== 'aborted') pairError(errorText(e));
    }
  }

  function onPairCode({ code }) {
    if (!pairingActive || !/^\d{6}$/.test(code ?? '')) return;
    $('waitLead').textContent = t('pair.approveOn', { host: pairHostName });
    $('waitCode').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    $('waitNote').textContent = t('pair.codeNote');
  }

  async function cancelPair() {
    if (pairingActive) { try { await Remote.cancelPair(); } catch {} }
  }

  async function takeLink() {
    try {
      const { payload } = await Remote.takePairLink();
      if (payload) await confirmThenPair(payload, { ask: true });
    } catch {}
  }

  // ── wiring ──

  $('add').onclick = startPair;
  $('scan').onclick = scan;
  $('usePaste').onclick = () => { const v = $('code').value.trim(); if (v) confirmThenPair(v, { ask: false }); };
  $('confirmNo').onclick = () => { pairStep('start'); show('list'); };
  $('pairCancel').onclick = cancelPair;
  $('pairBack').onclick = async () => { await cancelPair(); show('list'); };

  // Android back: close the pairing screen first, then let the app go to the background
  Plugins.App?.addListener?.('backButton', () => { if (!$('pair').hidden) { cancelPair(); show('list'); } else Plugins.App.minimizeApp?.(); });

  if (Remote) {
    Remote.addListener('status', s => {
      const h = hosts.get(s.hostId);
      if (!h) return refresh();
      h.state = s.state;
      if (s.state === 'connected') h.lastConnectedAt = Date.now();
      render();
    });
    Remote.addListener('pairCode', onPairCode);
    Remote.addListener('pairLink', takeLink);
    Remote.info().then(i => { $('plain').hidden = i.encrypted !== false; }).catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh().then(takeLink);
  }
  show('list');
})();
