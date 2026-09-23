import { t } from './i18n.mjs';

// A synchronous lease prevents new work between the idle check and shutdown.
export function createUpdateGate() {
  let active = 0, locked = false;
  return {
    enter() {
      if (locked) throw new Error(t('update.preparing'));
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
    acquire(busy = false) { if (locked || active || busy) return false; locked = true; return true; },
    release() { locked = false; },
    get locked() { return locked; },
  };
}
