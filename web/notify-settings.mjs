// 設定 › 通知（ADR 0086、docs/design.md「通知」）。
//
// - 「この PC」: 終わったとき・返事が要るとき（承認・質問）・失敗したとき の切り替え。その会話を見ている間は出さない
// - 「スマホ」: ペアリングしたスマホの一覧（端末名・最後に送った時刻・通知のオン/オフ）。切り替えはホスト側で止めるだけで、
//   スマホ側の設定（種類・ロック画面の会話名）はスマホのアプリで変える
//
// 状態はサーバーが持つ（notifyStatus コマンドと、変わるたびに届く notifyStatus イベント）。リモートの窓からも同じ画面が見える。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）とスイッチ（.cx-sw）を使う。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';

/** 最後に送った時刻。今日なら時刻、それより前なら日付。無ければ「まだ送っていません」 */
export function lastSentText(iso, now = Date.now()) {
  if (!iso) return t('settings.notify.phone.never');
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return t('settings.notify.phone.never');
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  const when = sameDay ? fmt.time(at, { hour: '2-digit', minute: '2-digit' })
    : fmt.dateTime(at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return t('settings.notify.phone.lastSent', { when });
}

/**
 * スマホの行の状態。通知を受け取る設定は端末が持ち（devices[].notify.enabled）、ホスト側の停止（muted）はこの画面が切り替える。
 * { on, switchable, hint }。on は実際に届く状態、switchable はこの画面で切り替えられるか
 */
export function phoneState(device) {
  const n = device?.notify ?? {};
  if (!n.registered || !n.enabled) return { on: false, switchable: false, hint: n.registered ? t('settings.notify.phone.offOnPhone') : '' };
  return { on: n.muted !== true, switchable: true, hint: '' };
}

function switchButton(label, on, onclick, disabled = false) {
  const b = el('button', 'cx-sw');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.onclick = onclick;
  return b;
}

/**
 * @param cmd     WS コマンド
 * @param page    設定のページを切り替える（onboarding.page）
 * @param onPc    この PC の設定が届いたとき（通知の判定が使う）
 */
export function setupNotifySettings({ cmd, page, onPc = () => {} }) {
  const $ = id => document.getElementById(id);
  const root = $('notifyPanel');
  let status = null, message = '', busy = false;

  const pcPanel = el('section', 'nf-section nf-pc');
  const phonePanel = el('section', 'nf-section nf-phones');
  const state = el('p', 'mp-state');
  state.setAttribute('role', 'status');
  root.append(pcPanel, phonePanel, state);

  // i18n-dynamic: settings.notify.pc.
  const PC_ROWS = [['done', 'settings.notify.pc.done'], ['reply', 'settings.notify.pc.reply'], ['failed', 'settings.notify.pc.failed']];

  /** 行ごと押せる（スイッチの外を押してもよい）。スイッチは役割と名前を持つ */
  function row(label, sub, control, extra) {
    const r = el('div', 'nf-row');
    const info = el('div', 'nf-info');
    info.append(el('span', 'nf-label', label));
    if (sub) info.append(el('small', null, sub));
    r.append(info);
    if (extra) r.append(extra);
    r.append(control);
    r.onclick = e => { if (e.target !== control && !control.disabled) control.click(); };
    return r;
  }
  const card = (...rows) => { const c = el('div', 'nf-card'); c.append(...rows); return c; };

  async function setPc(key, value) {
    if (busy || !status) return;
    busy = true; message = '';
    try { status = await cmd('setNotifyPc', { [key]: value }); onPc(status.pc); }
    catch (e) { message = e.message; }
    busy = false;
    paint();
  }
  async function setDevice(id, muted) {
    if (busy) return;
    busy = true; message = '';
    try { status = await cmd('setNotifyDevice', { id, muted }); }
    catch (e) { message = e.message; }
    busy = false;
    paint();
  }

  function paint() {
    const pc = status?.pc;
    const rows = PC_ROWS.map(([key, labelKey]) => {
      const label = t(labelKey);
      return row(label, '', switchButton(t('settings.notify.pc.switch', { label }), pc?.[key] !== false, () => setPc(key, pc?.[key] === false), busy || !pc));
    });
    pcPanel.replaceChildren(el('h4', null, t('settings.notify.pc.title')), card(...rows), el('small', 'nf-note', t('settings.notify.pc.viewing')));

    const devices = status?.devices ?? [];
    const out = [el('h4', null, t('settings.notify.phone.title'))];
    const phoneRows = [];
    for (const d of devices) {
      const s = phoneState(d);
      const sub = [lastSentText(d.notify?.lastSentAt), s.hint].filter(Boolean).join(' · ');
      const name = d.name || t('settings.remote.devices.unnamed');
      phoneRows.push(row(name, sub, switchButton(t('settings.notify.phone.switch', { name }), s.on, () => setDevice(d.id, s.on), busy || !s.switchable),
        el('span', s.on ? 'nf-state nf-on' : 'nf-state', s.on ? t('settings.notify.phone.on') : t('settings.notify.phone.off'))));
    }
    out.push(devices.length ? card(...phoneRows) : el('p', 'mp-note', t('settings.notify.phone.empty')));
    if (devices.length && status && status.relayConnected === false) out.push(el('small', 'nf-note', t('settings.notify.phone.noRelay')));
    phonePanel.replaceChildren(...out);
    state.textContent = message;
  }

  async function refresh() {
    try { status = await cmd('notifyStatus'); onPc(status.pc); message = ''; }
    catch (e) { message = e.message; }
    paint();
  }
  function event(ev) {
    if (ev.type !== 'notifyStatus' || !ev.status) return;
    status = ev.status;
    onPc(status.pc);
    paint();
  }

  $('notifyTab').onclick = () => { page('notify'); refresh(); };
  paint();
  return { refresh, event, get status() { return status; } };
}
