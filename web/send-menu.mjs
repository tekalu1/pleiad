// 送信の日時の面（docs/design-system.md「送信日時の指定」）。
//
// 入口は 3 つ。送信の円の右の ▾、送信の円の右クリック・長押し（contextmenu。長押しは web/long-press.mjs が起こす）、
// 入力欄の Ctrl+Shift+Enter。広い幅は入力欄の上に浮く面（.cpop。web/composer-controls.mjs の panel）、
// 480px 以下は ▾ を出さず、同じ内容を下からのシートで出す。
// 面の中は 2 段。候補（1 回押せば決まる）→「日時を指定…」で日のチップと時刻の欄（標準の datetime-local は使わない。design-system §2.4）。
// 押したら onSchedule(at) を呼ぶだけで、送る・予定を置く処理は client.mjs が持つ。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { panel } from './composer-controls.mjs';
import { isComposingKey } from './keyboard.mjs';
import { presets, dayChips, targetAt, TIME_STEPS, leftText, whenText, hostTimeText } from './schedule-times.mjs';

/**
 * @param {object} o
 * @param {HTMLElement} o.send         送信の円（右クリック・長押しの受け手）
 * @param {HTMLElement} o.more         ▾ のボタン（広い幅の面の持ち主）
 * @param {HTMLElement} o.pop          面
 * @param {HTMLElement} o.veil         シートの後ろの幕（狭い幅）
 * @param {MediaQueryList} o.narrow    480px 以下
 * @param {() => ({ available: boolean, resetsAt?: number|null })} o.context  今の会話の事情（送れない会話では available: false）
 * @param {() => Promise<{ persistent: boolean, hostZone: string|null }>} o.environment  窓を閉じても動き続けるか・PC の時刻帯
 * @param {(at: number) => Promise<void>} o.onSchedule
 * @param {() => Promise<void>} o.onSendNow
 */
export function setupSendMenu({ send, more, pop, veil, narrow, context, environment, onSchedule, onSendNow }) {
  let view = 'menu';
  let pick = { day: 1, time: '9:00' };
  let env = { persistent: true, hostZone: null };
  let note = null, summary = null, ok = null, hostNote = null;

  const commit = async (at) => {
    menu.hide(false);
    await onSchedule(at);
  };
  const close = () => menu.hide(false);

  function row({ label, hint, onClick, role = 'menuitem' }) {
    const b = el('button', 'copt'); b.type = 'button'; b.setAttribute('role', role);
    const body = el('span', 'cbody'); body.append(el('span', 'main', label)); b.append(body);
    if (hint) b.append(el('span', 'r', hint));
    b.onclick = onClick;
    return b;
  }

  function renderMenu() {
    pop.append(el('div', 'chead', t('schedule.menuTitle')));
    const now = Date.now();
    for (const p of presets(now, { resetsAt: context().resetsAt })) {
      pop.append(row({ label: p.label, hint: p.hint, onClick: () => commit(p.at).catch(() => {}) }));
    }
    pop.append(el('div', 'sep'));
    pop.append(row({ label: t('schedule.custom'), onClick: () => { view = 'picker'; menu.render(); menu.place(); focusFirst(); } }));
    if (narrow.matches) {
      pop.append(el('div', 'sep'));
      pop.append(row({ label: t('schedule.sendNow'), onClick: () => { menu.hide(false); onSendNow().catch(() => {}); } }));
    }
  }

  function renderPicker() {
    const now = Date.now();
    pop.append(el('div', 'chead', t('schedule.pickTitle')));
    const wrap = el('div', 'send-picker');
    const days = el('div', 'send-days'); days.setAttribute('role', 'group'); days.setAttribute('aria-label', t('schedule.dayGroup'));
    for (const d of dayChips(now)) {
      const b = el('button', null, d.label); b.type = 'button';
      if (d.sub) b.append(el('small', null, d.sub));
      b.setAttribute('aria-pressed', String(d.offset === pick.day));
      b.onclick = () => { pick.day = d.offset; for (const x of days.children) x.setAttribute('aria-pressed', String(x === b)); update(); };
      days.append(b);
    }
    const timeRow = el('div', 'send-time');
    const input = el('input'); input.value = pick.time; input.setAttribute('aria-label', t('schedule.timeAria')); input.inputMode = 'numeric'; input.autocomplete = 'off';
    input.oninput = () => { pick.time = input.value; update(); };
    input.onkeydown = (e) => {
      if (isComposingKey(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const at = targetAt(pick.day, pick.time); if (at) commit(at).catch(() => {}); }
    };
    const steps = el('div', 'send-steps');
    for (const s of TIME_STEPS) {
      const b = el('button', null, s); b.type = 'button';
      b.onclick = () => { pick.time = s; input.value = s; update(); };
      steps.append(b);
    }
    timeRow.append(input, steps);
    summary = el('div', 'send-sum'); summary.setAttribute('role', 'status');
    hostNote = el('p', 'send-note'); note = el('p', 'send-note', t('schedule.closedNote'));
    const foot = el('div', 'send-foot');
    const back = el('button', 'btn', t('schedule.back')); back.type = 'button';
    back.onclick = () => { view = 'menu'; menu.render(); menu.place(); focusFirst(); };
    ok = el('button', 'btn btn-primary', t('schedule.confirm')); ok.type = 'button';
    ok.onclick = () => { const at = targetAt(pick.day, pick.time); if (at) commit(at).catch(() => {}); };
    foot.append(back, ok);
    wrap.append(days, timeRow, summary, hostNote, note, foot);
    pop.append(wrap);
    update();
  }

  /** 日と時刻から、結果の 1 行・PC の時刻・ボタンの有効を決める（面は作り直さない。入力の途中で欄の焦点を失わないため） */
  function update() {
    if (!summary) return;
    const now = Date.now();
    const at = targetAt(pick.day, pick.time, now);
    ok.disabled = !at;
    summary.classList.toggle('bad', !at);
    summary.textContent = at ? `${t('schedule.summary', { when: whenText(at, now) })} · ${leftText(at, now)}` : t('schedule.invalid');
    const host = at ? hostTimeText(at, env.hostZone) : null;
    hostNote.hidden = !host;
    hostNote.textContent = host ? t('schedule.hostTime', { time: host }) : '';
    note.hidden = env.persistent;
  }

  const focusFirst = () => (pop.querySelector('.send-picker input') ?? pop.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });

  const menu = panel(more, pop, {
    align: 'right', width: 290,
    when: () => !narrow.matches && context().available,
    onShow: () => {
      veil.hidden = !narrow.matches;
      environment().then((e) => { env = e; update(); }).catch(() => {});
    },
    onHide: () => { veil.hidden = true; view = 'menu'; },
    render: () => {
      pop.replaceChildren();
      pop.classList.toggle('sheet', narrow.matches);
      if (narrow.matches) pop.append(el('div', 'sheet-grab'));
      summary = ok = note = hostNote = null;
      if (view === 'picker') renderPicker(); else renderMenu();
    },
  });
  more.setAttribute('aria-haspopup', 'menu');
  veil.onclick = close;

  const open = () => {
    if (!context().available) return;
    view = 'menu';
    // タッチ（狭い幅のシート）は焦点の枠を出さない。キーボードと広い幅は先頭の候補へ焦点を置く
    if (!menu.open) menu.show(!narrow.matches);
  };
  // 送信の円の右クリック・長押し（web/long-press.mjs が touch の長押しを contextmenu にする）
  send.addEventListener('contextmenu', (e) => { e.preventDefault(); open(); });
  return { open, close, get isOpen() { return menu.open; } };
}
