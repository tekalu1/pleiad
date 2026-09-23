// 設定 › リモート（ホスト側。docs/remote.md §3.3・§6.1・§6.3・§9）。
//
// - 「このホストをリモートから使えるようにする」のスイッチ、中継の URL・登録用の秘密（伏せ字。保存後は表示しない）・ホスト名、状態の一行
// - 「端末を追加」: QR（web/vendor/qrcode-generator.mjs で SVG に描く）・残り時間・コードのコピー・やめる。期限が来たら作り直せる
// - 承認のダイアログ: remotePairing の request で、どの画面にいても出す（差し色の「承認を待っている」と確認コード）
// - 端末一覧と「取り消す」（その場の確認）
// - ホストとして常駐する設定（デスクトップ版のホストだけ。RemoteStatus.resident.available）
//
// 状態はサーバーが持つ（remoteStatus コマンドと、変わるたびに届く remoteStatus イベント）。リモートの窓からも同じ画面が見える。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）とコンテキストのスイッチ（.cx-sw）を使う。
import { el, svgEl } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import qrcode from './vendor/qrcode-generator.mjs';

/** 確認コードを 3 桁ずつに分ける（「482 193」）。6 桁でなければそのまま */
export function formatCode(code) {
  const s = String(code ?? '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s;
}

/** 残り時間（m:ss）。過ぎていれば 0:00 */
export function remaining(expiresAt, now = Date.now()) {
  const sec = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000) || 0);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * QR の点を 1 本の path にする。{ size, d }。size は余白（4 マス）を含む一辺のマス数。
 * 誤り訂正は M（画面から読むので汚れには強くなくてよい。そのぶん点が大きい）
 */
export function qrPath(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  const n = qr.getModuleCount(), quiet = 4;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  return { size: n + quiet * 2, d };
}

