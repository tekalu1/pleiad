// 端末の依頼元に出る、ホストの Chrome の操作待ちのカード（docs/remote.md §4.5・docs/design-system.md §4.5、ADR 0204）。
// ホストの子が Chrome の準備・許可・操作を待っている間、依頼元の会話に 1 会話 1 枚だけ出る。
// 最初の 1 行で「どの PC の Chrome で何をするか」を言い、ホストの状態（setup → permission → denied）が変わると同じカードの中身を差し替える。
// 「許可」は出さない（ここから許可しても、つながるのはホストの Chrome の側で、進まない）。押せるのは「Chrome を使わずに続けてもらう」だけ。
// 枠（見出し・置き場・名簿への登録・決着の畳み）は client.mjs の chromeWaitCard、中身とボタンはここが持つ。

// i18n-dynamic: ui:chat.chromeWait.
const K = 'chat.chromeWait.';
const ADDRESS = 'chrome://inspect/#remote-debugging';
const REASONS = ['login', 'captcha', 'two_factor', 'payment', 'other'];
// 訳文の中の差し込み（ホスト名の太字・アドレスの等幅）を、文を壊さずに要素へ替えるための目印
const HOST = '\u{E001}';
const CODE = '\u{E002}';

/** 待った分数。1 分に満たなければ null（「待って 0 分」は出さない） */
export function waitedMinutes(since, nowMs) {
  const at = Date.parse(since ?? '');
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((nowMs - at) / 60_000);
  return minutes >= 1 ? minutes : null;
}

/** 状態の名前（描き分けの単位）。知らない値は、ふつうの「操作してください」に倒す */
export function waitState(w) {
  if (w?.reason === 'connect') return ['setup', 'permission', 'denied'].includes(w.state) ? w.state : 'setup';
  return w?.state === 'operating' ? 'operating' : 'asked';
}

/**
 * 本文とボタンを作る。
 *   view = chromeWaitView(ev, { el, t, cmd, now, spinner, foldElsewhere })
 *   view.body        … 本文（状態で中身が替わる。role=group の中の aria-live=polite）
 *   view.res         … 足の左の 1 行（待った時間・送信中・失敗の理由）
 *   view.skip        … 「Chrome を使わずに続けてもらう」
 *   view.update(w)   … permissionUpdate の chromeWait を渡して描き直す
 *   view.setOnline(b)… ホストの接続の状態。オフラインの間は押せず、言う
 *   view.tick()      … 待った時間の字を今に合わせる（client が 30 秒ごとに呼ぶ）
 *   view.settle()    … 決着した後に呼ぶ。以後は触らない
 */
