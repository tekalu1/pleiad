import { taskTitle } from '../../core/task-title.mjs';
import { backgroundTitle, taskTree, backgroundTotals } from '../../web/background-model.mjs';

export const name = 'background-model';
export const title = 'バックグラウンドのタイトル・集計・子孫の順序';
export default async function(t) {
  t.ok('明示タイトルの空白を詰めて 40 文字に切る', taskTitle('  alpha\n  beta   ' + 'x'.repeat(50), 'fallback') === ('alpha beta ' + 'x'.repeat(50)).slice(0, 40));
  t.ok('絵文字を途中で切らず 40 文字にする', taskTitle('🚀'.repeat(40), 'fallback') === '🚀'.repeat(40));
  t.ok('未指定・空タイトルは依頼の最初の空でない行へ戻る', taskTitle('', '\n \n  first   line  \nsecond') === 'first line'
    && backgroundTitle({ task: '\n  old   task\nmore' }) === 'old task');
  const tasks = [
    { taskId: 'root-old', parentSessionId: 'top', sessionId: 'a', createdAt: 1, status: 'completed' },
    { taskId: 'grandchild', parentSessionId: 'b', sessionId: 'c', createdAt: 3, status: 'running' },
    { taskId: 'child', parentSessionId: 'a', sessionId: 'b', createdAt: 2, status: 'completed' },
    { taskId: 'root-new', parentSessionId: 'top', sessionId: 'd', createdAt: 4, status: 'running' },
    { taskId: 'elsewhere', parentSessionId: 'other', sessionId: 'e', createdAt: 5, status: 'completed' },
  ];
  const tree = taskTree(tasks, 'top');
  t.ok('新しい根を先にし、孫を親の直後に深さ付きで並べる', tree.map(x => `${x.task.taskId}:${x.depth}`).join() === 'root-new:0,root-old:0,child:1,grandchild:2');
  t.ok('直下の委譲数と根の状態を子孫へ渡す', tree[1].childCount === 1 && tree[2].childCount === 1 && tree[3].rootLive === false);
  const totals = backgroundTotals([{ group: 'agent', live: true }, { group: 'agent', live: false }, { group: 'agent', live: false }, { group: 'command', live: true }]);
  t.ok('稼働中は全種、完了はサブエージェントと Pleiad タスクを数える', totals.live === 2 && totals.ended === 2);
}
