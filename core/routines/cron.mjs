// 5 欄の cron 式（分 時 日 月 曜日）の解析と、次に当たる時刻の計算（R1。ADR 0112）。依存を足さず、秒は持たない。
// 時刻は PC の現地時刻（Date の getHours など）。SDK も DOM も import しない純粋な部品。
//
//   parseCron(expr) → { expr, minute, hour, dom, month, dow, domAny, dowAny }   … 各欄は値の Set。曜日は 0〜6（日曜が 0。7 も日曜）。解析できなければ CronError
//   cronProblem(expr) → string | null                                           … 検査だけ（画面・ops の INVALID の理由）
//   nextCron(spec, after) → ms | null                                           … after（ms）より後の、いちばん早い一致の時刻（秒以下は 0）。8 年探して無ければ null（2 月 30 日など）
//
// 欄の書き方: `*`・`a`・`a-b`・`a,b,c`・`*/n`・`a-b/n`・`a/n`（a から最後まで n おき）。月と曜日は英語の 3 字（jan〜dec・sun〜sat）も読める。
// 日と曜日の両方を絞ったときは、cron の習わしどおり「どちらかに当たれば」（片方が `*` なら、もう片方だけで決まる）。
export class CronError extends Error {
  constructor(detail) { super(detail); this.name = 'CronError'; this.detail = detail; }
}

const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dom', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], offset: 1 },
  { key: 'dow', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], offset: 0 },
];
const SEARCH_YEARS = 8;

function number(field, text) {
  const name = field.names?.indexOf(text.toLowerCase());
  if (name !== undefined && name >= 0) return name + field.offset;
  if (!/^\d{1,2}$/.test(text)) throw new CronError(`${field.key}: "${text}" is not a number`);
  const n = Number(text);
  if (n < field.min || n > field.max) throw new CronError(`${field.key}: ${n} is out of range ${field.min}-${field.max}`);
  return n;
}

function parseField(field, text) {
  const values = new Set();
  let any = false;
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`${field.key}: empty item`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`${field.key}: "${part}" has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${field.key}: step "${stepText}" must be a positive number`);
      step = Number(stepText);
    }
    let from, to;
    if (range === '*') {
      from = field.min; to = field.key === 'dow' ? 6 : field.max;
      if (stepText === undefined) any = true;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) throw new CronError(`${field.key}: "${range}" is not a range`);
      from = number(field, a); to = number(field, b);
      if (from > to) throw new CronError(`${field.key}: range ${range} runs backwards`);
    } else {
      from = number(field, range);
      to = stepText !== undefined ? (field.key === 'dow' ? 6 : field.max) : from;
    }
    for (let v = from; v <= to; v += step) values.add(field.key === 'dow' && v === 7 ? 0 : v);
  }
  return { values, any };
}

/** 5 欄の式を解析する。欄の数が違う・範囲外・読めない書き方は CronError（detail に理由） */
export function parseCron(expr) {
  if (typeof expr !== 'string') throw new CronError('expression must be a string');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`expression needs 5 fields (minute hour day month weekday), got ${parts[0] === '' ? 0 : parts.length}`);
  const spec = { expr: parts.join(' ') };
  FIELDS.forEach((field, i) => {
    const { values, any } = parseField(field, parts[i]);
    spec[field.key] = values;
    if (field.key === 'dom') spec.domAny = any;
    if (field.key === 'dow') spec.dowAny = any;
  });
  return spec;
}

export function cronProblem(expr) {
  try { parseCron(expr); return null; } catch (e) { if (e instanceof CronError) return e.detail; throw e; }
}

const dayMatches = (spec, date) => {
  if (!spec.month.has(date.getMonth() + 1)) return false;
  const dom = spec.dom.has(date.getDate());
  const dow = spec.dow.has(date.getDay());
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dow;
  if (spec.dowAny) return dom;
  return dom || dow;
};

/** after（ms）より後の、いちばん早い一致。夏時間で存在しない時刻は飛ばす。見つからなければ null */
export function nextCron(spec, after) {
  const base = new Date(after);
  const hours = [...spec.hour].sort((a, b) => a - b);
  const minutes = [...spec.minute].sort((a, b) => a - b);
  const end = new Date(base.getFullYear() + SEARCH_YEARS, base.getMonth(), base.getDate()).getTime();
  for (let day = new Date(base.getFullYear(), base.getMonth(), base.getDate()); day.getTime() <= end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (!dayMatches(spec, day)) continue;
    // 探し始めの日は、基準の時より前の時は見なくてよい（毎分の式を何千回も数えるときの無駄を省く）
    const sameDay = day.getTime() === new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    for (const h of hours) {
      if (sameDay && h < base.getHours()) continue;
      for (const m of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (at.getHours() !== h || at.getMinutes() !== m) continue;   // 夏時間の隙間
        if (at.getTime() > after) return at.getTime();
      }
    }
  }
  return null;
}
