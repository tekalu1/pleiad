// Durable timed actions. The payload is data, never a closure, so startup and
// wake from sleep use the same check. Kind 'send' is a message the user scheduled (core/send-schedule.mjs), kind 'post' is a thread reply the user scheduled
// (a channel post; it has channelId and threadId instead of sessionId).
// fire() may return { hold } to keep a due row without firing it again (a send that is too late
// to send unattended); the row stays in the list until a person sends or cancels it.
// fire() may return { reschedule: at, patch? } to keep the row (with patch merged in) and fire it again at that time.
// Rows of kind 'resume' (the automatic resume after a usage limit, removed by ADR 0160) are not valid: restore drops
// them, and the next save leaves them out of the file.
import fs from 'node:fs/promises';
import { writeAtomic } from './atomic-file.mjs';

/** A row the schedule can keep: a conversation action (send) or a channel post (post) */
const validRow = (row) => typeof row?.id === 'string' && Number.isFinite(row.at)
  && (row.kind === 'send' ? typeof row.sessionId === 'string' : row.kind === 'post' && typeof row.channelId === 'string' && typeof row.threadId === 'string');

export function createSchedule({ file, fire, changed = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const rows = new Map();
  const firing = new Set();
  let timer = null;
  let paused = false;
  let writes = Promise.resolve();
  const list = () => [...rows.values()].map(row => ({ ...row }));
  const save = () => {
    const data = JSON.stringify({ version: 1, entries: list() }, null, 2);
    writes = writes.catch(() => {}).then(() => writeAtomic(file, data));
    return writes;
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    timer = null;
    if (paused) return;
    const next = Math.min(...list().filter(row => !firing.has(row.id) && !row.held).map(row => row.retryAt ?? row.at));
    if (!Number.isFinite(next)) return;
    timer = setTimer(() => { timer = null; void check(); }, Math.max(0, Math.min(2_147_000_000, next - now())));
    timer?.unref?.();
  };
  const check = async () => {
    for (const row of list().filter(row => (row.retryAt ?? row.at) <= now() && !firing.has(row.id) && !row.held)) {
      if (paused) break;
      firing.add(row.id);
      try {
        const result = await fire(row);
        // A person may have cancelled or replaced the row while it was firing; only the row that fired is removed.
        const current = rows.get(row.id);
        if (current?.createdAt === row.createdAt) {
          if (result?.hold) rows.set(row.id, { ...current, held: result.hold, heldAt: now() });
          else if (Number.isFinite(result?.reschedule)) rows.set(row.id, { ...current, ...(result.patch ?? {}), at: result.reschedule, retryAt: undefined });
          else rows.delete(row.id);
          await save();
          changed(list());
        }
      } catch {
        // A failed action stays durable and is retried a minute later (and after the host wakes or restarts).
        // `at` is the planned time and is kept: it decides whether a send is too late to send unattended.
        if (rows.get(row.id)?.createdAt === row.createdAt) {
          rows.set(row.id, { ...rows.get(row.id), retryAt: now() + 60_000 });
          await save();
        }
      } finally { firing.delete(row.id); }
    }
    arm();
  };
  return {
    list,
    async restore() {
      const saved = await fs.readFile(file, 'utf8').then(text => JSON.parse(text), () => null).catch(() => null);
      if (saved?.version === 1 && Array.isArray(saved.entries)) {
        for (const row of saved.entries) if (validRow(row)) rows.set(row.id, row);
      }
      arm();
      await check();
    },
    async put(row) {
      if (!validRow(row)) throw new Error('Invalid schedule');
      rows.set(row.id, { ...row, createdAt: row.createdAt ?? now() });
      await save(); changed(list()); arm();
      return row;
    },
    async cancel(id) {
      if (!rows.delete(id)) return false;
      await save(); changed(list()); arm(); return true;
    },
    // Removes a row and returns it (null if absent or being fired right now), for "send now" and "edit":
    // the caller owns the action from here, so the timer cannot fire it a second time.
    async take(id) {
      const row = rows.get(id);
      if (!row || firing.has(id)) return null;
      rows.delete(id);
      await save(); changed(list()); arm();
      return { ...row };
    },
    get(id) { const row = rows.get(id); return row ? { ...row } : null; },
    // Updates fields of a row that stays in the list (a held send that was announced).
    async patch(id, fields) {
      const row = rows.get(id);
      if (!row) return false;
      rows.set(id, { ...row, ...fields });
      await save(); changed(list());
      return true;
    },
    check,
    // 引き継ぎ（無停止の更新 2d）の間は、時刻が来ても撃たない。行は残り、新しいサーバーの restore が見る。取りやめたら resume で戻す
    pause() { paused = true; if (timer) clearTimer(timer); timer = null; },
    resume() { if (!paused) return; paused = false; arm(); },
    /** 撃っている最中の行があるか（引き継ぎの前に終わるのを待つ） */
    get firing() { return firing.size > 0; },
  };
}
