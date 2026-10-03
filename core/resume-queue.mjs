export const DEFAULT_LIMIT_RESUME = Object.freeze({ mode: 'auto', concurrency: 3, guardPercent: 50 });

export function normalizeLimitResume(value) {
  return {
    mode: ['auto', 'ask', 'off'].includes(value?.mode) ? value.mode : 'auto',
    concurrency: [1, 2, 3, 0].includes(value?.concurrency) ? value.concurrency : 3,
    guardPercent: [30, 50, null].includes(value?.guardPercent) ? value.guardPercent : 50,
  };
}

export function createResumeQueue({ start, guard = async () => null, guarded = () => {}, changed = () => {}, settings = () => DEFAULT_LIMIT_RESUME }) {
  const pending = new Map();
  const running = new Set();
  let paused = false;
  let bypassGuard = false;
  let pumping = false;
  let guardUsed = null;
  const view = () => ({ pending: [...pending.values()].sort(compare), running: [...running], paused, guardUsed });
  const compare = (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.sentAt ?? 0) - (a.sentAt ?? 0);
  const notify = () => changed(view());
  const pump = async () => {
    if (pumping || paused) return;
    pumping = true;
    try {
      for (;;) {
        const max = settings().concurrency || Infinity;
        if (running.size >= max || !pending.size || paused) break;
        const row = [...pending.values()].sort(compare)[0];
        const used = await guard(row);
        guardUsed = used;
        const threshold = settings().guardPercent;
        if (!bypassGuard && threshold !== null && used !== null && used >= threshold) {
          paused = true; notify(); guarded(row, used); break;
        }
        pending.delete(row.sessionId);
        running.add(row.sessionId);
        notify();
        Promise.resolve().then(() => start(row)).catch(() => {
          running.delete(row.sessionId); notify(); void pump();
        });
      }
    } finally { pumping = false; }
  };
  return {
    view,
    enqueue(row) { if (!running.has(row.sessionId)) pending.set(row.sessionId, row); notify(); setTimeout(() => { void pump(); }, 50).unref?.(); },
    remove(id) { const removed = pending.delete(id); if (removed) notify(); return removed; },
    settled(id) { if (running.delete(id)) { notify(); void pump(); } },
    first(id) { const row = pending.get(id); if (!row) return false; row.priority = Date.now(); notify(); void pump(); return true; },
    continue() { paused = false; bypassGuard = true; guardUsed = null; notify(); void pump(); },
    stop() { paused = true; notify(); },
    update() { void pump(); },
  };
}
