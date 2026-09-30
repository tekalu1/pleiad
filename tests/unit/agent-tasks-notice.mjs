import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { canSteerNotice } from '../../core/completion-notices.mjs';

export const name = 'agent-tasks-notice';
export const title = '完了通知: 受け取り済みは送らない（read）・同じ親の分は 1 つにまとめる・走っているターンへ渡す（steerable）と送り直し';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-notice-'));
  let seq = 0, parentReady = false, canSteer = false, steerResult = 'ok';
  const delivered = [];
  const manager = await createAgentTasks({
    dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    execute: async (_task, prompt) => {
      if (prompt.startsWith('slow')) await sleep(400);
      return { outcome: prompt.startsWith('fail') ? 'error' : 'ok', text: `result:${prompt}` };
    },
    ready: async () => parentReady,
    steerable: async () => canSteer,
    deliver: async tasks => {
      // 走っているターンへ渡す道（steerable）でも新しいターンの道でも、まとめた配列で来る
      if (!parentReady && !canSteer) return 'requeue';
      if (steerResult === 'requeue' && !parentReady) return 'requeue';
      delivered.push({ ids: tasks.map(x => x.taskId), via: parentReady ? 'turn' : 'steer' });
      return steerResult === 'error' ? 'error' : 'ok';
    },
  });
  const delegate = async (owner, prompt) => manager.call(owner, 'ply_delegate', { backend: 'fake', task: prompt });
  const done = id => ['completed', 'failed'].includes(manager.get(id).status);
  try {
    // ---- B: 依頼元が ply_task_wait / ply_task_status で結果を受け取ったら、通知は送らない
    {
      const a = await delegate('p1', 'slow-a');
      const waited = await manager.call('p1', 'ply_task_wait', { taskId: a.taskId, seconds: 5 });
      t.ok('ply_task_wait は完了と結果を返す', waited.status === 'completed' && waited.result === 'result:slow-a');
      await until(() => manager.get(a.taskId).notification === 'read');
      parentReady = true; await sleep(1300);
      t.ok('受け取った結果の完了通知は、親が空いても送らない', delivered.length === 0 && manager.get(a.taskId).notification === 'read', JSON.stringify(delivered));
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'));
      t.ok('read は保存される（再起動しても送らない）', saved[a.taskId].notification === 'read');

      // status でも同じ。offset が残っていても（長い結果の続きがあっても）受け取った時点で配達済み
      parentReady = false;
      const b = await delegate('p1', 'fail-b');
      await until(() => done(b.taskId));
      await manager.call('p1', 'ply_task_status', { taskId: b.taskId });
      parentReady = true; await sleep(1300);
      t.ok('ply_task_status で失敗を受け取っても送らない', delivered.length === 0 && manager.get(b.taskId).notification === 'read');

      // 走っている間の status は受け取りではない。list は結果を返さないので受け取りにしない
      parentReady = false;
      const c = await delegate('p1', 'slow-c');
      const running = await manager.call('p1', 'ply_task_status', { taskId: c.taskId });
      t.ok('実行中の status は受け取りにしない', running.status !== 'completed' && manager.get(c.taskId).notification === 'none');
      await until(() => manager.get(c.taskId).notification === 'pending');
      await manager.call('p1', 'ply_task_list', {});
      t.ok('ply_task_list は結果を返さないので受け取りにしない', manager.get(c.taskId).notification === 'pending');
      parentReady = true;
      await until(() => delivered.length === 1);
      t.ok('受け取っていなければ今までどおり送る', delivered[0].ids.length === 1 && delivered[0].ids[0] === c.taskId && manager.get(c.taskId).notification === 'sent');

      // 受け取った後で追加の指示を送ると、次の回の結果は通知する
      const before = delivered.length;
      await manager.call('p1', 'ply_task_send', { taskId: a.taskId, message: 'again' });
      await until(() => delivered.length === before + 1);
      t.ok('read の後に ply_task_send で走らせた回は通知する', delivered.at(-1).ids[0] === a.taskId && manager.get(a.taskId).notification === 'sent');
    }

    // ---- C: 同じ親に溜まった通知は 1 つ（1 回の deliver）にまとめる。別の親とは混ぜない
    {
      parentReady = false; delivered.length = 0;
      const ids = [];
      for (const prompt of ['one', 'two', 'three']) ids.push((await delegate('p2', prompt)).taskId);
      const other = (await delegate('p3', 'other')).taskId;
      await until(() => [...ids, other].every(id => manager.get(id).notification === 'pending'));
      parentReady = true;
      await until(() => delivered.length === 2);
      const mine = delivered.find(x => x.ids.includes(ids[0]));
      t.ok('同じ親の 3 件は 1 回の配送にまとまる', mine.ids.length === 3 && ids.every(id => mine.ids.includes(id)), JSON.stringify(delivered));
      t.ok('別の親の通知は混ぜない', delivered.find(x => x.ids.includes(other)).ids.length === 1);
      t.ok('まとめた 3 件とも sent', ids.every(id => manager.get(id).notification === 'sent'));
      // メモリの sent は保存より先に立つ（保存は rename のやり直しで遅れうる）。ファイルが sent になるまで待つ
      const savedNow = async () => JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'));
      await until(async () => { const f = await savedNow().catch(() => null); return f && ids.every(id => f[id]?.notification === 'sent'); });
      const saved = await savedNow();
      t.ok('まとめた分の送信済みは保存される', ids.every(id => saved[id].notification === 'sent'));
    }

    // ---- 走っているターンへ渡す（steerable）: 新しいターンを待たずに届き、sent になる
    {
      parentReady = false; canSteer = true; delivered.length = 0;
      const s = await delegate('p4', 'steer-me');
      await until(() => manager.get(s.taskId).notification === 'sent');
      t.ok('親が走っていて途中送信を受けられるなら、その場で届いて sent', delivered.length === 1 && delivered[0].via === 'steer' && delivered[0].ids[0] === s.taskId);

      // 渡せなかった（steer が false）: pending へ戻り、空いた後の新しいターンで送る
      canSteer = true; steerResult = 'requeue'; delivered.length = 0;
      const r = await delegate('p4', 'steer-false');
      await until(() => done(r.taskId));
      await sleep(1200);
      t.ok('途中送信を受理されなければ pending のまま', manager.get(r.taskId).notification === 'pending' && delivered.length === 0);
      canSteer = false; parentReady = true;
      await until(() => manager.get(r.taskId).notification === 'sent');
      t.ok('空いたら新しいターンで送る', delivered.length === 1 && delivered[0].via === 'turn');

      // 結果不明（throw）は unknown。自動で送り直さない
      steerResult = 'error'; parentReady = false; canSteer = true; delivered.length = 0;
      const u = await delegate('p4', 'steer-throws');
      await until(() => manager.get(u.taskId).notification === 'unknown');
      canSteer = false; parentReady = true; await sleep(1200);
      t.ok('受領が不明なら unknown のまま再送しない', delivered.length === 1 && manager.get(u.taskId).notification === 'unknown');
      steerResult = 'ok';

      // 渡ったが読まれないままターンが死んだ: renotify で pending に戻し、空いたときの経路で送り直す
      parentReady = false; canSteer = true; delivered.length = 0;
      const d = await delegate('p4', 'dropped');
      await until(() => manager.get(d.taskId).notification === 'sent');
      const revision = manager.get(d.taskId).revision ?? 0;
      canSteer = false;
      await manager.renotify([{ taskId: d.taskId, revision }]);
      t.ok('読まれずに捨てられた通知は pending に戻る', manager.get(d.taskId).notification === 'pending');
      parentReady = true;
      await until(() => delivered.length === 2);
      t.ok('空いたら新しいターンで送り直す', delivered[1].via === 'turn' && manager.get(d.taskId).notification === 'sent');
      // 受け取り済み（read）や別の回のものは戻さない
      await manager.renotify([{ taskId: d.taskId, revision: revision + 1 }, { taskId: 'missing', revision: 0 }]);
      t.ok('回が違う・無いタスクは戻さない', manager.get(d.taskId).notification === 'sent');

      // 依頼元が ply_task_wait で待っている間に終わった: 結果は待ちの戻り値で渡すので、走っているターンへ通知を重ねない
      parentReady = false; canSteer = true; delivered.length = 0;
      const w = await delegate('p4', 'slow-waited');
      const got = await manager.call('p4', 'ply_task_wait', { taskId: w.taskId, seconds: 5 });
      await sleep(1200);
      t.ok('待ちで受け取った結果は途中送信でも届けない', got.status === 'completed' && delivered.length === 0 && manager.get(w.taskId).notification === 'read', JSON.stringify(delivered));
    }

    // ---- 途中送信の条件（canSteerNotice）: 人間の送信待ちが先・予約された次ターンの設定・圧縮・中断・途中送信の無いバックエンド
    {
      const turn = (over = {}) => ({ ac: { signal: { aborted: false } }, outcome: null, control: { steer: async () => true }, ...over });
      const ok = { unsent: false, nextSettings: null };
      t.ok('走っていて途中送信を持つターンには渡す', canSteerNotice(turn(), ok) === true);
      t.ok('人間の送信待ちがあれば渡さない（人の送信が先）', canSteerNotice(turn(), { ...ok, unsent: true }) === false);
      t.ok('次ターンの設定が予約されていれば渡さない', canSteerNotice(turn(), { ...ok, nextSettings: { model: 'x' } }) === false);
      t.ok('ターンが無ければ渡さない', canSteerNotice(null, ok) === false);
      t.ok('途中送信を持たないバックエンド（Antigravity）には渡さない', canSteerNotice(turn({ control: {} }), ok) === false);
      t.ok('中断された・終わったターンには渡さない', canSteerNotice(turn({ ac: { signal: { aborted: true } } }), ok) === false && canSteerNotice(turn({ outcome: 'ok' }), ok) === false);
      t.ok('圧縮のターンには渡さない', canSteerNotice(turn({ compactTrigger: 'auto' }), ok) === false);
    }
  } finally { manager.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
