// チャンネルの予算の形（ADR 0119）。設定はチャンネルの定義（index.json）の `budget`、使った分はスレッドの状態（ThreadState.spend）。
// 数える・止めるのは core/bots/budget.mjs。ここは形と検査と日付だけ（SDK も DOM も import しない）。
//
//   budgetOf(channel) → { daily: number|null, perThread: number }
//       … daily は 1 日の予算（bot のバックエンドの週の使用枠に対する %）。null は予算なし。perThread は 1 スレッドが使える分（daily に対する %）。
//         設定が無いチャンネルは DEFAULT_BUDGET
//   normalizeBudget(input, current) → { daily, perThread }   … channels.update の検査。渡した欄だけ変える。不正なら Error（メッセージは英語の理由）
//   allowanceOf(budget) → number|null                          … 1 スレッドの配分（週の枠に対する %）。予算なしは null
//   dayOf(ms) → 'YYYY-MM-DD'                                   … この PC の現地の日付（予算は日付が変わると 0 から数える）
//   spentOn(thread, day) → number                              … そのスレッドがその日に使った %
//   spentToday(threads, channelId, day) → number               … チャンネルのスレッドがその日に使った % の合計

export const DEFAULT_BUDGET = Object.freeze({ daily: 5, perThread: 50 });
export const BUDGET_LIMITS = Object.freeze({ dailyMax: 100, perThreadMin: 1, perThreadMax: 100 });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pad = (n) => String(n).padStart(2, '0');
export const DAY_RX = /^\d{4}-\d{2}-\d{2}$/;

export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function budgetOf(channel) {
  const b = channel?.budget;
  if (!b || typeof b !== 'object') return { ...DEFAULT_BUDGET };
  const daily = b.daily === null ? null : finite(b.daily) && b.daily >= 0 ? Math.min(b.daily, BUDGET_LIMITS.dailyMax) : DEFAULT_BUDGET.daily;
  const perThread = finite(b.perThread) && b.perThread >= BUDGET_LIMITS.perThreadMin ? Math.min(b.perThread, BUDGET_LIMITS.perThreadMax) : DEFAULT_BUDGET.perThread;
  return { daily, perThread };
}

export function normalizeBudget(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('budget must be an object');
  const next = budgetOf({ budget: current });
  if (input.daily !== undefined) {
    if (input.daily !== null && !(finite(input.daily) && input.daily >= 0 && input.daily <= BUDGET_LIMITS.dailyMax)) throw new Error(`budget.daily must be null or 0-${BUDGET_LIMITS.dailyMax}`);
    next.daily = input.daily;
  }
  if (input.perThread !== undefined) {
    if (!(finite(input.perThread) && input.perThread >= BUDGET_LIMITS.perThreadMin && input.perThread <= BUDGET_LIMITS.perThreadMax)) throw new Error(`budget.perThread must be ${BUDGET_LIMITS.perThreadMin}-${BUDGET_LIMITS.perThreadMax}`);
    next.perThread = input.perThread;
  }
  return next;
}

/** next が current より使える分を増やすか（予算を外す・1 日の予算を上げる・スレッドの配分を上げる）。AI が増やすのは guarded（core/ops/channels.mjs） */
export function loosensBudget(current, next) {
  const a = budgetOf({ budget: current }), b = budgetOf({ budget: next });
  if (a.daily !== null && b.daily === null) return true;
  if (a.daily !== null && b.daily > a.daily) return true;
  return b.perThread > a.perThread;
}

export const allowanceOf = (budget) => (budget.daily === null ? null : (budget.daily * budget.perThread) / 100);

export const spentOn = (thread, day) => (thread?.spend?.day === day && finite(thread.spend.percent) ? thread.spend.percent : 0);

export const spentToday = (threads, channelId, day) => (threads ?? []).filter((t) => t.channelId === channelId).reduce((n, t) => n + spentOn(t, day), 0);
