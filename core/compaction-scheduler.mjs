// A timer belongs to one conversation and one native session. Nothing survives a restart.
export function createCompactionScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  canRun, compact, changed = () => {} }) {
  const pending = new Map();
  const graceMs = 8 * 60_000;

  function cancel(id) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimer(entry.timer);
    pending.delete(id);
    changed(id, null);
    return true;
  }

  function schedule(id, sessionId, delayMs) {
    cancel(id);
    if (!id || !sessionId || !Number.isFinite(delayMs) || delayMs < 0) return null;
    const at = now() + delayMs;
    const entry = { id, sessionId, at, timer: null };
    pending.set(id, entry);
    entry.timer = setTimer(async () => {
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      changed(id, null);
      const elapsed = now() - at;
      if (elapsed < 0 || elapsed > graceMs) return;
      try {
        if (!await canRun(id, sessionId)) return;
        await compact(id, sessionId);
      } catch {
        // The reservation is already consumed. A failed run reports its boundary in core.
      }
    }, delayMs);
    entry.timer?.unref?.();
    changed(id, at);
    return at;
  }

  return { schedule, cancel, get: id => pending.get(id)?.at ?? null,
    entries: () => [...pending.values()].map(({ id, at }) => ({ sessionId: id, at })) };
}
