/** One stable title for the task record, child conversation, and background list. */
export function taskTitle(title, task) {
  const explicit = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
  const fallback = String(task ?? '').split(/\r?\n/).find(line => line.trim())?.trim().replace(/\s+/g, ' ') ?? '';
  return [...(explicit || fallback)].slice(0, 40).join('');
}
