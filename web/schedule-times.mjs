// 送信日時の候補と指定の計算（docs/design-system.md「送信日時の指定」）。
// 時刻は UTC のミリ秒で持ち、見ている端末の時刻帯で組み・出す。DOM は触らない（テストから直接呼ぶ）。
import { t, lang } from './i18n.mjs';

const MIN = 60_000;
/** 朝 6 時より前は「今朝 9:00」を候補に出す */
const MORNING_EDGE = 6;
/** 何日先まで指定できるか（core/send-schedule.mjs の MAX_AHEAD_MS と同じ） */
export const MAX_AHEAD_MS = 366 * 24 * 60 * MIN;

/** 日付だけ（0:00）に丸めて day 日ずらす */
const dayAt = (now, offset, h = 0, m = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d;
};

/** 「9:00」。見ている端末の言語の時刻の書き方 */
export const timeText = (at) => new Date(at).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });

/** 「10/4（日）」 */
export function dateText(at) {
  const d = new Date(at);
  return t('schedule.date', { month: d.getMonth() + 1, day: d.getDate(), weekday: d.toLocaleDateString(lang, { weekday: 'short' }) });
}

/** 今日なら「9:00」、ほかの日は「10/4（日）9:00」 */
export const whenText = (at, now = Date.now()) =>
  new Date(at).toDateString() === new Date(now).toDateString() ? timeText(at) : t('schedule.dateTime', { date: dateText(at), time: timeText(at) });

/** 長さ（ミリ秒）を「41 分」「1 時間 5 分」「1 日 7 時間」にする（分未満は切り上げて 1 分） */
export function spanText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / MIN));
  if (minutes < 60) return t('schedule.span.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return rest ? `${t('schedule.span.hours', { count: hours })} ${t('schedule.span.minutes', { count: rest })}` : t('schedule.span.hours', { count: hours });
  const days = Math.floor(hours / 24), h = hours % 24;
  return h ? `${t('schedule.span.days', { count: days })} ${t('schedule.span.hours', { count: h })}` : t('schedule.span.days', { count: days });
}

/** 「あと 7 時間 11 分」 */
export const leftText = (at, now = Date.now()) => t('schedule.left', { span: spanText(at - now) });

/**
 * 送信の候補。1 回押せば決まる。上限で止まっている会話は「上限の解除後」が先頭。
 * 今朝 9:00 は朝 6 時前だけ、今日 18:00 は 10 分以上先のときだけ、月曜の朝 9:00 は水〜土だけ（近い週明け）
 * @returns {{ key: string, label: string, hint: string, at: number }[]}
 */
export function presets(now = Date.now(), { resetsAt = null } = {}) {
  const n = new Date(now);
  const out = [];
  const hint = (at) => (at - now < 24 * 60 * MIN ? t('schedule.after', { span: spanText(at - now) }) : dateText(at));
  if (Number.isFinite(resetsAt) && resetsAt > now) {
    out.push({ key: 'reset', label: t('schedule.afterReset', { time: timeText(resetsAt) }), hint: t('schedule.after', { span: spanText(resetsAt - now) }), at: resetsAt });
  }
  const morning = dayAt(n, 0, 9).getTime();
  if (n.getHours() < MORNING_EDGE) out.push({ key: 'morning', label: t('schedule.morning'), hint: hint(morning), at: morning });
  const evening = dayAt(n, 0, 18).getTime();
  if (evening - now >= 10 * MIN) out.push({ key: 'evening', label: t('schedule.evening'), hint: hint(evening), at: evening });
  const tomorrow = dayAt(n, 1, 9).getTime();
  out.push({ key: 'tomorrow', label: t('schedule.tomorrow'), hint: hint(tomorrow), at: tomorrow });
  const untilMonday = (8 - n.getDay()) % 7 || 7;
  if (untilMonday >= 2 && untilMonday <= 5) {
    const monday = dayAt(n, untilMonday, 9).getTime();
    out.push({ key: 'monday', label: t('schedule.monday'), hint: dateText(monday), at: monday });
  }
  return out;
}

/** 日のチップ 7 日分（今日・明日・以降は日付）。offset が dayAt の引数 */
export function dayChips(now = Date.now()) {
  return Array.from({ length: 7 }, (_, offset) => {
    const at = dayAt(now, offset).getTime();
    return { offset, at, label: offset === 0 ? t('schedule.today') : offset === 1 ? t('schedule.tomorrowShort') : dateText(at),
      sub: offset < 2 ? dateText(at) : '' };
  });
}

/** 時刻の欄の字（「9:00」「9」「18:30」「0930」。en は「9:00 pm」も）を { h, m } に。読めなければ null */
export function parseTime(text) {
  const m = /^(\d{1,2})(?:[:：.]?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.[0]?.toLowerCase();
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = h % 12 + (meridiem === 'p' ? 12 : 0);
  }
  return h < 24 && minute < 60 ? { h, m: minute } : null;
}

/** 日（dayChips の offset）と時刻の字から送る時刻（ミリ秒）。読めない・過ぎている・先すぎるなら null */
export function targetAt(offset, timeStr, now = Date.now()) {
  const time = parseTime(timeStr);
  if (!time) return null;
  const at = dayAt(now, offset, time.h, time.m).getTime();
  return at > now && at - now <= MAX_AHEAD_MS ? at : null;
}

/** よく使う時刻の候補（時刻の欄の下） */
export const TIME_STEPS = ['7:00', '9:00', '12:00', '18:00', '22:00'];

/** 時刻帯の名前（IANA）。見ている端末のもの */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** ホストの時刻帯でのその時刻（「10/4 9:00（JST）」）。端末と同じ時刻帯なら null */
export function hostTimeText(at, hostZone) {
  if (!hostZone || hostZone === localZone()) return null;
  try {
    const d = new Date(at);
    const parts = new Intl.DateTimeFormat(lang, { timeZone: hostZone, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', hour12: false }).format(d);
    return parts;
  } catch { return null; }
}
