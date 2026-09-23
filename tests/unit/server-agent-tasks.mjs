import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
export const name = 'server-agent-tasks';
export const title = 'Pleiad MCP 経由の委譲から結果通知・子会話・停止まで';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-'));
  const home = path.join(scratch, 'home'); await fs.mkdir(home);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake,procway,antigravity', AGENT_HOST_PROCWAY_HOME: home,
    AGENT_HOST_PROCWAY_CODE: path.join(ROOT, 'tests/lib/fake-procway/cli.mjs'),
    AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"` }, dataDir: scratch });
  // 親より強い子を委譲するときは、親の会話で1回だけ承認カードが出る。
  // それを数えたうえで許可する（止まったままだと委譲が始まらない）。
  // 承認の中継を測る節では答えを保留する（hold）。それ以外は今までどおり即許可する
  const escalations = [];
  const held = new Map();
  let hold = false;
  const c = await open({ port: server.port, token: server.token, onEvent: async (ev, api) => {
    if (ev.type !== 'permission') return;
    if (hold) { held.set(ev.id, ev); return; }
    escalations.push(ev);
    await api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
  } });
  const awaitTasks = async fn => {
    // A cold Windows worker has a 30s startup budget; include that in the wait.
    const deadline = Date.now() + 60_000;
    let rows;
    while (Date.now() < deadline) { rows = await c.cmd('agentTasks'); if (fn(rows)) return rows; await sleep(50); }
    throw new Error('task timeout: ' + JSON.stringify(rows.map(({ backend, status, notification, error }) => ({ backend, status, notification, error }))));
  };
  // 承認の一覧が条件を満たすまで待つ。満たさないまま尽きたら false（t.ok が落とす）
  const awaitPerms = async fn => {
    for (let i = 0; i < 200; i++) { if (fn((await c.cmd('running')).permissions ?? [])) return true; await sleep(50); } return false;
  };
  const cardOf = sessionId => [...held.values()].find(ev => ev.sessionId === sessionId);
  // その会話から Pleiad の MCP ツールを1回呼び、戻りの JSON を読む
  const callTool = async (sessionId, name, args) => {
    const from = c.mark();
    await c.runTurn({ sessionId, prompt: prompt(name, args) });
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === sessionId, { from, ms: 60000 });
    return JSON.parse(ev.text);
  };
  try {
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { backend: 'fake', task: 'echo:CHILD_RESULT' }) });
    const sid = first.sessionId;
    let rows = await awaitTasks(rows => rows.length === 1 && rows[0].notification === 'sent');
    const child = rows[0];
    t.ok('MCP 委譲で別の子会話を開始する', child.sessionId !== sid && child.parentSessionId === sid && child.result === 'CHILD_RESULT');
    const sessions = await c.cmd('listSessions');
    t.ok('一覧に管理元と親を保存する', sessions.find(s => s.id === child.sessionId)?.delegation?.parentSessionId === sid);
    const parent = await c.cmd('loadSession', { sessionId: sid });
    t.ok('完了通知を人間の発言と区別する', parent.messages.filter(m => m.internalTaskNotice).length === 1);
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_task_send', { taskId: child.taskId, message: 'echo:FOLLOW_UP' }) });
    rows = await awaitTasks(rows => rows[0].result === 'FOLLOW_UP' && rows[0].notification === 'sent');
    t.ok('追加指示が同じ子に届く', rows[0].sessionId === child.sessionId);
    const history = await c.cmd('loadSession', { sessionId: child.sessionId });
    t.ok('子会話に両方の依頼と結果が残る', history.messages.filter(m => m.role === 'user').length === 2);
    const nestedPrompt = prompt('ply_delegate', { backend: 'fake', task: 'echo:DEEP_RESULT' });
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { backend: 'fake', task: nestedPrompt }) });
    rows = await awaitTasks(rows => rows.some(r => r.task === nestedPrompt && r.notification === 'sent'));
    const nestedResult = rows.find(r => r.task === nestedPrompt).result;
    t.ok('孫の結果を受け取った子の最終回答を親へ返す', nestedResult.includes('[Pleiad タスク完了通知') && nestedResult.includes('DEEP_RESULT') && rows.some(r => r.depth === 2 && r.notification === 'sent'));
    const other = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_task_status', { taskId: child.taskId }) });
    t.ok('別会話の taskId を MCP から操作できない', other.events.some(e => e.type === 'tool.result' && e.isError));
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { backend: 'fake', task: 'slow' }) });
    rows = await awaitTasks(rows => rows.some(r => r.task === 'slow' && r.status === 'running'));
    const slow = rows.find(r => r.task === 'slow');
    await c.cmd('cancelAgentTask', { taskId: slow.taskId });
    await awaitTasks(rows => rows.find(r => r.taskId === slow.taskId)?.status === 'cancelled');
    t.ok('UI の停止コマンドが子の実行を止める', !(await c.cmd('running')).turns.some(r => r.sessionId === slow.sessionId));
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { backend: 'procway', task: 'bg 1 700 600' }) });
    rows = await awaitTasks(rows => rows.some(r => r.backend === 'procway' && r.notification === 'sent'));
    const native = rows.find(r => r.backend === 'procway');
    t.ok('委譲先 procway の内部の子と wake も待つ', native.status === 'completed' && native.result.includes('再開した:'),
      JSON.stringify({ status: native.status, error: native.error, result: native.result }));
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { backend: 'procway', task: 'bg 1 60000 500' }) });
    rows = await awaitTasks(rows => rows.some(r => r.task === 'bg 1 60000 500' && r.status === 'running'));
    const nativeSlow = rows.find(r => r.task === 'bg 1 60000 500');
    await c.waitFor(e => e.type === 'running' && e.background?.some(b => b.sessionId === nativeSlow.sessionId), { ms: 15000 });
    await c.cmd('cancelAgentTask', { taskId: nativeSlow.taskId });
    await awaitTasks(rows => rows.find(r => r.taskId === nativeSlow.taskId)?.status === 'cancelled');
    t.ok('委譲先の内部バックグラウンドジョブも停止する', !(await c.cmd('running')).background.some(b => b.sessionId === nativeSlow.sessionId));
    for (let i = 0; i < 100; i++) { if (!(await c.cmd('running')).turns.some(t => t.sessionId === sid)) break; await sleep(50); }
    t.ok('親の強さに収まる委譲では聞かない', escalations.length === 0, `${escalations.length} 件聞かれた`);
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { backend: 'antigravity', task: 'agy-test-task' }) });
    rows = await awaitTasks(rows => rows.some(r => r.backend === 'antigravity' && r.notification === 'sent'));
    const agyChild = rows.find(r => r.backend === 'antigravity');
    t.ok('委譲先 antigravity で子会話を開始し結果を受け取る', agyChild.status === 'completed' && agyChild.result.includes('agy-test-task'));
    const allSessions = await c.cmd('listSessions');
    t.ok('antigravity の子は yolo モードで開始する', allSessions.find(s => s.id === agyChild.sessionId)?.mode === 'yolo');
    const asked = escalations.find(e => e.toolName === 'ply_delegate');
    t.ok('親より強い委譲は親の会話で1回だけ聞き、何をどの強さで動かすか見せる',
      escalations.length === 1 && String(asked?.title ?? '').includes('Antigravity') && String(asked?.title ?? '').includes('yolo'), asked?.title ?? '聞かれなかった');
    // 親が auto（聞かずに進む）なら、子も既定の default ではなく auto で始まる
    await c.runTurn({ sessionId: sid, mode: 'auto', prompt: prompt('ply_delegate', { backend: 'fake', task: 'echo:INHERITED' }) });
    rows = await awaitTasks(rows => rows.some(r => r.task === 'echo:INHERITED' && r.notification === 'sent'));
    const inherited = rows.find(r => r.task === 'echo:INHERITED');
    t.ok('子は親の承認モードの強さを継ぐ', inherited.mode === 'auto',
      `${inherited.mode} / ${(await c.cmd('listSessions')).find(s => s.id === inherited.sessionId)?.mode}`);

    // ---- 承認の中継と、依頼元への「承認待ち」の伝達
    hold = true;
    const top = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { backend: 'fake', task: 'ask-slow' }) })).sessionId;
    rows = await awaitTasks(rows => rows.some(r => r.parentSessionId === top));
    const asker = rows.find(r => r.parentSessionId === top);
    const relayed = await awaitPerms(p => [top, asker.sessionId].every(id => p.some(x => x.sessionId === id)));
    t.ok('子の承認を依頼元の会話にも出す', relayed, [...held.values()].map(ev => ev.sessionId).join(' / '));
    t.ok('中継したカードには「常に許可」を出さない', cardOf(top)?.canAlways === false && cardOf(asker.sessionId)?.canAlways === true);
    t.ok('中継したカードにどの会話の承認かを出す', String(cardOf(top)?.title ?? '').includes('ask-slow'), cardOf(top)?.title ?? '');
    t.ok('承認待ちの子は依頼元に waiting として見える', (await callTool(top, 'ply_task_status', { taskId: asker.taskId })).status === 'waiting');
    const waitedAt = Date.now();
    const waited = await callTool(top, 'ply_task_wait', { taskId: asker.taskId });
    t.ok('ply_task_wait は承認待ちならすぐ戻る', waited.status === 'waiting' && Date.now() - waitedAt < 15000, `${Date.now() - waitedAt}ms`);
    t.ok('依頼元のターンが終わっても中継した承認は取り下げない', (await c.cmd('running')).permissions.some(x => x.sessionId === top));
    await c.cmd('resolvePermission', { id: cardOf(top).id, allow: true });
    t.ok('依頼元で答えると子の承認も決着し、複製が消える',
      await awaitPerms(p => ![top, asker.sessionId].some(id => p.some(x => x.sessionId === id))));
    t.ok('承認が済めば running に戻る', (await callTool(top, 'ply_task_status', { taskId: asker.taskId })).status === 'running');
    await c.cmd('cancelAgentTask', { taskId: asker.taskId });
    await awaitTasks(rows => rows.find(r => r.taskId === asker.taskId)?.status === 'cancelled');

    // 孫の承認は、子と依頼元の両方まで届く。答えるのはどの会話でもよい
    held.clear();
    const deepTop = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { backend: 'fake', task: prompt('ply_delegate', { backend: 'fake', task: 'ask' }) }) })).sessionId;
    rows = await awaitTasks(rows => rows.some(r => r.parentSessionId === deepTop));
    const mid = rows.find(r => r.parentSessionId === deepTop);
    rows = await awaitTasks(rows => rows.some(r => r.parentSessionId === mid.sessionId));
    const deep = rows.find(r => r.parentSessionId === mid.sessionId);
    const family = [deepTop, mid.sessionId, deep.sessionId];
    t.ok('孫の承認は祖先すべてに中継する', await awaitPerms(p => family.every(id => p.some(x => x.sessionId === id))),
      [...held.values()].map(ev => ev.sessionId).join(' / '));
    await c.cmd('resolvePermission', { id: cardOf(deep.sessionId).id, allow: true });
    t.ok('子の会話で答えても祖先の複製が消える', await awaitPerms(p => !family.some(id => p.some(x => x.sessionId === id))));
    await awaitTasks(rows => rows.find(r => r.taskId === deep.taskId)?.result === '許可された');

    // 中断の後片付けで、祖先側の複製が取り残されない
    held.clear();
    const cancelTop = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { backend: 'fake', task: 'ask' }) })).sessionId;
    rows = await awaitTasks(rows => rows.some(r => r.parentSessionId === cancelTop));
    const doomed = rows.find(r => r.parentSessionId === cancelTop);
    await awaitPerms(p => [cancelTop, doomed.sessionId].every(id => p.some(x => x.sessionId === id)));
    await c.cmd('cancelAgentTask', { taskId: doomed.taskId });
    t.ok('子のターンを中断すると祖先側の複製も残らない',
      await awaitPerms(p => ![cancelTop, doomed.sessionId].some(id => p.some(x => x.sessionId === id))));
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
}
