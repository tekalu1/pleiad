// ルーティンの編集のシート・脇・見出しの、DOM に触れない決まりごと（テストから直接呼ぶ。ADR 0111・docs/channels.md）。
// i18n-dynamic: channels:routines.day.
// i18n-dynamic: channels:routines.text.event.
// 画面の部品は routine-sheet.mjs・routine-store.mjs。型の正本は core/channels/types.mjs の Routine。
// 「次は …」の見積もりはここで計算する（編集中の式にも出すため）。保存済みのルーティンの nextAt は routines.list / get が返す値が正で、これは目安。
// 時刻は PC の現地時刻。曜日は 0=日 … 6=土（Date#getDay と cron の曜日）。

export const KINDS = Object.freeze(['daily', 'weekly', 'interval', 'cron', 'event', 'webhook']);
/** シートに並べる曜日（月 … 日）。値は 0=日 … 6=土 */
export const WEEK_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
/** 間隔の選び肢（分） */
export const INTERVAL_MINUTES = Object.freeze([5, 10, 15, 30, 45, 60, 120, 180, 240, 360, 720, 1440]);
/** 承認待ちの期限の選び肢（分） */
export const TIMEOUT_MINUTES = Object.freeze([5, 10, 15, 30, 60, 120, 360, 720, 1440]);
export const DEFAULT_TIMEOUT = 30;
export const EVENT_ONS = Object.freeze(['done', 'failed', 'waiting']);
/** 今は選べない種類（webhook は P3 の H1 が受け口を足してから） */
export const DISABLED_KINDS = Object.freeze(['webhook']);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHHMM = (s) => typeof s === 'string' && HHMM.test(s);
const minutesOf = (s) => { const m = HHMM.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

// ---------------------------------------------------------------- 下書き

/** 種類ごとの既定のトリガ。prev があれば引き継げる欄（時刻）を保つ */
export function defaultTrigger(kind, prev) {
  const at = isHHMM(prev?.at) ? prev.at : '09:00';
  switch (kind) {
    case 'daily': return { kind, at, weekdaysOnly: false };
    case 'weekly': return { kind, days: [1], at };
    case 'interval': return { kind, minutes: 30 };
    case 'cron': return { kind, expr: '0 9 * * 1-5' };
    case 'event': return { kind, on: 'failed', scope: 'all' };
    case 'webhook': return { kind, hookId: '' };
    default: return defaultTrigger('daily', prev);
  }
}

/** 既定の承認モード: bot のモードが「確認なし・制限なし」でなければそれ、そうでなければ語彙の既定（無人で動くので、強いモードは写さない） */
export function defaultRoutineMode(modes, botMode) {
  const ids = Object.keys(modes ?? {});
  const danger = (m) => m?.scope === 'full' && m?.autonomy === 'never';
  if (botMode in (modes ?? {}) && !danger(modes[botMode])) return botMode;
  if (ids.includes('default')) return 'default';
  return ids.find((id) => !danger(modes[id])) ?? ids[0] ?? '';
}

/** 語彙に無い承認モードなら、語彙の既定へ（バックエンドを替えたとき） */
export function validRoutineMode(modes, id) {
  if (id in (modes ?? {})) return id;
  return defaultRoutineMode(modes, '');
}

export function newDraft({ botId = '', channelId = '', mode = '' } = {}) {
  return { id: null, name: '', botId, channelId, prompt: '', trigger: defaultTrigger('daily'), mode, approvalTimeoutMin: DEFAULT_TIMEOUT, paused: false };
}

export function fromRoutine(r) {
  return {
    id: r.id, name: r.name ?? '', botId: r.botId ?? '', channelId: r.channelId ?? '', prompt: r.prompt ?? '',
    trigger: JSON.parse(JSON.stringify(r.trigger ?? defaultTrigger('daily'))),
    mode: r.mode ?? '', approvalTimeoutMin: Number(r.approvalTimeoutMin) || DEFAULT_TIMEOUT, paused: Boolean(r.paused),
  };
}

/** 種類を替える。時刻は引き継ぎ、ほかは既定に */
export function switchKind(trigger, kind) {
  return trigger?.kind === kind ? trigger : defaultTrigger(kind, trigger);
}

function cleanTrigger(tr) {
  switch (tr.kind) {
    case 'daily': return { kind: 'daily', at: tr.at, weekdaysOnly: Boolean(tr.weekdaysOnly) };
    case 'weekly': return { kind: 'weekly', days: WEEK_ORDER.filter((d) => tr.days?.includes(d)).sort((a, b) => a - b), at: tr.at };
    case 'interval': return { kind: 'interval', minutes: Number(tr.minutes), ...(tr.window?.from && tr.window?.to ? { window: { from: tr.window.from, to: tr.window.to } } : {}) };
    case 'cron': return { kind: 'cron', expr: String(tr.expr ?? '').trim().replace(/\s+/g, ' ') };
    case 'event': return { kind: 'event', on: tr.on, scope: tr.scope ?? 'all' };
    default: return { ...tr };
  }
}

/** routines.create / routines.update に渡す欄（routineId と paused は呼び出し側） */
export function fieldsOf(draft) {
  return {
    name: draft.name.trim(), botId: draft.botId, channelId: draft.channelId, prompt: draft.prompt.trim(),
    trigger: cleanTrigger(draft.trigger), mode: draft.mode, approvalTimeoutMin: Number(draft.approvalTimeoutMin) || DEFAULT_TIMEOUT,
  };
}

/** 保存済み（か開いた時点）と同じ内容か。閉じるときの確認と、試しに動かす前に保存が要るかに使う */
export const sameDraft = (a, b) => JSON.stringify(fieldsOf(a)) === JSON.stringify(fieldsOf(b));

/**
 * 保存してよいか。errors のキーは欄の名前、値は辞書 channels:routines.error.<値> の語。
 * name・bot・channel・prompt・trigger（時刻・曜日・間隔・時間帯・式・webhook）
 */
export function validate(draft) {
  const errors = {};
  if (!draft.name.trim()) errors.name = 'name';
  if (!draft.botId) errors.bot = 'bot';
  if (!draft.channelId) errors.channel = 'channel';
  if (!draft.prompt.trim()) errors.prompt = 'prompt';
  const tr = draft.trigger;
  if (tr.kind === 'daily' || tr.kind === 'weekly') {
    if (!isHHMM(tr.at)) errors.trigger = 'time';
    else if (tr.kind === 'weekly' && !tr.days?.length) errors.trigger = 'days';
  } else if (tr.kind === 'interval') {
    if (!(Number(tr.minutes) >= 1)) errors.trigger = 'minutes';
    else if (tr.window && (!isHHMM(tr.window.from) || !isHHMM(tr.window.to) || tr.window.from === tr.window.to)) errors.trigger = 'window';
  } else if (tr.kind === 'cron') {
    if (!parseCron(tr.expr)) errors.trigger = 'cron';
  } else if (tr.kind === 'event') {
    if (!EVENT_ONS.includes(tr.on)) errors.trigger = 'event';
  } else errors.trigger = 'kind';   // webhook は今は作れない
  return { ok: Object.keys(errors).length === 0, errors };
}

// ---------------------------------------------------------------- cron（5 欄。画面の見積もりと検査のため。正本はサーバー側）

const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];   // 分・時・日・月・曜日

