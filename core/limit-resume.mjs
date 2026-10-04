// 使用量の上限で止まった会話の自動再開の、時刻と使用量の判断（ADR 0129。docs/design.md「中断と再開」）。
// 副作用を持たない関数だけを置く（予定の置き方・再開の実行は core/server.mjs）。
import { codexBucket } from './backends/codex-limit.mjs';
import { windowsFor } from './delegation-routing.mjs';

/** 解除時刻が分からない上限を、使用量で確かめ直す最初の間隔 */
export const POLL_MS = 30 * 60_000;
/** 確かめ直しの間隔の上限 */
export const POLL_MAX_MS = 6 * 60 * 60_000;

/**
 * 確かめ直しの間隔。試しに再開してすぐ再び上限（時刻不明）になるたび（strikes）に 30 分 → 1 時間 → 2 時間 … と伸ばし、6 時間までにする。
 * 往復のたびに「続けて」の発言が積もらないようにする
 */
export const pollInterval = (strikes = 0) => Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.max(0, strikes));

/**
 * 上限の予定の時刻。解除時刻が分かって未来なら、その時刻に再開する（遠い先でも）。
 * 分からない・もう過ぎている（取得元が古い）ときは、30 分後（strikes があれば伸ばした間隔の後）から使用量を確かめる。
 * 過ぎた時刻のまま予定を置くと、再開してすぐ上限になる往復が止まらない
 */
export function resumePlan(resetsAt, now = Date.now(), strikes = 0) {
  return Number.isFinite(resetsAt) && resetsAt > now ? { resetsAt, at: resetsAt, poll: false }
    : { resetsAt: null, at: now + pollInterval(strikes), poll: true };
}

/** 解除時刻の見込みがあるか（止まった会話の送信待ちを、時刻まで API に流さない目安） */
export const limitHolds = (limit, now = Date.now()) => Number.isFinite(limit?.resetsAt)
  ? limit.resetsAt > now : limit?.autoResume === true;

/**
 * 止まった枠だけに絞る。Codex は主の枠とそのモデルに当たる追加の枠（limitId）、Claude は全体の枠とそのモデルの系統の枠（model）、
 * Antigravity はそのモデルのグループ。絞れなければ（モデルが分からない・当たる枠が無い）全部
 */
function scopedWindows(windows, backend, model) {
  const scoped = backend === 'codex' ? codexBucket(windows, model)
    : backend === 'claude' || backend === 'antigravity' ? windowsFor(backend, model, windows) : windows;
  return scoped.length ? scoped : windows;
}

/**
 * 使用量（backend.usage() の結果。単一の windows か、Claude のアカウントごとの accounts）で、止まった枠が空いたか。
 * true = 空いた、false = まだ上限、null = 読めない（枠が無い・使用率が数でない・止まったアカウントの枠が読めない）。
 * 見るのは止まった枠だけ（別のモデルの枠・別のバケットが 100% でも関係ない）。5 時間枠で止まったと分かっている（window）ならその枠だけ。
 * 解除時刻を過ぎた枠は使用率が古いので、空いたものとして数える
 */
export function limitOpen(quota, { account = '', window = null, backend = null, model = '' } = {}, now = Date.now()) {
  // 止まったアカウントの項目が見つからない・枠を持たないときは、別のアカウントの枠で判断しない（ログイン中のアカウント '' だけは先頭の項目）
  const entry = quota?.accounts ? quota.accounts.find(a => a.accountId === account) ?? (account === '' ? quota.accounts[0] : null) : null;
  const windows = quota?.accounts ? entry?.windows ?? [] : quota?.windows ?? [];
  const scoped = scopedWindows(windows, backend, model);
  const relevant = window === 'five_hour' ? scoped.filter(w => w.minutes === 300) : scoped;
  const state = relevant.map(w => {
    const reset = w.resetsAt == null ? NaN : new Date(w.resetsAt).getTime();
    if (Number.isFinite(reset) && reset <= now) return 'open';
    if (!Number.isFinite(w.usedPercent)) return 'unknown';
    return w.usedPercent >= 100 ? 'limited' : 'open';
  });
  if (state.includes('limited')) return false;
  return state.includes('open') ? true : null;
}
