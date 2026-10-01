import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-notice';
export const title = '委譲の完了通知: 走っているターンへ途中送信で届ける・受け取り済みは送らない・複数は 1 つにまとめる（fake）';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });
const NOTICE = 'Pleiad タスク完了通知';

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-notice-'));
  const servers = [];
  const clients = [];
  const boot = async env => {
    const dataDir = await fs.mkdtemp(path.join(scratch, 'data-'));
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...env }, dataDir });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    servers.push(server); clients.push(c);
    const tasksOf = async parent => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent);
    const awaitTasks = async (parent, fn, ms = 60_000) => {
      const end = Date.now() + ms; let rows;
      while (Date.now() < end) { rows = await tasksOf(parent); if (fn(rows)) return rows; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(rows.map(({ task, status, notification }) => ({ task, status, notification }))));
    };
    const noticesOf = (sessionId, from = 0) => c.since(from).filter(e => e.type === 'taskNotice' && e.sessionId === sessionId);
    const turnEnds = (sessionId, from = 0) => c.since(from).filter(e => e.type === 'turnEnd' && e.sessionId === sessionId);
    return { server, c, tasksOf, awaitTasks, noticesOf, turnEnds };
  };
  try {
    // ---- 途中送信の「渡った」合図を持たないバックエンド（fake の既定。steerConfirms なし）
    {
      const { c, tasksOf, awaitTasks, noticesOf, turnEnds } = await boot({});

      // A: 依頼元のターンが走っている間に子が終わったら、その場で今のターンへ届く（新しいターンにしない）
      const p1 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 1.5') })).sessionId;
      const mark1 = c.mark();
      const running1 = c.runTurn({ sessionId: p1, prompt: 'bg 1 6' });
      let rows = await awaitTasks(p1, rows => rows[0]?.notification === 'sent');
      const child1 = rows[0];
      t.ok('依頼元のターンが走っている間に、完了通知が sent になる', turnEnds(p1, mark1).length === 0 && (await c.cmd('running')).turns.some(r => r.sessionId === p1));
      const live = noticesOf(p1, mark1);
      t.ok('通知の一行は 1 回だけ、taskId と結果を持つ', live.length === 1 && live[0].text.startsWith(`[${NOTICE} / ${child1.taskId}]`) && live[0].text.includes('状態: completed'), live[0]?.text?.slice(0, 80));
      t.ok('人間の吹き出し（userMessage）にも送信待ちにもしない', !c.since(mark1).some(e => e.type === 'userMessage' && e.sessionId === p1)
        && !c.since(mark1).some(e => e.type === 'outbox' && e.sessionId === p1 && e.messages?.length));
      await running1;
      await sleep(1600);
      t.ok('依頼元のターンが終わっても、同じ完了通知の新しいターンは始まらない', turnEnds(p1, mark1).length === 1 && noticesOf(p1, mark1).length === 1);
      const loaded = await c.cmd('loadSession', { sessionId: p1 });
      const asNotice = loaded.messages.filter(m => m.internalTaskNotice);
      t.ok('履歴では通知として描き、人間の発言と区別する', asNotice.length === 1 && asNotice[0].text.includes(child1.taskId));
      t.ok('依頼元はターンの中で通知に答えている', loaded.messages.some(m => m.role === 'assistant' && m.text.includes('受け取った') && m.text.includes(child1.taskId)));
      t.ok('OS の完了通知は依頼元のターンの終わりに 1 回', c.since(mark1).filter(e => e.type === 'completionReady' && e.sessionId === p1).length === 1);

      // B: ply_task_wait で結果を受け取ったら、あとから同じ完了の通知を送らない
      const p2 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 1.5') })).sessionId;
      const mark2 = c.mark();
      const waited = await c.runTurn({ sessionId: p2, prompt: ply('ply_task_wait', { taskId: (await tasksOf(p2))[0].taskId, seconds: 30 }) });
      const got = JSON.parse(waited.events.find(e => e.type === 'tool.result' && e.sessionId === p2).text);
      t.ok('依頼元は ply_task_wait で完了と結果を受け取る', got.status === 'completed');
      await sleep(2000);
      const read = (await tasksOf(p2))[0];
      t.ok('受け取った結果の完了通知は届かない（read）', read.notification === 'read' && noticesOf(p2, mark2).length === 0 && turnEnds(p2, mark2).length === 1, read.notification);

      // C: 依頼元が通知を受けられない間（次ターンの設定を予約して途中送信を止める）に溜まった通知は、空いたとき 1 つにまとまる
      // 子は途中送信を止めた後に終わらせる。短いと遅い CI で止める前に終わり、走っているターンや前のターンへ届いてしまう
      const p3 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 5') })).sessionId;
      await c.runTurn({ sessionId: p3, prompt: delegate('bg 1 5') });
      const mark3 = c.mark();
      const running3 = c.runTurn({ sessionId: p3, prompt: 'bg 1 12' });
      await c.waitFor(e => e.type === 'turnResult' || e.type === 'phase', { from: mark3, ms: 20000 });
      await c.cmd('setTurnSettings', { sessionId: p3, backend: 'fake', model: 'fast' });
      rows = await awaitTasks(p3, rows => rows.length === 2 && rows.every(r => r.status === 'completed'));
      await sleep(1200);
      t.ok('途中送信を止めている間は、走っているターンへ通知しない', rows.every(r => r.notification === 'pending') && noticesOf(p3, mark3).length === 0
        && turnEnds(p3, mark3).length === 0);
      await running3;
      rows = await awaitTasks(p3, rows => rows.every(r => r.notification === 'sent'));
      const batch = noticesOf(p3, mark3);
      t.ok('空いたら 2 件が 1 つの通知（1 ターン）にまとまる', batch.length === 1 && turnEnds(p3, mark3).length === 2, `${batch.length} 通 / ${turnEnds(p3, mark3).length} ターン`);
      t.ok('まとめた通知は件数の見出しと taskId ごとの節を持つ', batch[0].text.startsWith(`[${NOTICE} / 2 件]`)
        && rows.every(r => batch[0].text.includes(`--- ${r.taskId} ---`)), batch[0]?.text?.slice(0, 120));
    }

    // ---- 「渡った」合図を後から出すバックエンド（本物の claude / codex と同じ steerConfirms）と、受理されない場合
    {
      const { c, tasksOf, awaitTasks, noticesOf, turnEnds } = await boot({ AGENT_HOST_FAKE_STEER_CONFIRM_MS: '150' });

      // 渡った合図で通知の一行を出す。人間の発言（userMessage）にはしない
      const p4 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 1.5') })).sessionId;
      const mark4 = c.mark();
      const running4 = c.runTurn({ sessionId: p4, prompt: 'bg 1 6' });
      const rows4 = await awaitTasks(p4, rows => rows[0]?.notification === 'sent');
      await c.waitFor(e => e.type === 'taskNotice' && e.sessionId === p4, { from: mark4, ms: 10000 });
      t.ok('渡った合図で通知の一行を 1 回出す（人間の発言にしない）', noticesOf(p4, mark4).length === 1
        && !c.since(mark4).some(e => e.type === 'userMessage' && e.sessionId === p4), rows4[0].taskId);
      await running4;
      await sleep(1200);
      t.ok('渡った通知は新しいターンで送り直さない', turnEnds(p4, mark4).length === 1 && noticesOf(p4, mark4).length === 1);

      // 受理されない（steer が false）: 空いた後の新しいターンで届く
      const p5 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 1.5 DECLINE_STEER') })).sessionId;
      const mark5 = c.mark();
      const running5 = c.runTurn({ sessionId: p5, prompt: 'bg 1 6' });
      let rows = await awaitTasks(p5, rows => rows[0]?.status === 'completed');
      await sleep(1500);
      rows = await tasksOf(p5);
      t.ok('途中送信が受理されない間は pending のまま、ターンの中には届かない', rows[0].notification === 'pending' && noticesOf(p5, mark5).length === 0 && turnEnds(p5, mark5).length === 0);
      await running5;
      await awaitTasks(p5, rows => rows[0]?.notification === 'sent');
      await c.waitFor(e => e.type === 'taskNotice' && e.sessionId === p5, { from: mark5, ms: 20000 });
      await sleep(600);
      t.ok('空いた後の新しいターンで届く（今までの経路）', noticesOf(p5, mark5).length === 1 && turnEnds(p5, mark5).length === 2, `${turnEnds(p5, mark5).length} ターン`);
    }
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
