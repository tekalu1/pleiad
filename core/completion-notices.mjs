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
