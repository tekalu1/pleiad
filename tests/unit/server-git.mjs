// git の動きをサーバー越しに（fake + 一時リポジトリ。ADR 0085）。
// ターンの始まりの撮影・終わりの要約（present kind: git）・何も動かないターンは出さない・git 管理外は何もしない・
// gitStatus / gitPanel / gitDiff・委譲の子の完了通知に変更の 1 行、を確かめる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { COMMANDS } from '../../core/protocol.mjs';

export const name = 'server-git';
export const title = 'git の動き（サーバー越し）: ターンの撮影と要約・パネルの口・git 管理外・委譲の完了通知の変更の 1 行';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-git-')));
  const repo = path.join(scratch, 'repo');
  const plain = path.join(scratch, 'plain');
  await fs.mkdir(path.join(repo, 'core'), { recursive: true });
  await fs.mkdir(plain, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'core', 'a.mjs'), 'one\ntwo\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');

  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_GIT_SNAPSHOTS: 'on' }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/turn/').split('\n').filter(Boolean);
  // ターンの始まりの撮影（隠し ref の start）は、ターンの始まりと並んで非同期に撮られる。ツールが始まった・承認が来たことは、それが済んだ印ではない。
  // 遅い環境で撮影より先に作業場所を変えると、変更が撮影に入って「動かなかったターン」になるので、その会話の start の ref ができるのを待つ
  const startSnapped = async (sessionId) => {
    const ref = `refs/pleiad/turn/${sessionId}/1-start`;
    for (let i = 0; i < 600 && !refs().includes(ref); i++) await sleep(50);
  };
  // 台本の最初のツールは ask: true で承認待ちに止める。撮影が済んだのを見てから作業場所を実際に変え、変え終わってから承認して台本を進める（台本の ms の固定の長さでは、遅い環境で git の起動が間に合わず、変更より先にターンが終わる）
  const permissionBeforeTurnEnd = async (running, from) => Promise.race([
    c.waitFor((e) => e.type === 'permission', { from, ms: 30_000 }),
    running.then((result) => { throw new Error(`承認より先にターンが終わった: ${JSON.stringify({ outcome: result.outcome, events: result.events?.map(e => e.type) })}`); }),
  ]);
  const turnWithChanges = async (args, change) => {
    const from = c.mark();
    const running = c.runTurn(args);
    const asked = await permissionBeforeTurnEnd(running, from);
    await startSnapped(asked.sessionId);
    await change();
    await c.cmd('resolvePermission', { id: asked.id, allow: true });
    return running;
  };
  try {
    t.ok('コマンドを protocol に登録している', ['gitStatus', 'gitPanel', 'gitDiff'].every((n) => COMMANDS.has(n)));

    // ---- 1. ブランチを作り、直し、コミットし、PR を出すターン
    const steps = { steps: [
      { tool: 'Bash', input: { command: 'git checkout -b fix/x' }, result: "Switched to a new branch 'fix/x'", ask: true },
      { tool: 'Bash', input: { command: 'git commit -am "fix: a"' }, result: '[fix/x abcdef0] fix: a\n 1 file changed', ms: 100 },
      { tool: 'Bash', input: { command: 'gh pr create' }, result: 'https://github.com/example/p/pull/9', ms: 100 },
      { text: '直しました' },
    ] };
    const first = await turnWithChanges({ backend: 'fake', cwd: repo, prompt: `steps:${JSON.stringify(steps)}` }, async () => {
      sh(repo, 'checkout', '-q', '-b', 'fix/x');
      await fs.writeFile(path.join(repo, 'core', 'a.mjs'), 'one\nTWO\nthree\n');
      sh(repo, 'commit', '-q', '-am', 'fix: a');
      await fs.writeFile(path.join(repo, 'new.txt'), 'x\n');
    });
    const sid = first.sessionId;
    const present = first.events.find((e) => e.type === 'present' && e.kind === 'git');
    t.ok('ターンの終わりに present kind: git が出る（返答の下の 1 行の元）', Boolean(present) && present.sessionId === sid, JSON.stringify(present));
    t.ok('要約: ブランチ・ファイル数と行数・コミット・PR', present?.git.branch === 'fix/x' && present.git.files === 2 && present.git.add === 3 && present.git.del === 1
      && present.git.commitCount === 1 && present.git.commits[0].subject === 'fix: a' && present.git.pr?.number === 9 && present.git.created === true, JSON.stringify(present?.git));
    const endIndex = first.events.findIndex((e) => e.type === 'turnEnd' && e.sessionId === sid);
    t.ok('要約は turnEnd より前（次の発言より先に並ぶ）', first.events.indexOf(present) < endIndex);
    t.ok('隠し ref は始まりと終わりの 2 つ', refs().sort().join() === `refs/pleiad/turn/${sid}/1-end,refs/pleiad/turn/${sid}/1-start`, refs().join());
    t.ok('ユーザーのブランチは増えず、作業ツリー（未追跡 new.txt）はそのまま', sh(repo, 'branch', '--list').split('\n').length === 2 && sh(repo, 'status', '--porcelain').includes('?? new.txt'));
    const loaded = await c.cmd('loadSession', { sessionId: sid });
    const saved = loaded.presents.find((p) => p.kind === 'git');
    t.ok('要約は会話に保存され、読み直しても出る（at はターンの終わり）', saved?.git.pr?.number === 9 && Date.parse(saved.at) >= Date.parse(loaded.messages.at(-1)?.at ?? 0) - 1000, JSON.stringify(saved));

    // ---- 2. 何も動かないターンは要約を出さない
    const quiet = await c.runTurn({ sessionId: sid, prompt: 'echo:ok' });
    t.ok('git が動かなかったターンは要約を出さない', !quiet.events.some((e) => e.type === 'present' && e.kind === 'git'));
    t.ok('動かなかったターンの start の ref は残さない', refs().length === 2, refs().join());

    // ---- 3. パネルの口
    const status = await c.cmd('gitStatus', { sessionId: sid });
    t.ok('gitStatus: ブランチ・変更の数・linked でない', status.git?.branch === 'fix/x' && status.git.dirty === 1 && status.git.linked === false && status.git.ahead === null, JSON.stringify(status));
    const panel = await c.cmd('gitPanel', { sessionId: sid, range: 'session' });
    t.ok('gitPanel: 状態・タイムライン（作成・コミット・PR の順）・この会話の間の変更', panel.git.branch === 'fix/x'
      && panel.timeline.map((e) => e.kind).join() === 'branch,commit,pr' && panel.timeline[1].hash === 'abcdef0' && panel.timeline.every((e) => e.uuid)
      && panel.changes.range === 'session' && panel.changes.hasSession && panel.changes.files.map((f) => f.path).join() === 'core/a.mjs,new.txt', JSON.stringify([panel.timeline, panel.changes]));
    const uncommitted = await c.cmd('gitPanel', { sessionId: sid, range: 'uncommitted' });
    t.ok('gitPanel: コミットしていない分は new.txt だけ', uncommitted.changes.files.map((f) => f.path).join() === 'new.txt' && uncommitted.changes.files[0].state === 'A');
    const diff = await c.cmd('gitDiff', { sessionId: sid, range: 'session', path: 'core/a.mjs' });
    t.ok('gitDiff: ハンクの行', diff.diff?.hunks[0].lines.some((l) => l.t === '+' && l.s === 'TWO') && diff.diff.binary === false, JSON.stringify(diff));
    const fresh = await c.cmd('gitStatus', { sessionId: sid, summary: true });
    t.ok('gitStatus summary: 会話の間のファイル・コミット', fresh.git.session?.files === 2 && fresh.git.session.commits === 1, JSON.stringify(fresh.git.session));

    // ---- 4. 作業場所の検証
    t.ok('知らない会話は null', (await c.cmd('gitStatus', { sessionId: 'no-such-session' })).git === null);
    t.ok('会話の無い下書きの cwd は、使ったことのある場所だけ通す', (await c.cmd('gitStatus', { cwd: repo })).git?.branch === 'fix/x' && (await c.cmd('gitStatus', { cwd: scratch })).git === null);
    t.ok('引数が無くても落ちない', (await c.cmd('gitStatus', {})).git === null && (await c.cmd('gitDiff', {})).diff === null);

    // ---- 5. git 管理外
    const nogit = await c.runTurn({ backend: 'fake', cwd: plain, prompt: 'echo:hi' });
    t.ok('git 管理外では要約を出さず、状態は null', !nogit.events.some((e) => e.type === 'present' && e.kind === 'git') && (await c.cmd('gitStatus', { sessionId: nogit.sessionId })).git === null);
    t.ok('git 管理外のターンは ref を作らない', refs().length === 2);

    // ---- 6. 委譲の子の完了通知に変更の 1 行
    const wt = path.join(scratch, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'pleiad/ply-1', wt);
    const childSteps = { steps: [{ tool: 'Bash', input: { command: 'work' }, result: 'ok', ask: true }, { text: '終わった' }] };
    const parentFrom = c.mark();
    const parentRun = c.runTurn({ backend: 'fake', cwd: repo, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', task: `steps:${JSON.stringify(childSteps)}`, cwd: wt }) });
    // 子のツールを承認待ちに止め、子が worktree を変え終わるまで終わらせない（実時間の長さで待たない）
    const started = await permissionBeforeTurnEnd(parentRun, parentFrom);
    await startSnapped(started.sessionId);
    await fs.writeFile(path.join(wt, 'w1.txt'), 'a\nb\n');
    sh(wt, 'add', '.'); sh(wt, 'commit', '-q', '-m', 'child: w1');
    await fs.writeFile(path.join(wt, 'w2.txt'), 'c\n');
    await c.cmd('resolvePermission', { id: started.id, allow: true });
    const parent = await parentRun;
    // 遅い環境では、子が始まって終わるまでに 10 秒を超える。待つ上限は長く取る
    let row;
    for (let i = 0; i < 600 && !(row = (await c.cmd('agentTasks')).find((r) => r.parentSessionId && ['completed', 'failed'].includes(r.status))); i++) await sleep(100);
    t.ok('子のタスクの記録に変更の要約（ブランチ・ファイル・コミット）が載る', row?.git?.branch === 'pleiad/ply-1' && row.git.files === 2 && row.git.commits === 1 && row.git.linked === true, JSON.stringify(row?.git));
    const notices = [];
    for (let i = 0; i < 300 && !notices.length; i++) { notices.push(...c.since(parentFrom).filter((e) => e.type === 'taskNotice' && /Pleiad タスク完了通知/.test(e.text))); await sleep(100); }
    t.ok('完了通知に「変更: <branch> · N ファイル +a −d · コミット k」', notices.some((n) => /変更: pleiad\/ply-1 · 2 ファイル \+3 −0 · コミット 1/.test(n.text)), notices.map((n) => n.text).join('\n---\n').slice(0, 600));
    // ply_task_status にも 1 行の要約（gitSummary）
    for (let i = 0; i < 300 && (await c.cmd('running')).turns.length; i++) await sleep(100);
    const asked = await c.runTurn({ sessionId: parent.sessionId, prompt: ply('ply_task_status', { taskId: row.taskId }) });
    const reply = (await c.cmd('loadSession', { sessionId: asked.sessionId })).messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
    t.ok('ply_task_status の結果にも gitSummary（変更: …）', /gitSummary":"変更: pleiad\/ply-1 · 2 ファイル \+3 −0 · コミット 1/.test(reply), reply.slice(0, 400));
    void started;
  } finally {
    c.close();
    await server.stop?.();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
