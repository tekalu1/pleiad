// 委譲の子が返答を終えた後も裏の作業が残るとき、タスクが running のまま残らず、依頼元へ完了通知が届くこと。
// fake バックエンドでサーバー全体を通す（LLM は呼ばない）。
//   - "bg-shell": Claude で、裏へ回ったコマンドが終わらず main だけが止まった形（phase: waiting のままターンが続く）。
//     2026-09-27 に、Claude の子が報告を書き終えた後も running のまま残り、依頼元に通知が届かなかった（docs/agent-delegation.md「子に残った裏の作業」）
//   - "bg": 裏のサブエージェント。自分で終わるので止めない
//   - "term": Codex のバックグラウンド端末（ターンの外に残る。終わっても main は再開しない）。子にも親にも残る形
//   - "hook-follow": 報告の後に Stop フックが続けさせ、調べものだけして一言書いた形。結果と通知は報告（docs/agent-delegation.md「子の結果」）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-background';
export const title = '委譲の子の終わり方: 裏の作業が残っても完了して通知が届く（コマンド・サブエージェント・端末）・Stop フックの続きの一言を結果にしない';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const WAIT_MS = 1500;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-bg-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_DELEGATION_BACKGROUND_WAIT_MS: String(WAIT_MS) } });
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
      const waitedAt = Date.now();
      t.ok('子のターンは main が止まっても裏のコマンドを待ち続ける（phase: waiting）', (await phaseOf(task.sessionId)) === 'waiting');
      const early = await taskOf(task.taskId);
      t.note(`waiting を見てから状態を読むまで ${Date.now() - waitedAt}ms（上限 ${WAIT_MS}ms）`);
      t.ok('待つ上限の前は running のまま（正当に待っている裏のコマンドを先回りして止めない）', early?.status === 'running' && !early.stoppedBackground, JSON.stringify({ status: early?.status }));
      const done = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' ? r : null; });
      t.ok('上限を過ぎると裏のコマンドを止めて completed になる（running のまま残らない）', done?.status === 'completed', JSON.stringify({ status: done?.status, notification: done?.notification }));
      t.ok('結果に止める前の報告が残る（止めた後の main の一言で上書きされない）',
        done?.result?.includes('子の報告: 作業を終えた') && done.result.includes('裏のコマンドが止められた'), JSON.stringify(done?.result));
      t.ok('止めた裏の作業をタスクに記録する', done?.stoppedBackground?.length === 1 && done.stoppedBackground[0].kind === 'shell'
        && done.stoppedBackground[0].label === 'cat >> /dev/null', JSON.stringify(done?.stoppedBackground));
      const got = await until(async () => { const list = await notices(parent); return list.length ? list : null; }, 10000);
      const text = got?.[0]?.text ?? '';
      t.ok('依頼元へ完了通知が 1 回届き、止めた裏のコマンドを伝える', got?.length === 1 && text.includes(task.taskId) && text.includes('子の報告: 作業を終えた')
        && text.includes('cat >> /dev/null') && text.includes('止めました'), text.slice(0, 400));
      const status = await callTool(parent, 'ply_task_status', { taskId: task.taskId });
      t.ok('ply_task_status にも止めた裏の作業が載る', status.status === 'completed' && status.stoppedBackground?.[0]?.label === 'cat >> /dev/null', JSON.stringify({ status: status.status, stoppedBackground: status.stoppedBackground }));
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
