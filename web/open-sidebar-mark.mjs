// 「サイドバーを開く」の印（docs/design-system.md §4.1「脇を閉じている間の印」）。
// 脇が見えていない間（700px 以下の引き出し・広い画面で閉じたとき）も、ほかの会話の完了・承認待ちに気付けるようにする。
//   承認待ちがあれば ◆（差し色。2 件以上なら数を添える。グループの要約と同じ規則）、無ければ未確認の青い丸。
//   件数はボタンのアクセシブルな名前に入れる（印は aria-hidden。色だけに頼らない: 名前と形の違う ● / ◆）。
//   今開いている会話は数えない。脇が見えている間は開くボタンごと隠れる（style.css の #openSidebar）

/**
 * 今の会話を除いた、承認待ちと完了・未確認の件数。
 * 未確認は一覧の行と同じく、走っている・裏で待っている会話では数えない（行では弧・衛星が勝つ）
 */
export function attentionCounts(sessions, { currentId = null, waitingIds = new Set(), unreadIds = new Set(), busyIds = new Set() } = {}) {
  let waiting = 0, unread = 0;
  for (const s of sessions ?? []) {
    if (!s?.id || s.id === currentId) continue;
    if (waitingIds.has(s.id)) waiting++;
    if (unreadIds.has(s.id) && !busyIds.has(s.id)) unread++;
  }
  return { waiting, unread };
}

/** 開くボタンに印とアクセシブルな名前を付ける */
export function paintOpenSidebar(button, { waiting = 0, unread = 0 } = {}, t) {
  let mark = button.querySelector('.side-mark');
  if (!waiting && !unread) {
    mark?.remove();
    button.setAttribute('aria-label', t('app.openSidebar'));
    return;
  }
  if (!mark) {
    mark = document.createElement('span');
    mark.className = 'side-mark';
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  }
  mark.dataset.kind = waiting ? 'wait' : 'unread';
  mark.textContent = waiting > 1 ? String(waiting) : '';
  const parts = [];
  if (waiting) parts.push(t('sidebar.waitingCount', { count: waiting }));
  if (unread) parts.push(t('sidebar.unreadCount', { count: unread }));
  button.setAttribute('aria-label', t('app.openSidebarWith', { detail: parts.join(' · ') }));
}
