// A synchronous lease prevents new work between the idle check and shutdown.
export function createUpdateGate() {
  let active = 0, locked = false;
  return {
    enter() {
      if (locked) throw new Error('更新の準備中です。少し待ってから操作してください。');
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
    acquire(busy = false) { if (locked || active || busy) return false; locked = true; return true; },
    release() { locked = false; },
    get locked() { return locked; },
  };
}
