// 中断で止めたものを会話に残し、中断の後の最初のターンでエージェントへ 1 回だけ伝える（docs/design.md「中断と再開」）。
// fake バックエンドだけで、LLM は呼ばない。
//   - 記録: 取り消した委譲タスク（止めた時点の状態）・終わっていたのに完了通知が届いていなかったタスク（unread）・
//     止まったバックグラウンドのコマンド・却下扱いにした承認待ちを、sidecar の会話の行（stops）に残す
//   - 伝える: 再開の文（resume の text）・保留の送り直し（resume の outbox）・中断した会話への新しい送信のどれでも、
//     発言の前に <pleiad-interruption> の文を 1 回だけ添える。発言の本文は書き換えない。画面へは interruptionNote で出し、
//     履歴では発言と分けたシステム側の 1 行（kind: interruptionNote）になる。渡ったら stops は消える
//   - 止めたものが無ければ今の文のまま（何も添えない）
//   - 届いていなかった結果は ply_task_status で読める
//   - 再起動で止まった委譲タスクも、依頼元の会話の stops に残って伝わる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-interrupt-stops';
export const title = '中断で止めたもの（委譲タスク・届いていない結果・裏のコマンド・承認待ち）を残し、再開・送り直し・新しい送信の最初に 1 回だけ伝える';

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const JA = JSON.parse(await fs.readFile(path.join(ROOT, 'web/locales/ja/server.json'), 'utf8'));
const OPEN = '<pleiad-interruption>';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-stops-'));
  const dataDir = path.join(scratch, 'data');
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  // 承認は自分で答える（自動では許可しない）
  let c = await open({ port: server.port, token: server.token });
  const sidecar = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'sessions.json'), 'utf8'));
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
  const tasksOf = async owner => c.cmd('agentTasks', { sessionId: owner });
  const idle = async sessionId => until(async () => {
    const items = sessionId ? await c.cmd('listMessages', { sessionId }) : [];
    const work = await c.cmd('running');
    return !work.turns.some(x => !sessionId || x.sessionId === sessionId) && !items.some(m => m.status === 'queued' || m.status === 'sending');
  });
  const startTurn = async (sessionId, prompt) => {
    const from = c.mark();
    await c.cmd('runTurn', { sessionId, prompt });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === sessionId, { from, ms: 20000 });
    return from;
  };
  const abort = async (sessionId, reason) => {
    const from = c.mark();
    await c.cmd('abort', { sessionId, ...(reason ? { reason } : {}) });
    return c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
  };
  const notes = (from, sessionId) => c.since(from).filter(e => e.type === 'interruptionNote' && e.sessionId === sessionId);
  const history = async sessionId => (await c.cmd('loadSession', { sessionId })).messages;
  try {
    // ================= 委譲タスク: 取り消したもの・終わっていたのに届いていなかったもの（resume の text で伝える）
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'ask', title: 'Early' }) })).sessionId;
    await c.runTurn({ sessionId: parent, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow', title: 'Long' }) });
    const tasks = await until(async () => { const rows = await tasksOf(parent); return rows.length === 2 && rows.every(r => r.sessionId) ? rows : null; });
    const early = tasks?.find(r => r.title === 'Early'), long = tasks?.find(r => r.title === 'Long');
    t.ok('委譲タスクが 2 つできる', Boolean(early && long), JSON.stringify(tasks?.map(r => r.title)));
    // Early の子は承認を待っている。依頼元が走っている間に許可して終わらせると、完了通知は届かず pending のまま
    const card = await until(async () => (await c.cmd('running')).permissions.find(p => p.sessionId === early.sessionId));
    t.ok('子の承認待ちが出る', Boolean(card));
    let from = await startTurn(parent, 'slow');
    await c.cmd('resolvePermission', { id: card.id, allow: true });
    const pending = await until(async () => (await tasksOf(parent)).find(r => r.taskId === early.taskId && r.status === 'completed' && r.notification === 'pending'));
    t.ok('依頼元が走っている間に終わった子の完了通知は pending', Boolean(pending));
    await until(async () => (await tasksOf(parent)).find(r => r.taskId === long.taskId && r.status === 'running'));
    let end = await abort(parent);
    t.ok('依頼元は中断で終わる', end.interrupted?.reason === 'user', JSON.stringify(end.interrupted));
    let saved = (await sidecar())[parent];
    const stoppedTasks = saved.stops?.tasks ?? [];
    const unread = stoppedTasks.find(x => x.taskId === early.taskId), cut = stoppedTasks.find(x => x.taskId === long.taskId);
    t.ok('終わっていたのに届いていなかった結果は unread として残る', unread?.unread === true && unread.status === 'completed' && unread.title === 'Early', JSON.stringify(unread));
    t.ok('取り消した委譲タスクは止めた時点の状態で残る', cut && !cut.unread && cut.status === 'running' && cut.title === 'Long', JSON.stringify(cut));
    t.ok('中断の理由も残る', saved.stops?.reason === 'user', saved.stops?.reason);
    await sleep(1200);
    t.ok('中断した会話へ完了通知で勝手にターンを始めない', !(await c.cmd('running')).turns.some(x => x.sessionId === parent) && (await tasksOf(parent)).find(r => r.taskId === early.taskId)?.notification === 'suppressed');

    from = c.mark();
    const resumed = await c.cmd('resume', { sessionId: parent });
    t.ok('保留が無ければ理由の文を送る', resumed.sent === 'text', JSON.stringify(resumed));
    end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === parent, { from, ms: 20000 });
    let said = c.since(from).filter(e => e.type === 'userMessage' && e.sessionId === parent);
    let told = notes(from, parent);
    t.ok('再開の文は今の文のまま（本文は書き換えない）', said.length === 1 && said[0].text === JA.resume.prompt.user, JSON.stringify(said.map(e => e.text)));
    t.ok('止めたものを 1 回だけ伝え、その発言に結び付ける', told.length === 1 && told[0].messageId === said[0].messageId, JSON.stringify(told));
    const body = told[0]?.text ?? '';
    t.ok('伝えた文に、取り消したタスクと届いていなかった結果の読み方が載る',
      body.includes(long.taskId) && body.includes('Long') && body.includes(early.taskId) && body.includes('ply_task_status') && body.includes('利用者が中断した'), body);
    t.ok('画面へ出す中身は印を含まない', !body.includes(OPEN));
    let rows = await history(parent);
    let at = rows.findIndex(m => m.kind === 'interruptionNote');
    t.ok('履歴では発言と分けたシステム側の 1 行になり、続く発言は元の文のまま',
      at >= 0 && rows[at].role === 'system' && rows[at].body.includes(long.taskId) && rows[at + 1]?.role === 'user' && rows[at + 1].text === JA.resume.prompt.user,
      JSON.stringify(rows.slice(at, at + 2)));
    t.ok('どの user の発言にも印は残らない', !rows.some(m => m.role === 'user' && String(m.text).includes(OPEN)));
    t.ok('伝えたら stops は消える', (await sidecar())[parent].stops == null, JSON.stringify((await sidecar())[parent].stops));
    from = c.mark();
    await c.runTurn({ sessionId: parent, prompt: 'echo:after' });
    t.ok('次のターンでは伝えない（1 回だけ）', notes(from, parent).length === 0);
    // 届いていなかった結果は ply_task_status で読める
    const read = await c.runTurn({ sessionId: parent, prompt: ply('ply_task_status', { taskId: early.taskId }) });
    const status = JSON.parse(read.events.find(e => e.type === 'tool.result')?.text ?? '{}');
    t.ok('届いていなかった結果は ply_task_status で読める', status.status === 'completed' && typeof status.result === 'string' && status.result.length > 0, JSON.stringify({ status: status.status, result: status.result }));

    // ================= 承認待ち（新しい送信で伝える）
    const asker = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:first' })).sessionId;
    from = c.mark();
    await c.cmd('runTurn', { sessionId: asker, prompt: 'ask-slow' });
    await c.waitFor(e => e.type === 'permission' && e.sessionId === asker, { from, ms: 20000 });
    end = await abort(asker);
    saved = (await sidecar())[asker];
    t.ok('却下扱いにした承認待ちがツール名と対象で残る', saved.stops?.approvals?.length === 1 && saved.stops.approvals[0].tool === 'fake_write' && saved.stops.approvals[0].target === 'a.txt',
      JSON.stringify(saved.stops));
    from = c.mark();
    await c.cmd('sendMessage', { sessionId: asker, messageId: 'stops-new-0001', prompt: 'echo:next' });
    t.ok('新しい送信のターンが終わる', await idle(asker));
    said = c.since(from).filter(e => e.type === 'userMessage' && e.sessionId === asker);
    told = notes(from, asker);
    t.ok('新しい送信にも 1 回だけ添える（本文はそのまま）', told.length === 1 && told[0].messageId === 'stops-new-0001' && said.length === 1 && said[0].text === 'echo:next',
      JSON.stringify({ told, said: said.map(e => e.text) }));
    t.ok('承認待ちの文が載る', /fake_write: a\.txt/.test(told[0]?.text ?? ''), told[0]?.text);
    rows = await history(asker);
    at = rows.findIndex(m => m.kind === 'interruptionNote');
    t.ok('履歴: 伝えた文の後に元の発言', at >= 0 && rows[at + 1]?.text === 'echo:next', JSON.stringify(rows.slice(-3)));

    // ================= 裏のコマンド（保留の送り直しで伝える）
    const bg = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:first' })).sessionId;
    from = await startTurn(bg, 'bg-shell 報告');
    await c.waitFor(e => e.type === 'phase' && e.sessionId === bg && e.state === 'waiting', { from, ms: 20000 });
    await c.cmd('sendMessage', { sessionId: bg, messageId: 'stops-held-0001', prompt: 'echo:held' });
    await abort(bg);
    saved = (await sidecar())[bg];
    t.ok('止まったバックグラウンドのコマンドが id とコマンドで残る', saved.stops?.background?.length === 1 && saved.stops.background[0].id.startsWith('fake-shell-')
      && saved.stops.background[0].label === 'cat >> /dev/null' && saved.stops.background[0].kind === 'shell', JSON.stringify(saved.stops));
    await until(async () => (await c.cmd('listMessages', { sessionId: bg })).find(m => m.id === 'stops-held-0001')?.status === 'paused');
    from = c.mark();
    const again = await c.cmd('resume', { sessionId: bg });
    t.ok('保留があれば送り直す', again.sent === 'outbox' && again.count === 1, JSON.stringify(again));
    t.ok('送り直したターンが終わる', await idle(bg));
    told = notes(from, bg);
    said = c.since(from).filter(e => e.type === 'userMessage' && e.sessionId === bg);
    t.ok('送り直しにも 1 回だけ添える（本文はそのまま）', told.length === 1 && told[0].messageId === 'stops-held-0001' && said.length === 1 && said[0].text === 'echo:held',
      JSON.stringify({ told: told.length, said: said.map(e => e.text) }));
    t.ok('裏のコマンドの文が載る', (told[0]?.text ?? '').includes('cat >> /dev/null') && (told[0]?.text ?? '').includes(saved.stops.background[0].id), told[0]?.text);

    // ================= 止めたものが無い中断は、今の文のまま（何も添えない）
    const plain = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:first' })).sessionId;
    await startTurn(plain, 'slow');
    await abort(plain);
    t.ok('止めたものが無ければ stops は残らない', (await sidecar())[plain].stops == null, JSON.stringify((await sidecar())[plain].stops));
    from = c.mark();
    await c.cmd('resume', { sessionId: plain });
    t.ok('再開のターンが終わる', await idle(plain));
    said = c.since(from).filter(e => e.type === 'userMessage' && e.sessionId === plain);
    t.ok('何も添えず、今の文のまま', notes(from, plain).length === 0 && said.length === 1 && said[0].text === JA.resume.prompt.user, JSON.stringify(said.map(e => e.text)));
    t.ok('履歴にも伝えた行は出ない', !(await history(plain)).some(m => m.kind === 'interruptionNote'));

    // ================= 再起動で止まった委譲タスク（落ちた・強制終了）
    const crashed = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow', title: 'Crash' }) })).sessionId;
    const crashTask = await until(async () => (await tasksOf(crashed)).find(r => r.status === 'running'));
    t.ok('委譲の子が走っている', Boolean(crashTask));
    c.close(); await server.stop();
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
    c = await open({ port: server.port, token: server.token });
    saved = (await sidecar())[crashed];
    t.ok('再起動で止まった委譲タスクが依頼元の stops に残る', saved.stops?.tasks?.some(x => x.taskId === crashTask.taskId && x.restart && x.status === 'running' && x.title === 'Crash'),
      JSON.stringify(saved.stops));
    from = c.mark();
    await c.runTurn({ sessionId: crashed, prompt: 'echo:after-restart' });
    told = notes(from, crashed);
    t.ok('次のターンで再起動で止まったことを伝える', told.length === 1 && told[0].text.includes(crashTask.taskId) && told[0].text.includes('再起動'), told[0]?.text);
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
