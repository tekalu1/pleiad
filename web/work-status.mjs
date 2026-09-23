// A server left by a finished turn is available infrastructure, not an AI reply in progress.
//
// 数えるのは「終わりが必ず届くので待てるもの」だけ。Claude のバックグラウンドのコマンドは
// 完了通知（task_notification）が来るので `waitable: true` が付いて数える（core/backends/claude-background.mjs）。
// 終わりの合図が無い裏のシェル・端末は、数えると印が消えなくなるので数えない。
const waited = (x) => x.waitable === true || (x.kind !== 'shell' && x.kind !== 'terminal');

export function behindOfTasks(tasks, { waiting = false } = {}) {
  const live = (tasks ?? []).filter(waited);
  if (!live.length && !waiting) return null;
  return {
    n: Math.max(1, live.length),
    label: live.every(x => x.kind === 'agent') ? 'サブエージェントを待っている'
      : live.every(x => x.kind === 'shell') ? 'バックグラウンドのコマンドを待っている'
      : '裏の作業を待っている',
  };
}
