// A timer belongs to one conversation and one backend. The scheduler keeps them in memory only;
// core/server.mjs saves the visible ones and puts them back after a restart (ADR 0068).
export const COMPACTION_GRACE_MS = 8 * 60_000;

export function idleCompactionGuards(current, busy) {
  return { canStart: () => current() && !busy(), canInvoke: current };
}

export function createCompactionScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  canRun, compact, changed = () => {} }) {
  const pending = new Map();
  const revisions = new Map();
  const graceMs = COMPACTION_GRACE_MS;

  const revision = id => revisions.get(id) ?? 0;
  function cancel(id) {
    if (!id) return false;
    revisions.set(id, revision(id) + 1);
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimer(entry.timer);
    pending.delete(id);
    if (entry.visible) changed(id, null);
    return true;
  }
  function cancelFiring(shouldCancel = () => true) {
    for (const [id, entry] of pending)
      if (!entry.visible && shouldCancel({ sessionId: id, backendId: entry.sessionId, usedTokens: entry.usedTokens })) cancel(id);
  }

  function schedule(id, sessionId, delayMs, expectedRevision = revision(id), usedTokens = null) {
    if (revision(id) !== expectedRevision) return null;
    const old = pending.get(id);
    if (old) {
      clearTimer(old.timer);
      pending.delete(id);
      if (old.visible) changed(id, null);
    }
    if (!id || !sessionId || !Number.isFinite(delayMs) || delayMs < 0) return null;
    const at = now() + delayMs;
    const entry = { id, sessionId, at, timer: null, visible: true, revision: expectedRevision, usedTokens };
    const current = () => pending.get(id) === entry && revision(id) === entry.revision;
    pending.set(id, entry);
    entry.timer = setTimer(async () => {
      if (!current()) return;
      entry.visible = false;
      changed(id, null);
      const elapsed = now() - at;
      try {
        if (elapsed < 0 || elapsed > graceMs || !await canRun(id, sessionId) || !current()) return;
        await compact(id, sessionId, current);
      } catch {
        // The reservation is already consumed. A failed run reports its boundary in core.
      } finally {
        if (pending.get(id) === entry) pending.delete(id);
      }
    }, delayMs);
    entry.timer?.unref?.();
    changed(id, at);
    return at;
  }

  return { schedule, cancel, cancelFiring, revision, now, graceMs, get: id => pending.get(id)?.visible ? pending.get(id).at : null,
    entries: () => [...pending.values()].filter(entry => entry.visible)
      .map(({ id, at, sessionId, usedTokens }) => ({ sessionId: id, at, backendId: sessionId, usedTokens })) };
}
