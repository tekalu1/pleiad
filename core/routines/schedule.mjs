// ルーティンのトリガの検査と「次の発火」の計算（R1。ADR 0111）。時刻は PC の現地時刻。純粋な部品（SDK も DOM も import しない）。
//
//   validateTrigger(trigger) → 整えたトリガ                  … 形が違えば TriggerError（detail に理由）。余計な欄は落とす
//   isTimed(trigger) → boolean                              … 時刻で動くトリガ（daily・weekly・interval・cron）か。event・webhook は予約しない
//   nextFireAt(trigger, baseline) → ms | null               … baseline（ms）より後の、次の発火。時刻で動かないトリガ・当たりが無い式は null
//   firesPerWeek(trigger) → number | null                   … 頻度の目安（1 週間の発火の回数。基準の週を固定して数える）。時刻で動かないトリガは null。update が「頻度を上げる」かの判定に使う
//
// 間隔（interval）は「前に動いた時刻から minutes 後」。時間帯（window）つきなら、その時刻が帯の外のとき次の帯の頭（from）へ寄せる。
// baseline は、予定を数え始める時刻（作った・再開した・トリガを変えた・前に動いた時刻のうち、いちばん後ろ。core/routines/service.mjs の baselineOf）。
import { parseCron, nextCron, CronError } from './cron.mjs';

export class TriggerError extends Error {
  constructor(detail) { super(detail); this.name = 'TriggerError'; this.detail = detail; }
}

export const TRIGGER_KINDS = Object.freeze(['daily', 'weekly', 'interval', 'cron', 'event', 'webhook']);
export const EVENT_KINDS = Object.freeze(['done', 'failed', 'waiting']);
export const INTERVAL_MIN_MINUTES = 1;
export const INTERVAL_MAX_MINUTES = 7 * 24 * 60;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => { const m = HHMM.exec(hhmm); return Number(m[1]) * 60 + Number(m[2]); };
const time = (field, value) => {
  if (typeof value !== 'string' || !HHMM.test(value)) throw new TriggerError(`${field} must be HH:MM (24 hours)`);
  return value;
};
const ids = (field, value) => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) throw new TriggerError(`${field} must be an array of ids`);
  return [...new Set(value)];
};

export function validateTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new TriggerError('trigger must be an object');
  switch (trigger.kind) {
    case 'daily':
      return { kind: 'daily', at: time('at', trigger.at), weekdaysOnly: trigger.weekdaysOnly === true };
    case 'weekly': {
      if (!Array.isArray(trigger.days) || !trigger.days.length || trigger.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new TriggerError('days must be a non-empty array of 0-6 (0 is Sunday)');
      return { kind: 'weekly', days: [...new Set(trigger.days)].sort((a, b) => a - b), at: time('at', trigger.at) };
    }
    case 'interval': {
      const { minutes } = trigger;
      if (!Number.isInteger(minutes) || minutes < INTERVAL_MIN_MINUTES || minutes > INTERVAL_MAX_MINUTES) throw new TriggerError(`minutes must be an integer ${INTERVAL_MIN_MINUTES}-${INTERVAL_MAX_MINUTES}`);
      const out = { kind: 'interval', minutes };
      if (trigger.window !== undefined && trigger.window !== null) {
        out.window = { from: time('window.from', trigger.window?.from), to: time('window.to', trigger.window?.to) };
        if (out.window.from === out.window.to) throw new TriggerError('window.from and window.to must differ');
      }
      return out;
    }
    case 'cron': {
      try { return { kind: 'cron', expr: parseCron(trigger.expr).expr }; }
      catch (e) { if (e instanceof CronError) throw new TriggerError(`expr: ${e.detail}`); throw e; }
    }
    case 'event': {
      if (!EVENT_KINDS.includes(trigger.on)) throw new TriggerError(`on must be one of ${EVENT_KINDS.join(' / ')}`);
      const scope = trigger.scope ?? 'all';
      if (scope !== 'all') {
        if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TriggerError('scope must be "all" or { sessionIds }');
        const sessionIds = ids('scope.sessionIds', scope.sessionIds);
        if (!sessionIds.length) throw new TriggerError('scope.sessionIds must not be empty (use "all" for every conversation)');
        return { kind: 'event', on: trigger.on, scope: { sessionIds } };
      }
      return { kind: 'event', on: trigger.on, scope: 'all' };
    }
    case 'webhook':
      // 受け口は P3（H1。ADR 0112）。ここは型と分岐の入れ物だけ（hookId は H1 が決める）
      if (typeof trigger.hookId !== 'string' || !trigger.hookId) throw new TriggerError('hookId must be a string');
      return { kind: 'webhook', hookId: trigger.hookId };
    default:
      throw new TriggerError(`kind must be one of ${TRIGGER_KINDS.join(' / ')}`);
  }
}

export const isTimed = (trigger) => ['daily', 'weekly', 'interval', 'cron'].includes(trigger?.kind);

/** 毎日・毎週・cron を 5 欄の式にそろえる（内部で同じ「次の時刻」の関数に落とす） */
function cronOf(trigger) {
  switch (trigger.kind) {
    case 'daily': { const [h, m] = trigger.at.split(':').map(Number); return `${m} ${h} * * ${trigger.weekdaysOnly ? '1-5' : '*'}`; }
    case 'weekly': { const [h, m] = trigger.at.split(':').map(Number); return `${m} ${h} * * ${trigger.days.join(',')}`; }
    default: return trigger.expr;
  }
}

/** local の分の位置（0〜1439）が時間帯の中か。from を含み、to も含む（分の単位）。from > to は夜をまたぐ */
function inWindow(at, window) {
  const d = new Date(at);
  const md = d.getHours() * 60 + d.getMinutes();
  const from = minutesOf(window.from), to = minutesOf(window.to);
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

function nextWindowStart(at, window) {
  const d = new Date(at);
  const md = d.getHours() * 60 + d.getMinutes();
  const from = minutesOf(window.from);
  const day = md < from ? d.getDate() : d.getDate() + 1;
  return new Date(d.getFullYear(), d.getMonth(), day, Math.floor(from / 60), from % 60, 0, 0).getTime();
}

export function nextFireAt(trigger, baseline) {
  if (!isTimed(trigger) || !Number.isFinite(baseline)) return null;
  if (trigger.kind === 'interval') {
    const candidate = baseline + trigger.minutes * 60_000;
    if (!trigger.window || inWindow(candidate, trigger.window)) return candidate;
    return nextWindowStart(candidate, trigger.window);
  }
  return nextCron(parseCron(cronOf(trigger)), baseline);
}

// 頻度の目安を数える基準の週（月曜 0 時から 7 日。夏時間の影響を受けにくい冬の週）
const WEEK_FROM = new Date(2024, 0, 1, 0, 0, 0, 0).getTime();
const WEEK_TO = new Date(2024, 0, 8, 0, 0, 0, 0).getTime();
const COUNT_CAP = 10_080;

export function firesPerWeek(trigger) {
  if (!isTimed(trigger)) return null;
  let n = 0;
  // 間隔は baseline からの相対なので、基準の週の頭から数える（時間帯つきは帯の頭から始まる）
  for (let at = nextFireAt(trigger, WEEK_FROM - 1); at !== null && at < WEEK_TO && n < COUNT_CAP; at = nextFireAt(trigger, at)) n++;
  return n;
}
