// Codex の実行前の拒否を、会話の画面・委譲の結果（ply_task_status の rejections）・完了通知まで通しで確かめる。
// Codex は身代わり（tests/lib/fake-codex.mjs）。FAKE_CODEX_ROLLOUT_DIR に rollout を書き、thread/start・resume の応答で thread.path を返す。
// 拒否は通知にも thread/read にも出さず rollout にだけ書く（本物と同じ）。LLM は呼ばない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'server-codex-rejections';
export const title = 'Codex の実行前の拒否: 会話にツールのエラーとして出し、委譲の結果と完了通知に載せる（秘密は伏せる）';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-codex-rejections-'));
  const rollouts = path.join(scratch, 'rollouts');
  await fs.mkdir(rollouts);
  const server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_ROLLOUT_DIR: rollouts } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const awaitTasks = async fn => {
    const deadline = Date.now() + 60_000;
    let rows;
    while (Date.now() < deadline) { rows = await c.cmd('agentTasks'); if (fn(rows)) return rows; await sleep(50); }
    throw new Error('task timeout: ' + JSON.stringify(rows.map(({ backend, status, notification, error }) => ({ backend, status, notification, error }))));
  };
  const callTool = async (sessionId, name, args) => {
    for (let i = 0; ; i++) {
      try {
        const turn = await c.runTurn({ sessionId, prompt: prompt(name, args) });
        return JSON.parse(turn.events.find(e => e.type === 'tool.result' && e.sessionId === sessionId).text);
      } catch (e) { if (i > 200 || !/切り替え中|実行中|running/.test(e.message)) throw e; await sleep(50); }
    }
  };
  const rejectedOf = turn => turn.events.filter(e => e.type === 'tool.result' && e.rejection);
  try {
    // ---- 自分の会話（委譲ではない）: 画面にツールのエラーとして出る
    const { sessionId: cx } = await c.cmd('newSession', { backend: 'codex', cwd: ROOT });
    let turn = await c.runTurn({ sessionId: cx, prompt: 'reject' });
    let got = rejectedOf(turn);
    const starts = turn.events.filter(e => e.type === 'tool.start' && e.input?.rejected);
    t.ok('rollout にだけある拒否を拾い、引用されただけの文は拾わない', got.length === 2 && got.map(e => e.rejection.kind).join() === 'policy,spawn', JSON.stringify(got.map(e => e.rejection)));
    t.ok('会話にはコマンドのツールとして出し、結果はエラー', starts.length === 2 && starts.every(e => e.name === 'commandExecution') && starts[0].input.command.startsWith('Stop-Process -Id 4242')
      && got.every(e => e.isError) && got[0].text.startsWith('Codex の安全判定で実行前に拒否された（blocked by policy）'), JSON.stringify(starts.map(e => e.input)));
    t.ok('ターンの結果は変えない（ok）で、拒否はターンの終わりより前に出る', turn.events.find(e => e.type === 'turnResult')?.outcome === 'ok'
      && turn.events.findIndex(e => e.type === 'turnResult') > turn.events.findIndex(e => e.type === 'tool.result' && e.rejection));
    t.ok('会話の画面の分は伏せない（子の会話は今もコマンドを全文で出している）', got[0].rejection.command.includes('fake-token-0123456789'));
    turn = await c.runTurn({ sessionId: cx, prompt: 'hello' });
    t.ok('拒否の無いターンでは何も足さない（前のターンの分を読み直さない）', rejectedOf(turn).length === 0 && !turn.events.some(e => e.input?.rejected));
    turn = await c.runTurn({ sessionId: cx, prompt: 'reject-ask' });
    got = rejectedOf(turn);
    t.ok('同じターンで同じ call id の承認を求められていれば approvalRequested', got.length === 1 && got[0].rejection.approvalRequested === true, JSON.stringify(got.map(e => e.rejection)));
    turn = await c.runTurn({ sessionId: cx, prompt: 'reject-late' });
    t.ok('出力の行が turn/completed の後に書かれても拾う', rejectedOf(turn).length === 1);
    const history = await c.cmd('loadSession', { sessionId: cx });
    t.ok('会話を開き直すと thread/read から作る履歴には残らない（今の形）', history.messages.length > 0 && !JSON.stringify(history.messages).includes('call_code_'));

    // ---- 委譲の子: ply_task_status の rejections と完了通知
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'codex', task: 'reject' }) })).sessionId;
    let rows = await awaitTasks(rows => rows.length === 1 && rows[0].notification === 'sent');
    const task = rows[0];
    const status = await callTool(parent, 'ply_task_status', { taskId: task.taskId });
    const [policy, spawn] = status.rejections ?? [];
    t.ok('ply_task_status に rejections が載る', status.rejections?.length === 2 && status.status === 'completed', JSON.stringify(status.rejections));
    t.ok('形は { tool, via, command, shell, kind, reason, raw, approvalRequested, callId, turnId }',
      Object.keys(policy ?? {}).sort().join() === 'approvalRequested,callId,command,kind,raw,reason,shell,tool,turnId,via'
      && policy.tool === 'exec_command' && policy.via === 'code_mode' && policy.kind === 'policy' && policy.reason === 'blocked by policy'
      && policy.shell === 'powershell.exe' && policy.approvalRequested === false && /^call_code_/.test(policy.callId) && typeof policy.turnId === 'string'
      && spawn?.kind === 'spawn' && spawn.via === 'code_mode' && spawn.command === null, JSON.stringify(policy));
    t.ok('依頼元へ返す command と raw は秘密の形を伏せる', policy.command.includes('Bearer ***') && policy.command.includes('https://***@example.invalid/x?token=***&q=***')
      && !JSON.stringify(status.rejections).includes('fake-token-0123456789') && !JSON.stringify(status.rejections).includes('user:pass'), policy.command);
    t.ok('raw は 300 字で切る', policy.raw.length <= 301 && policy.raw.startsWith('exec_command failed: CreateProcess'));
    const notice = (await c.cmd('loadSession', { sessionId: parent })).messages.find(m => m.internalTaskNotice)?.text ?? '';
    const header = agentT('ja', 'delegation.noticeRejections', { count: 2, items: '' }).split('\n')[0];
    t.ok('完了通知の本文に件数と先頭の command・reason を載せ、全件は ply_task_status と案内する', notice.includes(header) && notice.includes('- Stop-Process -Id 4242')
      && notice.includes('（blocked by policy）') && notice.includes('ply_task_status の rejections') && !notice.includes('fake-token-0123456789'), notice.slice(-600));
    const list = await callTool(parent, 'ply_task_list', {});
    t.ok('ply_task_list は件数だけ（中身は ply_task_status）', list.tasks[0]?.rejectionCount === 2 && !('rejections' in list.tasks[0]));

    // ---- ply_task_send の次の回: 前の回の分を渡し終えていれば置き換える
    await callTool(parent, 'ply_task_send', { taskId: task.taskId, message: 'reject-direct' });
    rows = await awaitTasks(rows => rows[0].revision === 1 && rows[0].status === 'completed' && rows[0].notification === 'sent');
    const next = await callTool(parent, 'ply_task_status', { taskId: task.taskId });
    t.ok('完了通知を送った後の追加の指示では、その回の拒否で置き換える', next.rejections?.length === 1 && next.rejections[0].via === 'direct'
      && next.rejections[0].command.startsWith('Remove-Item -LiteralPath'), JSON.stringify(next.rejections));
    await callTool(parent, 'ply_task_send', { taskId: task.taskId, message: 'hello' });
    rows = await awaitTasks(rows => rows[0].revision === 2 && rows[0].status === 'completed' && rows[0].notification === 'sent');
    const clean = await callTool(parent, 'ply_task_status', { taskId: task.taskId });
    const notices = (await c.cmd('loadSession', { sessionId: parent })).messages.filter(m => m.internalTaskNotice);
    t.ok('拒否の無い回は rejections が空で、完了通知にも段落を足さない', clean.rejections?.length === 0 && notices.length === 3 && !notices.at(-1).text.includes(header));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
