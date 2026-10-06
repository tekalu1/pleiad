// A timer belongs to one conversation and one backend. The scheduler keeps them in memory only;
// core/server.mjs saves the visible ones and puts them back after a restart (ADR 0069).
export const COMPACTION_GRACE_MS = 8 * 60_000;

export function idleCompactionGuards(current, busy) {
  return { canStart: () => current() && !busy(), canInvoke: current };
}

export function createCompactionScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  canRun, compact, changed = () => {} }) {
  const pending = new Map();
  const revisions = new Map();
  const graceMs = COMPACTION_GRACE_MS;
  // 引き継ぎ（無停止の更新 2d）で止めた予約。予約は core/server.mjs が保存していて、新しいサーバーが戻す。取りやめたら resume で戻す
  let stopped = null;

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
    pending.set(id, entry);
    arm(entry, delayMs);
    changed(id, at);
    return at;
  }

  function arm(entry, delayMs) {
    const { id, sessionId, at } = entry;
    const current = () => pending.get(id) === entry && revision(id) === entry.revision;
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
  }

  /** 予約のタイマーを止める（予約は残る）。引き継ぎのとき、新しいサーバーが保存から戻す */
  function stop() {
    stopped ??= [];
    for (const entry of pending.values()) {
      if (!entry.visible || !entry.timer) continue;
      clearTimer(entry.timer);
      entry.timer = null;
      stopped.push(entry);
    }
  }
  /** stop で止めた予約のタイマーを戻す（引き継ぎを取りやめたとき） */
  function resume() {
    const entries = stopped ?? [];
    stopped = null;
    for (const entry of entries) if (pending.get(entry.id) === entry && !entry.timer) arm(entry, Math.max(0, entry.at - now()));
  }

  return { schedule, cancel, cancelFiring, stop, resume, revision, now, graceMs, get: id => pending.get(id)?.visible ? pending.get(id).at : null,
    entries: () => [...pending.values()].filter(entry => entry.visible)
      .map(({ id, at, sessionId, usedTokens }) => ({ sessionId: id, at, backendId: sessionId, usedTokens })) };
}
