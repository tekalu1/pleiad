/** Preserve an in-flight local change when an older listSessions reply arrives. */
export function overlaySessions(sessions, patches, deleted = new Map()) {
  const rows = sessions.map(s => patches.has(s.id) ? { ...s, ...patches.get(s.id) } : s);
  for (const row of deleted.values()) if (!rows.some(s => s.id === row.id)) rows.push(row);
  return rows;
}

export function currentRows(rows, sessions) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  return rows.map(row => byId.get(row.id) ?? row);
}

/** Restore precisely the values that the operation changed. */
export function rollbackSessions(sessions, before) {
  const old = new Map(before.map(s => [s.sessionId, s]));
  return sessions.map(s => old.has(s.id) ? { ...s, status: old.get(s.id).status, ungrouped: old.get(s.id).ungrouped } : s);
}
