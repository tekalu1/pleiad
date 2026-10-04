// 使用量の上限で止まった会話の自動再開の、時刻と使用量の判断（ADR 0129。docs/design.md「中断と再開」）。
// 副作用を持たない関数だけを置く（予定の置き方・再開の実行は core/server.mjs）。

/** 解除時刻が分からない上限を、使用量で確かめ直す間隔 */
export const POLL_MS = 30 * 60_000;

/**
 * 上限の予定の時刻。解除時刻が分かって未来なら、その時刻に再開する（遠い先でも）。
 * 分からない・もう過ぎている（取得元が古い）ときは、30 分後から使用量を確かめる。
 * 過ぎた時刻のまま予定を置くと、再開してすぐ上限になる往復が止まらない
 */
export function resumePlan(resetsAt, now = Date.now()) {
  return Number.isFinite(resetsAt) && resetsAt > now ? { resetsAt, at: resetsAt, poll: false }
    : { resetsAt: null, at: now + POLL_MS, poll: true };
}

/** 解除時刻の見込みがあるか（止まった会話の送信待ちを、時刻まで API に流さない目安） */
export const limitHolds = (limit, now = Date.now()) => Number.isFinite(limit?.resetsAt)
  ? limit.resetsAt > now : limit?.autoResume === true;

/**
 * 使用量（backend.usage() の結果。単一の windows か、Claude のアカウントごとの accounts）で、止まった枠が空いたか。
 * true = 空いた、false = まだ上限、null = 読めない（枠が無い・使用率が数でない）。
 * 5 時間枠で止まったと分かっている（window）ならその枠だけ、そうでなければ全部の枠を見る。
 * 解除時刻を過ぎた枠は使用率が古いので、空いたものとして数える
 */
export function limitOpen(quota, { account = '', window = null } = {}, now = Date.now()) {
  const windows = quota?.accounts
    ? (quota.accounts.find(a => a.accountId === account)?.windows ?? quota.accounts[0]?.windows ?? [])
    : quota?.windows ?? [];
  const relevant = window === 'five_hour' ? windows.filter(w => w.minutes === 300) : windows;
  const state = relevant.map(w => {
    const reset = w.resetsAt == null ? NaN : new Date(w.resetsAt).getTime();
    if (Number.isFinite(reset) && reset <= now) return 'open';
    if (!Number.isFinite(w.usedPercent)) return 'unknown';
    return w.usedPercent >= 100 ? 'limited' : 'open';
  });
  if (state.includes('limited')) return false;
  return state.includes('open') ? true : null;
}
