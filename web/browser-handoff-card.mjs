// Chrome の操作待ちのカード（permission の browserHandoff。core/chrome/handoff.mjs、ADR 0148・0168）。
// 接続の案内（reason: connect。setup / permission / denied）と、人への依頼（asked → operating）の 2 種類を 1 枚で描く。
// client.mjs は枠（見出し・置き場・名簿への登録）を作り、中身とボタンはここが持つ。
// 決着（戻した・つながった・断った・中断）はサーバーの permissionSettled で届き、畳む字は settledLine が決める。
// リモートの端末（client が operateHere を渡す）では「Chrome で操作する」を「この端末で操作する」（右パネルの Chrome の窓で操作する。by: 'device'）と
// 「PC で操作する」に分ける（第 7 段）。

const CHROME_INSPECT_ADDRESS = 'chrome://inspect/#remote-debugging';
// i18n-dynamic: ui:chat.browserHandoff.
const K = 'chat.browserHandoff.';
const S = 'settings.browser.agentBrowser.';

const REASONS = ['login', 'captcha', 'two_factor', 'payment', 'other'];

/** 依頼の種類の字（login ほか）。知らない値は other */
export const reasonLabel = (t, reason) => t(`${K}reason.${REASONS.includes(reason) ? reason : 'other'}`);

/** カードの見出しの 1 行（一覧・通知・畳んだ後の要約に使う） */
export function handoffSummary(t, h) {
  return h.reason === 'connect' ? t(`${K}connect.lead`) : t(`${K}askedLead`, { reason: reasonLabel(t, h.reason) });
}

/** 決着の 1 行。ev は permissionSettled のイベント（allow・reason・response） */
export function settledLine(t, ev) {
  const r = ev?.response;
  if (ev?.allow === true && r?.kind === 'connected') return t(`${K}done.${r.continued ? 'connectedContinued' : 'connected'}`);
  if (ev?.allow === true) return t(`${K}done.${r?.continued ? 'resumedContinued' : 'resumed'}`);
  if (ev?.reason === 'aborted') return t(`${K}done.aborted`);
  return t(`${K}done.declined`);
}

/**
 * 本文とボタンを作る。
 *   view = browserHandoffView(ev, { el, t, cmd, operateHere })
 *   view.body      … 本文の要素（差し替えで中身が替わる）
 *   view.buttons   … 今のボタン（actions へ並べる）。replaceButtons の呼び出しで並べ直す
 *   view.update(h) … permissionUpdate の browserHandoff を渡して描き直す
 * onChange(buttons, res) は描き直すたびに呼ばれ、client が actions を並べ直す。
 * operateHere() はリモートの端末だけ: 右パネルの Chrome の窓を開き、映像の箱の大きさ（{ width, height, scale }。開けなければ null）を返す
 */
