// Durable timed actions. The payload is data, never a closure, so startup and
// wake from sleep use the same check. A future send action can use the same file.
import fs from 'node:fs/promises';
import { writeAtomic } from './atomic-file.mjs';

export function createSchedule({ file, fire, changed = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const rows = new Map();
  const firing = new Set();
  let timer = null;
  let writes = Promise.resolve();
  const list = () => [...rows.values()].map(row => ({ ...row }));
  const save = () => {
    const data = JSON.stringify({ version: 1, entries: list() }, null, 2);
    writes = writes.catch(() => {}).then(() => writeAtomic(file, data));
    return writes;
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    const next = Math.min(...list().filter(row => !firing.has(row.id)).map(row => row.at));
    if (!Number.isFinite(next)) return;
    timer = setTimer(() => { timer = null; void check(); }, Math.max(0, Math.min(2_147_000_000, next - now())));
    timer?.unref?.();
  };
  const check = async () => {
    for (const row of list().filter(row => row.at <= now() && !firing.has(row.id))) {
      firing.add(row.id);
      try {
        await fire(row);
        if (rows.get(row.id)?.createdAt === row.createdAt) {
          rows.delete(row.id);
          await save();
          changed(list());
        }
      } catch {
        // A failed action stays durable and is retried after the host wakes or restarts.
        row.at = now() + 60_000;
        rows.set(row.id, row);
        await save();
      } finally { firing.delete(row.id); }
    }
    arm();
  };
  return {
    list,
    async restore() {
      const saved = await fs.readFile(file, 'utf8').then(text => JSON.parse(text), () => null).catch(() => null);
      if (saved?.version === 1 && Array.isArray(saved.entries)) {
        for (const row of saved.entries)
          if (typeof row?.id === 'string' && ['resume', 'send'].includes(row.kind)
            && typeof row.sessionId === 'string' && Number.isFinite(row.at)) rows.set(row.id, row);
      }
      arm();
      await check();
    },
    async put(row) {
      if (typeof row?.id !== 'string' || !['resume', 'send'].includes(row.kind)
        || typeof row.sessionId !== 'string' || !Number.isFinite(row.at)) throw new Error('Invalid schedule');
      rows.set(row.id, { ...row, createdAt: row.createdAt ?? now() });
      await save(); changed(list()); arm();
      return row;
    },
    async cancel(id) {
      if (!rows.delete(id)) return false;
      await save(); changed(list()); arm(); return true;
    },
    check,
  };
}
