// スレッドの帯の「予算」のメーターと内訳（docs/design-system.md「スレッドの帯」、ADR 0119）。
//   メーターは Chats の入力欄の上の文脈のメーターと同じ部品（compaction.css の .context-meter / .context-meter-bar）。
//   分母は「このスレッドに今日使ってよい量」（チャンネルの 1 日の予算 × 1 スレッドの配分。どちらも bot のバックエンドの週の使用枠に対する %）。
//   使った分は同じ単位で足されているので、割合は使った % ÷ 配分の %。小数を切り捨てないので、少し使えば棒が動く。
//   押すと内訳（channels.threadBudget）: bot ごとの今日の使用トークン（キャッシュは別に）・1 日の上限の目安・週の使用枠とリセット時刻・休憩中。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { botIcon } from './bot-icon.mjs';
import { percentText } from '../header-usage.mjs';

/** 棒の最小の長さ（%）。使っていれば、小さくても見える */
export const MIN_FILL = 6;

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** トークンの数。1.2k・3.4M */
export function tokensShort(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v >= 1_000_000) { const m = v / 1_000_000; return `${m >= 100 ? Math.round(m) : (Math.round(m * 10) / 10).toString()}M`; }
  const k = v / 1000;
  return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toString()}k`;
}

/**
 * スレッドのトークンを「新しい入力・出力・キャッシュ読み」に分ける。入力はキャッシュ読みを含む（Claude・Codex・Antigravity とも）ので、
 * キャッシュ読みを引いたものが新しい入力。キャッシュ読みが入力より大きいのは、キャッシュを入力と分けて数えていた頃の Antigravity の行
 * （core/usage.mjs の inputWithCache と同じ見方）なので、その入力はキャッシュを含まないものとして読む
 * @param {{ input?: number, output?: number, cached?: number }} tokens
 */
export function tokenSplit(tokens) {
  const cached = Math.max(0, Number(tokens?.cached) || 0);
  const raw = Math.max(0, Number(tokens?.input) || 0);
  const output = Math.max(0, Number(tokens?.output) || 0);
  const fresh = cached > raw ? raw : raw - cached;
  return { fresh, output, cached, total: fresh + output };
}

/**
 * メーターの材料。予算の無いチャンネル（1 日の予算が null）・DM は null。
 * @param {{ daily: number|null, perThread: number }|null} budget チャンネルの budget
 * @param {{ spend?: { day: string, percent: number } }|null} thread
 * @returns {{ spent: number, allowance: number, ratio: number, pct: number, text: string, fill: number, high: boolean }|null}
 */
export function meterOf(budget, thread, now = Date.now()) {
  if (!budget || budget.daily == null || !(budget.perThread > 0)) return null;
  const allowance = (budget.daily * budget.perThread) / 100;
  if (!(allowance > 0)) return null;
  const spend = thread?.spend;
  const spent = spend?.day === dayOf(now) && spend.percent > 0 ? spend.percent : 0;
  const ratio = spent / allowance;
  const pct = ratio * 100;
  const text = spent <= 0 ? '0%' : pct < 1 ? '<1%' : percentText(pct);
  return { spent, allowance, ratio, pct, text, fill: spent > 0 ? Math.min(100, Math.max(pct, MIN_FILL)) : 0, high: pct >= 80 };
}

/** 週の使用枠に対する %。0.04 のような小さな値も 0 にしない */
export function weeklyText(percent) {
  const v = Number(percent) || 0;
  if (v <= 0) return '0%';
  if (v < 0.01) return '<0.01%';
  return `${v >= 10 ? Math.round(v) : Math.round(v * 100) / 100}%`;
}

const timeText = (iso, lang) => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const same = dayOf(at.getTime()) === dayOf(Date.now());
  return at.toLocaleString(lang, same ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const caretIcon = () => {
  const svg = svgEl('svg', { class: 'i caret', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M7 10l5 5 5-5' }));
  return svg;
};

/**
 * 帯のメーター（押すと内訳）。要素は 1 つを使い回し、状態は update で渡す。
 * @param {{ load: () => Promise<object|null>, bots: () => Map<string, object>, lang: () => string }} deps
 */
export function createBudgetMeter({ load, bots, lang }) {
  const wrap = el('span', 'context-meter-wrap th-meter-wrap');
  wrap.hidden = true;
  const button = el('button', 'context-meter th-meter');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const pop = el('div', 'pop th-budget-pop');
  pop.id = `thBudgetPop${Math.random().toString(36).slice(2, 8)}`;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('channels:thread.budget.title'));
  pop.hidden = true;
  button.setAttribute('aria-controls', pop.id);
  wrap.append(button, pop);

  let current = null, totals = null, seq = 0, loadedAt = 0;

  function paintButton() {
    if (!current) { wrap.hidden = true; return; }
    wrap.hidden = false;
    button.classList.toggle('high', current.high);
    const bar = el('span', 'context-meter-bar');
    const fill = el('span');
    fill.style.width = `${current.fill}%`;
    bar.append(fill);
    button.replaceChildren(document.createTextNode(t('channels:thread.budget.label')), bar, document.createTextNode(current.text), caretIcon());
    button.setAttribute('aria-label', t('channels:thread.budget.spoken', { pct: current.text }));
  }

  function row(label, value, cls = '') {
    const r = el('div', `th-bp-row ${cls}`.trim());
    r.append(el('span', 'k', label), el('span', 'v', value));
    return r;
  }

  function botRow(b) {
    const bot = bots().get(b.botId);
    const box = el('div', 'th-bp-bot');
    const head = el('div', 'th-bp-bothead');
    if (bot) head.append(botIcon(bot, 'th-bp-icon'));
    head.append(el('b', null, bot?.name ?? b.botId));
    if (b.restingUntil) head.append(el('span', 'rest', t('channels:thread.budget.resting', { time: timeText(b.restingUntil, lang()) })));
    box.append(head);
    const { fresh, output, cached } = tokenSplit(b.today);
    box.append(el('div', 'th-bp-line', fresh + output + cached
      ? t('channels:thread.budget.botToday', { input: tokensShort(fresh), output: tokensShort(output), cached: tokensShort(cached) })
      : t('channels:thread.budget.botNone')));
    const bits = [];
    if (b.allowanceTokens) bits.push(t('channels:thread.budget.botLimit', { tokens: tokensShort(b.allowanceTokens) }));
    if (b.window) {
      bits.push(t('channels:thread.budget.botWeek', { used: weeklyText(b.window.usedPercent) }));
      if (b.window.resetsAt) bits.push(t('channels:thread.budget.botReset', { time: timeText(b.window.resetsAt, lang()) }));
    }
    box.append(el('div', 'th-bp-line weak', bits.length ? bits.join(' · ') : t('channels:thread.budget.botUnknown')));
    return box;
  }

  function paintPop(data) {
    const body = [];
    const head = el('div', 'th-bp-head');
    head.append(el('b', null, t('channels:thread.budget.title')));
    body.push(head);
    if (!data) {
      body.push(el('p', 'th-bp-note', t('channels:thread.budget.failed')));
    } else {
      const m = current;
      const bar = el('div', 'th-bp-bar');
      const fill = el('i');
      fill.style.width = `${m?.fill ?? 0}%`;
      bar.append(fill);
      body.push(row(t('channels:thread.budget.thread'), m ? m.text : '—', m?.high ? 'high' : ''), bar);
      body.push(el('p', 'th-bp-sub', t('channels:thread.budget.amount', { spent: weeklyText(data.spent), allowance: weeklyText(data.allowance) })));
      if (data.derived) body.push(el('p', 'th-bp-sub', t('channels:thread.budget.derived')));
      body.push(row(t('channels:thread.budget.channel'), t('channels:thread.budget.channelAmount', { spent: weeklyText(data.channelSpent), daily: weeklyText(data.daily) })));
      if (totals) {
        const s = tokenSplit(totals);
        body.push(el('div', 'th-bp-sec', t('channels:thread.budget.totals')),
          el('div', 'th-bp-line', t('channels:thread.budget.botToday', { input: tokensShort(s.fresh), output: tokensShort(s.output), cached: tokensShort(s.cached) })));
      }
      if (data.bots?.length) {
        const list = el('div', 'th-bp-bots');
        for (const b of data.bots) list.append(botRow(b));
        body.push(el('div', 'th-bp-sec', t('channels:thread.budget.bots')), list);
      }
      body.push(el('p', 'th-bp-note', t('channels:thread.budget.hint')));
    }
    pop.replaceChildren(...body);
  }

  async function refresh() {
    const mine = ++seq;
    let data = null;
    try { data = await load(); } catch { data = null; }
    if (mine !== seq || pop.hidden) return;
    loadedAt = Date.now();
    paintPop(data);
  }

  function close(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    seq++;
    if (focus) button.focus();
  }
  function open() {
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    pop.replaceChildren(el('p', 'th-bp-note', t('channels:thread.loading')));
    refresh();
  }
  button.onclick = () => (pop.hidden ? open() : close(true));
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target)) close(); });
  document.addEventListener('focusin', (e) => { if (!pop.hidden && !wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (!pop.hidden && e.key === 'Escape') { e.preventDefault(); close(true); } });

  return {
    el: wrap,
    /** メーターの材料（meterOf の返り）とスレッド全体のトークンを渡す。開いている間は内訳も取り直す（取りすぎない） */
    update(meter, tokens) {
      current = meter;
      totals = tokens;
      paintButton();
      if (!meter) { close(); return; }
      if (!pop.hidden && Date.now() - loadedAt > 1500) refresh();
    },
    close,
  };
}
