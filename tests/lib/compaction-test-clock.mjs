import fs from 'node:fs';
import { createCompactionScheduler as create } from '../../core/compaction-scheduler.mjs';
export { idleCompactionGuards } from '../../core/compaction-scheduler.mjs';
const now = () => {
  try { return Number(fs.readFileSync(process.env.TEST_COMPACTION_CLOCK, 'utf8')); }
  catch { return 0; } // Atomic replacement may briefly be unavailable on Windows.
};
export function createCompactionScheduler(options) {
  return create({ ...options, now, clearTimer: clearInterval,
    setTimer(fn, delay) {
      const at = now() + delay;
      const timer = setInterval(() => {
        if (now() < at) return;
        clearInterval(timer);
        void fn();
      }, 10);
      timer.unref();
      return timer;
    },
  });
}
