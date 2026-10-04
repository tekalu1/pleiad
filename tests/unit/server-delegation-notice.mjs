import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates, fakeSignal } from '../lib/fake-gate.mjs';

export const name = 'server-delegation-notice';
export const title = '委譲の完了通知: 走っているターンへ途中送信で届ける・受け取り済みは送らない・複数は 1 つにまとめる（fake）';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });
const NOTICE = 'Pleiad タスク完了通知';
// サーバーは 500ms ごとに通知を見直す（core/agent-tasks.mjs の kick）。「後から新しいターンも通知も起きない」ことは、
// 見直しが 2〜3 回回る間だけ観察する。固定の bg のように子の終わりを待つ時間ではなく、起きないことの確認。
// 通知を試みた合図はサーバーの外から見えないので、状態やイベントでは代えられない
const NOTICE_RETRY_WINDOW_MS = 1200;
const NO_LATE_NOTICE_MS = { a: 1600, wait: 2000, p4: 1200, p5: 600 };

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-notice-'));
  const servers = [];
  const clients = [];
  const boot = async env => {
    const dataDir = await fs.mkdtemp(path.join(scratch, 'data-'));
    const gates = await createFakeGates(scratch);
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...gates.env, ...env }, dataDir });
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
    // 依頼元の直前のターンが終わり、そのとき保留の子の通知が無かった合図。後から別のターンが起きないことまでは表さない
    const idle = (sessionId, from) => c.waitFor(e => e.type === 'completionReady' && e.sessionId === sessionId, { from, ms: 30_000 });
    // 依頼元のターン（bg 台本）が途中送信を受けられる（phase: waiting）ようになるまで
    const listening = (sessionId, from) => c.waitFor(e => e.type === 'phase' && e.sessionId === sessionId && e.state === 'waiting', { from, ms: 30_000 });
    return { server, c, gates, tasksOf, awaitTasks, noticesOf, turnEnds, idle, listening };
  };
  try {
    // ---- 途中送信の「渡った」合図を持たないバックエンド（fake の既定。steerConfirms なし）
    {
      const { c, gates, tasksOf, awaitTasks, noticesOf, turnEnds, idle, listening } = await boot({});

      // A: 依頼元のターンが走っている間に子が終わったら、その場で今のターンへ届く（新しいターンにしない）
      const p1 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:a-child') })).sessionId;
      const mark1 = c.mark();
      const running1 = c.runTurn({ sessionId: p1, prompt: 'bg 1 gate:a-parent' });
      await listening(p1, mark1);
      await gates.open('a-child');
      let rows = await awaitTasks(p1, rows => rows[0]?.notification === 'sent');
      const child1 = rows[0];
      t.ok('依頼元のターンが走っている間に、完了通知が sent になる', turnEnds(p1, mark1).length === 0 && (await c.cmd('running')).turns.some(r => r.sessionId === p1));
      const live = noticesOf(p1, mark1);
      t.ok('通知の一行は 1 回だけ、taskId と結果を持つ', live.length === 1 && live[0].text.startsWith(`[${NOTICE} / ${child1.taskId}]`) && live[0].text.includes('状態: completed'), live[0]?.text?.slice(0, 80));
      t.ok('人間の吹き出し（userMessage）にも送信待ちにもしない', !c.since(mark1).some(e => e.type === 'userMessage' && e.sessionId === p1)
        && !c.since(mark1).some(e => e.type === 'outbox' && e.sessionId === p1 && e.messages?.length));
      await gates.open('a-parent');
      await running1;
      await idle(p1, mark1);
      await sleep(NO_LATE_NOTICE_MS.a);
      t.ok('依頼元のターンが終わっても、同じ完了通知の新しいターンは始まらない', turnEnds(p1, mark1).length === 1 && noticesOf(p1, mark1).length === 1);
      const loaded = await c.cmd('loadSession', { sessionId: p1 });
      const asNotice = loaded.messages.filter(m => m.internalTaskNotice);
      t.ok('履歴では通知として描き、人間の発言と区別する', asNotice.length === 1 && asNotice[0].text.includes(child1.taskId));
      t.ok('依頼元はターンの中で通知に答えている', loaded.messages.some(m => m.role === 'assistant' && m.text.includes('受け取った') && m.text.includes(child1.taskId)));
      t.ok('OS の完了通知は依頼元のターンの終わりに 1 回', c.since(mark1).filter(e => e.type === 'completionReady' && e.sessionId === p1).length === 1);

      // B: ply_task_wait で結果を受け取ったら、あとから同じ完了の通知を送らない
      const p2 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:b-child') })).sessionId;
      const mark2 = c.mark();
      const waiting2 = c.runTurn({ sessionId: p2, prompt: ply('ply_task_wait', { taskId: (await tasksOf(p2))[0].taskId, seconds: 30 }) });
      // 待ちのツール呼び出しが始まってから、サーバーへ 1 往復して子を終わらせる（待ちの登録そのものは外から見えない。
      // 登録より先に終わっても、結果を受け取って通知が来ない（read）契約は同じ）
      await c.waitFor(e => e.type === 'tool.start' && e.sessionId === p2 && e.name === 'mcp__ply_agents__ply_task_wait', { from: mark2, ms: 30_000 });
      await c.cmd('agentTasks');
      await gates.open('b-child');
      const waited = await waiting2;
      const got = JSON.parse(waited.events.find(e => e.type === 'tool.result' && e.sessionId === p2).text);
      t.ok('依頼元は ply_task_wait で完了と結果を受け取る', got.status === 'completed');
      await idle(p2, mark2);
      await sleep(NO_LATE_NOTICE_MS.wait);
      const read = (await tasksOf(p2))[0];
      t.ok('受け取った結果の完了通知は届かない（read）', read.notification === 'read' && noticesOf(p2, mark2).length === 0 && turnEnds(p2, mark2).length === 1, read.notification);

      // C: 依頼元が通知を受けられない間（次ターンの設定を予約して途中送信を止める）に溜まった通知は、空いたとき 1 つにまとまる
      // 子は途中送信を止めた後に終わらせる（ゲートで決める。先に終わると走っているターンや前のターンへ届いてしまう）
      const p3 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:c-child-1') })).sessionId;
      await c.runTurn({ sessionId: p3, prompt: delegate('bg 1 gate:c-child-2') });
      const mark3 = c.mark();
      const running3 = c.runTurn({ sessionId: p3, prompt: 'bg 1 gate:c-parent' });
      await listening(p3, mark3);
      await c.cmd('setTurnSettings', { sessionId: p3, backend: 'fake', model: 'fast' });
      await gates.open('c-child-1');
      await gates.open('c-child-2');
      // 通知を試みた直後は delivering のことがある。予約により pending に戻るまで待つ。
      rows = await awaitTasks(p3, rows => rows.length === 2 && rows.every(r => r.status === 'completed' && r.notification === 'pending'));
      await sleep(NOTICE_RETRY_WINDOW_MS);
      rows = await tasksOf(p3);
      t.ok('途中送信を止めている間は、走っているターンへ通知しない', rows.every(r => r.notification === 'pending') && noticesOf(p3, mark3).length === 0
        && turnEnds(p3, mark3).length === 0);
      await gates.open('c-parent');
      await running3;
      rows = await awaitTasks(p3, rows => rows.every(r => r.notification === 'sent'));
      await idle(p3, mark3);
      const batch = noticesOf(p3, mark3);
      t.ok('空いたら 2 件が 1 つの通知（1 ターン）にまとまる', batch.length === 1 && turnEnds(p3, mark3).length === 2, `${batch.length} 通 / ${turnEnds(p3, mark3).length} ターン`);
      t.ok('まとめた通知は件数の見出しと taskId ごとの節を持つ', batch[0].text.startsWith(`[${NOTICE} / 2 件]`)
        && rows.every(r => batch[0].text.includes(`--- ${r.taskId} ---`)), batch[0]?.text?.slice(0, 120));
    }

    // ---- 「渡った」合図を後から出すバックエンド（本物の claude / codex と同じ steerConfirms）と、受理されない場合
    {
      const { server, c, gates, tasksOf, awaitTasks, noticesOf, turnEnds, idle, listening } = await boot({ AGENT_HOST_FAKE_STEER_CONFIRM_MS: '20' });

      // 渡った合図で通知の一行を出す。人間の発言（userMessage）にはしない
      const p4 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:p4-child') })).sessionId;
      const mark4 = c.mark();
      const running4 = c.runTurn({ sessionId: p4, prompt: 'bg 1 gate:p4-parent' });
      await listening(p4, mark4);
      await gates.open('p4-child');
      const rows4 = await awaitTasks(p4, rows => rows[0]?.notification === 'sent');
      await c.waitFor(e => e.type === 'taskNotice' && e.sessionId === p4, { from: mark4, ms: 10000 });
      t.ok('渡った合図で通知の一行を 1 回出す（人間の発言にしない）', noticesOf(p4, mark4).length === 1
        && !c.since(mark4).some(e => e.type === 'userMessage' && e.sessionId === p4), rows4[0].taskId);
      await gates.open('p4-parent');
      await running4;
      await idle(p4, mark4);
      await sleep(NO_LATE_NOTICE_MS.p4);
      t.ok('渡った通知は新しいターンで送り直さない', turnEnds(p4, mark4).length === 1 && noticesOf(p4, mark4).length === 1);

      // 受理されない（steer が false）: 空いた後の新しいターンで届く
      const p5 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:p5-child DECLINE_STEER') })).sessionId;
      const mark5 = c.mark();
      const running5 = c.runTurn({ sessionId: p5, prompt: 'bg 1 gate:p5-parent' });
      await listening(p5, mark5);
      await gates.open('p5-child');
      await awaitTasks(p5, rows => rows[0]?.status === 'completed');
      // サーバーが途中送信を試み、fake が受理しなかった合図を待つ（時間でなく、起きたことで待つ）
      await fakeSignal(server, 'steer-declined');
      const rows5 = await awaitTasks(p5, rows => rows[0]?.notification === 'pending');
      t.ok('途中送信が受理されない間は pending のまま、ターンの中には届かない', rows5[0].notification === 'pending' && noticesOf(p5, mark5).length === 0 && turnEnds(p5, mark5).length === 0);
      await gates.open('p5-parent');
      await running5;
      await awaitTasks(p5, rows => rows[0]?.notification === 'sent');
      await c.waitFor(e => e.type === 'taskNotice' && e.sessionId === p5, { from: mark5, ms: 20000 });
      await idle(p5, mark5);
      await sleep(NO_LATE_NOTICE_MS.p5);
      t.ok('空いた後の新しいターンで届く（今までの経路）', noticesOf(p5, mark5).length === 1 && turnEnds(p5, mark5).length === 2, `${turnEnds(p5, mark5).length} ターン`);
    }
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