function parseField(src, [lo, hi]) {
  const out = new Set();
  for (const part of String(src).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!(step >= 1)) return null;
    let from, to;
    if (m[1] === '*') [from, to] = [lo, hi];
    else if (m[1].includes('-')) [from, to] = m[1].split('-').map(Number);
    else { from = Number(m[1]); to = m[2] === undefined ? from : hi; }
    if (!(from >= lo && to <= hi && from <= to)) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** 5 欄の式を解く。読めなければ null。dow は 7 を 0 に畳む。dom/dow の * は「制限なし」の印（どちらも制限があれば OR） */
export function parseCron(expr) {
  const f = String(expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const sets = f.map((s, i) => parseField(s, RANGES[i]));
  if (sets.some((s) => !s)) return null;
  const dow = new Set([...sets[4]].map((d) => (d === 7 ? 0 : d)));
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow, domAny: f[2].startsWith('*'), dowAny: f[4].startsWith('*') };
}

const dayMatches = (c, d) => {
  const byDom = c.dom.has(d.getDate()), byDow = c.dow.has(d.getDay());
  if (c.domAny || c.dowAny) return (c.domAny || byDom) && (c.dowAny || byDow);
  return byDom || byDow;
};

/** 式に合う次の時刻（after より後。1 年先まで）。無ければ null */
export function nextCron(expr, after) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c) return null;
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let dayOffset = 0; dayOffset <= 366; dayOffset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!c.month.has(day.getMonth() + 1) || !dayMatches(c, day)) continue;
    for (let h = 0; h < 24; h++) {
      if (!c.hour.has(h)) continue;
      for (let m = 0; m < 60; m++) {
        if (!c.minute.has(m)) continue;
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
        if (at >= start.getTime()) return at;
      }
    }
  }
  return null;
}

/** 式の読み下し。よくある形（毎日・平日・曜日の指定で、時刻が 1 つ）だけ。それ以外は null */
export function describeCron(expr) {
  const c = parseCron(expr);
  if (!c || c.minute.size !== 1 || c.hour.size !== 1 || !c.domAny || c.month.size !== 12 || String(expr).trim().split(/\s+/)[3] !== '*') return null;
  const at = `${String([...c.hour][0]).padStart(2, '0')}:${String([...c.minute][0]).padStart(2, '0')}`;
  const days = [...c.dow].sort((a, b) => a - b);
  if (days.length === 7) return { kind: 'daily', at };
  if (days.join() === '1,2,3,4,5') return { kind: 'weekdays', at };
  return { kind: 'weekly', at, days };
}

