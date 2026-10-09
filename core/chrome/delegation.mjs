// 断るときは code: 'TASK_REFUSED' と detail.reason（invalid・notChild・changed）を付ける。ply_browser（core/browser-bridge.mjs）がエージェントの言語の文にする
const refuse = (reason, message) => Object.assign(new Error(message), { code: 'TASK_REFUSED', detail: { reason } });

// 委譲した子の Chrome の窓。taskId は推測可能なので、毎回タスクと会話メタの両方で所有を確かめる。
export async function delegatedChromeTarget(parentId, taskId, { task, meta }) {
  if (!parentId || typeof taskId !== 'string' || !taskId) throw refuse('invalid', 'invalid task');
  const row = task(taskId);
  if (!row || row.parentSessionId !== parentId || !row.sessionId || row.host) throw refuse('notChild', 'task is not a local direct child');
  const child = await meta(row.sessionId);
  if (child?.delegation?.taskId !== taskId || child.delegation.parentSessionId !== parentId) throw refuse('changed', 'task ownership changed');
  return row.sessionId;
}

/** 画面へ返す小さい一覧。実際に開いている窓だけを返し、子のプロフィールはその会話から引く。waiting: 人への依頼（ログインなど）を待っている窓（閉じる前の確かめに使う） */
export function delegatedChromeWindows(parentId, { rows, sessions, summary, profile, state = () => 'idle', waiting = () => false }) {
  const opened = new Set(sessions());
  const own = opened.has(parentId) ? [{ sessionId: parentId, taskId: null, title: null }] : [];
  const children = rows().filter(row => row.parentSessionId === parentId && row.sessionId && !row.host && opened.has(row.sessionId))
    .map(row => ({ sessionId: row.sessionId, taskId: row.taskId, title: row.title ?? null }));
  return [...own, ...children].map(row => ({ ...row, windows: summary(row.sessionId).windows, profile: profile(row.sessionId) ?? null, state: state(row.sessionId), waiting: waiting(row.sessionId) === true }))
    .filter(row => row.windows > 0);
}
