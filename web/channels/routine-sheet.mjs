// ルーティンの編集のシート（W5。承認済みのモック 06、docs/channels.md「ルーティン」、ADR 0112）。
// 白い <dialog>#routineSheet（広い画面は浮く面、狭い画面は全画面）。いつ（毎日・毎週・間隔・cron・イベント・webhook）・
// 誰が（bot）・どこで（チャンネル）・何を（指示）・承認モード（入力欄と同じ選択）・承認待ちの期限・［試しに動かす］［取り消す］［作る］。
// 操作はすべて routines.* を host.invoke で呼ぶ（新しい WS コマンドは足さない）。一覧は routine-store.mjs。出来事 routinesChanged で脇・見出し・bot のページが更新される。
//
// 開く入口: document の channels:routine（detail: { routineId } で編集 / { channelId?, botId? } で新規）。入口の部品は routine-entry.mjs。
// 部品の口（web/channels/index.mjs）: onEvent(ev)・show(view)。show は bot のページへ「ルーティン」の節を差し込む（bot-page.mjs には触らない）。
//
// ［試しに動かす］は保存してある内容で走る（routines.run { dryRun: true } は routineId を取る）。新しい下書きは、一時停止のまま作ってから走らせ、
// 取り消すと消す（作るを押したら再開）。保存済みのルーティンは、直した内容を先に保存してから走らせる。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { remoteInfo } from '../remote-badge.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { runMark } from '../arc.mjs';
import { backendLogo } from '../side.mjs';
import { panel, renderMode, isDanger } from '../composer-controls.mjs';
import { onlyMode } from './bot-model.mjs';
import { botIcon } from './bot-icon.mjs';
import { sideChannels } from './side-model.mjs';
import { getRoutineStore } from './routine-store.mjs';
import { glyph, CLOCK, whenText, stateText, botBlock } from './routine-entry.mjs';
import * as M from './routine-model.mjs';

const SHIELD = 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z';
const WARN = ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5M12 17.2v.3'];
const CARET = 'M7 10l5 5 5-5';
const CLOSE = 'M6 6l12 12M18 6L6 18';
const GLYPH = (d) => glyph(d);

const message = (e) => (e && typeof e === 'object' && 'message' in e ? e.message : String(e));
const DELETE_CONFIRM_MS = 4000;

export function createRoutineSheet(host) {
  const store = getRoutineStore(host);
  let sheet = null;          // 開いているシート { onEvent(ev), focus() }
  let opening = false;

  async function open(detail = {}) {
    // 閉じた直後（close の出来事が届く前）に次の入口が来ても、閉じたシートは「開いている」と見なさない
    if (sheet?.isOpen()) { sheet.focus(); return; }
    if (opening) return;
    opening = true;
    try {
      const read = (op, args) => host.invoke(op, args).catch(() => null);
      const [bl, cl, fresh] = await Promise.all([
        read('bots.list', {}), read('channels.list', {}),
        detail.routineId ? read('routines.get', { routineId: detail.routineId }) : null,
      ]);
      const routine = detail.routineId ? (fresh?.id ? fresh : store.get(detail.routineId)) : null;
      if (detail.routineId && !routine) return;   // 消えている
      const made = buildSheet({ host, store, routine, bots: (bl?.bots ?? []).filter((b) => !b.plain), channels: cl?.channels ?? [], channelId: detail.channelId, botId: detail.botId, done: () => { if (sheet === made) sheet = null; } });
      sheet = made;
    } finally {
      opening = false;
    }
  }
  document.addEventListener('channels:routine', (e) => open(e.detail ?? {}));

  // ---- bot のページに「ルーティン」の節を差し込む（bot-page.mjs が持つ #botView の左の列の末尾）
  const block = botBlock(host);
  let channelsById = new Map();
  async function mountBlock(botId) {
    const left = document.querySelector('#botView .bp-grid > .bp-col');
    if (!left) return;
    if (block.el.parentNode !== left) left.append(block.el);
    block.setBot(botId === 'new' ? null : botId, channelsById);
    try {
      const r = await host.invoke('channels.list', {});
      channelsById = new Map((r?.channels ?? []).map((c) => [c.id, c]));
      block.setBot(botId === 'new' ? null : botId, channelsById);
    } catch { /* 名前の字が出ないだけ */ }
  }

  return {
    onEvent(ev) {
      store.onEvent(ev);
      sheet?.onEvent?.(ev);
    },
    show(view) {
      if (view?.kind === 'bot' && view.id) mountBlock(view.id);
      else block.setBot(null);
    },
    hide() { block.setBot(null); },
  };
}

// ====================================================================================================================
// シート

