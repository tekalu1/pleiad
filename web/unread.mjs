// Completion belongs to the server; acknowledgement belongs to this browser.
export const READ_STORE = "agent-host-read-completions";

export function createReadCompletions(storage) {
  const read = new Map();
  const merge = raw => {
    try {
      for (const [id, at] of JSON.parse(raw ?? "[]")) {
        if (typeof id === "string" && Number.isFinite(at) && at > 0) {
          read.set(id, Math.max(read.get(id) ?? 0, at));
        }
      }
    } catch { /* Unavailable or corrupt storage must not prevent opening a conversation. */ }
  };
  try { merge(storage?.getItem(READ_STORE)); } catch {}
  return {
    merge,
    mark(id, at) {
      if (!id || !Number.isFinite(at) || at <= 0) return;
      // Merge other tabs before writing so their acknowledgements are preserved.
      try { merge(storage?.getItem(READ_STORE)); } catch {}
      read.set(id, Math.max(read.get(id) ?? 0, at));
      try { storage?.setItem(READ_STORE, JSON.stringify([...read])); } catch {}
    },
    hasUnread(session) {
      return Number.isFinite(session.completedAt) && session.completedAt > (read.get(session.id) ?? 0);
    },
  };
}