export function browserHandoffView(ev, { el, t, cmd, onChange = () => {}, operateHere = null }) {
  let h = ev.browserHandoff;
  const targetSessionId = () => h.targetSessionId ?? ev.targetSessionId ?? ev.sessionId;
  const body = el('div', 'bh-body');
  const res = el('span', 'res');
  let buttons = [];
  let busy = false;

  const fail = err => {
    if (err?.code === 'ALREADY_RESOLVED') return;
    res.className = 'res fail';
    res.setAttribute('role', 'alert');
    res.replaceChildren(`✕ ${t(`${K}failed`, { error: err?.message ?? String(err) })}`);
  };
  /** 押したら応答まで止め、失敗したら押す前の形に戻す。成功の畳みはサーバーの決着の便りが行う（操作によっては先に届く） */
  const run = (button, work) => async () => {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    res.className = 'res';
    res.removeAttribute('role');
    res.replaceChildren();
    try { await work(); } catch (err) { fail(err); }
    busy = false;
    paint();   // 押している間に届いた差し替えも、ここで反映する
  };
  const button = (label, work, cls = 'btn') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = run(b, work);
    return b;
  };
  const decline = () => button(t(`${K}decline`), () => cmd('resolvePermission', { id: ev.id, allow: false, always: false, messageKey: 'userDenied' }), 'btn btn-quiet');
  const note = text => el('p', 'browser-setting-note', text);

  function paintConnect() {
    const lead = el('div', 'bh-lead');
    if (h.state === 'setup') {
      lead.textContent = t(`${S}setup.status`);
      const steps = el('ol', 'browser-conn-steps');
      const one = el('li'); one.append(el('span', 'n', '1'), el('span', null, t(`${S}setup.step1`)), el('code', null, CHROME_INSPECT_ADDRESS));
      const two = el('li'); two.append(el('span', 'n', '2'), el('span', null, t(`${S}setup.step2`)));
      steps.append(one, two);
      body.replaceChildren(lead, steps, note(t(`${S}setup.note`)));
      buttons = [decline()];
    } else if (h.state === 'denied') {
      lead.textContent = t(`${S}denied.status`);
      body.replaceChildren(lead);
      buttons = [decline(), button(t(`${S}denied.retry`), () => cmd('chromeConnect'), 'btn btn-primary')];
    } else {
      lead.textContent = t(`${S}permission.status`);
      body.replaceChildren(lead, note(t(`${S}permission.note`)));
      buttons = [decline(), ...(h.dialog ? [button(t(`${S}permission.raise`), () => cmd('chromeRaiseDialog'), 'btn btn-primary')] : [])];
    }
  }

  function paintRequest() {
    const lead = el('div', 'bh-lead');
    if (h.state === 'operating') {
      lead.textContent = t(`${K}operating`);
      const where = h.by !== 'device' ? t(`${K}operatingNote`) : operateHere ? t(`${K}operatingOnDevice`) : t(`${K}operatingByDevice`);
      body.replaceChildren(lead, note(where));
      buttons = [button(t(h.turnLive === false ? `${K}resumeContinue` : `${K}resume`), () => cmd('chromeResume', { sessionId: targetSessionId() }), 'btn btn-primary')];
    } else {
      lead.textContent = t(`${K}askedLead`, { reason: reasonLabel(t, h.reason) });
      body.replaceChildren(lead);
      if (h.message) body.append(el('p', 'bh-message', h.message));
      buttons = operateHere
        ? [decline(), button(t(`${K}operateOnPc`), () => cmd('chromeTakeOver', { sessionId: targetSessionId() })), button(t(`${K}operateHere`), takeOverHere, 'btn btn-primary')]
        : [decline(), button(t(`${K}operate`), () => cmd('chromeTakeOver', { sessionId: targetSessionId() }), 'btn btn-primary')];
    }
    if (h.waitingTasks?.length > 1) {
      const list = el('ul', 'bh-waiting-tasks');
      for (const task of h.waitingTasks) {
        const item = el('li', task.current ? 'current' : null, task.title || task.taskId || '');
        // 操作に開く窓は一つだけ。どの子の窓かを字でも示す（終わると次の子の窓に替わる）
        if (task.current) item.append(el('small', 'bh-current', ` · ${t(`${K}waitingCurrent`)}`));
        list.append(item);
      }
      body.append(list);
    }
    if (h.windowTitle) body.append(el('small', 'bh-window', h.windowTitle));
  }

  async function takeOverHere() {
    const size = await operateHere();
    if (!size) throw new Error(t(`${K}noWindow`));
    await cmd('chromeTakeOver', { sessionId: targetSessionId(), by: 'device', ...size });
  }

  function paint() {
    if (h.reason === 'connect') paintConnect(); else paintRequest();
    onChange(buttons, res);
  }
  paint();

  return {
    body,
    res,
    get buttons() { return buttons; },
    summary: () => handoffSummary(t, h),
    update(next) {
      if (!next) return;
      h = { ...h, ...next };
      if (!busy) paint();
    },
  };
}