// ---------------------------------------------------------------- 次の時刻の見積もり

function atOnDay(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
}

/** 次に動く時刻（ms）。毎日・毎週・cron だけ（間隔は前回からなので見積もらない。イベント・webhook は時刻を持たない） */
export function nextRun(trigger, after = Date.now()) {
  if (trigger?.kind === 'cron') return nextCron(trigger.expr, after);
  if ((trigger?.kind !== 'daily' && trigger?.kind !== 'weekly') || !isHHMM(trigger.at)) return null;
  const from = new Date(after);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const wd = day.getDay();
    if (trigger.kind === 'daily' && trigger.weekdaysOnly && (wd === 0 || wd === 6)) continue;
    if (trigger.kind === 'weekly' && !trigger.days?.includes(wd)) continue;
    const at = atOnDay(day, trigger.at);
    if (at > after) return at;
  }
  return null;
}

/** 今日・明日・それ以外のどれか。画面が「今日 23:00」「明日 9:00」「10/6（月）9:00」に整える */
export function dayKind(at, now = Date.now()) {
  const a = new Date(at), n = new Date(now);
  const days = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'date';
}

// ---------------------------------------------------------------- 脇の並べ方

/**
 * 脇のルーティン: 次に動く時刻の近い順。有効で時刻を持つもの → 有効で時刻の無いもの（イベント・webhook）→ 一時停止。
 * 同じなら名前順。入力は変えない
 */
export function sortForSide(routines) {
  const rank = (r) => (r.paused ? 2 : Number.isFinite(r.nextAt) ? 0 : 1);
  return [...(routines ?? [])].sort((a, b) => (rank(a) - rank(b))
    || (rank(a) === 0 ? a.nextAt - b.nextAt : 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { numeric: true, sensitivity: 'base' }));
}

export const SIDE_LIMIT = 3;

/** 直近の実行が失敗か（脇の行に「✕ 失敗」を出す） */
export const lastFailed = (r) => r?.last?.state === 'failed';

// ---------------------------------------------------------------- 一覧の読み取り

/** routines.list の返り（{ routines } か配列）から行の配列を取り出す。形が違えば空 */
export function listOf(result) {
  const rows = Array.isArray(result) ? result : result?.routines;
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
}

/** 出来事 routinesChanged を一覧へ当てる。nextAt は新しい値が無ければ古い値を保つ（再計算は読み直しで） */
export function applyChange(list, ev) {
  if (ev?.removed) return list.filter((r) => r.id !== ev.removed);
  const r = ev?.routine;
  if (!r?.id) return list;
  const old = list.find((x) => x.id === r.id);
  const merged = { ...old, ...r, ...(r.nextAt === undefined && old ? { nextAt: old.nextAt } : {}) };
  return old ? list.map((x) => (x.id === r.id ? merged : x)) : [...list, merged];
}

// ---------------------------------------------------------------- 文言（t を受け取る。辞書は channels:routines.*）

const pad2 = (n) => String(n).padStart(2, '0');
/** 曜日の並び: 月・水・金（区切りは言語に従う） */
export const daysText = (days, t) => WEEK_ORDER.filter((d) => days?.includes(d)).map((d) => t(`channels:routines.day.${d}`)).join(t('channels:routines.daySep'));
export const timeText = (hhmm) => { const m = minutesOf(hhmm); return Number.isFinite(m) ? `${Math.floor(m / 60)}:${pad2(m % 60)}` : ''; };

/** 分の読み方: 30 分・2 時間・1 日 */
export function minutesText(minutes, t) {
  const m = Number(minutes);
  if (m % 1440 === 0) return t('channels:routines.unit.days', { count: m / 1440 });
  if (m % 60 === 0) return t('channels:routines.unit.hours', { count: m / 60 });
  return t('channels:routines.unit.minutes', { count: m });
}

/** トリガの 1 行の読み: 「毎日 9:00（平日）」「30 分ごと」「cron 0 9 * * 1-5」「会話の失敗」 */
export function triggerText(tr, t) {
  switch (tr?.kind) {
    case 'daily':
      return tr.weekdaysOnly ? t('channels:routines.text.weekdays', { time: timeText(tr.at) }) : t('channels:routines.text.daily', { time: timeText(tr.at) });
    case 'weekly': return t('channels:routines.text.weekly', { days: daysText(tr.days, t), time: timeText(tr.at) });
    case 'interval': return t('channels:routines.text.interval', { every: minutesText(tr.minutes, t) })
      + (tr.window ? t('channels:routines.text.window', { from: timeText(tr.window.from), to: timeText(tr.window.to) }) : '');
    case 'cron': return t('channels:routines.text.cron', { expr: tr.expr });
    case 'event': return t(`channels:routines.text.event.${tr.on}`);
    case 'webhook': return t('channels:routines.text.webhook');
    default: return '';
  }
}
