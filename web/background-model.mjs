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

/**
 * 委譲した子の会話（sessionId）が生んだネイティブのサブエージェント（孫）。新しいものを先に並べる。
 * 走っている分は配信（running の subagents。このターンの分）、終わった分は読み出し済みの past。同じ子（origin か id が同じ）は配信を取る
 */
export function nativeChildren(sessionId, subagents, past = []) {
  if (!sessionId) return [];
  const live = (subagents ?? []).filter(a => a.sessionId === sessionId);
  const origins = new Set(live.map(a => a.origin).filter(Boolean)), ids = new Set(live.map(a => a.id));
  const when = (a) => (a.startedAt ? new Date(a.startedAt).getTime() || 0 : 0);
  return [...live, ...past.filter(a => !origins.has(a.origin) && !ids.has(a.id))].sort((a, b) => when(b) - when(a));
}

// hostStale: ホストの孫の行で、しばらく読めていないもの（走っていたかもしれない・終わったかもしれない）。どちらにも数えない
export function backgroundTotals(items) {
  return { live: items.filter(item => item.live).length,
    ended: items.filter(item => item.group === 'agent' && !item.live && !item.hostStale).length };
}

/** 種類の並び（固定）。数が変わっても、入口の中の位置が入れ替わらない */
export const BACKGROUND_KIND_ORDER = ['claude', 'codex', 'antigravity', 'compat', 'term'];
const LOGO_BACKENDS = new Set(['claude', 'codex', 'antigravity']);
/** 項目の種類。エージェントはロゴのある接続先ごと、互換の接続先は 1 つにまとめ、裏のコマンド・端末は term */
export function backgroundKind(item) {
  if (item.group === 'command') return 'term';
  return LOGO_BACKENDS.has(item.backend) ? item.backend : 'compat';
}

/**
 * 入口のチップに出す中身（docs/design-system.md「入力欄の上の帯」）。動いているものを種類ごとにまとめる。
 * 承認待ちを含む種類だけ先頭へ寄せ、残りは固定の並び。並べるのは 3 種類まで（残りは hidden に数える）だが、承認待ちの種類は隠さない
 */
export function backgroundSummary(items, maxVisible = 3) {
  const live = items.filter(item => item.live);
  const byKind = new Map();
  for (const item of live) {
    const kind = backgroundKind(item);
    const group = byKind.get(kind) ?? { kind, n: 0, waiting: 0 };
    group.n++;
    if (item.waiting) group.waiting++;
    byKind.set(kind, group);
  }
  const groups = [...byKind.values()].sort((a, b) =>
    Number(b.waiting > 0) - Number(a.waiting > 0) || BACKGROUND_KIND_ORDER.indexOf(a.kind) - BACKGROUND_KIND_ORDER.indexOf(b.kind));
  const shown = Math.max(maxVisible, groups.filter(group => group.waiting > 0).length);
  const visible = groups.length > shown ? groups.slice(0, shown) : groups;
  return { live: live.length, ended: items.filter(item => item.group === 'agent' && !item.live).length,
    groups, visible, hidden: groups.length - visible.length };
}

/**
 * Channels のスレッドの一覧: エージェントの項目を、親（根）の会話ごと（= bot ごと）に分ける。会話の出てくる順・中の順は items のまま。
 * 子孫は根と同じグループ（item.owner は client.mjs の backgroundItems が根の会話を入れる）
 * @returns {Map<string|null, object[]>}
 */
export function groupByOwner(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.group !== 'agent') continue;
    (groups.get(item.owner ?? null) ?? groups.set(item.owner ?? null, []).get(item.owner ?? null)).push(item);
  }
  return groups;
}

/**
 * 1 つのグループで見せる行。動いている親（とその子孫）は全部、終わった親は先頭から limit 件まで（子孫は親に付く）。
 * remaining は見せなかった終わった親の数（「さらに N 件を表示」）
 */
export function visibleRows(rows, limit) {
  const finishedRoots = rows.filter(x => !(x.rootLive ?? x.live) && !x.depth);
  const shown = new Set(finishedRoots.slice(0, limit).map(x => x.key));
  let root = null;
  const visible = rows.filter(x => {
    if (x.rootLive ?? x.live) return true;
    if (!x.depth) { root = x.key; return shown.has(x.key); }
    return shown.has(root);
  });
  return { rows: visible, remaining: finishedRoots.length - shown.size };
}
