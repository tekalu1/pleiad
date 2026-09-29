// A completed turn can leave delegated work or a background command running.
// Keep its notice until the conversation is idle, including when no new turn follows.
export const hasPendingChild = tasks => tasks.some(r =>
  ['queued', 'running', 'cancelling'].includes(r.status)
  || ['pending', 'delivering'].includes(r.notification)
  || (['completed', 'failed'].includes(r.status) && r.notification === 'none'));

export function createCompletionNotices({ busy, send }) {
  const pending = new Map();
  const flush = (sessionId) => {
    const completedAt = pending.get(sessionId);
    if (!completedAt || busy(sessionId)) return false;
    if (!send({ type: 'completionReady', sessionId, completedAt })) return false;
    pending.delete(sessionId);
    return true;
  };
  return {
    finished(sessionId, outcome, completedAt) {
      if (!sessionId) return;
      if (outcome === 'ok' && Number.isFinite(completedAt)) pending.set(sessionId, completedAt);
      flush(sessionId);
    },
    changed(sessionId) {
      if (sessionId) flush(sessionId);
      else for (const id of pending.keys()) flush(id);
    },
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
