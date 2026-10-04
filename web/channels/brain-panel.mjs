// bot のページの「思考の流れ」（ADR 0126）。心拍の入り切り・間隔・眠らせる・今すぐ、欲求の数値、気がかり、思考の流れ（新しい順）。
// 画面と docs では「思考の流れ（モデルの出力の記録）」と書く。体験があるとは書かない。欲求は数値で見せる（コードで計算した値）。
// 操作はすべて host.invoke(op, args)。更新は brainChanged（呼び出し側が refresh する）。心拍の ON・間隔は bots.update の pulse（bot のページの保存の列に乗せる）。
// i18n-dynamic: channels:bot.brain.kind.
// i18n-dynamic: channels:bot.brain.reason.
// i18n-dynamic: channels:bot.brain.drives.
//
//   createBrainPanel(host, { update }) → { el, setBot(bot), refresh() }
//     update(patch) … bots.update の欄（{ pulse: { on?, everyMin? } }）を保存する（bot のページの保存。返ったら setBot が呼ばれる）
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';

const EVERY = [5, 10, 15, 30, 60];
const DRIVES = ['curiosity', 'anxiety', 'loneliness', 'fatigue'];
const message = (e) => (e && typeof e === 'object' && 'message' in e ? e.message : String(e));
const pad = (n) => String(n).padStart(2, '0');
/** 今日なら 10:41、別の日なら 10/3 10:41 */
export function timeLabel(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 連続する静かな行を 1 行にたたむ（新しい順の並びのまま）。{ row, n, at } の列。静かな行の理由は、たたんだ先頭（いちばん新しい行）のもの */
export function foldStream(rows) {
  const out = [];
  for (const row of rows ?? []) {
    const last = out.at(-1);
    if (row.kind === 'quiet' && last?.row.kind === 'quiet') { last.n += 1; last.oldest = row.at; continue; }
    out.push({ row, n: 1, oldest: row.at });
  }
  return out;
}

export function createBrainPanel(host, { update }) {
  const root = el('div', 'brain-wrap');
  const S = { bot: null, view: null, seq: 0, error: '', busy: false };

  const head = el('h4', null, t('channels:bot.brain.title'));
  head.append(el('span', 'r', t('channels:bot.brain.record')));
  const note = el('p', 'bp-nt brain-note', t('channels:bot.brain.note'));

  // 心拍の入り切りと間隔
  const sw = el('button', 'bp-sw');
  sw.type = 'button';
  sw.id = 'botPulseSwitch';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('channels:bot.brain.pulse.label'));
  const every = el('select', 'brain-every');
  every.id = 'botPulseEvery';
  every.setAttribute('aria-label', t('channels:bot.brain.pulse.every'));
  for (const n of EVERY) { const o = el('option', null, t('channels:bot.brain.pulse.minutes', { n })); o.value = String(n); every.append(o); }
  const pulseRow = el('div', 'bp-kvr brain-pulse');
  pulseRow.append(el('span', 'k', t('channels:bot.brain.pulse.label')), sw, every);
  const hint = el('p', 'bp-nt', t('channels:bot.brain.pulse.hint'));

  // 状態・操作
  const status = el('p', 'brain-status');
  const sleepBtn = el('button', 'btn', t('channels:bot.brain.actions.sleep'));
  sleepBtn.type = 'button';
  sleepBtn.id = 'botBrainSleep';
  const beatBtn = el('button', 'btn', t('channels:bot.brain.actions.beat'));
  beatBtn.type = 'button';
  beatBtn.id = 'botBrainBeat';
  const clearBtn = el('button', 'btn', t('channels:bot.brain.actions.clear'));
  clearBtn.type = 'button';
  clearBtn.id = 'botBrainClear';
  const actions = el('div', 'brain-actions');
  actions.append(sleepBtn, beatBtn, clearBtn);
  const err = el('p', 'mem-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  const drives = el('div', 'brain-drives');
  drives.setAttribute('aria-label', t('channels:bot.brain.drives.title'));
  const loopsHead = el('div', 'memh second');
  loopsHead.append(el('b', null, t('channels:bot.brain.loops.title')));
  const loopsBox = el('div', 'brain-loops');
  const streamHead = el('div', 'memh second');
  streamHead.append(el('b', null, t('channels:bot.brain.stream.title')));
  const streamMeta = el('span');
  streamHead.append(streamMeta);
  const streamBox = el('div', 'brain-stream');
  root.append(pulseRow, hint, status, actions, err, drives, loopsHead, loopsBox, streamHead, streamBox);

  const wrap = el('div', 'bp-brain');
  wrap.append(head, note, root);

  const setError = (text) => { S.error = text; err.textContent = text; err.hidden = !text; };

  // ---------------------------------------------------------------- 描画
  const pulseOf = () => S.view?.pulse ?? S.bot?.pulse ?? { on: false, everyMin: 10 };

  function paintControls() {
    const pulse = pulseOf();
    const st = S.view?.status;
    sw.setAttribute('aria-checked', String(Boolean(pulse.on)));
    if (document.activeElement !== every) every.value = String(pulse.everyMin ?? 10);
    every.disabled = !pulse.on;
    const parts = [];
    if (!pulse.on) parts.push(t('channels:bot.brain.pulse.off'));
    else if (st?.paused) parts.push(t('channels:bot.brain.status.paused'));
    else if (st?.running) parts.push(t('channels:bot.brain.status.running'));
    else if (st?.nextAt) parts.push(t('channels:bot.brain.status.next', { time: timeLabel(st.nextAt) }));
    if (pulse.on) parts.push(st?.lastBeatAt ? t('channels:bot.brain.status.last', { time: timeLabel(st.lastBeatAt) }) : t('channels:bot.brain.status.never'));
    if (pulse.on && st) {
      if (!st.home) parts.push(t('channels:bot.brain.status.noHome'));
      else {
        parts.push(t('channels:bot.brain.status.home', { name: st.home.name }));
        const b = st.budget;
        if (b) parts.push(b.daily === null ? t('channels:bot.brain.status.budgetNone') : t('channels:bot.brain.status.budgetLeft', { pct: String(Math.round(b.channel * 100) / 100) }));
        if (b) parts.push(t('channels:bot.brain.status.tokensLeft', { k: String(Math.round(b.tokensLeft / 1000)) }));
      }
    }
    status.textContent = parts.join(' · ');
    sleepBtn.textContent = st?.paused ? t('channels:bot.brain.actions.wake') : t('channels:bot.brain.actions.sleep');
    sleepBtn.disabled = !pulse.on || S.busy;
    beatBtn.disabled = !pulse.on || Boolean(st?.paused) || Boolean(st?.running) || S.busy;
    clearBtn.disabled = !S.view || (S.view.total === 0 && !(S.view.loops?.length)) || S.busy;
  }

  function paintDrives() {
    drives.replaceChildren();
    const values = S.view?.status?.drives;
    drives.hidden = !values;
    if (!values) return;
    for (const name of DRIVES) {
      const v = Math.max(0, Math.min(1, values[name] ?? 0));
      const row = el('div', 'brain-drive');
      row.dataset.drive = name;
      const meter = el('span', 'brain-meter');
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '1');
      meter.setAttribute('aria-valuenow', String(v));
      meter.setAttribute('aria-label', t(`channels:bot.brain.drives.${name}`));
      const fill = el('span', 'brain-fill');
      fill.style.width = `${Math.round(v * 100)}%`;
      meter.append(fill);
      row.append(el('span', 'brain-dk', t(`channels:bot.brain.drives.${name}`)), meter, el('span', 'brain-dv', v.toFixed(2)));
      drives.append(row);
    }
  }

  function wakeText(w) {
    return [w?.thread ? `thread ${w.thread}` : null, w?.word ? `「${w.word}」` : null, Number.isFinite(w?.at) ? timeLabel(w.at) : null].filter(Boolean).join(' · ');
  }

  function paintLoops() {
    loopsBox.replaceChildren();
    const list = S.view?.loops ?? [];
    if (!list.length) { loopsBox.append(el('p', 'mem-empty', t('channels:bot.brain.loops.empty'))); return; }
    for (const l of list) {
      const row = el('div', 'brain-loop');
      row.dataset.id = l.id;
      const tx = el('span', 'tx');
      tx.append(el('span', 'tx-text', l.text));
      const meta = [wakeText(l.wakeOn) ? t('channels:bot.brain.loops.wake', { wake: wakeText(l.wakeOn) }) : null,
        Number.isFinite(l.due) ? t('channels:bot.brain.loops.due', { due: timeLabel(l.due) }) : null,
        l.taint ? t('channels:bot.brain.loops.taint') : null].filter(Boolean).join(' · ');
      if (meta) tx.append(el('span', 'brain-meta', meta));
      const drop = el('button', 'btn forget', t('channels:bot.brain.loops.resolve'));
      drop.type = 'button';
      drop.onclick = () => run(() => host.invoke('brain.loopResolve', { botId: S.bot.id, id: l.id, status: 'dropped' }));
      row.append(tx, drop);
      loopsBox.append(row);
    }
  }

  function reasonText(meta) {
    const reason = meta?.reason;
    if (!reason) return '';
    const key = `channels:bot.brain.reason.${reason}`;
    const text = t(key);
    return text === key ? reason : text;
  }

  function paintStream() {
    streamBox.replaceChildren();
    const rows = S.view?.stream ?? [];
    streamMeta.textContent = S.view ? t('channels:bot.brain.stream.total', { n: S.view.total }) : '';
    if (!rows.length) { streamBox.append(el('p', 'mem-empty', t('channels:bot.brain.stream.empty'))); return; }
    for (const { row, n } of foldStream(rows)) {
      const line = el('div', `brain-row k-${row.kind}`);
      line.dataset.seq = String(row.seq);
      line.dataset.kind = row.kind;
      const tx = el('span', 'tx');
      const label = el('span', 'brain-kind', t(`channels:bot.brain.kind.${row.kind}`));
      let text = row.text;
      if (row.kind === 'quiet') text = n > 1 ? t('channels:bot.brain.stream.quietMany', { n }) : t('channels:bot.brain.stream.quiet');
      tx.append(label, el('span', 'tx-text', text));
      const bits = [];
      if (row.kind === 'quiet' && row.meta?.reason) bits.push(t('channels:bot.brain.stream.why', { reason: reasonText(row.meta) }));
      if (row.tokens) bits.push(t('channels:bot.brain.stream.tokens', { n: (row.tokens.input ?? 0) + (row.tokens.output ?? 0) + (row.tokens.cached ?? 0) }));
      if (row.taint) bits.push(t('channels:bot.brain.stream.taint'));
      if (bits.length) tx.append(el('span', 'brain-meta', bits.join(' · ')));
      line.append(el('time', 'brain-time', timeLabel(row.at)), tx);
      streamBox.append(line);
    }
  }

  function paint() {
    const live = Boolean(S.bot);
    wrap.hidden = !live;
    if (!live) return;
    paintControls();
    paintDrives();
    paintLoops();
    paintStream();
  }

  // ---------------------------------------------------------------- 操作
  async function run(task) {
    if (!S.bot) return;
    S.busy = true;
    setError('');
    paintControls();
    try { await task(); }
    catch (e) { setError(t('channels:bot.brain.failed', { error: message(e) })); }
    S.busy = false;
    await refresh();
  }

  sw.addEventListener('click', () => {
    if (!S.bot) return;
    const next = !pulseOf().on;
    sw.setAttribute('aria-checked', String(next));
    S.busy = true;
    update({ pulse: { on: next } }).finally(() => { S.busy = false; refresh(); });
  });
  every.addEventListener('change', () => { if (S.bot) update({ pulse: { everyMin: Number(every.value) } }).finally(refresh); });
  sleepBtn.addEventListener('click', () => run(() => host.invoke('brain.pause', { botId: S.bot.id, paused: !S.view?.status?.paused })));
  beatBtn.addEventListener('click', () => run(() => host.invoke('brain.beat', { botId: S.bot.id })));
  clearBtn.addEventListener('click', () => { if (window.confirm(t('channels:bot.brain.actions.clearConfirm'))) run(() => host.invoke('brain.clear', { botId: S.bot.id })); });

  // ---------------------------------------------------------------- 読み込み
  async function refresh() {
    const bot = S.bot;
    if (!bot) { paint(); return; }
    const seq = ++S.seq;
    try {
      const view = await host.invoke('brain.view', { botId: bot.id, limit: 80 });
      if (seq !== S.seq || S.bot?.id !== bot.id) return;
      S.view = view;
      setError('');
    } catch (e) {
      if (seq !== S.seq || S.bot?.id !== bot.id) return;
      setError(t('channels:bot.brain.failed', { error: message(e) }));
    }
    paint();
  }

  return {
    el: wrap,
    setBot(bot) {
      const same = bot && S.bot?.id === bot.id;
      S.bot = bot ?? null;
      if (!same) { S.view = null; setError(''); }
      paint();
      if (bot) refresh();
    },
    refresh,
  };
}
