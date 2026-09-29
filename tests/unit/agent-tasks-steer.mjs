import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';

export const name = 'agent-tasks-steer';
export const title = '追加指示（ply_task_send）: 走っている子のターンへ途中送信で渡す・受理されない/捨てられた/合図なしは待機へ戻り 1 回だけ次のターンで';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-steer-'));
  let seq = 0, steerable = true, outcome = 'delivered', onSteer = null;
  const runs = [], steered = [], holds = new Map();
  let manager;
  const states = id => manager.instructions(id).instructions.map(x => `${x.text}:${x.state}`).join();
  const runsOf = id => runs.filter(x => x[0] === id).map(x => x[1]);
  const release = id => holds.get(id)?.();
  const manage = async () => {
    manager = await createAgentTasks({
      dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
      prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
      // hold- で始まる依頼は、放すまで子のターンが走っている形。ターンが終わるとき、server の endTurn と同じく途中送信の後始末を先にする
      execute: async (task, prompt, signal) => {
        runs.push([task.taskId, prompt]);
        if (prompt.startsWith('hold-')) {
          await new Promise(resolve => { holds.set(task.taskId, resolve); signal.addEventListener('abort', resolve, { once: true }); });
          await manager.settleSteers(task.sessionId);
        }
        return { outcome: signal.aborted ? 'aborted' : 'ok', text: `result:${prompt}` };
      },
      deliver: async () => 'ok',
      childSteerable: async () => steerable,
      steer: async (task, instruction) => {
        steered.push([task.taskId, instruction.text]);
        await onSteer?.(task, instruction);
        return outcome;
      },
    });
  };
  await manage();
  // 走っている子を作る。delegate → running になるまで待つ
  const start = async prompt => {
    const job = await manager.call('p', 'ply_delegate', { backend: 'fake', task: prompt });
    await until(() => holds.has(job.taskId) && manager.get(job.taskId).status === 'running');
    return job.taskId;
  };
  const send = (id, message) => manager.call('p', 'ply_task_send', { taskId: id, message });
  try {
    // ---- 受理（合図の無いバックエンド）: 渡ったものとして配送済み。新しいターンは走らない
    {
      outcome = 'delivered'; steered.length = 0;
      const id = await start('hold-a');
      const out = await send(id, 'steered-a');
      t.ok('渡った指示の返り値に warning は付かない', out.warning === undefined);
      t.ok('走っている子へ途中送信で渡し、その場で配送済みになる', steered.length === 1 && steered[0][1] === 'steered-a'
        && states(id) === 'steered-a:delivered' && out.pendingMessages === 0 && out.status === 'running', JSON.stringify({ steered, s: states(id), out: out.pendingMessages }));
      t.ok('待機の表示は出ない（pendingMessages 0）', manager.get(id).pendingMessages === 0);
      release(id);
      await until(() => manager.get(id).status === 'completed');
      await sleep(200);
      t.ok('同じ回の結果で完了し、新しいターンは走らない', JSON.stringify(runsOf(id)) === '["hold-a"]' && manager.get(id).result === 'result:hold-a');
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'));
      t.ok('配送済みは保存される', saved[id].instructions[0].state === 'delivered' && saved[id].queue.length === 0);
      await until(() => manager.get(id).notification === 'sent');
      t.ok('完了通知は走っていた回の結果を 1 回だけ渡す', manager.get(id).notification === 'sent');
    }

    // ---- 受理して合図を待つ（steerConfirms）: 合図まで sending、渡ったら delivered
    {
      outcome = 'pending'; steered.length = 0;
      const id = await start('hold-b');
      const out = await send(id, 'steered-b');
      const instruction = manager.instructions(id).instructions[0];
      t.ok('受理しただけでは送信中（sending）で、待機にも配送済みにもしない', instruction.state === 'sending' && out.pendingMessages === 0, instruction.state);
      await manager.steered(id, instruction.id, 'delivered');
      t.ok('渡った合図で配送済みになる', states(id) === 'steered-b:delivered');
      release(id);
      await until(() => manager.get(id).status === 'completed');
      await sleep(200);
      t.ok('次のターンは走らない', JSON.stringify(runsOf(id)) === '["hold-b"]');
    }

    // ---- 合図が受理の応答より先に来る
    {
      outcome = 'pending'; steered.length = 0;
      onSteer = async (task, instruction) => { await manager.steered(task.taskId, instruction.id, 'delivered'); };
      const id = await start('hold-c');
      await send(id, 'steered-c');
      onSteer = null;
      t.ok('合図が先に来ても配送済みのまま（受理の結果で戻さない）', states(id) === 'steered-c:delivered');
      release(id);
      await until(() => manager.get(id).status === 'completed');
      await sleep(200);
      t.ok('次のターンは走らない（先着の合図）', JSON.stringify(runsOf(id)) === '["hold-c"]');
    }

    // ---- 捨てられた（userMessage.dropped）: 待機へ戻り、次のターンで 1 回だけ送る
    {
      outcome = 'pending'; steered.length = 0;
      const id = await start('hold-d');
      await send(id, 'steered-d');
      const instruction = manager.instructions(id).instructions[0];
      await manager.steered(id, instruction.id, 'dropped');
      t.ok('捨てられたら待機（queued）へ戻る', states(id) === 'steered-d:queued' && manager.get(id).pendingMessages === 1);
      await manager.steered(id, instruction.id, 'dropped');
      t.ok('同じ合図が重なっても二重に積まない', manager.get(id).pendingMessages === 1);
      release(id);
      await until(() => manager.get(id).status === 'completed' && runsOf(id).length === 2);
      await manager.steered(id, instruction.id, 'delivered');   // 遅れて来た合図は無視される
      await sleep(200);
      t.ok('次のターンで 1 回だけ配送される', JSON.stringify(runsOf(id)) === '["hold-d","steered-d"]' && states(id) === 'steered-d:delivered' && manager.get(id).result === 'result:steered-d');
    }

    // ---- 合図が来ないままターンが終わった: 待機へ戻り、次のターンで 1 回だけ
    {
      outcome = 'pending'; steered.length = 0;
      const id = await start('hold-e');
      await send(id, 'steered-e');
      release(id);
      await until(() => manager.get(id).status === 'completed' && runsOf(id).length === 2);
      await sleep(200);
      t.ok('合図なしでターンが終わったら次のターンで配送する', JSON.stringify(runsOf(id)) === '["hold-e","steered-e"]' && states(id) === 'steered-e:delivered');
      t.ok('結果は新しい指示の回のもの', manager.get(id).result === 'result:steered-e');
    }

    // ---- 受理されない（steer が false）: 待機のまま、次のターンで
    {
      outcome = 'requeue'; steered.length = 0;
      const id = await start('hold-f');
      const out = await send(id, 'steered-f');
      t.ok('受理されなければ待機のまま', steered.length === 1 && states(id) === 'steered-f:queued' && out.pendingMessages === 1);
      release(id);
      await until(() => manager.get(id).status === 'completed' && runsOf(id).length === 2);
      t.ok('次のターンで配送する', JSON.stringify(runsOf(id)) === '["hold-f","steered-f"]' && states(id) === 'steered-f:delivered');
    }

    // ---- 結果不明（steer が throw）: 送り直さず未配送（dropped）
    {
      outcome = 'error'; steered.length = 0;
      const id = await start('hold-g');
      const outG = await send(id, 'steered-g');
      t.ok('結果不明は未配送（dropped）で残し、待機にはしない', states(id) === 'steered-g:dropped' && manager.get(id).pendingMessages === 0);
      t.ok('依頼元には結果不明の一言（warning）が付く。ほかの場合は付かない', typeof outG.warning === 'string' && outG.warning.includes('ply_task_status'));
      release(id);
      await until(() => manager.get(id).status === 'completed');
      await sleep(200);
      t.ok('送り直さない', JSON.stringify(runsOf(id)) === '["hold-g"]');
    }

    // ---- 渡せない状態（childSteerable が false）: steer を呼ばず待機
    {
      outcome = 'delivered'; steered.length = 0; steerable = false;
      const id = await start('hold-h');
      await send(id, 'steered-h');
      t.ok('渡せない子には steer を呼ばず待機する', steered.length === 0 && states(id) === 'steered-h:queued');
      release(id);
      await until(() => manager.get(id).status === 'completed' && runsOf(id).length === 2);
      t.ok('次のターンで配送する（今までどおり）', states(id) === 'steered-h:delivered');
      steerable = true;
    }

    // ---- 順序: 待機の指示が先にあるとき、後の指示だけ途中送信で追い越さない
    {
      outcome = 'delivered'; steered.length = 0; steerable = false;
      const id = await start('hold-i');
      await send(id, 'first-i');
      steerable = true;
      await send(id, 'second-i');
      t.ok('前の指示が待機中なら、後の指示も待機して順序を守る', steered.length === 0 && states(id) === 'first-i:queued,second-i:queued');
      release(id);
      await until(() => manager.get(id).status === 'completed' && runsOf(id).length === 3);
      t.ok('FIFO で配送する', JSON.stringify(runsOf(id)) === '["hold-i","first-i","second-i"]');
    }

    // ---- 前の途中送信が決着する前の次の指示は待機（二重・順序の入れ替わりを避ける）
    {
      outcome = 'pending'; steered.length = 0;
      const id = await start('hold-j');
      await send(id, 'first-j');
      await send(id, 'second-j');
      t.ok('合図待ちの間に送った次の指示は待機する', steered.length === 1 && states(id) === 'first-j:sending,second-j:queued');
      await manager.steered(id, manager.instructions(id).instructions[0].id, 'delivered');
      release(id);
      await until(() => manager.get(id).status === 'completed' && runsOf(id).length === 2);
      t.ok('次の指示は次のターンで、先の指示は二重にならない', JSON.stringify(runsOf(id)) === '["hold-j","second-j"]' && states(id) === 'first-j:delivered,second-j:delivered');
    }

    // ---- 止めたタスクは、合図待ちの指示で生き返らない
    {
      outcome = 'pending'; steered.length = 0;
      const id = await start('hold-k');
      await send(id, 'steered-k');
      await manager.cancel(id);
      await until(() => manager.get(id).status === 'cancelled');
      t.ok('止めた後は待機に残さず未配送（dropped）', states(id) === 'steered-k:dropped' && manager.get(id).pendingMessages === 0 && JSON.stringify(runsOf(id)) === '["hold-k"]', `${states(id)} ${manager.get(id).status}`);
    }

    // ---- 走っていない（完了済み）タスクへは途中送信しない
    {
      outcome = 'delivered'; steered.length = 0;
      const job = await manager.call('p', 'ply_delegate', { backend: 'fake', task: 'quick-l' });
      await until(() => manager.get(job.taskId).status === 'completed');
      await send(job.taskId, 'after-l');
      await until(() => manager.get(job.taskId).status === 'completed' && runsOf(job.taskId).length === 2);
      t.ok('完了後の指示は今までどおり新しいターンで走らせる', steered.length === 0 && JSON.stringify(runsOf(job.taskId)) === '["quick-l","after-l"]');
    }

    // ---- 再起動: 合図待ちの指示（sending）は配送済みとして残り、再実行しない
    {
      outcome = 'pending'; steered.length = 0;
      const id = await start('hold-m');
      await send(id, 'steered-m');
      manager.close();
      const before = runs.length;
      await manage();
      t.ok('再起動後、合図待ちだった指示は配送済み・待機なし・再実行なし', states(id) === 'steered-m:delivered' && manager.get(id).status === 'interrupted' && manager.get(id).pendingMessages === 0);
      await sleep(600);
      t.ok('再起動で子を走らせ直さない', runs.length === before);
    }
  } finally { manager.close(); }
}