/** 中継との接続の一行。{ text, strong }。strong は困っているとき（つながらない） */
export function connectionLine(status, now = Date.now()) {
  const c = status?.connection ?? { state: 'disabled' };
  const online = (status?.devices ?? []).filter(d => d.connected).length;
  switch (c.state) {
    case 'connected':
      return { text: online ? t('settings.remote.state.connectedDevices', { count: online }) : t('settings.remote.state.connected'), strong: false };
    case 'connecting':
      return { text: t('settings.remote.state.connecting'), strong: false };
    case 'retrying': {
      const reason = c.error?.message ? t('settings.remote.state.reason', { reason: c.error.message }) : '';
      const at = c.retryAt && Date.parse(c.retryAt) > now ? t('settings.remote.state.retryAt', { time: fmt.time(c.retryAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : '';
      return { text: t('settings.remote.state.failed') + reason + at, strong: true };
    }
    case 'error':
      return { text: t('settings.remote.state.failed') + (c.error?.message ? t('settings.remote.state.reason', { reason: c.error.message }) : ''), strong: true };
    default:
      return { text: t('settings.remote.state.disabled'), strong: false };
  }
}

/** 端末の種類の名前。知らない値はそのまま */
export function platformName(platform) {
  const key = String(platform ?? '').toLowerCase();
  // i18n-dynamic: settings.remote.platform.
  return ['desktop', 'ios', 'android'].includes(key) ? t(`settings.remote.platform.${key}`) : String(platform ?? '');
}

/** 端末の行の補足（種類 · 追加した日 · 最後に使った時刻） */
export function deviceLine(device, now = Date.now()) {
  const parts = [];
  const kind = platformName(device.platform);
  if (kind) parts.push(kind);
  if (device.createdAt) parts.push(t('settings.remote.devices.added', { date: fmt.dateTime(device.createdAt, { year: 'numeric', month: 'numeric', day: 'numeric' }) }));
  parts.push(device.lastSeenAt ? t('settings.remote.devices.lastSeen', { when: fmt.relative(device.lastSeenAt, now) }) : t('settings.remote.devices.neverSeen'));
  return parts.join(' · ');
}

function button(text, onclick, className = 'btn') {
  const b = el('button', className, text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

function field(labelText, input) {
  const label = el('label', 'mp-field');
  label.append(el('span', null, labelText), input);
  return label;
}

function input({ type = 'text', placeholder = '', autocomplete = 'off' } = {}) {
  const i = document.createElement('input');
  i.type = type; i.placeholder = placeholder; i.autocomplete = autocomplete; i.spellcheck = false;
  return i;
}

/**
 * @param cmd  WS コマンド
 * @param page 設定のページを切り替える（onboarding.page）
 */
export function setupRemote({ cmd, page }) {
  const $ = id => document.getElementById(id);
  const root = $('remotePanel');
  /** 最後に届いた RemoteStatus */
  let status = null;
  /** 表示中のペアリング { payload, expiresAt } と、その終わり方（null | 'expired' | 'connecting'） */
  let offer = null, offerEnd = null, tick = null;
  /** message は状態の一行に出す失敗、notice は端末の欄の下に出す知らせ（追加した・取り消した・失敗） */
  let confirming = '', busy = false, message = '', notice = '';

  // ---- 骨組み（一度だけ作る。中身は paint で入れ替える）
  const sw = button('', () => toggle(), 'cx-sw');
  sw.id = 'remoteEnable';
  sw.setAttribute('role', 'switch');
  const swLabel = el('label', 'rm-switch-label', t('settings.remote.enable'));
  swLabel.htmlFor = 'remoteEnable';
  sw.setAttribute('aria-label', t('settings.remote.enable'));
  const head = el('div', 'rm-switch');
  head.append(swLabel, sw);
  const stateLine = el('p', 'rm-state');
  stateLine.setAttribute('role', 'status');
  stateLine.setAttribute('aria-live', 'polite');

  // 中継
  const relay = el('form', 'mp-panel rm-relay');
  const relayUrl = input({ type: 'url', placeholder: 'https://relay.example.com' });
  const secret = input({ type: 'password', autocomplete: 'new-password' });
  const hostName = input();
  const relayUrlField = field(t('settings.remote.relay.url'), relayUrl);
  const secretField = field(t('settings.remote.relay.secret'), secret);
  const hostField = field(t('settings.remote.relay.hostName'), hostName);
  const relayUrlNote = el('small'), secretNote = el('small');
  relayUrlField.append(relayUrlNote); secretField.append(secretNote);
  const storageNote = el('p', 'mp-warn rm-storage');
  const save = button(t('settings.remote.relay.save'), null);
  save.type = 'submit';
  const relayState = el('p', 'mp-state');
  relayState.setAttribute('role', 'status');
  const relayActions = el('div', 'mp-actions');
  relayActions.append(save);
  relay.append(el('h3', null, t('settings.remote.relay.title')), relayUrlField, secretField, hostField, storageNote, relayActions, relayState);
  for (const i of [relayUrl, secret, hostName]) i.oninput = () => paintSave();
  relay.onsubmit = e => { e.preventDefault(); if (!save.disabled) saveRelay(); };

  // 端末
  const devicesPanel = el('section', 'mp-panel rm-devices-panel');
  const devicesHead = el('h3', null, t('settings.remote.devices.title'));
  const list = el('div', 'rm-devices');
  const add = button(t('settings.remote.pair.add'), () => startPairing(), 'btn btn-primary');
  const addHint = el('small', 'rm-add-hint');
  const addRow = el('div', 'rm-add');
  addRow.append(add, addHint);
  const pairCard = el('section', 'mp-card rm-pair');
  pairCard.hidden = true;
  pairCard.setAttribute('aria-live', 'polite');
  const pairMessage = el('p', 'mp-state rm-pair-message');
  pairMessage.setAttribute('role', 'status');
  const loginNote = el('p', 'mp-note rm-login-note', t('settings.remote.loginOnHost'));

  // 常駐（デスクトップ版のホストだけ）
  const resident = el('section', 'mp-panel rm-resident');
  const keep = document.createElement('input');
  keep.type = 'checkbox'; keep.id = 'remoteKeepRunning';
  const keepLabel = el('label', 'mp-check');
  keepLabel.append(keep, el('span', null, t('settings.remote.resident.keepRunning')));
  const sleepSeg = el('div', 'seg sec rm-sleep');
  sleepSeg.setAttribute('role', 'group');
  sleepSeg.setAttribute('aria-label', t('settings.remote.resident.sleep'));
  const SLEEP = [['working', t('settings.remote.resident.sleepWorking')], ['always', t('settings.remote.resident.sleepAlways')], ['off', t('settings.remote.resident.sleepOff')]];
  for (const [value, text] of SLEEP) {
    const b = button(text, () => setResident({ sleep: value }), '');
    b.dataset.sleep = value;
    sleepSeg.append(b);
  }
  const residentState = el('p', 'mp-state');
  residentState.setAttribute('role', 'status');
  resident.append(el('h3', null, t('settings.remote.resident.title')), keepLabel,
    el('p', 'rm-sub', t('settings.remote.resident.sleep')), sleepSeg, residentState);
  keep.onchange = () => setResident({ keepRunning: keep.checked });

  // ほかのホストにつなぐ（デスクトップ版の端末の機能。ローカルの窓だけ。desktop/remote-hosts.html）
  const others = el('div', 'rm-others');
  if (window.plyDesktop?.openRemoteHosts && !window.plyRemote) {
    others.append(button(t('settings.remote.otherHosts'), () => window.plyDesktop.openRemoteHosts(), 'btn btn-quiet'));
  }

  devicesPanel.append(devicesHead, list, addRow, pairCard, pairMessage);
  root.append(head, stateLine, relay, devicesPanel, loginNote, resident, others);

  // ---- 承認のダイアログ（どの画面にいても出す）
  const dialog = document.createElement('dialog');
  dialog.className = 'rm-dialog';
  dialog.id = 'remotePairDialog';
  dialog.setAttribute('aria-labelledby', 'remotePairTitle');
  document.body.append(dialog);
  /** ダイアログに出している承認待ちの id */
  let asking = '';
  dialog.addEventListener('cancel', e => e.preventDefault());   // Esc で黙って閉じない（決めるまで残す）

  // ---- 描く
  function paint() {
    const s = status;
    const on = s?.enabled === true;
    sw.setAttribute('aria-checked', String(on));
    sw.disabled = busy || !s;
    const line = s ? connectionLine(s) : { text: t('settings.remote.state.loading'), strong: false };
    stateLine.textContent = message || line.text;
    stateLine.classList.toggle('rm-strong', Boolean(message) || line.strong);

    if (s) {
      if (document.activeElement !== relayUrl && !relayUrl.dataset.dirty) relayUrl.value = s.relayUrlFromEnv ? '' : s.relayUrl ?? '';
      relayUrl.placeholder = s.relayUrlFromEnv ? s.relayUrl : 'https://relay.example.com';
      relayUrlNote.textContent = s.relayUrlFromEnv ? t('settings.remote.relay.urlFromEnv') : '';
      secret.placeholder = s.hasEnrollSecret && !s.enrollSecretFromEnv ? t('settings.remote.relay.secretSaved') : '';
      secretNote.textContent = s.enrollSecretFromEnv ? t('settings.remote.relay.secretFromEnv') : '';
      if (document.activeElement !== hostName && !hostName.dataset.dirty) hostName.value = s.hostName ?? '';
      storageNote.textContent = s.storage && s.storage.encrypted === false ? `⚠ ${t('settings.remote.relay.notEncrypted')}` : '';
      storageNote.hidden = !storageNote.textContent;
    }
    pairMessage.textContent = notice;
    paintSave();
    paintDevices();
    paintPairing();
    paintResident();
    paintDialog();
  }

  function dirty() {
    if (!status) return false;
    const url = relayUrl.value.trim(), host = hostName.value.trim();
    return (url !== (status.relayUrlFromEnv ? '' : status.relayUrl ?? '')) || secret.value !== '' || host !== (status.hostName ?? '');
  }
  function paintSave() {
    const d = dirty();
    relayUrl.dataset.dirty = d && relayUrl.value.trim() !== (status?.relayUrlFromEnv ? '' : status?.relayUrl ?? '') ? '1' : '';
    hostName.dataset.dirty = d && hostName.value.trim() !== (status?.hostName ?? '') ? '1' : '';
    save.disabled = busy || !d;
  }
  /** 保存する欄の差分。変えていない欄は送らない（秘密は空なら今の値を残す） */
  function relayPatch() {
    const patch = {};
    const url = relayUrl.value.trim(), host = hostName.value.trim();
    if (url !== (status?.relayUrlFromEnv ? '' : status?.relayUrl ?? '')) patch.relayUrl = url;
    if (host !== (status?.hostName ?? '')) patch.hostName = host;
    if (secret.value !== '') patch.enrollSecret = secret.value.trim();
    return patch;
  }

  function paintDevices() {
    const devices = status?.devices ?? [];
    const out = [];
    if (!devices.length) out.push(el('p', 'mp-note rm-empty', t('settings.remote.devices.empty')));
    for (const d of devices) {
      const card = el('div', 'mp-card rm-device');
      const row = el('div', 'mp-row');
      const info = el('div', 'mp-card-info');
      const name = el('strong', null, d.name || t('settings.remote.devices.unnamed'));
      info.append(name, el('small', null, deviceLine(d)));
      const state = el('span', d.connected ? 'rm-online' : 'rm-offline', d.connected ? t('settings.remote.devices.online') : t('settings.remote.devices.offline'));
      const actions = el('div', 'mp-card-actions');
      actions.append(state, button(t('settings.remote.devices.revoke'), () => { confirming = d.id; paintDevices(); }));
      actions.hidden = confirming === d.id;
      row.append(info, actions);
      card.append(row);
      if (confirming === d.id) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, t('settings.remote.devices.revokeConfirm', { name: d.name || t('settings.remote.devices.unnamed') })));
        const buttons = el('div', 'mp-card-actions');
        buttons.append(button(t('settings.remote.devices.keep'), () => { confirming = ''; paintDevices(); }),
          button(t('settings.remote.devices.revokeConfirmButton'), () => revoke(d)));
        ask.append(buttons);
        card.append(ask);
      }
      out.push(card);
    }
    list.replaceChildren(...out);
    const connected = status?.enabled && status.connection?.state === 'connected';
    add.disabled = busy || !connected || Boolean(offer && !offerEnd);
    addHint.textContent = !status?.enabled ? t('settings.remote.pair.needEnable') : !connected ? t('settings.remote.pair.needConnected') : '';
    addRow.hidden = Boolean(offer);
  }

  function paintPairing() {
    if (!offer) { pairCard.hidden = true; stopTick(); return; }
    pairCard.hidden = false;
    const out = [el('h3', null, t('settings.remote.pair.title'))];
    if (offerEnd === 'connecting') {
      out.push(el('p', null, t('settings.remote.pair.connecting')));
      out.push(actionRow(button(t('settings.remote.pair.close'), () => closeOffer())));
    } else if (offerEnd === 'expired') {
      out.push(el('p', 'mp-warn', t('settings.remote.pair.expired')));
      out.push(actionRow(button(t('settings.remote.pair.close'), () => closeOffer()), button(t('settings.remote.pair.again'), () => startPairing(), 'btn btn-primary')));
    } else {
      const body = el('div', 'rm-pair-body');
      const figure = el('div', 'rm-qr');
      const { size, d } = qrPath(offer.payload);
      const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': t('settings.remote.pair.qrLabel'), 'shape-rendering': 'crispEdges' });
      svg.append(svgEl('rect', { class: 'rm-qr-bg', width: size, height: size }), svgEl('path', { class: 'rm-qr-fg', d }));
      figure.append(svg);
      const side = el('div', 'rm-pair-side');
      const left = el('p', 'rm-left');
      left.id = 'remotePairLeft';
      side.append(left, el('p', 'rm-pair-hint', t('settings.remote.pair.hint')),
        el('p', 'mp-warn', `⚠ ${t('settings.remote.fullAccess')}`));
      const code = el('code', 'rm-payload', offer.payload);
      const copy = button(t('settings.remote.pair.copy'), () => copyPayload(copy));
      const codeRow = el('div', 'rm-code-row');
      codeRow.append(code, copy);
      side.append(codeRow);
      body.append(figure, side);
      out.push(body, actionRow(button(t('settings.remote.pair.cancel'), () => cancelPairing())));
      startTick();
    }
    pairCard.replaceChildren(...out);
    paintLeft();
  }
  function actionRow(...buttons) {
    const row = el('div', 'mp-actions');
    row.append(...buttons);
    return row;
  }
  function paintLeft() {
    const left = $('remotePairLeft');
    if (!left || !offer) return;
    left.textContent = t('settings.remote.pair.left', { time: remaining(offer.expiresAt) });
    if (Date.parse(offer.expiresAt) <= Date.now() && !offerEnd) { offerEnd = 'expired'; paintPairing(); paintDevices(); }
  }
  function startTick() { if (!tick) tick = setInterval(paintLeft, 1000); }
  function stopTick() { clearInterval(tick); tick = null; }

  function paintResident() {
    const r = status?.resident;
    resident.hidden = !r?.available;
    if (!r?.available) return;
    keep.checked = r.keepRunning;
    keep.disabled = busy;
    for (const b of sleepSeg.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.sleep === r.sleep);
      b.setAttribute('aria-pressed', String(b.dataset.sleep === r.sleep));
      b.disabled = busy;
    }
  }

  // ---- 承認のダイアログ
  function paintDialog() {
    const requests = status?.pairing?.requests ?? [];
    const current = requests.find(r => r.id === asking) ?? requests[0];
    if (!current) {
      asking = '';
      if (dialog.open) dialog.close();
      return;
    }
    if (current.id === asking && dialog.open) return;
    asking = current.id;
    const name = current.name || t('settings.remote.devices.unnamed');
    const kind = el('p', 'rm-dialog-kind');
    kind.append(el('span', 'card-kind', `◆ ${t('settings.remote.approve.mark')}`));
    const title = el('h2', null, t('settings.remote.approve.title', { name }));
    title.id = 'remotePairTitle';
    const codeLabel = el('p', 'rm-dialog-label', t('settings.remote.approve.codeLabel'));
    const code = el('p', 'rm-dialog-code', formatCode(current.code));
    const meta = [platformName(current.platform), current.app].filter(Boolean).join(' · ');
    const state = el('p', 'mp-state rm-dialog-state');
    state.setAttribute('role', 'status');
    const deny = button(t('settings.remote.approve.deny'), () => decide(current, false, state), 'btn btn-quiet');
    const approve = button(t('settings.remote.approve.approve'), () => decide(current, true, state), 'btn btn-primary');
    const actions = el('div', 'rm-dialog-actions');
    actions.append(deny, approve);
    dialog.replaceChildren(kind, title, ...(meta ? [el('p', 'rm-dialog-meta', meta)] : []), codeLabel, code,
      el('p', 'rm-dialog-hint', t('settings.remote.approve.hint')), el('p', 'rm-dialog-hint', t('settings.remote.fullAccess')), state, actions);
    if (!dialog.open) dialog.showModal();
    deny.focus();   // 既定の居場所は「拒否」（Enter の押し間違いで承認しない）
  }
  async function decide(request, yes, state) {
    for (const b of dialog.querySelectorAll('button')) b.disabled = true;
    try {
      if (yes) {
        const device = await cmd('remotePairingApprove', { id: request.id });
        notice = t('settings.remote.approve.added', { name: device?.name || request.name || '' });
      } else {
        await cmd('remotePairingDeny', { id: request.id });
        notice = '';
      }
      if (status) status = { ...status, pairing: { ...status.pairing, requests: status.pairing.requests.filter(r => r.id !== request.id) } };
      asking = '';
      paint();
    } catch (e) {
      state.textContent = e.message;
      for (const b of dialog.querySelectorAll('button')) b.disabled = false;
    }
  }

  // ---- 操作
  /** 操作を 1 つずつ。失敗の理由は fail へ（既定は状態の一行） */
  async function run(fn, fail = text => { message = text; }) {
    if (busy) return;
    busy = true; message = ''; paint();
    try { await fn(); }
    catch (e) { fail(e.message); }
    finally { busy = false; paint(); }
  }
  const failNotice = text => { notice = text; };
  function toggle() {
    const next = !(status?.enabled === true);
    relayState.textContent = '';
    return run(async () => {
      // 有効にするときは、入力したまま保存していない中継の設定も一緒に送る（押す順番で失敗させない）
      status = await cmd('setRemoteSettings', { ...(next ? relayPatch() : {}), enabled: next });
      if (next) clearInputs();
    });
  }
  function saveRelay() {
    relayState.textContent = '';
    return run(async () => {
      status = await cmd('setRemoteSettings', relayPatch());
      clearInputs();
      relayState.textContent = t('settings.remote.relay.saved');
    }, text => { relayState.textContent = text; });
  }
  function clearInputs() {
    secret.value = '';
    relayUrl.dataset.dirty = ''; hostName.dataset.dirty = '';
    relayUrl.value = status?.relayUrlFromEnv ? '' : status?.relayUrl ?? '';
    hostName.value = status?.hostName ?? '';
  }
  function startPairing() {
    notice = '';
    return run(async () => {
      const r = await cmd('remotePairingStart');
      offer = { payload: r.payload, expiresAt: r.expiresAt };
      offerEnd = null;
      paint();
      pairCard.scrollIntoView?.({ block: 'nearest' });
    }, failNotice);
  }
  function cancelPairing() {
    const had = offer;
    offer = null; offerEnd = null;
    paint();
    if (had) cmd('remotePairingCancel').then(s => { status = s; paint(); }).catch(e => { notice = e.message; paint(); });
  }
  function closeOffer() { offer = null; offerEnd = null; paint(); }
  function revoke(device) {
    return run(async () => {
      status = await cmd('remoteRevoke', { id: device.id });
      confirming = '';
      notice = t('settings.remote.devices.revoked', { name: device.name || '' });
    }, failNotice);
  }
  function setResident(patch) {
    residentState.textContent = '';
    return run(async () => { status = await cmd('setRemoteResident', patch); }, text => { residentState.textContent = text; });
  }
  async function copyPayload(b) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(offer?.payload ?? '');
      b.textContent = t('settings.remote.pair.copied');
    } catch {
      // コピーできないときは文字列を選んでおく（手でコピーできる）
      const code = pairCard.querySelector('.rm-payload');
      if (code) { const range = document.createRange(); range.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(range); }
      b.textContent = t('settings.remote.pair.copyFailed');
    }
    clearTimeout(b.resetTimer);
    b.resetTimer = setTimeout(() => { b.textContent = t('settings.remote.pair.copy'); }, 1800);
  }

  // ---- サーバーから
  async function refresh() {
    try { status = await cmd('remoteStatus'); }
    catch (e) { message = e.message; }
    paint();
  }
  function event(ev) {
    if (ev.type === 'remoteStatus') {
      status = ev.status ?? status;
      // 表示中の QR の入場券が無くなった。期限なら「作り直す」、ほかの画面で取り下げたなら閉じる
      // （使われたときは先に remotePairing の connecting が届いている）
      if (offer && !offerEnd && !status?.pairing?.offer) {
        if (Date.parse(offer.expiresAt) <= Date.now() + 1000) offerEnd = 'expired';
        else { offer = null; }
      }
      paint();
      return;
    }
    if (ev.type === 'remotePairing') {
      if (ev.phase === 'connecting' && offer) offerEnd = 'connecting';
      if (ev.phase === 'request') {
        // 承認待ちに移ったら QR の面は用済み
        if (offerEnd === 'connecting') { offer = null; offerEnd = null; }
        if (status && ev.request && !status.pairing.requests.some(r => r.id === ev.request.id)) {
          status = { ...status, pairing: { ...status.pairing, requests: [...status.pairing.requests, ev.request] } };
        }
      }
      if (ev.phase === 'expired' && !ev.request && offer && !offerEnd) offerEnd = 'expired';
      if (ev.phase === 'cancelled' || (ev.phase === 'expired' && ev.request)) {
        if (offerEnd === 'connecting') { offer = null; offerEnd = null; }
        notice = ev.phase === 'cancelled' ? t('settings.remote.approve.cancelled') : t('settings.remote.approve.expired');
      }
      if (ev.phase === 'approved' && ev.device) notice = t('settings.remote.approve.added', { name: ev.device.name || '' });
      if (ev.phase === 'denied') notice = t('settings.remote.approve.denied');
      if (ev.request && ev.phase !== 'request' && status) {
        status = { ...status, pairing: { ...status.pairing, requests: status.pairing.requests.filter(r => r.id !== ev.request.id) } };
      }
      paint();
    }
  }

  $('remoteTab').onclick = () => { page('remote'); refresh(); };
  paint();
  return { refresh, event, get status() { return status; } };
}
