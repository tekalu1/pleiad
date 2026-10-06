// A completed turn can leave delegated work or a background command running.
// Keep its notice until the conversation is idle, including when no new turn follows.
export const hasPendingChild = tasks => tasks.some(r =>
  ['queued', 'running', 'cancelling'].includes(r.status)
  || ['pending', 'delivering'].includes(r.notification)
  || (['completed', 'failed'].includes(r.status) && r.notification === 'none'));

/**
 * ターンの終わりを、会話が落ち着いてから 1 回だけ知らせる。正常終了（ok）と失敗（error）が対象で、中断は知らせない。
 * send は画面へ（届け先が居なければ false を返し、次に誰かがつながったとき届ける）。
 * ready は離れた端末への通知用で、画面が居るかによらず、落ち着いた時点で 1 回だけ呼ぶ（ADR 0086）。
 * info.startedAt は 30 秒未満のターンを通知から外すために ready へ渡す。info.bot は bot の会話の種類（sidecar の bot.kind）で、画面への completionReady に `bot` として載せる。
 */
export function createCompletionNotices({ busy, send, ready = () => {} }) {
  const pending = new Map();
  const flush = (sessionId) => {
    const entry = pending.get(sessionId);
    if (!entry || busy(sessionId)) return false;
    if (!entry.pushed) {
      entry.pushed = true;
      try { ready({ sessionId, outcome: entry.outcome, completedAt: entry.completedAt, startedAt: entry.startedAt }); } catch { /* 離れた端末への通知の失敗で画面の通知を止めない */ }
    }
    // bot の会話なら種類を添える（画面の通知は、スレッド・DM・ルーティンの会話の完了を出さず、失敗だけ出す。ADR 0109・0127）
    if (!send({ type: 'completionReady', sessionId, completedAt: entry.completedAt, outcome: entry.outcome, ...(entry.bot ? { bot: entry.bot } : {}) })) return false;
    pending.delete(sessionId);
    return true;
  };
  return {
    finished(sessionId, outcome, completedAt, info = {}) {
      if (!sessionId) return;
      if ((outcome === 'ok' || outcome === 'error') && Number.isFinite(completedAt)) {
        pending.set(sessionId, { completedAt, outcome, startedAt: info.startedAt, bot: info.bot ?? null, pushed: false });
      }
      flush(sessionId);
    },
    changed(sessionId) {
      if (sessionId) flush(sessionId);
      else for (const id of pending.keys()) flush(id);
    },
    /** 会話を消した（sessions.delete。ADR 0143）。まだ知らせていない完了を捨てる */
    forget(sessionId) { pending.delete(sessionId); },
  };
}

/**
 * 走っているターンへ、完了通知（依頼元のターン。ADR 0057）や追加指示（子のターン。ADR 0065）を途中送信（control.steer）で渡してよいか。
 * 人間の送信待ち（unsent）を優先し、次ターンの設定が予約されている会話（outbox も途中送信を断る）・圧縮のターン・
 * 中断や終了に向かっているターン・途中送信を持たないバックエンド（Antigravity）には渡さない
 */
export function canSteerNotice(turn, { unsent, nextSettings }) {
  if (!turn || turn.ac?.signal?.aborted || turn.outcome || turn.compactTrigger || typeof turn.control?.steer !== 'function') return false;
  return !unsent && !nextSettings;
}