export function chromeWaitView(ev, { el, t, cmd, now = () => Date.now(), spinner = null, foldElsewhere = () => {} }) {
  let w = { ...ev.chromeWait };
  let online = ev.remote?.online !== false;
  let busy = false;
  let settled = false;
  const host = ev.remote?.hostName ?? '';
  const body = el('div', 'cw-body');
  body.setAttribute('aria-live', 'polite');
  const res = el('span', 'res cw-live');
  const skip = el('button', 'btn', t(`${K}skip`));
  skip.type = 'button';

  /** 訳文 → ノード。{{host}} は太字、{{address}} は等幅。ほかの差し込みは文字のまま */
  const rich = (key, vars = {}) => {
    const out = [];
    for (const piece of t(`${K}${key}`, { host: HOST, address: CODE, ...vars }).split(new RegExp(`(${HOST}|${CODE})`))) {
      if (piece === HOST) out.push(el('b', 'cw-host', host));
      else if (piece === CODE) out.push(el('code', 'cw-addr', ADDRESS));
      else if (piece) out.push(piece);
    }
    return out;
  };
  const lead = (key, vars) => { const d = el('div', 'cw-lead'); d.append(...rich(key, vars)); return d; };
  const note = (key) => el('p', 'cw-note', t(`${K}${key}`, { host }));

  const reasonText = () => t(`chat.browserHandoff.reason.${REASONS.includes(w.reason) ? w.reason : 'other'}`);

  function paintBody() {
    const kind = waitState(w);
    if (kind === 'setup') {
      const steps = el('ol', 'cw-steps');
      const first = el('span');
      first.append(...rich('setup.step1'));
      const one = el('li'); one.append(el('span', 'n', '1'), first);
      const two = el('li'); two.append(el('span', 'n', '2'), el('span', null, t(`${K}setup.step2`)));
      steps.append(one, two);
      body.replaceChildren(lead('setup.lead'), steps);
    } else if (kind === 'permission') {
      body.replaceChildren(lead('permission.lead'));
    } else if (kind === 'denied') {
      body.replaceChildren(lead('denied.lead'), note('denied.note'));
    } else if (kind === 'operating') {
      body.replaceChildren(lead('operating.lead'), ...(w.message ? [el('p', 'cw-message', w.message)] : []));
    } else {
      body.replaceChildren(lead('asked.lead', { reason: reasonText() }), ...(w.message ? [el('p', 'cw-message', w.message)] : []));
    }
    if (!online) body.append(note('offline'));
  }

  /** 足の左の 1 行。送っている間・失敗の間はそちらを優先し、触らない */
  function paintLive() {
    if (busy || res.getAttribute('role') === 'alert') return;
    res.className = 'res cw-live';
    if (!online || settled) { res.replaceChildren(); return; }
    const kind = waitState(w);
    const minutes = waitedMinutes(w.since, now());
    const waited = minutes === null ? t(`${K}waitedNow`) : t(`${K}waited`, { minutes });
    const text = kind === 'setup' ? (minutes === null ? t(`${K}setup.auto`) : `${t(`${K}setup.auto`)}${t(`${K}join`)}${waited}`) : waited;
    res.replaceChildren(...(spinner ? [spinner()] : []), text);
  }

  const paintButtons = () => { skip.disabled = busy || !online || settled; };
  const paint = () => { paintBody(); paintLive(); paintButtons(); };

  skip.onclick = async () => {
    if (busy || skip.disabled) return;
    busy = true;
    paintButtons();
    res.className = 'res cw-live';
    res.removeAttribute('role');
    res.replaceChildren(...(spinner ? [spinner()] : []), t(`${K}skipSending`));
    try {
      // 子には会話の言語で「人が Chrome を使わずに続けるよう選んだ」と返る（サーバーが messageKey を訳す）
      await cmd('resolvePermission', { id: ev.id, allow: false, always: false, messageKey: 'userDenied' });
    } catch (err) {
      busy = false;
      // 先によそで片付いていた。失敗ではなく、畳む
      if (err?.code === 'ALREADY_RESOLVED') { foldElsewhere(ev.id); return; }
      res.className = 'res fail';
      res.setAttribute('role', 'alert');
      res.replaceChildren(`✕ ${t(`${K}skipFailed`, { error: err?.message ?? String(err) })}`);
      paintButtons();
      return;
    }
    // 畳みは決着の便り（permissionRelayEnd）が行う。便りが先に届いていれば、もう畳まれている
    busy = false;
    paintButtons();
  };

  paint();

  return {
    body,
    res,
    skip,
    update(next) {
      if (!next || settled) return;
      w = { ...w, ...next };
      if (busy) return;
      paint();
      // 状態が替わったときだけ、本文を 240ms でなじませる（動きを減らす設定では何もしない）
      if (typeof body.animate === 'function' && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
        body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
      }
    },
    setOnline(flag) {
      online = flag !== false;
      if (settled) return;
      paintBody();
      paintLive();
      paintButtons();
    },
    tick() { if (!settled) paintLive(); },
    settle() { settled = true; busy = false; paintLive(); paintButtons(); },
  };
}

/** 決着の 1 行（時刻は付けない）。ev は { by, allow, reason }。reason は依頼の種類（chromeWait.reason） */
export function chromeSettledLine(t, { by, allow, reason, host }) {
  if (by === 'abort') return t(`${K}done.aborted`);
  if (allow === true) return reason === 'connect' ? t(`${K}done.connected`, { host }) : t(`${K}done.resumed`, { host });
  if (by === 'device') return t(`${K}done.skipped`);
  return t(`${K}done.declined`, { host });
}
