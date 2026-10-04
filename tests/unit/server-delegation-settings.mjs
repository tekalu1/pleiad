// 依頼元が委譲した子の設定（エージェント・モデル・思考の強さ）を ply_task_send で替える（ADR 0135、docs/agent-delegation.md「ツール」）。
// fake・身代わりの Codex・身代わりの agy でサーバー全体を通す。LLM は呼ばない
//   - 走っている子: モデルは今のターンへ即時に伝わり、思考の強さは次のターンから。ターンは止めない
//   - message なしで設定だけ・message と一緒に
//   - 無いモデル・選べない思考の強さは断り、何も変えない
//   - 走っていない子のエージェントを替える: 次のターンで引き継ぎ（履歴を渡す）、完了した子を勝手に走らせない
//   - 親より緩くなる切り替え（agy は全部自動）は親の会話で 1 回聞く。断ったら何も変えない
//   - 他の会話のタスクは変えられない
//   - 記録: 子の会話の変更の記録（by: agent・via・bySession）、タスクの backend・model・effort・routing.changed、agentTaskChanged
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-settings';
export const title = '委譲した子のエージェント・モデル・思考の強さを依頼元が ply_task_send で替える';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-settings-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake,codex,antigravity',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`,
    AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"` } });
  const permissions = [];
  let allow = true;
  const c = await open({ port: server.port, token: server.token, onEvent: async (ev, api) => {
    if (ev.type !== 'permission') return;
    permissions.push(ev);
    await api.cmd('resolvePermission', { id: ev.id, allow }).catch(() => {});
  } });
  const tasks = async () => c.cmd('agentTasks');
  const awaitTask = async (taskId, fn, what = '') => {
    const deadline = Date.now() + 60_000;
    let row;
    while (Date.now() < deadline) { row = (await tasks()).find(r => r.taskId === taskId); if (row && fn(row)) return row; await sleep(50); }
    throw new Error(`task timeout ${what}: ` + JSON.stringify(row && { status: row.status, backend: row.backend, model: row.model, effort: row.effort, notification: row.notification, error: row.error }));
  };
  // その会話から ply_agents のツールを 1 回呼び、戻り（エラーなら { error }）を読む
  const call = async (sessionId, name, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(name, args) });
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60000 });
    return ev.isError ? { error: ev.text } : JSON.parse(ev.text);
  };
  // 変更の記録は AI の口（ply_control の sessions.changes。via・bySession を含む形）で読む。画面の形は via・bySession を載せない
  let reader = null;
  const changes = async sessionId => {
    const turn = await c.runTurn({ ...(reader ? { sessionId: reader } : { backend: 'fake', cwd: ROOT }),
      prompt: 'control:' + JSON.stringify({ name: 'call_op', arguments: { op: 'sessions.changes', args: { sessionId, limit: 50 } } }) });
    reader = turn.sessionId;
    const got = JSON.parse(turn.events.find(e => e.type === 'tool.result').text);
    return (got.result ?? got).changes ?? [];
  };
  // 依頼元へ完了通知が届き、依頼元のターンが終わるまで待つ（その間に依頼元で次のターンを始めない）
  const settle = async taskId => {
    await awaitTask(taskId, r => !['queued', 'running', 'cancelling'].includes(r.status) && !['none', 'pending', 'delivering'].includes(r.notification), 'settle');
    for (let i = 0; i < 200 && (await c.cmd('running')).turns.some(x => x.sessionId === parent); i++) await sleep(50);
  };
  let parent;
  const row = async sessionId => (await c.cmd('listSessions')).find(s => s.id === sessionId);
  try {
    // ---- 走っている子（台本 slow）。モデルと思考の強さを替える
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', model: 'smart', task: 'slow' }) });
    parent = first.sessionId;
    const slow = JSON.parse(first.events.find(e => e.type === 'tool.result').text);
    await awaitTask(slow.taskId, r => r.status === 'running', 'slow running');
    for (let i = 0; i < 100 && !(await c.cmd('running')).turns.some(x => x.sessionId === slow.sessionId); i++) await sleep(50);
    const mark = c.mark();
    const live = await call(parent, 'ply_task_send', { taskId: slow.taskId, model: 'fast', effort: 'high' });
    t.ok('message なしで設定だけ替えられ、新しい値を返す', !live.error && live.settings?.backend === 'fake' && live.settings.model === 'fast' && live.settings.effort === 'high'
      && live.settings.appliesTo === 'nextTurn' && live.model === 'fast' && live.effort === 'high', JSON.stringify(live).slice(0, 400));
    t.ok('走っている子のモデルは、できるエージェントなら今のターンへ即時に伝わる', live.settings?.modelLive === true, JSON.stringify(live.settings));
    let slowRow = (await tasks()).find(r => r.taskId === slow.taskId);
    t.ok('子のターンは止めない（設定だけでは追加の指示も積まない）', slowRow.status === 'running' && (await c.cmd('running')).turns.some(x => x.sessionId === slow.sessionId)
      && (slowRow.instructions ?? []).length === 0, slowRow.status);
    t.ok('タスクの記録が新しい値になり、routing に依頼元が替えた印が残る', slowRow.model === 'fast' && slowRow.effort === 'high'
      && slowRow.routing?.changed?.by === 'parent' && slowRow.routing.changed.from?.model === 'smart' && slowRow.routing.target?.model === 'fast', JSON.stringify(slowRow.routing));
    const slowChild = await row(slow.sessionId);
    t.ok('思考の強さは子の次のターンからの予約（nextSettings）。モデルはもう子の会話のもの', slowChild.model === 'fast' && slowChild.nextSettings?.effort === 'high', JSON.stringify({ model: slowChild.model, next: slowChild.nextSettings }));
    const logged = await changes(slow.sessionId);
    const byParent = logged.filter(x => x.by === 'agent' && x.via === 'mcp' && x.bySession === parent);
    t.ok('子の会話の変更の記録に、依頼元の AI が変えたこと（by・via・bySession）が残る', ['model', 'effort'].every(f => byParent.some(x => x.field === f))
      && byParent.find(x => x.field === 'model').from === 'smart' && byParent.find(x => x.field === 'model').to === 'fast' && byParent.find(x => x.field === 'effort').to === 'high', JSON.stringify(logged));
    t.ok('画面にはタスクが変わったことを知らせる', c.since(mark).some(e => e.type === 'agentTaskChanged' && e.taskId === slow.taskId));

    // ---- 無いモデル・選べない思考の強さは断り、何も変えない
    const unknown = await call(parent, 'ply_task_send', { taskId: slow.taskId, model: 'no-such-model' });
    t.ok('今の一覧に無いモデルは model_unknown で断る', String(unknown.error ?? '').includes('model_unknown') && String(unknown.error).includes('fast'), unknown.error);
    const badEffort = await call(parent, 'ply_task_send', { taskId: slow.taskId, model: 'tiny', effort: 'high' });
    t.ok('そのモデルで選べない思考の強さは断る', Boolean(badEffort.error), JSON.stringify(badEffort));
    slowRow = (await tasks()).find(r => r.taskId === slow.taskId);
    t.ok('断ったときはタスクも子の会話も変えない', slowRow.model === 'fast' && slowRow.effort === 'high' && (await row(slow.sessionId)).model === 'fast'
      && (await changes(slow.sessionId)).length === logged.length, JSON.stringify({ model: slowRow.model, effort: slowRow.effort }));

    // ---- 他の会話のタスクは変えられない
    const stranger = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_task_send', { taskId: slow.taskId, model: 'smart' }) });
    t.ok('自分が委譲していないタスクは断る', stranger.events.some(e => e.type === 'tool.result' && e.isError));
    t.ok('断ったタスクは変わらない', (await tasks()).find(r => r.taskId === slow.taskId).model === 'fast');
    await call(parent, 'ply_task_cancel', { taskId: slow.taskId });
    await awaitTask(slow.taskId, r => r.status === 'cancelled', 'slow cancelled');
    await settle(slow.taskId);

    // ---- 走っていない子のエージェントを替える（fake → Codex）。次のターンで引き継ぐ
    const made = await call(parent, 'ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ONE' });
    await settle(made.taskId);
    const switched = await call(parent, 'ply_task_send', { taskId: made.taskId, backend: 'codex' });
    let done = (await tasks()).find(r => r.taskId === made.taskId);
    t.ok('完了した子のエージェントを替えても、勝手に走らせない', !switched.error && done.status === 'completed' && done.backend === 'codex'
      && switched.settings?.backend === 'codex' && done.routing?.changed?.from?.backend === 'fake', JSON.stringify(switched).slice(0, 300));
    let child = await row(made.sessionId);
    t.ok('子の会話はまだ元のエージェントで、次のターンの予約に入る', child.backend === 'fake' && child.nextSettings?.backend === 'codex', JSON.stringify({ backend: child.backend, next: child.nextSettings }));
    t.ok('エージェントを替えたことも子の会話の変更の記録に残る', (await changes(made.sessionId)).some(x => x.field === 'backend' && x.from === 'fake' && x.to === 'codex' && x.by === 'agent' && x.bySession === parent));
    t.ok('親の強さに収まる切り替えは聞かない', permissions.length === 0, permissions.map(p => p.title).join(' / '));
    await call(parent, 'ply_task_send', { taskId: made.taskId, message: 'echo:TWO' });
    await settle(made.taskId);
    done = (await tasks()).find(r => r.taskId === made.taskId);
    child = await row(made.sessionId);
    const history = await c.cmd('loadSession', { sessionId: made.sessionId });
    t.ok('次のターンは切り替え先で走り、会話の履歴を引き継ぐ', child.backend === 'codex' && !child.nextSettings && done.backend === 'codex'
      && history.messages.some(m => m.role === 'user' && String(m.text).includes('echo:ONE')), JSON.stringify({ backend: child.backend, status: done.status, error: done.error }));

    // ---- message と一緒に替える
    const both = await call(parent, 'ply_task_send', { taskId: made.taskId, message: 'echo:THREE', backend: 'fake', model: 'fast' });
    t.ok('message と一緒に替えると、指示を積み、設定も返す', !both.error && both.settings?.backend === 'fake' && both.settings.model === 'fast' && both.pendingMessages >= 0, JSON.stringify(both).slice(0, 300));
    await settle(made.taskId);
    done = (await tasks()).find(r => r.taskId === made.taskId);
    child = await row(made.sessionId);
    t.ok('戻した先（fake）で、指定したモデルで走る', child.backend === 'fake' && child.model === 'fast' && done.backend === 'fake' && done.model === 'fast', JSON.stringify({ backend: child.backend, model: child.model }));

    // ---- 親より緩くなる切り替え（agy は全部自動）。親の会話で 1 回聞く
    allow = false;
    const denied = await call(parent, 'ply_task_send', { taskId: made.taskId, backend: 'antigravity' });
    // 子（Codex の ask）のコマンドの承認も親へ中継されて数に入るので、ply_task_send の承認だけを数える
    const asked = () => permissions.filter(p => p.toolName === 'ply_task_send');
    t.ok('親より緩くなる切り替えは親の会話で聞き、断ったら失敗する', Boolean(denied.error) && asked().length === 1
      && String(asked()[0].title ?? '').includes('Antigravity'), JSON.stringify({ denied, titles: permissions.map(p => p.title) }));
    done = (await tasks()).find(r => r.taskId === made.taskId);
    t.ok('断ったら何も変えない', done.backend === 'fake' && !(await row(made.sessionId)).nextSettings, JSON.stringify({ backend: done.backend }));
    allow = true;
    const agy = await call(parent, 'ply_task_send', { taskId: made.taskId, backend: 'antigravity' });
    done = (await tasks()).find(r => r.taskId === made.taskId);
    t.ok('許可すれば替わり、子の承認モードは委譲と同じ規則で決まる（agy は yolo）', !agy.error && asked().length === 2 && done.backend === 'antigravity' && done.mode === 'yolo'
      && (await row(made.sessionId)).nextSettings?.mode === 'yolo', JSON.stringify({ agy: agy.error, backend: done.backend, mode: done.mode }));
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
}
