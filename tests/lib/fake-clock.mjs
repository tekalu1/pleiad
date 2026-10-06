// 差し替え用の時計。advance(ms) で、期限の来たタイマーを順に走らせる（実時間は進めない）。
// タイマーが走るたびに、非同期の続き（偽の Chrome との実の通信を含む）が進むのを少し待つ。
export function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const flush = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    flush,
    /** ms だけ進める。期限が来た順に走らせ、そのたびに続きを待つ */
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let nextId = null, nextAt = Infinity;
        for (const [id, timer] of timers) if (timer.at <= target && timer.at < nextAt) { nextId = id; nextAt = timer.at; }
        if (nextId === null) break;
        const timer = timers.get(nextId); timers.delete(nextId);
        t = Math.max(t, timer.at);
        timer.fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
}
