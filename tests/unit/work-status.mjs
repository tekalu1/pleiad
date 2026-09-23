import { behindOfTasks, liveTasksOf } from '../../web/work-status.mjs';
export const name = 'work-status';
export const title = '端末の待ち受けをAIの結果待ちとして表示しない';
export default function (t) {
  const terminal = { kind: 'terminal' }, agent = { kind: 'agent' };
  t.ok('端末だけなら衛星と作業時間を出さない', behindOfTasks([terminal]) === null);
  t.ok('端末とシェルだけでも完了扱い', behindOfTasks([terminal, { kind: 'shell' }]) === null);
  t.ok('サブエージェントの結果待ちは残す', behindOfTasks([agent]).n === 1);
  t.ok('混在時はサブエージェントだけを数える', behindOfTasks([terminal, agent]).n === 1);
  t.ok('実行中のターンのwaitingは引き続き表示する', behindOfTasks([], { waiting: true }).n === 1);

  // Claude の local_bash は完了通知が必ず来るので待てる（waitable）。合図の無い裏のシェルは待てない
  const command = { kind: 'shell', waitable: true };
  t.ok('待てる印の付いたシェルは数える', behindOfTasks([command]).n === 1);
  t.ok('見出しはコマンドを待っていると分かる語',
    behindOfTasks([command]).label === 'バックグラウンドのコマンドを待っている', behindOfTasks([command]).label);
  t.ok('サブエージェントと混ざれば裏の作業', behindOfTasks([agent, command]).label === '裏の作業を待っている');
  t.ok('サブエージェントだけなら今までどおり', behindOfTasks([agent]).label === 'サブエージェントを待っている');

  // Pleiad タスク（委譲した子の会話）は、依頼元の会話で衛星になる。終わったものと他の会話のものは数えない
  const tasks = [
    { taskId: 'a', parentSessionId: 'p', status: 'running' },
    { taskId: 'b', parentSessionId: 'p', status: 'queued' },
    { taskId: 'c', parentSessionId: 'p', status: 'completed' },
    { taskId: 'd', parentSessionId: 'q', status: 'running' },
  ];
  t.ok('依頼元の会話の終わっていないタスクだけを拾う', JSON.stringify(liveTasksOf(tasks, 'p').map(x => x.taskId)) === '["a","b"]');
  t.ok('タスクだけなら衛星の数と見出し', behindOfTasks(liveTasksOf(tasks, 'p')).n === 2 && behindOfTasks(liveTasksOf(tasks, 'p')).label === 'タスクを待機中');
  t.ok('終わったタスクだけなら衛星を出さない', behindOfTasks(liveTasksOf([tasks[2]], 'p')) === null);
  t.ok('サブエージェントと混ざれば裏の作業', behindOfTasks([agent, ...liveTasksOf(tasks, 'p')]).label === '裏の作業を待っている');
}
