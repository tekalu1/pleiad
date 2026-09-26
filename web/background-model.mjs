/** The persisted title may be absent on tasks created before title was added. */
export function backgroundTitle(task) {
  return [...(task.title?.trim() || String(task.task ?? '').split(/\r?\n/).find(line => line.trim())?.trim().replace(/\s+/g, ' ') || task.taskId || '')].slice(0, 40).join('');
}

/** Return root tasks and descendants in display order. Descendants stay with their root. */
export function taskTree(tasks, sessionId) {
  const byParent = new Map();
  for (const task of tasks ?? []) {
    const siblings = byParent.get(task.parentSessionId) ?? [];
    siblings.push(task);
    byParent.set(task.parentSessionId, siblings);
  }
  const newer = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  for (const siblings of byParent.values()) siblings.sort(newer);
  const seen = new Set();
  const visit = (task, depth, rootLive) => {
    if (seen.has(task.taskId)) return [];
    seen.add(task.taskId);
    const children = byParent.get(task.sessionId) ?? [];
    return [{ task, depth, rootLive, childCount: children.length }, ...children.flatMap(child => visit(child, depth + 1, rootLive))];
  };
  return (byParent.get(sessionId) ?? []).flatMap(root => visit(root, 0, ['queued', 'running', 'cancelling', 'waiting'].includes(root.status)));
}

export function backgroundTotals(items) {
  return { live: items.filter(item => item.live).length,
    ended: items.filter(item => item.group === 'agent' && !item.live).length };
}