function buildSheet({ host, store, routine, bots, channels, channelId, botId, done }) {
  let isNew = !routine;
  const botOf = (id) => bots.find((b) => b.id === id) ?? null;
  const channelOptions = () => {
    const live = sideChannels(channels).filter((c) => !c.archivedAt);
    const dms = channels.filter((c) => c.kind === 'dm' && !c.archivedAt);
    const cur = D.channelId && !live.some((c) => c.id === D.channelId) ? channels.find((c) => c.id === D.channelId) : null;
    return [...live, ...dms, ...(cur && !dms.includes(cur) ? [cur] : [])];
  };
  const channelOf = (id) => channels.find((c) => c.id === id) ?? null;
  const backendLabel = (id) => host.state?.backends?.find((b) => b.id === id)?.label ?? id;

  // ---- 下書き
  const pickedChannel = channelOf(channelId);
  const startBot = botOf(botId) ?? botOf(pickedChannel?.kind === 'dm' ? pickedChannel.botId : pickedChannel?.members?.[0]) ?? bots[0] ?? null;
  const startChannel = pickedChannel && !pickedChannel.archivedAt ? pickedChannel
    : sideChannels(channels).find((c) => !c.archivedAt && (startBot ? c.members?.includes(startBot.id) : true)) ?? sideChannels(channels).find((c) => !c.archivedAt)
    ?? (startBot?.dmChannelId ? channelOf(startBot.dmChannelId) : null);
  const D = isNew ? M.newDraft({ botId: startBot?.id ?? '', channelId: startChannel?.id ?? '' }) : M.fromRoutine(routine);
  let orig = structuredClone(D);          // 保存済み（か開いた時点）の内容。取り消しの確認と、試しに動かす前の保存の要否に使う
  let current = routine;                  // サーバーが持つ今のルーティン（paused・last を出す）
  let modeTouched = !isNew;
  let busy = false, tried = false;
  let tempCreated = false, finalized = false;     // 試しのために一時停止で作った下書き
  const vocab = new Map();                         // backend → modes

  // ---- DOM
  const dlg = el('dialog', 'routine-sheet');
  dlg.id = 'routineSheet';
  dlg.setAttribute('aria-labelledby', 'rsTitle');
  const form = el('form', 'rs-form');
  form.noValidate = true;
  form.method = 'dialog';

  const head = el('h3', 'rs-title');
  head.id = 'rsTitle';
  const closeX = el('button', 'btn btn-icon rs-x');
  closeX.type = 'button';
  closeX.title = t('channels:routines.cancel');
  closeX.setAttribute('aria-label', t('channels:routines.cancel'));
  closeX.append(GLYPH(CLOSE));
  head.append(GLYPH(CLOCK), t('channels:routines.title'), el('span', 'rs-sp'), closeX);

  const fld = (key, label, ...nodes) => {
    const f = el('div', 'fld');
    f.dataset.fld = key;
    const k = el('span', 'k', label);
    const v = el('div', 'v');
    v.append(...nodes);
    const fe = el('span', 'fe');
    fe.setAttribute('role', 'alert');
    fe.hidden = true;
    v.append(fe);
    f.append(k, v);
    return { f, v, fe };
  };

  // 名前
  const nameIn = el('input', 'fin');
  nameIn.id = 'rsName';
  nameIn.type = 'text';
  nameIn.maxLength = 80;
  nameIn.autocomplete = 'off';
  nameIn.spellcheck = false;
  nameIn.placeholder = t('channels:routines.name.placeholder');
  nameIn.setAttribute('aria-label', t('channels:routines.name.label'));
  const fName = fld('name', t('channels:routines.name.label'), nameIn);

  // 状態（保存済みだけ）と前回
  const stateSeg = el('div', 'seg');
  stateSeg.setAttribute('role', 'group');
  stateSeg.setAttribute('aria-label', t('channels:routines.state.label'));
  const onBtn = el('button', null, t('channels:routines.state.on'));
  const offBtn = el('button', null, t('channels:routines.state.off'));
  onBtn.type = offBtn.type = 'button';
  onBtn.dataset.state = 'on';
  offBtn.dataset.state = 'off';
  stateSeg.append(onBtn, offBtn);
  const lastLine = el('span', 'rs-last');
  const openChannelBtn = el('button', 'btn btn-quiet rs-open');
  openChannelBtn.type = 'button';
  openChannelBtn.textContent = t('channels:routines.openChannel');
  const stateRow = el('div', 'row2');
  stateRow.append(stateSeg, lastLine, openChannelBtn);
  const fState = fld('state', t('channels:routines.state.label'), stateRow);
  fState.f.hidden = isNew;

  // いつ
  const kindSeg = el('div', 'seg rs-kinds');
  kindSeg.setAttribute('role', 'group');
  kindSeg.setAttribute('aria-label', t('channels:routines.when.label'));
  for (const k of M.KINDS) {
    const b = el('button', null, t(`channels:routines.kind.${k}`));   // i18n-dynamic: channels:routines.kind.
    b.type = 'button';
    b.dataset.when = k;
    if (M.DISABLED_KINDS.includes(k)) { b.disabled = true; b.title = t('channels:routines.kind.soon'); }
    kindSeg.append(b);
  }
  const whenBody = el('div', 'rs-when');
  const fWhen = fld('trigger', t('channels:routines.when.label'), kindSeg, whenBody);

  // 誰が・どこで
  const botChip = chipButton('rsBotChip');
  const chChip = chipButton('rsChannelChip');
  const whoRow = el('div', 'row2');
  whoRow.append(botChip.btn, el('span', 'weak', t('channels:routines.who.ga')), chChip.btn);
  if (t('channels:routines.who.de')) whoRow.append(el('span', 'weak', t('channels:routines.who.de')));   // 言語によっては後ろの語が要らない
  const botNote = el('p', 'nt');
  botNote.hidden = true;
  const fWho = fld('who', t('channels:routines.who.label'), whoRow, botNote);

  // 何を
  const promptIn = el('textarea', 'fta');
  promptIn.id = 'rsPrompt';
  promptIn.rows = 3;
  promptIn.maxLength = 6000;
  promptIn.spellcheck = false;
  promptIn.placeholder = t('channels:routines.prompt.placeholder');
  promptIn.setAttribute('aria-label', t('channels:routines.prompt.label'));
  const fPrompt = fld('prompt', t('channels:routines.prompt.label'), promptIn);

  // 承認モード
  const modeChip = chipButton('rsModeChip');
  const modeRow = el('div', 'row2');
  modeRow.append(modeChip.btn);
  const modeNote = el('p', 'nt');
  const fMode = fld('mode', t('channels:routines.mode.label'), modeRow, modeNote);

  // 承認待ちで
  const timeoutChip = chipButton('rsTimeoutChip');
  const timeoutRow = el('div', 'row2');
  timeoutRow.append(el('span', null, t('channels:routines.timeout.before')), timeoutChip.btn, el('span', null, t('channels:routines.timeout.after')));
  const fTimeout = fld('timeout', t('channels:routines.timeout.label'), timeoutRow);

  // 足
  const err = el('p', 'rs-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const res = el('span', 'res');
  res.id = 'rsTry';
  res.setAttribute('role', 'status');
  const delBtn = el('button', 'btn btn-quiet rs-delete');
  delBtn.type = 'button';
  delBtn.id = 'rsDelete';
  delBtn.hidden = isNew;
  const tryBtn = el('button', 'btn btn-quiet');
  tryBtn.type = 'button';
  tryBtn.id = 'rsTryBtn';
  tryBtn.textContent = t('channels:routines.try.button');
  const cancelBtn = el('button', 'btn');
  cancelBtn.type = 'button';
  cancelBtn.id = 'rsCancel';
  cancelBtn.textContent = t('channels:routines.cancel');
  const saveBtn = el('button', 'btn btn-primary');
  saveBtn.type = 'submit';
  saveBtn.id = 'rsSave';
  saveBtn.textContent = isNew ? t('channels:routines.create') : t('channels:routines.save');
  const foot = el('div', 'sheet-foot');
  foot.append(delBtn, res, tryBtn, cancelBtn, saveBtn);

  const body = el('div', 'rs-body');
  body.append(fName.f, fState.f, fWhen.f, fWho.f, fPrompt.f, fMode.f, fTimeout.f, err);
  form.append(head, body, foot);
  dlg.append(form);
  document.body.append(dlg);

  // ---- 選べる面（入力欄の .cpop と同じ。チップの下に出す）
  const pops = [];
  const placed = (p) => {
    const base = p.place.bind(p);
    p.place = () => {
      if (p.pop.hidden) return;
      base();
      const r = p.chip.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 14;
      const above = r.top - 12;
      if (below >= 240 || below > above) {
        p.pop.style.bottom = 'auto';
        p.pop.style.top = `${Math.round(r.bottom + 6)}px`;
        p.pop.style.maxHeight = `${Math.max(160, Math.round(below))}px`;
      } else p.pop.style.top = 'auto';
    };
    pops.push(p);
    return p;
  };
  const whenPops = [];   // 「いつ」の欄の面。種類を替えるたびに作り直すので、前のを片付ける
  const resetWhenPops = () => {
    for (const p of whenPops.splice(0)) { p.hide(false); p.pop.remove(); pops.splice(pops.indexOf(p), 1); }
  };
  /** チップ + 面。items() は { key, main, sub?, on, pick } の配列 */
  const chooser = (chip, { title, width = 300, align = 'left', items, when, bucket }) => {
    const pop = el('div', 'pop cpop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', title);
    pop.hidden = true;
    dlg.append(pop);
    chip.btn.dataset.title = title;
    chip.btn.setAttribute('aria-label', `${title}: ${chip.label.textContent}`);
    const p = placed(panel(chip.btn, pop, {
      width, align, when,
      render: () => {
        const box = el('div', 'clistbox');
        box.setAttribute('role', 'listbox');
        box.setAttribute('aria-label', title);
        box.append(...items().map((o) => optionRow(o, () => { p.hide(); o.pick(); })));
        pop.replaceChildren(el('div', 'chead', title), box);
      },
    }));
    bucket?.push(p);
    return p;
  };

  // ---- 値の描画
  const labelOf = (chip, ...nodes) => {
    chip.label.replaceChildren(...nodes);
    if (chip.btn.dataset.title) chip.btn.setAttribute('aria-label', `${chip.btn.dataset.title}: ${chip.label.textContent}`);   // 面の名前 + 今の値
  };
  function paintBot() {
    const b = botOf(D.botId);
    if (!b) { labelOf(botChip, document.createTextNode(t('channels:routines.who.pickBot'))); return; }
    const av = botIcon(b, 'av xs');
    av.setAttribute('aria-hidden', 'true');
    labelOf(botChip, av, document.createTextNode(b.name));
    if (b.backend) botChip.label.append(backendLogo(b.backend, backendLabel(b.backend)));
    botChip.btn.setAttribute('aria-label', t('channels:routines.who.botAria', { name: b.name }));
  }
  function paintChannel() {
    const c = channelOf(D.channelId);
    if (!c) { labelOf(chChip, document.createTextNode(t('channels:routines.who.pickChannel'))); return; }
    const b = c.kind === 'dm' ? botOf(c.botId) : null;
    if (b) labelOf(chChip, botIcon(b, 'av xs'), document.createTextNode(c.name));
    else labelOf(chChip, document.createTextNode(c.kind === 'dm' ? c.name : `# ${c.name}`));
    chChip.btn.setAttribute('aria-label', t('channels:routines.who.channelAria', { name: c.name }));
  }
  function paintMode() {
    const modes = vocab.get(botOf(D.botId)?.backend) ?? {};
    const m = modes[D.mode];
    const danger = isDanger(m);
    modeChip.lead.replaceChildren(GLYPH(danger ? WARN : SHIELD));
    modeChip.lead.hidden = false;
    modeChip.btn.classList.toggle('danger', danger);
    labelOf(modeChip, document.createTextNode(m?.label ?? (D.mode || '…')));
    modeChip.btn.setAttribute('aria-label', t(danger ? 'composer.mode.chipAriaDanger' : 'composer.mode.chipAria', { mode: m?.label ?? D.mode }));
    modeChip.btn.dataset.value = D.mode;
    const only = onlyMode(modes);
    modeNote.textContent = danger ? t('channels:routines.mode.danger')
      : only ? t('channels:routines.mode.only', { backend: backendLabel(botOf(D.botId)?.backend), mode: modes[only]?.label ?? only })
        : t('channels:routines.mode.hint');
    modeNote.classList.toggle('strong', danger);
  }
  function paintTimeout() {
    labelOf(timeoutChip, document.createTextNode(M.minutesText(D.approvalTimeoutMin, t)));
  }
  function paintState() {
    if (isNew) return;
    const paused = Boolean(current?.paused);
    onBtn.classList.toggle('on', !paused);
    offBtn.classList.toggle('on', paused);
    onBtn.setAttribute('aria-pressed', String(!paused));
    offBtn.setAttribute('aria-pressed', String(paused));
    const last = current?.last;
    lastLine.textContent = last ? t('channels:routines.last', { state: stateText(last.state), when: whenText(last.at) }) : t('channels:routines.neverRan');
    lastLine.classList.toggle('fail', last?.state === 'failed');
    openChannelBtn.hidden = !channelOf(D.channelId);
  }
  const syncKinds = () => { for (const b of kindSeg.querySelectorAll('button')) { const on = b.dataset.when === D.trigger.kind; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); } };

  // ---- いつ（種類ごとの欄）
  const timeInput = (value, label, onInput) => {
    const i = el('input', 'fin rs-time');
    i.type = 'time';
    i.value = M.isHHMM(value) ? value : '';
    i.setAttribute('aria-label', label);
    i.addEventListener('input', () => onInput(i.value));
    return i;
  };
  const row2 = (...nodes) => { const r = el('div', 'row2'); r.append(...nodes); return r; };
  let nextNote = null;
  function paintNext() {
    if (!nextNote) return;
    const tr = D.trigger;
    let text = '';
    if (tr.kind === 'cron') {
      const d = M.describeCron(tr.expr);
      const nx = M.nextRun(tr);
      if (!M.parseCron(tr.expr)) text = t('channels:routines.cron.hint');
      else text = [d ? cronText(d) : '', nx ? t('channels:routines.next', { when: whenText(nx) }) : t('channels:routines.nextNone')].filter(Boolean).join(' · ');
    } else if (tr.kind === 'daily' || tr.kind === 'weekly') {
      const nx = M.nextRun(tr);
      text = nx ? t('channels:routines.next', { when: whenText(nx) }) : '';
    } else if (tr.kind === 'interval') {
      text = t('channels:routines.interval.hint');
    } else if (tr.kind === 'event') {
      text = t(`channels:routines.event.hint.${tr.on}`);   // i18n-dynamic: channels:routines.event.hint.
    }
    nextNote.textContent = text;
  }
  const cronText = (d) => (d.kind === 'daily' ? t('channels:routines.cron.daily', { time: M.timeText(d.at) })
    : d.kind === 'weekdays' ? t('channels:routines.cron.weekdays', { time: M.timeText(d.at) })
      : t('channels:routines.cron.weekly', { days: M.daysText(d.days, t), time: M.timeText(d.at) }));

  function paintWhen() {
    resetWhenPops();
    syncKinds();
    const tr = D.trigger;
    nextNote = el('span', 'nt rs-next');
    nextNote.id = 'rsNext';
    const nodes = [];
    if (tr.kind === 'daily') {
      const at = timeInput(tr.at, t('channels:routines.time'), (v) => { D.trigger.at = v; paintNext(); });
      at.id = 'rsAt';
      const chip = chipButton('rsWeekdays');
      const set = (only) => { D.trigger.weekdaysOnly = only; labelOf(chip, document.createTextNode(t(only ? 'channels:routines.daily.weekdays' : 'channels:routines.daily.everyday'))); paintNext(); };
      labelOf(chip, document.createTextNode(t(tr.weekdaysOnly ? 'channels:routines.daily.weekdays' : 'channels:routines.daily.everyday')));
      chooser(chip, { title: t('channels:routines.daily.label'), width: 220, bucket: whenPops, items: () => [
        { key: 'every', main: t('channels:routines.daily.everyday'), on: !D.trigger.weekdaysOnly, pick: () => set(false) },
        { key: 'weekdays', main: t('channels:routines.daily.weekdays'), on: D.trigger.weekdaysOnly, pick: () => set(true) },
      ] });
      nodes.push(row2(at, chip.btn));
    } else if (tr.kind === 'weekly') {
      const days = el('div', 'dayp');
      days.setAttribute('role', 'group');
      days.setAttribute('aria-label', t('channels:routines.weekly.label'));
      for (const d of M.WEEK_ORDER) {
        const b = el('button', null, t(`channels:routines.day.${d}`));   // i18n-dynamic: channels:routines.day.
        b.type = 'button';
        b.dataset.day = String(d);
        const on = tr.days?.includes(d);
        b.classList.toggle('on', Boolean(on));
        b.setAttribute('aria-pressed', String(Boolean(on)));
        b.addEventListener('click', () => {
          const set = new Set(D.trigger.days ?? []);
          if (set.has(d)) set.delete(d); else set.add(d);
          D.trigger.days = [...set];
          b.classList.toggle('on', set.has(d));
          b.setAttribute('aria-pressed', String(set.has(d)));
          paintNext();
        });
        days.append(b);
      }
      const at = timeInput(tr.at, t('channels:routines.time'), (v) => { D.trigger.at = v; paintNext(); });
      at.id = 'rsAt';
      nodes.push(days, row2(at));
    } else if (tr.kind === 'interval') {
      const every = chipButton('rsEvery');
      const paintEvery = () => labelOf(every, document.createTextNode(t('channels:routines.text.interval', { every: M.minutesText(D.trigger.minutes, t) })));
      paintEvery();
      chooser(every, { title: t('channels:routines.interval.label'), width: 220, bucket: whenPops, items: () => {
        const list = M.INTERVAL_MINUTES.includes(D.trigger.minutes) ? M.INTERVAL_MINUTES : [...M.INTERVAL_MINUTES, D.trigger.minutes].filter((x) => x >= 1).sort((a, b) => a - b);
        return list.map((m) => ({ key: `min:${m}`, main: t('channels:routines.text.interval', { every: M.minutesText(m, t) }), on: m === D.trigger.minutes, pick: () => { D.trigger.minutes = m; paintEvery(); } }));
      } });
      const win = chipButton('rsWindow');
      const winBox = el('span', 'rs-win');
      const paintWin = () => {
        const w = D.trigger.window;
        labelOf(win, document.createTextNode(w ? t('channels:routines.interval.window') : t('channels:routines.interval.allDay')));
        winBox.replaceChildren();
        if (w) {
          const from = timeInput(w.from, t('channels:routines.interval.from'), (v) => { D.trigger.window.from = v; });
          const to = timeInput(w.to, t('channels:routines.interval.to'), (v) => { D.trigger.window.to = v; });
          from.id = 'rsFrom';
          to.id = 'rsTo';
          winBox.append(from, el('span', 'weak', '–'), to);
        }
      };
      paintWin();
      chooser(win, { title: t('channels:routines.interval.windowLabel'), width: 220, bucket: whenPops, items: () => [
        { key: 'allday', main: t('channels:routines.interval.allDay'), on: !D.trigger.window, pick: () => { delete D.trigger.window; paintWin(); } },
        { key: 'window', main: t('channels:routines.interval.window'), on: Boolean(D.trigger.window), pick: () => { D.trigger.window ??= { from: '09:00', to: '19:00' }; paintWin(); } },
      ] });
      nodes.push(row2(every.btn, el('span', 'weak', t('channels:routines.interval.during')), win.btn, winBox));
    } else if (tr.kind === 'cron') {
      const expr = el('input', 'fin mono');
      expr.id = 'rsCron';
      expr.type = 'text';
      expr.value = tr.expr ?? '';
      expr.spellcheck = false;
      expr.autocomplete = 'off';
      expr.style.width = '11em';
      expr.setAttribute('aria-label', t('channels:routines.cron.label'));
      expr.addEventListener('input', () => { D.trigger.expr = expr.value; paintNext(); });
      nodes.push(row2(expr, nextNote));
    } else if (tr.kind === 'event') {
      const seg = el('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', t('channels:routines.event.label'));
      for (const on of M.EVENT_ONS) {
        const b = el('button', null, t(`channels:routines.event.${on}`));   // i18n-dynamic: channels:routines.event.
        b.type = 'button';
        b.dataset.on = on;
        const sel = tr.on === on;
        b.classList.toggle('on', sel);
        b.setAttribute('aria-pressed', String(sel));
        b.addEventListener('click', () => {
          D.trigger.on = on;
          for (const x of seg.querySelectorAll('button')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
          paintNext();
        });
        seg.append(b);
      }
      const n = tr.scope?.sessionIds?.length;
      nodes.push(row2(seg), row2(el('span', 'weak', t('channels:routines.event.scope')), el('span', 'rs-scope', n ? t('channels:routines.event.scopeSome', { count: n }) : t('channels:routines.event.scopeAll'))));
    }
    if (tr.kind === 'webhook') {
      const savedHook = current?.trigger?.kind === 'webhook' ? current.trigger.hookId : null;
      if (savedHook) {
        const url = el('input', 'fin mono');
        url.id = 'rsWebhookUrl'; url.readOnly = true;
        url.value = `${location.origin}/hooks/${encodeURIComponent(savedHook)}`;
        url.setAttribute('aria-label', t('channels:routines.webhook.url'));
        url.style.cssText = 'flex:1;min-width:0';
        const copy = el('button', 'btn', t('channels:routines.webhook.copyUrl'));
        copy.type = 'button';
        copy.onclick = () => navigator.clipboard.writeText(url.value).then(() => { copy.textContent = t('channels:routines.webhook.copied'); }, (e) => showFail(message(e)));
        if (remoteInfo(window.plyRemote)) nodes.push(el('span', 'nt', t('channels:routines.webhook.hostOnly')));
        else nodes.push(row2(url, copy));
        const rotate = el('button', 'btn', t('channels:routines.webhook.rotate'));
        rotate.id = 'rsRotateSecret'; rotate.type = 'button';
        const value = el('input', 'fin mono');
        value.id = 'rsWebhookSecret'; value.readOnly = true; value.hidden = true;
        value.style.cssText = 'width:100%;min-width:0';
        value.setAttribute('aria-label', t('channels:routines.webhook.secret'));
        const once = el('span', 'nt', t('channels:routines.webhook.once')); once.hidden = true;
        const copySecret = el('button', 'btn', t('channels:routines.webhook.copySecret'));
        copySecret.type = 'button'; copySecret.hidden = true;
        copySecret.onclick = () => navigator.clipboard.writeText(value.value).then(() => { copySecret.textContent = t('channels:routines.webhook.copied'); }, (e) => showFail(message(e)));
        rotate.onclick = async () => {
          if (busy) return;
          setBusy(true); rotate.disabled = true; value.value = ''; value.hidden = copySecret.hidden = once.hidden = true;
          try {
            const r = await host.invoke('routines.rotateSecret', { routineId: D.id });
            if (closed || !value.isConnected) return;
            value.value = r.secret; value.hidden = copySecret.hidden = once.hidden = false;
            copySecret.textContent = t('channels:routines.webhook.copySecret');
            value.focus(); value.select();
          } catch (e) { showFail(message(e)); }
          finally { setBusy(false); rotate.disabled = false; }
        };
        nodes.push(row2(el('span', 'weak', t('channels:routines.webhook.secret')), rotate), el('span', 'nt', t('channels:routines.webhook.invalidates')), value, row2(copySecret), once);
      } else nodes.push(el('span', 'nt', t('channels:routines.webhook.saveFirst')));
      nodes.push(el('span', 'nt', t('channels:routines.webhook.tunnel')));
    }
    if (tr.kind !== 'cron') nodes.push(nextNote);
    whenBody.replaceChildren(...nodes);
    paintNext();
  }

  // ---- 選べる面の定義
  chooser(botChip, { title: t('channels:routines.who.label'), width: 300, items: () => bots.map((b) => ({
    key: `bot:${b.id}`, main: b.name, avatar: b, sub: backendLabel(b.backend), on: b.id === D.botId, pick: () => setBot(b.id),
  })), when: () => bots.length > 0 });
  chooser(chChip, { title: t('channels:routines.where.label'), width: 300, items: () => channelOptions().map((c) => ({
    key: `channel:${c.id}`, main: c.kind === 'dm' ? c.name : `# ${c.name}`, avatar: c.kind === 'dm' ? botOf(c.botId) : null, sub: c.kind === 'dm' ? t('channels:routines.where.dm') : c.purpose || '', on: c.id === D.channelId,
    pick: () => { D.channelId = c.id; paintChannel(); paintState(); },
  })), when: () => channelOptions().length > 0 });
  const modePop = el('div', 'pop cpop');
  modePop.id = 'rsModePop';
  modePop.setAttribute('role', 'dialog');
  modePop.setAttribute('aria-label', t('channels:routines.mode.label'));
  modePop.hidden = true;
  dlg.append(modePop);
  const modePanel = placed(panel(modeChip.btn, modePop, { width: 340, render: () => renderMode({ pop: modePop, target: { mode: D.mode, modes: vocab.get(botOf(D.botId)?.backend) ?? {} }, on: { mode: (id) => { D.mode = id; modeTouched = true; paintMode(); } }, hide: () => modePanel.hide() }) }));
  chooser(timeoutChip, { title: t('channels:routines.timeout.label'), width: 220, items: () => {
    const list = M.TIMEOUT_MINUTES.includes(D.approvalTimeoutMin) ? M.TIMEOUT_MINUTES : [...M.TIMEOUT_MINUTES, D.approvalTimeoutMin].sort((a, b) => a - b);
    return list.map((m) => ({ key: `timeout:${m}`, main: M.minutesText(m, t), on: m === D.approvalTimeoutMin, pick: () => { D.approvalTimeoutMin = m; paintTimeout(); } }));
  } });
  const closePops = () => { for (const p of pops) p.hide(false); modePanel.hide(false); };

  // ---- bot を替えたとき: 語彙（承認モード）を読み、モードを整える
  async function ensureVocab(backend) {
    if (!backend || vocab.has(backend)) return;
    const modes = await host.cmd('modes', { backend }).catch(() => null);
    if (modes && Object.keys(modes).length) vocab.set(backend, modes);
  }
  async function setBot(id) {
    D.botId = id;
    const b = botOf(id);
    paintBot();
    botNote.hidden = true;
    await ensureVocab(b?.backend);
    if (D.botId !== id) return;
    const modes = vocab.get(b?.backend) ?? {};
    if (Object.keys(modes).length) {
      D.mode = modeTouched ? M.validRoutineMode(modes, D.mode) : M.defaultRoutineMode(modes, b?.mode);
      if (isNew) orig.mode = D.mode;
    }
    paintMode();
  }

  // ---- 検査の表示
  const clearErrors = () => {
    err.hidden = true;
    for (const f of [fName, fWhen, fWho, fPrompt]) { f.fe.hidden = true; f.fe.textContent = ''; }
  };
  const FIELD_OF = { name: fName, trigger: fWhen, bot: fWho, channel: fWho, prompt: fPrompt };
  function showErrors(errors) {
    clearErrors();
    let first = null;
    for (const [key, code] of Object.entries(errors)) {
      const f = FIELD_OF[key];
      if (!f) continue;
      f.fe.textContent = t(`channels:routines.error.${code}`);   // i18n-dynamic: channels:routines.error.
      f.fe.hidden = false;
      first ??= key;
    }
    const focusTarget = { name: nameIn, prompt: promptIn, bot: botChip.btn, channel: chChip.btn, trigger: whenBody.querySelector('input,button') ?? kindSeg.querySelector('button.on') }[first];
    focusTarget?.focus();
  }
  const showFail = (text) => { err.textContent = text; err.hidden = false; };

  // ---- 保存・試し・削除
  const syncFields = () => { D.name = nameIn.value; D.prompt = promptIn.value; };
  const dirty = () => { syncFields(); return !M.sameDraft(D, orig); };
  const setBusy = (on) => { busy = on; saveBtn.disabled = tryBtn.disabled = delBtn.disabled = on; };

  const valid = () => {
    syncFields();
    const v = M.validate(D);
    if (!v.ok) { showErrors(v.errors); return false; }
    clearErrors();
    return true;
  };

  /** サーバーへ今の内容を置く。新規は一時停止で作る（asTrial）。保存済みは直しがあれば更新。返り: routineId */
  async function persist({ asTrial }) {
    const fields = M.fieldsOf(D);
    if (!D.id) {
      let r = await host.invoke('routines.create', { ...fields, paused: asTrial });
      if (asTrial && r && !r.paused) r = await host.invoke('routines.pause', { routineId: r.id }).catch(() => r);
      D.id = r.id;
      D.trigger = structuredClone(r.trigger);
      current = r;
      store.put(r);
      tempCreated = asTrial;
      orig = structuredClone(D);
      return r.id;
    }
    if (dirty()) {
      const r = await host.invoke('routines.update', { routineId: D.id, ...fields });
      current = { ...current, ...r };
      D.trigger = structuredClone(r.trigger);
      store.put(current);
      orig = structuredClone(D);
    }
    return D.id;
  }

  async function save() {
    if (busy || !valid()) return;
    setBusy(true);
    try {
      const wasTrial = tempCreated;
      const newHook = D.trigger.kind === 'webhook' && current?.trigger?.kind !== 'webhook';
      const id = await persist({ asTrial: false });
      if (wasTrial) {
        const r = await host.invoke('routines.resume', { routineId: id });
        current = { ...current, ...r };
        store.put(current);
      }
      finalized = true;
      if (newHook) {
        isNew = false; fState.f.hidden = false; delBtn.hidden = false;
        saveBtn.textContent = t('channels:routines.save');
        paintState(); paintWhen();
      } else closeSheet();
    } catch (e) {
      showFail(t('channels:routines.saveFailed', { error: message(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function tryRun() {
    if (busy || !valid()) return;
    setBusy(true);
    tried = true;
    res.replaceChildren(runMark(t('channels:feed.state.working')), document.createTextNode(t('channels:routines.try.running')));
    res.classList.remove('fail');
    try {
      const id = await persist({ asTrial: true });
      if (closed) { dropTemp(); return; }   // 作っている間に閉じられた
      const r = await host.invoke('routines.run', { routineId: id, dryRun: true });
      if (!dlg.isConnected) return;
      const state = typeof r?.state === 'string' ? r.state : 'done';
      const summary = typeof r?.summary === 'string' ? r.summary : typeof r?.text === 'string' ? r.text : '';
      res.replaceChildren(document.createTextNode([stateText(state), summary].filter(Boolean).join(' · ')));
      res.classList.toggle('fail', state === 'failed');
    } catch (e) {
      if (!dlg.isConnected) return;
      res.textContent = t('channels:routines.try.failed', { error: message(e) });
      res.classList.add('fail');
    } finally {
      if (dlg.isConnected) setBusy(false);
    }
  }

  let deleteArmed = 0;
  function paintDelete() {
    delBtn.textContent = deleteArmed ? t('channels:routines.deleteConfirm') : t('channels:routines.delete');
    delBtn.classList.toggle('armed', Boolean(deleteArmed));
  }
  async function remove() {
    if (busy || !D.id) return;
    if (!deleteArmed) {
      deleteArmed = setTimeout(() => { deleteArmed = 0; paintDelete(); }, DELETE_CONFIRM_MS);
      paintDelete();
      return;
    }
    clearTimeout(deleteArmed);
    deleteArmed = 0;
    setBusy(true);
    try {
      await host.invoke('routines.delete', { routineId: D.id });
      store.drop(D.id);
      finalized = true;
      closeSheet();
    } catch (e) {
      showFail(t('channels:routines.deleteFailed', { error: message(e) }));
      paintDelete();
    } finally {
      setBusy(false);
    }
  }

  async function setPaused(paused) {
    if (isNew || busy || Boolean(current?.paused) === paused) return;
    setBusy(true);
    clearErrors();
    try {
      const r = await host.invoke(paused ? 'routines.pause' : 'routines.resume', { routineId: D.id });
      current = { ...current, ...r };
      store.put(current);
      paintState();
    } catch (e) {
      showFail(t('channels:routines.saveFailed', { error: message(e) }));
    } finally {
      setBusy(false);
    }
  }

  // ---- 閉じる（試しのために作った下書きは、確定しなければ消す）
  let closed = false;
  const closeSheet = () => { if (dlg.open) dlg.close(); };
  /** 試すために作った下書きを、確定しないまま閉じたら消す */
  function dropTemp() {
    if (!tempCreated || finalized || !D.id) return;
    const id = D.id;
    tempCreated = false;
    host.invoke('routines.delete', { routineId: id }).then(() => store.drop(id)).catch(() => {});
  }
  // Esc・［取り消す］・× のどれで閉じても通る後始末
  dlg.addEventListener('close', () => {
    closed = true;
    closePops();
    clearTimeout(deleteArmed);
    dropTemp();
    dlg.remove();
    done();
    returnTo?.focus?.({ preventScroll: true });
  });
  const returnTo = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  // 背後の押下: 打った内容があれば閉じない（誤って押して失わないように）
  dlg.addEventListener('click', (e) => { if (e.target === dlg && !dirty() && !tried) closeSheet(); });

  // ---- 入力
  closeX.onclick = closeSheet;
  cancelBtn.onclick = closeSheet;
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  tryBtn.onclick = tryRun;
  delBtn.onclick = remove;
  onBtn.onclick = () => setPaused(false);
  offBtn.onclick = () => setPaused(true);
  openChannelBtn.onclick = () => {
    closeSheet();
    document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: D.channelId } }));
  };
  kindSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-when]');
    if (!b || b.disabled) return;
    D.trigger = M.switchKind(D.trigger, b.dataset.when);
    fWhen.fe.hidden = true;
    paintWhen();
  });
  nameIn.addEventListener('keydown', (e) => { if (isComposingKey(e) && e.key === 'Enter') e.preventDefault(); });
  nameIn.addEventListener('input', () => { fName.fe.hidden = true; });
  promptIn.addEventListener('input', () => { fPrompt.fe.hidden = true; });
  promptIn.addEventListener('keydown', (e) => { if (!isComposingKey(e) && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });

  // ---- 初期表示
  nameIn.value = D.name;
  promptIn.value = D.prompt;
  paintBot();
  paintChannel();
  paintTimeout();
  paintWhen();
  paintDelete();
  paintState();
  if (!bots.length) { botNote.textContent = t('channels:routines.who.noBots'); botNote.hidden = false; }
  (async () => {
    const b = botOf(D.botId);
    await ensureVocab(b?.backend);
    if (closed) return;
    const modes = vocab.get(b?.backend) ?? {};
    if (Object.keys(modes).length) {
      D.mode = isNew ? M.defaultRoutineMode(modes, b?.mode) : M.validRoutineMode(modes, D.mode);
      orig.mode = D.mode;
    }
    paintMode();
  })();
  paintMode();
  dlg.showModal();
  (isNew ? nameIn : promptIn).focus();

  return {
    isOpen: () => dlg.open,
    focus() { (dlg.querySelector('input,textarea') ?? dlg).focus(); },
    onEvent(ev) {
      if (ev?.type !== 'routinesChanged' || !D.id) return;
      if (ev.removed === D.id && !finalized) { finalized = true; closeSheet(); return; }
      if (ev.routine?.id === D.id) { current = { ...current, ...ev.routine }; paintState(); }
    },
  };
}

// ---------------------------------------------------------------- 部品

/** 押すチップ（.chip.fld-chip）。label に字を入れ替える。見た目は style.css の .chip */
function chipButton(id) {
  const btn = el('button', 'chip fld-chip');
  btn.type = 'button';
  btn.id = id;
  const lead = el('span', 'lead');
  lead.hidden = true;
  const label = el('span', 'v');
  const caret = GLYPH(CARET);
  caret.classList.add('caret');
  btn.append(lead, label, caret);
  return { btn, label, lead };
}

/** 一覧の行（入力欄の面の行と同じ形: ✓・名前・補足） */
function optionRow({ key, main, avatar, sub, on, pick }, onPick) {
  const b = el('button', 'copt');
  b.type = 'button';
  b.dataset.key = key;
  b.setAttribute('role', 'option');
  b.setAttribute('aria-selected', String(Boolean(on)));
  b.append(el('span', 'tick', on ? '✓' : ''));
  const mid = el('span', 'cbody');
  const title = el('span', avatar ? 'main hasb' : 'main');
  if (avatar) title.append(botIcon(avatar, 'av xs'), el('span', 'txt', main));
  else title.textContent = main;
  mid.append(title);
  if (sub) mid.append(el('span', 'sub', sub));
  b.append(mid);
  b.onclick = onPick;
  return b;
}
