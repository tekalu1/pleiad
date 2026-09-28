// 返答前のコマンドは知らせるだけ。報告後の裏の作業は待機上限で片付け、完了通知を届ける。
// fake バックエンドでサーバー全体を通す（LLM は呼ばない）。
//   - "bg-shell": Claude で、裏へ回ったコマンドが終わらず main だけが止まった形（phase: waiting のままターンが続く）。
//     2026-09-27 に、Claude の子が報告を書き終えた後も running のまま残り、依頼元に通知が届かなかった（docs/agent-delegation.md「子に残った裏の作業」）
//   - "active-shell": main が返答前で、コマンドの結果を待っている形。上限を過ぎても自動停止しない
//   - "bg": 裏のサブエージェント。自分で終わるので止めない
//   - "term": Codex のバックグラウンド端末（ターンの外に残る。終わっても main は再開しない）。子にも親にも残る形
//   - "hook-follow": 報告の後に Stop フックが続けさせ、調べものだけして一言書いた形。結果と通知は報告（docs/agent-delegation.md「子の結果」）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-background';
export const title = '委譲の子の終わり方: 報告後は裏のコマンドを片付け、返答前は通知だけ（コマンド・サブエージェント・端末）・Stop フックの続きの一言を結果にしない';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const WAIT_MS = 1500;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-bg-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_TASK_COMMAND_MINUTES: '0.01', AGENT_HOST_TASK_SILENCE_MINUTES: '0', AGENT_HOST_DELEGATION_BACKGROUND_WAIT_MS: String(WAIT_MS) } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const taskOf = async (taskId) => (await c.cmd('agentTasks')).find((r) => r.taskId === taskId);
  const until = async (fn, ms = 30000) => {
    const deadline = Date.now() + ms;
    for (;;) { const v = await fn(); if (v || Date.now() > deadline) return v; await sleep(50); }
  };
  // 依頼元のターンの終わりは待たない（fake は返りの JSON を少しずつ流すので、その間に子が先へ進む）。
  // ツールの結果が届いた時点で返し、from（目印）も返す
  const delegate = async (task, sessionId) => {
    const from = c.mark();
    await c.cmd('runTurn', { ...(sessionId ? { sessionId } : { backend: 'fake', cwd: ROOT }), prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task }) });
    const ev = await c.waitFor((e) => e.type === 'tool.result' && String(e.text).includes('"taskId"'), { from, ms: 30000 });
    return { parent: ev.sessionId, task: JSON.parse(ev.text), from };
  };
  // その会話から Pleiad の MCP ツールを 1 回呼び、戻りの JSON を読む
  const callTool = async (sessionId, name, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(name, args) });
    const ev = await c.waitFor((e) => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 30000 });
    return JSON.parse(ev.text);
  };
  const notices = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages.filter((m) => m.internalTaskNotice);
  const phaseOf = async (sessionId) => (await c.cmd('running')).turns?.find((x) => x.sessionId === sessionId)?.phase;
  try {
    // ---- 1. 終わらない裏のコマンドを抱えたまま main が止まった子（Claude の形）
    {
      const { parent, task, from } = await delegate('bg-shell 子の報告: 作業を終えた');
      await c.waitFor((e) => e.type === 'phase' && e.sessionId === task.sessionId && e.state === 'waiting', { from, ms: 20000 });
      const early = await taskOf(task.taskId);
      t.ok('報告直後は裏のコマンドと台帳を残して待つ', early.status === 'running' && early.activeCommands.length === 1);
      const done = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' ? r : null; });
      t.ok('報告後の待機上限で片付け、子をcompletedにする', done?.status === 'completed');
      t.ok('停止前の報告と再開後の一言を結果に残す', done?.result.includes('子の報告: 作業を終えた') && done.result.includes('裏のコマンドが止められた'));
      t.ok('止めた作業を記録し、コマンド台帳を閉じる', done?.stoppedBackground?.[0]?.label === 'cat >> /dev/null' && done.activeCommands.length === 0);
      const received = (await notices(parent)).filter(m => m.text.includes('Pleiad タスク完了通知'));
      t.ok('完了通知は一度だけで、止めた作業と報告を載せる', received.length === 1 && received[0].text.includes('cat >> /dev/null')
        && received[0].text.includes('止めました') && received[0].text.includes('子の報告: 作業を終えた'));
      await until(async () => !(await c.cmd('running')).turns?.some(r => r.sessionId === parent));
      await callTool(parent, 'ply_task_send', { taskId: task.taskId, message: 'echo:FOLLOWUP_DONE' });
      const next = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' && r.result === 'FOLLOWUP_DONE' ? r : null; });
      t.ok('次の回で止めた作業がなければ前回の停止記録を消す', next && !next.stoppedBackground);
    }

    // main がまだコマンドの結果を待っている子。backgroundでも報告前なら片付けない。
    {
      const { parent, task, from } = await delegate('active-shell');
      await c.waitFor(e => e.type === 'phase' && e.sessionId === task.sessionId && e.state === 'active', { from, ms: 20000 });
      await sleep(WAIT_MS + 500);
      const running = await taskOf(task.taskId);
      t.ok('返答前のコマンドは片付けの上限を過ぎても止めない', running?.status === 'running' && running.activeCommands.length === 1
        && !running.stoppedBackground && (await phaseOf(task.sessionId)) === 'active');
      const notice = await until(async () => (await notices(parent)).find(m => m.text.includes('Pleiad コマンド長時間通知')));
      t.ok('返答前にはコマンドの時間通知だけが届く', notice?.text.includes('cat >> /dev/null') && !(await notices(parent)).some(m => m.text.includes('Pleiad タスク完了通知')));
      await until(async () => !(await c.cmd('running')).turns?.some(r => r.sessionId === parent));
      await callTool(parent, 'ply_task_cancel', { taskId: task.taskId });
      t.ok('返答前のコマンドは親が明示的に取り消せる', await until(async () => (await taskOf(task.taskId))?.status === 'cancelled'));
    }

    // 通常の会話では、報告後のwaitingにも片付けの時計を設けない。
    {
      const from = c.mark();
      await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: 'bg-shell 通常の会話の報告' });
      const ev = await c.waitFor(e => e.type === 'phase' && e.state === 'waiting', { from, ms: 10000 });
      await sleep(WAIT_MS + 500);
      t.ok('ユーザーの会話は報告後も自動停止しない', (await phaseOf(ev.sessionId)) === 'waiting');
      await c.cmd('abort', { sessionId: ev.sessionId });
      await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === ev.sessionId, { from, ms: 10000 });
    }

    // ---- 2. 裏のサブエージェントは止めない（自分で終わる）
    {
      const { task } = await delegate('bg 1 3');
      const done = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' ? r : null; });
      t.ok('上限を過ぎてもサブエージェントは止めず、終わるのを待って completed', done?.status === 'completed' && !done.stoppedBackground
        && done.result === 'サブエージェント 1 が終わった', JSON.stringify({ status: done?.status, result: done?.result, stopped: done?.stoppedBackground }));
    }

    // ---- 3. 端末（Codex の形）。子に残っても、親に残っていても止まらない
    {
      const { task } = await delegate('term 子の報告: 端末を残して終えた');
      const done = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' ? r : null; }, 15000);
      t.ok('子に端末が残っていても completed になり通知される（端末は終わっても main が再開しないので待たない）',
        done?.status === 'completed' && done.result === '子の報告: 端末を残して終えた', JSON.stringify({ status: done?.status, notification: done?.notification }));
      const running = await c.cmd('running');
      t.ok('子の端末はそのまま残す（止めない）', running.background?.some((b) => b.sessionId === task.sessionId && b.tasks.some((x) => x.kind === 'terminal')));

      await until(async () => (await notices(task.parentSessionId)).some(m => m.text.includes('Pleiad コマンド長時間通知')));
      await until(async () => !(await c.cmd('running')).turns?.some(r => r.sessionId === task.parentSessionId));
      await callTool(task.parentSessionId, 'ply_task_cancel', { taskId: task.taskId });
      t.ok('ターン外の終了で台帳も閉じる', await until(async () => !(await taskOf(task.taskId)).activeCommands.length));

      const mark = c.mark();
      await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: 'term 親の端末' });
      const parent = (await c.waitFor((e) => e.type === 'session' && e.sessionId, { from: mark, ms: 10000 })).sessionId;
      await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === parent, { from: mark, ms: 10000 });
      t.ok('親の会話に端末が残っている', (await c.cmd('running')).background?.some((b) => b.sessionId === parent));
      const { task: second } = await delegate('echo:CHILD_OF_TERMINAL_PARENT', parent);
      const sent = await until(async () => { const r = await taskOf(second.taskId); return r?.notification === 'sent' ? r : null; }, 15000);
      t.ok('親に端末が残っていても完了通知が届く', sent?.status === 'completed' && (await notices(parent)).some((m) => m.text.includes(second.taskId)),
        JSON.stringify({ status: sent?.status, notification: sent?.notification }));
    }

    // ---- 4. 報告の後に Stop フックが続けさせた一言は結果にしない
    {
      const { parent, task } = await delegate('hook-follow 子の報告: デザインを直した');
      const done = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' ? r : null; }, 15000);
      t.ok('結果は報告（Stop フックの続きの「ナレッジ化対象なし」ではない）', done?.status === 'completed' && done.result === '子の報告: デザインを直した', JSON.stringify({ status: done?.status, result: done?.result }));
      const child = await c.cmd('loadSession', { sessionId: task.sessionId });
      t.ok('子の会話には続きの一言も残る（印付き）', child.messages.at(-1)?.text === 'ナレッジ化対象なし' && child.messages.at(-1)?.stopHookFollowUp === true);
      const text = (await notices(parent))[0]?.text ?? '';
      t.ok('完了通知の結果も報告', text.includes('子の報告: デザインを直した') && !text.includes('ナレッジ化対象なし'), text.slice(0, 300));
    }
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
