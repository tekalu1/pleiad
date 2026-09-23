import { behindOfTasks } from '../../web/work-status.mjs';
export const name = 'work-status';
export const title = '端末の待ち受けをAIの結果待ちとして表示しない';
export default function (t) {
  const terminal = { kind: 'terminal' }, agent = { kind: 'agent' };
  t.ok('端末だけなら衛星と作業時間を出さない', behindOfTasks([terminal]) === null);
  t.ok('端末とシェルだけでも完了扱い', behindOfTasks([terminal, { kind: 'shell' }]) === null);
  t.ok('サブエージェントの結果待ちは残す', behindOfTasks([agent]).n === 1);
  t.ok('混在時はサブエージェントだけを数える', behindOfTasks([terminal, agent]).n === 1);
  t.ok('実行中のターンのwaitingは引き続き表示する', behindOfTasks([], { waiting: true }).n === 1);

  // Claude の local_bash は完了通知が必ず来るので待てる（waitable）。procway の裏のシェルには合図が無い
  const command = { kind: 'shell', waitable: true };
  t.ok('待てる印の付いたシェルは数える', behindOfTasks([command]).n === 1);
  t.ok('見出しはコマンドを待っていると分かる語',
    behindOfTasks([command]).label === 'バックグラウンドのコマンドを待っている', behindOfTasks([command]).label);
  t.ok('サブエージェントと混ざれば裏の作業', behindOfTasks([agent, command]).label === '裏の作業を待っている');
  t.ok('サブエージェントだけなら今までどおり', behindOfTasks([agent]).label === 'サブエージェントを待っている');
}
