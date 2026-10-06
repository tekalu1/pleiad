// 付け直した委譲の子のターン（無停止の更新 段階 2 の 2b-7。docs/zero-downtime-update/stage2-server-state.md §3 の 2・S8）: agentTasks.adoptRun。
// 旧サーバー（manager a）が子のターンを走らせたまま手を離し（execute が handedOff を返す）、新しいサーバー（manager b）が同じデータ置き場で
// adopting にそのタスクを挙げて起き、結果の確定（execute の後半）を adoptRun() で引き継ぐ。
//   - 起動の復元は付け直すタスクを interrupted にしない（付け直さないタスクは今までどおり interrupted）
//   - 手を離した旧サーバーは結果を書かない・通知しない（結果は新しいサーバーが 1 回だけ書く）
//   - 途中送信で渡している最中の追加指示（sending）は claim として引き継ぎ、渡った合図（steered）で配送済みにする。合図なしで終われば待機へ戻して次のターンで 1 回
//   - 付け直しをあきらめたら interrupted。取り消しの最中（cancelling）のタスクは、付け直しても cancelled で終わる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { readAgentTasks, writeAgentTasks } from '../lib/data-store.mjs';

export const name = 'agent-tasks-adopt';
export const title = '付け直した委譲の子: 起動の復元で interrupted にせず、結果の確定を 1 回だけ引き継ぐ（手を離した側は書かない・途中送信の claim・あきらめ・取り消し）';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-tasks-'));
  const delivered = [], executed = [];
  let seq = 0;
  // 旧サーバーの execute: 子のターンが走っている形。hand(taskId) で子のターンを新しいサーバーへ渡す（handedOff）。close の abort では何も返さず待ち続けない
  const hands = new Map();
  const open = ({ adopting = [], execute }) => createAgentTasks({
    dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0, adopting,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    execute: async (task, prompt, signal) => {
      executed.push([task.taskId, prompt]);
      return execute ? execute(task, prompt, signal) : new Promise(resolve => {
        hands.set(task.taskId, () => resolve({ handedOff: true }));
        signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true });
      });
    },
    deliver: async tasks => { delivered.push(...tasks.map(x => [x.taskId, x.status, x.result])); return 'ok'; },
    childSteerable: async () => true,
    steer: async () => 'pending',
  });
  const states = (manager, id) => manager.instructions(id).instructions.map(x => `${x.text}:${x.state}`).join();
  const start = async (manager, task) => {
    const job = await manager.call('p', 'ply_delegate', { backend: 'fake', task });
    await until(() => manager.get(job.taskId).status === 'running' && hands.has(job.taskId));
    return job.taskId;
  };
  let a = null, b = null;
  try {
    // ---- 旧サーバー: 子のターンを走らせ、追加指示を途中送信で渡して合図を待つ（sending）。その状態で子のターンを新しいサーバーへ渡す
    a = await open({});
    const id = await start(a, 'work');
    const other = await start(a, 'other');   // 付け直さないタスク
    await a.call('p', 'ply_task_send', { taskId: id, message: 'extra' });
    const extra = a.instructions(id).instructions[0];
    t.ok('旧サーバー: 途中送信で渡した追加指示は、渡った合図まで sending', extra.state === 'sending', extra.state);
    hands.get(id)();
    await sleep(300);
    t.ok('旧サーバー: 手を離した子の結果は書かず、通知もしない（running のまま）', a.get(id).status === 'running' && a.get(id).notification === 'none' && delivered.length === 0,
      JSON.stringify(a.get(id)));
    await a.close();
    a = null;

    // ---- 新しいサーバー: 付け直すタスクだけ interrupted にしない
    let finish;
    b = await open({ adopting: [id], execute: async () => { throw new Error('execute は呼ばれない'); } });
    t.ok('復元: 付け直すタスクは running のまま', b.get(id).status === 'running', b.get(id).status);
    t.ok('復元: 付け直さないタスクは今までどおり interrupted（restored に載る）', b.get(other).status === 'interrupted' && b.restored.map(x => x.taskId).join() === other);
    t.ok('復元: 付け直すタスクの途中送信の追加指示（sending）はそのまま', states(b, id) === 'extra:sending', states(b, id));
    await sleep(700);
    t.ok('復元: 付け直す前に新しい実行・通知は始まらない', executed.length === 2 && b.get(id).status === 'running' && delivered.length === 0);
    const adopted = b.adoptRun(id, () => new Promise(resolve => { finish = resolve; }), { claims: [extra.id, 'unknown-id'] });
    t.ok('adoptRun は引き継げたら true、2 回目は引き継がない（false）', adopted === true && b.adoptRun(id, async () => ({ outcome: 'ok' })) === false);
    await b.steered(id, extra.id, 'delivered');
    t.ok('渡った合図で、引き継いだ追加指示が配送済みになる', states(b, id) === 'extra:delivered', states(b, id));
    finish({ outcome: 'ok', text: 'adopted result' });
    await until(() => b.get(id).status === 'completed' && b.get(id).notification === 'sent');
    t.ok('結果の確定: completed で、結果は付け直した側のもの。完了通知は 1 回', b.get(id).result === 'adopted result'
      && delivered.filter(x => x[0] === id).length === 1, JSON.stringify(delivered));
    t.ok('execute（実行の開始）は呼ばれていない', executed.length === 2);
    await b.close();
    b = null;

    // ---- 合図なしで子のターンが終わる: claim は待機へ戻り、次のターンで 1 回
    a = await open({});
    const id3 = await start(a, 'work3');
    await a.call('p', 'ply_task_send', { taskId: id3, message: 'extra3' });
    const extra3 = a.instructions(id3).instructions[0];
    hands.get(id3)();
    await sleep(200);
    await a.close();
    a = null;
    b = await open({ adopting: [id3], execute: async (task, prompt) => ({ outcome: 'ok', text: `second:${prompt}` }) });
    b.adoptRun(id3, async task => { await b.settleSteers(task.sessionId); return { outcome: 'ok', text: 'first' }; }, { claims: [extra3.id] });
    await until(() => b.get(id3).status === 'completed' && b.get(id3).result === 'second:extra3');
    t.ok('合図なしで終われば待機へ戻り、次のターンで 1 回だけ配送する', states(b, id3) === 'extra3:delivered'
      && executed.filter(x => x[0] === id3).length === 2 && executed.at(-1)[1] === 'extra3', JSON.stringify(executed));
    await b.close();
    b = null;

    // ---- 付け直しをあきらめた（待ち受けのポートが取れないなど）: interrupted
    a = await open({});
    const id4 = await start(a, 'work4');
    hands.get(id4)();
    await sleep(200);
    await a.close();
    a = null;
    b = await open({ adopting: [id4], execute: async () => ({ outcome: 'ok' }) });
    t.ok('あきらめ: finish が無ければ false', b.adoptRun(id4, null) === false);
    await until(() => b.get(id4).status === 'interrupted');
    t.ok('あきらめたタスクは interrupted で、完了通知は出ない', b.get(id4).error && !delivered.some(x => x[0] === id4));
    await b.close();
    b = null;

    // ---- 取り消しの最中（cancelling）に旧サーバーが落ちた: 付け直しても cancelled で終わる
    a = await open({});
    const id5 = await start(a, 'work5');
    hands.get(id5)();
    await sleep(200);
    await a.close();
    a = null;
    const rows = readAgentTasks(dir);
    rows[id5].status = 'cancelling';
    writeAgentTasks(dir, rows);
    b = await open({ adopting: [id5], execute: async () => ({ outcome: 'ok' }) });
    t.ok('取り消しの最中のタスクも、付け直すなら cancelling のまま', b.get(id5).status === 'cancelling', b.get(id5).status);
    b.adoptRun(id5, async (task, signal) => ({ outcome: signal.aborted ? 'aborted' : 'ok', text: 'stopped' }));
    await until(() => b.get(id5).status === 'cancelled');
    t.ok('取り消し済みの印のまま付け直すと、結果は cancelled', b.get(id5).status === 'cancelled');
  } finally {
    await a?.close().catch(() => {});
    await b?.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
