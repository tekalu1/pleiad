// A server left by a finished turn is available infrastructure, not an AI reply in progress.
//
// 数えるのは「終わりが必ず届くので待てるもの」だけ。Claude のバックグラウンドのコマンドは
// 完了通知（task_notification）が来るので `waitable: true` が付いて数える（core/backends/claude-background.mjs）。
// 終わりの合図が無い裏のシェル・端末は、数えると印が消えなくなるので数えない。
import { t } from './i18n.mjs';

const waited = (x) => x.waitable === true || (x.kind !== 'shell' && x.kind !== 'terminal');

export function behindOfTasks(tasks, { waiting = false } = {}) {
  const live = (tasks ?? []).filter(waited);
  if (!live.length && !waiting) return null;
  return {
    n: Math.max(1, live.length),
    // 委譲した Pleiad タスクも利用者から見ればサブエージェント。呼び分けない（docs/design-system.md「バックグラウンド」）
    label: live.every(x => x.kind === 'agent' || x.kind === 'task') ? t('timeline.behind.subagents')
      : live.every(x => x.kind === 'shell') ? t('timeline.behind.commands')
      : t('activity.waitingBackground'),
  };
}

// Pleiad タスク（ply_delegate で委譲した子の会話）のうち、まだ終わっていないもの。
// 依頼元の会話から見ると裏で動いている子なので、サブエージェントと同じく衛星で待つ（完了は必ず届く）
const LIVE_TASK = new Set(['queued', 'running', 'cancelling', 'waiting']);
export function liveTasksOf(tasks, parentSessionId) {
  if (!parentSessionId) return [];
  return (tasks ?? []).filter(x => x.parentSessionId === parentSessionId && LIVE_TASK.has(x.status))
    .map(x => ({ kind: 'task', waitable: true, taskId: x.taskId }));
}
