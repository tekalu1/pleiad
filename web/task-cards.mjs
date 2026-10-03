// 委譲のタスクの行を画面に持つ（docs/agent-delegation.md「保存・画面・再起動」）。
// running は終わっていないもの・完了通知が届いていないものの短い行（依頼文・振り分けの記録なし）だけを配る。
// 委譲カード・バックグラウンドの一覧が使う過去の分は、開いている会話の分（子孫まで）を delegation.tasks で読んで持ち、
// その上に running の行を重ねる。ここは状態を持たない計算だけ（持つのは web/client.mjs）

const LIVE = new Set(['queued', 'running', 'cancelling']);
const UNDELIVERED = new Set(['none', 'pending', 'delivering']);

/** 会話の分の行（cards: taskId → 行）に running の行を重ねる。running にしか無い行（読む前に始まった委譲）も含める */
export function mergeTasks(cards, live) {
  const byId = new Map(cards);
  for (const r of live ?? []) byId.set(r.taskId, { ...(byId.get(r.taskId) ?? {}), ...r });
  return [...byId.values()];
}

/** この会話と、そこから委譲した子孫の会話の id（rows の親子をたどる） */
export function treeSessions(sessionId, rows) {
  const sessions = new Set(sessionId ? [sessionId] : []);
  if (!sessionId) return sessions;
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (sessions.has(r.parentSessionId) && r.sessionId && !sessions.has(r.sessionId)) { sessions.add(r.sessionId); grew = true; }
  }
  return sessions;
}

/**
 * running が届いたとき、読み直す行の id。この会話の木に入る行のうち、まだ持っていないもの（新しい委譲）と、
 * running から外れたもの（終わって通知が届いた。終わった後の状態・時刻を読む）。prevLive は前の running の行（taskId → 行）
 */
export function tasksToFetch({ cards, live = [], prevLive = new Map(), sessionId }) {
  const sessions = treeSessions(sessionId, [...cards.values(), ...live, ...prevLive.values()]);
  const now = new Set(live.map(r => r.taskId));
  const ids = new Set();
  for (const r of live) if (sessions.has(r.parentSessionId) && !cards.has(r.taskId)) ids.add(r.taskId);
  for (const [id, r] of prevLive) if (!now.has(id) && (cards.has(id) || sessions.has(r.parentSessionId))) ids.add(id);
  return [...ids];
}

/** 読んだ行のうち、まだ終わっていない（か通知が届いていない）のに running に無いもの。読んでいる間に終わったので、もう一度読む */
export function staleTasks(rows, live = []) {
  const now = new Set(live.map(r => r.taskId));
  return rows.filter(r => (LIVE.has(r.status) || UNDELIVERED.has(r.notification)) && !now.has(r.taskId)).map(r => r.taskId);
}
