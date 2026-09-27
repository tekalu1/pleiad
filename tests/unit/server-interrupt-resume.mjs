// 中断を会話の状態として残し、「再開」で続ける（docs/design.md「中断と再開」・ADR 0036）。
// fake バックエンドだけで、LLM は呼ばない。
//   - 中断で終わったターンは sidecar に interrupted { at, reason } を残し、一覧・turnEnd・loadSession に載る。at は completedAt と同じ
//   - turnResult aborted に reason が載る。abort の reason は user|update|quit だけ（ほかは user）
//   - 次のターンの開始で消える
//   - resume: 保留の未送信があればそれを送り直す（outbox）、無ければ理由ごとの文を送る（text）。実行中・中断していない会話は断る
//   - 全部の中断（reason: update）で、委譲の子の会話も同じ理由で中断として残る
//   - 起動時: 終わりが記録されていないターン（turnStartedAt > completedAt）は reason: restart の中断になる
//   - resume の先頭: failed（渡っていない）は保留と一緒に送り直す。unknown（結果不明）は OUTBOX_UNKNOWN で断る
//   - 中断した会話への新しい送信は、保留を先に並びのまま送り直してから続く（保留の後ろで詰まらない）
//   - 同時の再開は 1 つだけ通る（「続けて」を二重に送らない）
//   - 会話の中断の理由は、その取り消しで実際に止まる子のターンにだけ付く（終わったタスクの子を人が動かしているターンには付かない）
//   - ready に startedAt（サーバーの起動時刻）が載る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-interrupt-resume';
export const title = '中断は会話に理由付きで残り、「再開」で保留か理由の文を送って続けられる。落ちたターンは再起動で中断になる';

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const JA = JSON.parse(await fs.readFile(path.join(ROOT, 'web/locales/ja/server.json'), 'utf8'));

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-interrupt-'));
  const dataDir = path.join(scratch, 'data');
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  let c = await open({ port: server.port, token: server.token, autoAllow: true });
  const row = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  const sidecar = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'sessions.json'), 'utf8'));
  const rejected = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
  // 走り出す（activity が届く）まで待つ
  const startSlow = async (sessionId, prompt = 'slow') => {
    const from = c.mark();
    await c.cmd('runTurn', { sessionId, prompt });
    await c.waitFor(e => e.type === 'activity' && e.sessionId === sessionId, { from, ms: 20000 });
    return from;
  };
  // 何も走っていない（送信待ちも出きった）まで待つ
  const idle = async (sessionId) => {
    for (let i = 0; i < 400; i++) {
      // 一覧を先に見る（送信中を出た項目のターンは、もう running に載っている）
      const items = sessionId ? await c.cmd('listMessages', { sessionId }) : [];
      const work = await c.cmd('running');
      if (work.count === 0 && !items.some(m => m.status === 'queued' || m.status === 'sending')) return true;
      await sleep(50);
    }
    return false;
  };
  const users = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages.filter(m => m.role === 'user').map(m => m.text);
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.runTurn({ sessionId, prompt: 'echo:first' });
    t.ok('ready にサーバーの起動時刻（startedAt）が載る', Number.isFinite(c.ready.startedAt) && c.ready.startedAt <= Date.now(), String(c.ready.startedAt));
    t.ok('普通に終わった会話は中断していない', (await row(sessionId))?.interrupted === null, JSON.stringify((await row(sessionId))?.interrupted));
    t.ok('中断していない会話の再開は断る', (await rejected(c.cmd('resume', { sessionId }))) === JA.resume.notInterrupted);

    // ---- 中断（reason: update）が残る
    let from = await startSlow(sessionId);
    t.ok('実行中の会話の再開は断る', (await rejected(c.cmd('resume', { sessionId }))) === JA.resume.running);
    const stopped = await c.cmd('abort', { sessionId, reason: 'update' });
    t.ok('abort は理由を返す', stopped.aborted === 1 && stopped.reason === 'update', JSON.stringify(stopped));
    let end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    const result = c.since(from).find(e => e.type === 'turnResult' && e.sessionId === sessionId);
    t.ok('turnResult aborted に reason が載る', result?.outcome === 'aborted' && result.reason === 'update', JSON.stringify(result));
    t.ok('turnEnd に interrupted { at: completedAt, reason } が載る',
      end.interrupted?.reason === 'update' && end.interrupted.at === end.completedAt && Number.isFinite(end.completedAt), JSON.stringify(end));
    let listed = await row(sessionId);
    t.ok('一覧の行に interrupted が載る', listed?.interrupted?.reason === 'update' && listed.interrupted.at === listed.completedAt, JSON.stringify(listed?.interrupted));
    const loaded = await c.cmd('loadSession', { sessionId });
    t.ok('loadSession にも interrupted が載る', loaded.interrupted?.reason === 'update', JSON.stringify(loaded.interrupted));
    let saved = (await sidecar())[sessionId];
    t.ok('sidecar に保存され、走っている印（turnStartedAt）は片付く', saved.interrupted?.reason === 'update' && saved.turnStartedAt === null, JSON.stringify({ interrupted: saved.interrupted, turnStartedAt: saved.turnStartedAt }));

    // ---- 再開（保留が無い）: 理由ごとの文を普通の送信で送り、始まったターンで中断の印が消える
    from = c.mark();
    const resumed = await c.cmd('resume', { sessionId });
    t.ok('保留が無ければ理由の文を送る', resumed.sent === 'text' && resumed.count === 1, JSON.stringify(resumed));
    end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    const said = c.since(from).find(e => e.type === 'userMessage' && e.sessionId === sessionId);
    t.ok('送った文は見える発言（update の文）', said?.text === JA.resume.prompt.update, said?.text);
    t.ok('次のターンが終わると中断の印は消える', end.interrupted === null && (await row(sessionId))?.interrupted === null, JSON.stringify(end));
    t.ok('中断していない会話は再開できない（二度押し）', (await rejected(c.cmd('resume', { sessionId }))) === JA.resume.notInterrupted);

    // ---- 次のターンの開始で消える（終わる前から一覧は null）
    from = await startSlow(sessionId);
    await c.cmd('abort', { sessionId });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    t.ok('reason を省略した中断は user', (await row(sessionId))?.interrupted?.reason === 'user', JSON.stringify((await row(sessionId))?.interrupted));
    from = await startSlow(sessionId);
    t.ok('ターンが始まった時点で一覧の interrupted は null', (await row(sessionId))?.interrupted === null, JSON.stringify((await row(sessionId))?.interrupted));

    // ---- 保留の未送信があれば、それを送り直して再開する（「続けて」は送らない）
    const messageId = 'resume-outbox-0001';
    await c.cmd('sendMessage', { sessionId, messageId, prompt: 'echo:queued-during-turn' });
    await c.cmd('abort', { sessionId, reason: 'bogus' });
    end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    t.ok('不正な reason は user として扱う', end.interrupted?.reason === 'user', JSON.stringify(end.interrupted));
    let items = await c.cmd('listMessages', { sessionId });
    for (let i = 0; i < 100 && items.find(m => m.id === messageId)?.status !== 'paused'; i++) { await sleep(50); items = await c.cmd('listMessages', { sessionId }); }
    t.ok('中断で送信待ちは保留になる', items.find(m => m.id === messageId)?.status === 'paused', JSON.stringify(items.map(m => m.status)));
    from = c.mark();
    const again = await c.cmd('resume', { sessionId });
    t.ok('保留があればそれを送る（outbox・件数）', again.sent === 'outbox' && again.count === 1, JSON.stringify(again));
    end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    const sent = c.since(from).filter(e => e.type === 'userMessage' && e.sessionId === sessionId);
    t.ok('保留の本文だけが送られる（理由の文は送らない）', sent.length === 1 && sent[0].messageId === messageId && sent[0].text === 'echo:queued-during-turn',
      JSON.stringify(sent.map(e => e.text)));
    t.ok('保留を送ったターンが終わると中断は消える', end.outcome === 'ok' && end.interrupted === null, JSON.stringify(end));

    // ---- 中断した会話に新しい指示を送ると、保留を先に送り直してから続く（保留の後ろで詰まらない。レビュー #2）
    from = await startSlow(sessionId);
    await c.cmd('sendMessage', { sessionId, messageId: 'held-before-0001', prompt: 'echo:held-first' });
    await c.cmd('abort', { sessionId });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    items = await c.cmd('listMessages', { sessionId });
    for (let i = 0; i < 100 && items.find(m => m.id === 'held-before-0001')?.status !== 'paused'; i++) { await sleep(50); items = await c.cmd('listMessages', { sessionId }); }
    t.ok('中断で途中の送信は保留になる', items.find(m => m.id === 'held-before-0001')?.status === 'paused');
    await c.cmd('sendMessage', { sessionId, messageId: 'held-after-0001', prompt: 'echo:new-instruction' });
    t.ok('新しい指示を送ると保留も新しい指示も出ていく', await idle(sessionId));
    items = await c.cmd('listMessages', { sessionId });
    t.ok('保留と新しい指示はどちらも送られる', ['held-before-0001', 'held-after-0001'].every(id => items.find(m => m.id === id)?.status === 'sent'), JSON.stringify(items.map(m => [m.id, m.status])));
    const said2 = await users(sessionId);
    t.ok('保留が先、新しい指示が後', said2.indexOf('echo:held-first') >= 0 && said2.indexOf('echo:held-first') < said2.indexOf('echo:new-instruction'), JSON.stringify(said2.slice(-3)));
    t.ok('続いた会話は中断ではない', (await row(sessionId))?.interrupted === null);

    // ---- 同時の再開は 1 つだけ通り、「続けて」は 1 回だけ送られる（レビュー #3）
    from = await startSlow(sessionId);
    await c.cmd('abort', { sessionId });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 20000 });
    const c2 = await open({ port: server.port, token: server.token, autoAllow: true });
    try {
      const before = await users(sessionId);
      const both = await Promise.allSettled([c.cmd('resume', { sessionId }), c2.cmd('resume', { sessionId })]);
      t.ok('同時の再開は 1 つだけ受け付ける', both.filter(r => r.status === 'fulfilled').length === 1, JSON.stringify(both.map(r => r.status)));
      const late = await rejected(c2.cmd('resume', { sessionId }));
      t.ok('受け付けた直後の別の端末からの再開も断る', late === JA.resume.running || late === JA.resume.notInterrupted, String(late));
      t.ok('再開のターンが終わる', await idle(sessionId));
      const prompts = (await users(sessionId)).slice(before.length).filter(x => x === JA.resume.prompt.user);
      t.ok('「続けてください」は 1 回だけ', prompts.length === 1, JSON.stringify((await users(sessionId)).slice(before.length)));
    } finally { c2.close(); }

    // ---- 会話の中断の理由は、実際に止まる子のターンにだけ付く（レビュー #4）
    const quickParent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:child-done' }) })).sessionId;
    let doneChild = null;
    for (let i = 0; i < 400 && !doneChild; i++) {
      const task = (await c.cmd('agentTasks', { sessionId: quickParent }))[0];
      if (task?.status === 'completed' && task.sessionId) doneChild = task.sessionId; else await sleep(50);
    }
    t.ok('委譲の子が終わる', Boolean(doneChild));
    if (doneChild) {
      await idle();
      // 終わったタスクの子の会話を人が直接動かしている。依頼元を止めてもこのターンは止まらない
      from = await startSlow(doneChild);
      await c.cmd('abort', { sessionId: quickParent, reason: 'update' });
      t.ok('依頼元を止めても、終わったタスクの子のターンは走り続ける', (await c.cmd('running')).turns.some(x => x.sessionId === doneChild));
      await c.cmd('abort', { sessionId: doneChild });
      end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === doneChild, { from, ms: 20000 });
      t.ok('その子のターンは自分の中断の理由（user）で残る（依頼元の update を付けない）', end.interrupted?.reason === 'user', JSON.stringify(end.interrupted));
    }
    // 走っている委譲タスクの子は、依頼元の会話を止めた理由で残る（止める所 stopChild で付ける）
    const slowParent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }) })).sessionId;
    let liveChild = null;
    for (let i = 0; i < 400 && !liveChild; i++) {
      const running = await c.cmd('running');
      const task = running.tasks.find(r => r.parentSessionId === slowParent && r.status === 'running');
      if (task && running.turns.some(x => x.sessionId === task.sessionId)) liveChild = task.sessionId;
      else await sleep(50);
    }
    t.ok('走っている委譲の子がいる', Boolean(liveChild));
    if (liveChild) {
      from = c.mark();
      await c.cmd('abort', { sessionId: slowParent, reason: 'update' });
      end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === liveChild, { from, ms: 20000 });
      t.ok('依頼元を止めた理由（update）が、止まった子に付く', end.interrupted?.reason === 'update', JSON.stringify(end.interrupted));
      await idle();
    }

    // ---- 全部の中断（reason: quit）で、委譲の子の会話も同じ理由で中断として残る
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }) })).sessionId;
    let child = null;
    for (let i = 0; i < 400 && !child; i++) {
      const running = await c.cmd('running');
      const task = running.tasks.find(r => r.parentSessionId === parent && r.status === 'running');
      if (task && running.turns.some(x => x.sessionId === task.sessionId)) child = task.sessionId;
      else await sleep(50);
    }
    t.ok('委譲の子が走り出す', Boolean(child));
    if (child) {
      from = c.mark();
      const all = await c.cmd('abort', { reason: 'quit' });
      t.ok('全部の中断は走っている子のターンも止める', all.aborted >= 1 && all.reason === 'quit', JSON.stringify(all));
      end = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === child, { from, ms: 20000 });
      t.ok('子の会話も reason 付きで中断として残る', end.interrupted?.reason === 'quit' && (await row(child))?.interrupted?.reason === 'quit',
        JSON.stringify(end.interrupted));
      let work = await c.cmd('running');
      for (let i = 0; i < 200 && work.count > 0; i++) { await sleep(50); work = await c.cmd('running'); }
      t.ok('全部の中断の後、実行中の数は 0 になる（更新・終了へ進める）', work.count === 0 && work.permissions.length === 0, JSON.stringify({ count: work.count, tasks: work.tasks.map(r => r.status) }));
      const task = (await c.cmd('agentTasks', { sessionId: parent })).find(r => r.sessionId === child);
      t.ok('委譲タスクそのものは取り消す（今どおり）', task?.status === 'cancelled', task?.status);
    }

    // ---- 送信待ちの先頭が failed / unknown の中断した会話（再起動をまたいで sidecar に作る。レビュー #1）
    const failedId = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:before-failed' })).sessionId;
    const unknownId = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:before-unknown' })).sessionId;

    // ---- 起動時: 終わりが記録されていないターンは restart の中断になる
    await startSlow(sessionId);
    saved = (await sidecar())[sessionId];
    t.ok('走っている間は turnStartedAt が残る', Number.isFinite(saved.turnStartedAt) && saved.interrupted === null, JSON.stringify({ interrupted: saved.interrupted, turnStartedAt: saved.turnStartedAt }));
    c.close(); await server.stop();
    // 古い走った印（完了の方が新しい）は中断にしない
    const data = await sidecar();
    data[parent] = { ...data[parent], turnStartedAt: 100, completedAt: 200, interrupted: null };
    const old = new Date(Date.now() - 60000).toISOString();
    data[failedId] = { ...data[failedId], interrupted: { at: Date.now() - 1000, reason: 'user' },
      outbox: [{ id: 'failed-head-0001', args: { prompt: 'echo:failed-head' }, at: old, status: 'failed', error: 'x' }] };
    data[unknownId] = { ...data[unknownId], interrupted: { at: Date.now() - 1000, reason: 'user' },
      outbox: [{ id: 'unknown-head-0001', args: { prompt: 'echo:unknown-head' }, at: old, status: 'unknown', error: 'x' }] };
    await fs.writeFile(path.join(dataDir, 'sessions.json'), JSON.stringify(data));
    const before = Date.now();
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
    c = await open({ port: server.port, token: server.token });
    listed = await row(sessionId);
    t.ok('落ちたターンは reason: restart の中断になる', listed?.interrupted?.reason === 'restart' && listed.interrupted.at >= before, JSON.stringify(listed?.interrupted));
    t.ok('restart の中断は completedAt と同じ時刻（確認済みの印が届く）', listed?.completedAt === listed?.interrupted?.at, `${listed?.completedAt} / ${listed?.interrupted?.at}`);
    const after = await sidecar();
    t.ok('起動時に turnStartedAt を片付ける', after[sessionId].turnStartedAt === null && after[parent].turnStartedAt === null);
    t.ok('完了の方が新しい走った印は中断にしない', (await row(parent))?.interrupted === null, JSON.stringify((await row(parent))?.interrupted));
    // markRead は completedAt で丸めるので、中断の時刻まで確認済みにできる
    const read = await c.cmd('markRead', { reads: [[sessionId, listed.interrupted.at]] });
    t.ok('restart の中断も確認済みにできる', read.reads?.some(([id, at]) => id === sessionId && at === listed.interrupted.at), JSON.stringify(read));

    // 先頭が failed（エージェントに渡っていない）なら、それを送り直して再開する（成功と言って何も起きない、にしない）
    await c.cmd('watchSession', { sessionId: failedId });
    from = c.mark();
    const retried = await c.cmd('resume', { sessionId: failedId });
    t.ok('先頭が failed なら送り直す（outbox・件数）', retried.sent === 'outbox' && retried.count === 1, JSON.stringify(retried));
    t.ok('送り直したターンが終わる', await idle(failedId));
    items = await c.cmd('listMessages', { sessionId: failedId });
    t.ok('failed だった項目は送られる', items.find(m => m.id === 'failed-head-0001')?.status === 'sent', JSON.stringify(items.map(m => m.status)));
    const resent = c.since(from).find(e => e.type === 'userMessage' && e.sessionId === failedId);
    t.ok('送り直した本文が会話に届き、中断は消える', resent?.text === 'echo:failed-head' && (await row(failedId))?.interrupted === null, JSON.stringify(resent));
    // 先頭が unknown（届いたか分からない）なら断る。勝手に送らない
    t.ok('先頭が unknown なら専用の文で断る', (await rejected(c.cmd('resume', { sessionId: unknownId }))) === JA.resume.outboxUnknown);
    items = await c.cmd('listMessages', { sessionId: unknownId });
    t.ok('unknown の項目はそのまま、中断も残る', items.length === 1 && items[0].status === 'unknown' && (await row(unknownId))?.interrupted?.reason === 'user',
      JSON.stringify(items.map(m => m.status)));
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
