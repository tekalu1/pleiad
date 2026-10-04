import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'server-delegation-steer';
export const title = '委譲の追加指示（ply_task_send）: 走っている子のターンへ途中送信で渡す・受理されない/結果不明/捨てられた/合図なしは待機か未配送（fake）';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-steer-'));
  const servers = [], clients = [];
  const boot = async env => {
    const dataDir = await fs.mkdtemp(path.join(scratch, 'data-'));
    const gates = await createFakeGates(scratch);
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', ...gates.env, ...env }, dataDir });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    servers.push(server); clients.push(c);
    const tasksOf = async parent => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent);
    const awaitTask = async (parent, fn, ms = 60_000) => {
      const end = Date.now() + ms; let rows;
      while (Date.now() < end) { rows = await tasksOf(parent); if (rows[0] && fn(rows[0])) return rows[0]; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(rows.map(({ task, status, notification }) => ({ task, status, notification }))));
    };
    // 子（bg 台本）を依頼元ごとに 1 つ作り、子のターンが待ちに入る（途中送信を受けられる）まで進める。
    // 子は finish() でゲートを開くまで終わらない。終わらせるのは、場面で見たい状態を見終えてから
    const child = async (gate, { after } = {}) => {
      const mark = c.mark();
      const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate(`bg 1 gate:${gate}`) })).sessionId;
      const task = await awaitTask(parent, r => r.status === 'running');
      await c.waitFor(e => e.type === 'phase' && e.sessionId === task.sessionId && e.state === 'waiting', { from: mark, ms: 30000 });
      await after?.(task);
      return { parent, task, mark, finish: () => gates.open(gate) };
    };
    const send = (parent, task, message) => c.runTurn({ sessionId: parent, prompt: ply('ply_task_send', { taskId: task.taskId, message }) });
    const instructions = async task => (await c.cmd('agentTaskInstructions', { taskId: task.taskId })).instructions;
    const stateOf = async task => (await instructions(task)).map(x => `${x.text}:${x.state}`).join();
    // サーバーが合図（イベント）を受けて状態を書き換えるのは、イベントが届いた後。その状態になるまで待つ
    const awaitState = async (task, want, ms = 10_000) => {
      const end = Date.now() + ms; let now;
      while (Date.now() < end) { now = await stateOf(task); if (now === want) return now; await sleep(20); }
      return now;
    };
    // 結果が確定し、完了通知が依頼元へ届き終わるまで（これ以降は新しいターンを起こす仕事が残っていない）
    const settled = (parent, fn = () => true) => awaitTask(parent, r => r.status === 'completed' && r.notification === 'sent' && fn(r));
    const turnEnds = (task, from) => c.since(from).filter(e => e.type === 'turnEnd' && e.sessionId === task.sessionId);
    const events = (task, from, type) => c.since(from).filter(e => e.type === type && e.sessionId === task.sessionId);
    const userTexts = async task => (await c.cmd('loadSession', { sessionId: task.sessionId })).messages.filter(m => m.role === 'user').map(m => m.text);
    return { c, gates, awaitTask, settled, child, send, instructions, stateOf, awaitState, turnEnds, events, userTexts };
  };
  try {
    // ---- 「渡った」合図を持たないバックエンド（fake の既定）
    {
      const { c, awaitTask, settled, child, send, stateOf, turnEnds, events, userTexts } = await boot({});

      // 走っている子へ渡す: 同じターンに入り、その場で配送済み。新しいターンは走らない
      const a = await child('a');
      const markA = c.mark();
      await send(a.parent, a.task, 'echo:STEER_A');
      t.ok('走っている子には途中送信で渡り、その場で配送済みになる', await stateOf(a.task) === 'echo:STEER_A:delivered');
      const um = events(a.task, markA, 'userMessage');
      t.ok('子の会話に通常の user 発言として出る（送信待ちにも「まだ渡っていない」にもしない）',
        um.length === 1 && um[0].text === 'echo:STEER_A' && um[0].messageId.startsWith('task-send-') && !um[0].pending, JSON.stringify(um));
      await a.finish();
      const doneA = await settled(a.parent);
      t.ok('同じターンの中で答え、新しいターンは走らない', turnEnds(a.task, a.mark).length === 1 && doneA.pendingMessages === 0);
      const historyA = await c.cmd('loadSession', { sessionId: a.task.sessionId });
      t.ok('子の履歴に指示と、その場の返答が並ぶ', historyA.messages.some(m => m.role === 'user' && m.text === 'echo:STEER_A')
        && historyA.messages.some(m => m.role === 'assistant' && m.text.includes('受け取った: echo:STEER_A')));
      t.ok('完了通知は 1 回', (await c.cmd('agentTasks')).find(r => r.taskId === a.task.taskId).notification === 'sent');

      // 受理されない（DECLINE_STEER）: 待機のまま、次のターンで 1 回
      const b = await child('b');
      const outB = JSON.parse((await send(b.parent, b.task, 'echo:LATER DECLINE_STEER').then(r => r.events.find(e => e.type === 'tool.result'))).text);
      t.ok('受理されなければ待機（queued）で、依頼元には待機件数が見える', await stateOf(b.task) === 'echo:LATER DECLINE_STEER:queued' && outB.pendingMessages === 1);
      await b.finish();
      const doneB = await awaitTask(b.parent, r => r.result === 'LATER DECLINE_STEER' && r.status === 'completed');
      t.ok('次のターンで 1 回だけ配送する', turnEnds(b.task, b.mark).length === 2 && await stateOf(b.task) === 'echo:LATER DECLINE_STEER:delivered'
        && (await userTexts(b.task)).filter(x => x.includes('LATER')).length === 1, doneB.status);

      // 結果不明（THROW_STEER）: 送り直さない（未配送で残す）
      const cth = await child('cth');
      const outTh = JSON.parse((await send(cth.parent, cth.task, 'echo:THROWN THROW_STEER').then(r => r.events.find(e => e.type === 'tool.result'))).text);
      t.ok('結果不明は未配送（dropped）で残し、待機にしない。依頼元には確かめるよう一言添える', await stateOf(cth.task) === 'echo:THROWN THROW_STEER:dropped'
        && outTh.pendingMessages === 0 && typeof outTh.warning === 'string');
      await cth.finish();
      await settled(cth.parent);
      t.ok('自動で送り直さない', turnEnds(cth.task, cth.mark).length === 1 && !(await userTexts(cth.task)).some(x => x.includes('THROWN')));

      // 次ターンの設定が予約されている子は、途中送信を断る（完了通知と同じ）
      const d = await child('d');
      await c.cmd('setTurnSettings', { sessionId: d.task.sessionId, backend: 'fake', model: 'fast' });
      await send(d.parent, d.task, 'echo:NEXT');
      t.ok('次ターンの設定が予約されていれば待機する', await stateOf(d.task) === 'echo:NEXT:queued', await stateOf(d.task));
      await d.finish();
      await awaitTask(d.parent, r => r.status === 'completed' && r.result === 'NEXT');
    }

    // ---- 「渡った」合図を後から出すバックエンド（本物の claude / codex と同じ steerConfirms）
    // 受理から渡るまでの間は時間でなく、HOLD_CONFIRM のゲートで決める。それ以外の合図は即（20ms）出す
    {
      const { c, gates, awaitTask, settled, child, send, stateOf, awaitState, turnEnds, events, userTexts } = await boot({ AGENT_HOST_FAKE_STEER_CONFIRM_MS: '20' });

      // 受理 → 合図まで送信中 → 渡った
      const e1 = await child('e1');
      const mark1 = c.mark();
      const held = 'echo:CONFIRMED HOLD_CONFIRM:e1-confirm';
      await send(e1.parent, e1.task, held);
      t.ok('受理しただけでは送信中（sending）。画面は pending で出す', await stateOf(e1.task) === `${held}:sending`
        && events(e1.task, mark1, 'userMessage').some(e => e.pending === true && e.messageId.startsWith('task-send-')), await stateOf(e1.task));
      t.ok('合図の前には、渡ったとも捨てられたとも言わない', events(e1.task, mark1, 'userMessage.delivered').length === 0 && events(e1.task, mark1, 'userMessage.dropped').length === 0);
      await gates.open('e1-confirm');
      await c.waitFor(e => e.type === 'userMessage.delivered' && e.sessionId === e1.task.sessionId, { from: mark1, ms: 10000 });
      t.ok('渡った合図で配送済みになる', await awaitState(e1.task, `${held}:delivered`) === `${held}:delivered`);
      await e1.finish();
      await settled(e1.parent);
      t.ok('新しいターンは走らない', turnEnds(e1.task, e1.mark).length === 1);

      // 読まれずに捨てられた（userMessage.dropped）: 待機へ戻り、次のターンで 1 回だけ
      const e2 = await child('e2');
      const mark2 = c.mark();
      await send(e2.parent, e2.task, 'echo:DROPPED DROP_STEER');
      await c.waitFor(e => e.type === 'userMessage.dropped' && e.sessionId === e2.task.sessionId, { from: mark2, ms: 10000 });
      t.ok('捨てられたら待機（queued）へ戻る', await awaitState(e2.task, 'echo:DROPPED DROP_STEER:queued') === 'echo:DROPPED DROP_STEER:queued');
      await e2.finish();
      await awaitTask(e2.parent, r => r.status === 'completed' && r.result === 'DROPPED DROP_STEER');
      t.ok('次のターンで 1 回だけ配送する', turnEnds(e2.task, e2.mark).length === 2 && await stateOf(e2.task) === 'echo:DROPPED DROP_STEER:delivered'
        && (await userTexts(e2.task)).filter(x => x.includes('DROPPED')).length === 1);

      // 合図が来ないままターンが終わった: 待機へ戻り、次のターンで 1 回だけ。画面の発言は下げる
      const e3 = await child('e3');
      const mark3 = c.mark();
      await send(e3.parent, e3.task, 'echo:SILENT SILENT_STEER');
      t.ok('合図が来るまでは送信中', await awaitState(e3.task, 'echo:SILENT SILENT_STEER:sending') === 'echo:SILENT SILENT_STEER:sending');
      await e3.finish();
      await awaitTask(e3.parent, r => r.status === 'completed' && r.result === 'SILENT SILENT_STEER');
      t.ok('合図なしでターンが終わったら、次のターンで 1 回だけ配送する', turnEnds(e3.task, e3.mark).length === 2 && await stateOf(e3.task) === 'echo:SILENT SILENT_STEER:delivered'
        && (await userTexts(e3.task)).filter(x => x.includes('SILENT')).length === 1);
      t.ok('渡っていない発言は画面から下げる（userMessage.dropped）', events(e3.task, mark3, 'userMessage.dropped').length === 1);
    }
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
