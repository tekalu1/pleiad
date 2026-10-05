// worktree をサーバー越しに（fake + 一時リポジトリ。ADR 0089）。
// ぶつかりの判定（書き込み中の別の会話・読むだけ・git 管理外・自分は数えない）・worktree で始める（予約・取り消し・戻す）・
// 自動では作らない・委譲の子は isolate: true のときだけ作る・完了通知と ply_task_status の作業場所の行・
// 取り込み後の片付け・右パネルの残り（残す・退避・作り直し）・ファイルのプレビューの許可。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { COMMANDS } from '../../core/protocol.mjs';

export const name = 'server-worktree';
export const title = 'worktree（サーバー越し）: ぶつかりの判定・明示したときだけ作る・委譲の isolate・完了通知・取り込み後の片付け・退避と作り直し';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const exists = (p) => fs.stat(p).then(() => true, () => false);
const slash = (p) => p.replaceAll('\\', '/');
const long = (ms = 4000) => `steps:${JSON.stringify({ steps: [{ tool: 'Bash', input: { command: 'work' }, result: 'ok', ms }, { text: 'done' }] })}`;

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = slash(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-wt-'))));
  const repo = `${scratch}/repo`;
  const plain = `${scratch}/plain`;
  await fs.mkdir(`${repo}/core`, { recursive: true });
  await fs.mkdir(plain, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(`${repo}/core/a.mjs`, 'one\ntwo\n');
  await fs.writeFile(`${repo}/.gitignore`, 'node_modules\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');

  const dataDir = `${scratch}/data`;
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_WORKTREES: 'on', AGENT_HOST_WORKTREE_GRACE_MS: '0' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const branches = () => sh(repo, 'branch', '--list', 'pleiad/*').split('\n').map((s) => s.replace(/^[*+ ]+/, '')).filter(Boolean);
  // 走っているターンが無く、委譲の完了通知で始まるターンも落ち着くまで待つ（続けて同じ会話へ送ると「切り替え中」になる）
  const quiet = async () => {
    let calm = 0;
    for (let i = 0; i < 200 && calm < 4; i++) { await sleep(150); calm = (await c.cmd('running')).turns.length === 0 ? calm + 1 : 0; }
  };
  const startLong = async (cwd, ms = 4000) => {
    const from = c.mark();
    const running = c.runTurn({ backend: 'fake', cwd, prompt: long(ms) });
    const tool = await c.waitFor((e) => e.type === 'tool.start', { from });
    return { running, sessionId: tool.sessionId };
  };
  try {
    t.ok('コマンドを protocol に登録している', ['worktreeCheck', 'worktreeSplit', 'worktreeDiscard', 'worktreeKeep', 'worktreeArchive', 'worktreeRestore'].every((n) => COMMANDS.has(n)));

    // ---- 1. ぶつかりの判定
    const seed = await c.runTurn({ backend: 'fake', cwd: repo, prompt: 'echo:seed' });          // repo を「使ったことのある場所」にする
    await c.runTurn({ backend: 'fake', cwd: plain, prompt: 'echo:seed' });
    const idle = await c.cmd('worktreeCheck', { cwd: repo, backend: 'fake', mode: 'default' });
    t.ok('誰も書いていなければ conflicts は空・worktree を作れる（git）', idle.git === true && idle.conflicts.length === 0 && idle.canSplit === true, JSON.stringify(idle));
    t.ok('check に自動作成の always は無い', !('always' in idle));
    const A = await startLong(repo, 40_000);
    const busy = await c.cmd('worktreeCheck', { cwd: repo, backend: 'fake', mode: 'default' });
    t.ok('同じリポジトリで書き込みのターンが走っていれば、その会話が conflicts に出る', busy.conflicts.length === 1 && busy.conflicts[0].sessionId === A.sessionId && busy.canSplit === true, JSON.stringify(busy));
    t.ok('走っている会話自身は数えない', (await c.cmd('worktreeCheck', { sessionId: A.sessionId, cwd: repo })).conflicts.length === 0);
    t.ok('git 管理外には何も出さない', (await c.cmd('worktreeCheck', { cwd: plain, backend: 'fake', mode: 'default' })).git === false);
    t.ok('知らない場所は答えない（任意のフォルダーで git を走らせない）', (await c.cmd('worktreeCheck', { cwd: scratch, backend: 'fake', mode: 'default' })).git === false);
    t.ok('会話の cwd からも同じ結果', (await c.cmd('worktreeCheck', { sessionId: seed.sessionId, backend: 'fake', mode: 'default' })).conflicts.length === 1);

    // ---- 2. worktree で始める（作って予約・取り消し・予約して始める・戻す）
    const split = await c.cmd('worktreeSplit', { sessionId: seed.sessionId, cwd: repo });
    const wt = split.worktree;
    t.ok('分ける: リポジトリの隣・専用ブランチ・ブランチ付き', wt.path === `${scratch}/repo.pleiad/${wt.id}` && wt.branch === `pleiad/${wt.id}` && split.cwd === wt.path && (await exists(`${wt.path}/core/a.mjs`)) && branches().includes(wt.branch), JSON.stringify(split));
    await c.cmd('setTurnSettings', { sessionId: seed.sessionId, cwd: split.cwd });
    const reserved = await c.cmd('worktreeCheck', { sessionId: seed.sessionId, cwd: split.cwd, backend: 'fake', mode: 'default' });
    t.ok('予約した worktree は、チェックで current になる（元の場所・ブランチ付き）', reserved.current?.id === wt.id && reserved.current.origin === repo && reserved.canSplit === false && reserved.conflicts.length === 0, JSON.stringify(reserved));
    await c.cmd('setTurnSettings', { sessionId: seed.sessionId, cancel: true });
    for (let i = 0; i < 80 && (await exists(wt.path) || branches().includes(wt.branch)); i++) await sleep(100);
    t.ok('予約を取り消すと、使っていない worktree は片付く（フォルダー・ブランチ）', !(await exists(wt.path)) && !branches().includes(wt.branch));

    const split2 = (await c.cmd('worktreeSplit', { sessionId: seed.sessionId, cwd: repo })).worktree;
    await c.cmd('setTurnSettings', { sessionId: seed.sessionId, cwd: split2.path });
    const started = await c.runTurn({ sessionId: seed.sessionId, prompt: 'echo:in-wt' });
    const sessions = await c.cmd('listSessions', {});
    const row = sessions.find((s) => s.id === seed.sessionId);
    t.ok('予約して始めたターンは worktree で走り、会話の cwd がそこになる（変更履歴に残る）', started.outcome === 'ok' && slash(row?.cwd ?? '') === split2.path
      && (await c.cmd('loadSession', { sessionId: seed.sessionId })).messages.length > 0, JSON.stringify(row?.cwd));
    // 使っている会話が居る間は、掃除しても消えない
    t.ok('cwd がそこにある会話が居る間は消えない', (await exists(split2.path)) && branches().includes(split2.branch));
    // ファイルのプレビュー: worktree の中のファイルが読める（ADR 0050。置き場はリポジトリの隣）
    await fs.writeFile(`${split2.path}/note.txt`, 'wip\n');
    const url = `http://127.0.0.1:${server.port}/file-preview?token=${server.token}&sessionId=${seed.sessionId}&path=${encodeURIComponent(`${split2.path}/note.txt`)}`;
    const preview = await fetch(url);
    const previewBody = await preview.json().catch(() => null);
    t.ok('worktree の中のファイルはプレビューできる', preview.status === 200 && JSON.stringify(previewBody).includes('wip'), String(preview.status));

    // 元の場所に戻す（次のターンから）。変更があるので、戻した後も残り、右パネルの「残っている worktree」に出る
    await c.cmd('setTurnSettings', { sessionId: seed.sessionId, cwd: repo });
    await c.runTurn({ sessionId: seed.sessionId, prompt: 'echo:back' });
    const back = (await c.cmd('listSessions', {})).find((s) => s.id === seed.sessionId);
    t.ok('戻したターンは元の場所で走る', slash(back?.cwd ?? '') === repo);
    await sleep(500);
    t.ok('未コミットの変更がある worktree は、戻した後も残る', (await exists(split2.path)) && branches().includes(split2.branch));
    const panel = await c.cmd('gitPanel', { sessionId: seed.sessionId, range: 'uncommitted' });
    const left = panel.worktrees?.leftovers?.find((x) => x.id === split2.id);
    t.ok('右パネルの残っている worktree: ブランチ・ファイル数・取り込みを頼む相手（その会話）', left?.branch === split2.branch && left.files === 1 && left.mergeSessionId === seed.sessionId && left.fileNames.includes('note.txt') && left.baseBranch === 'main', JSON.stringify(left));
    t.ok('「残す」: kept になる', (await c.cmd('worktreeKeep', { id: split2.id, kept: true })).kept === true && (await c.cmd('gitPanel', { sessionId: seed.sessionId })).worktrees.leftovers[0].kept === true);
    await c.cmd('worktreeKeep', { id: split2.id, kept: false });
    t.ok('変更のあるものは worktreeDiscard でも消えない', (await c.cmd('worktreeDiscard', { id: split2.id })).action === 'kept' && (await exists(split2.path)));
    const arch = await c.cmd('worktreeArchive', { id: split2.id });
    t.ok('退避して消す: 隠し ref に撮ってから消える', arch.action === 'removed' && arch.ref.startsWith(`refs/pleiad/archive/${split2.id}/`) && !(await exists(split2.path)) && !branches().includes(split2.branch)
      && sh(repo, 'show', `${arch.ref}:note.txt`) === 'wip', JSON.stringify(arch));
    const restored = await c.cmd('worktreeRestore', { sessionId: seed.sessionId, ref: arch.ref });
    t.ok('元に戻す: 退避から新しい worktree を作り直し、中身（未コミットだったファイル）がある', (await exists(`${restored.worktree.path}/note.txt`)) && (await fs.readFile(`${restored.worktree.path}/note.txt`, 'utf8')).trim() === 'wip' && restored.worktree.id !== split2.id, JSON.stringify(restored));
    await c.cmd('worktreeArchive', { id: restored.worktree.id });

    // ---- 3. 衝突していても自動では worktree を作らない
    const B = await c.runTurn({ backend: 'fake', cwd: repo, prompt: 'echo:busy' });
    const bRow = (await c.cmd('listSessions', {})).find((s) => s.id === B.sessionId);
    t.ok('別の会話が書き込み中でも元の場所で始まり、worktree の印も出ない',
      slash(bRow?.cwd ?? '') === repo && !B.events.some((e) => e.type === 'present' && e.kind === 'worktree') && branches().length === 0);
    await c.cmd('abort', { sessionId: A.sessionId });
    await A.running;
    const C = await c.runTurn({ backend: 'fake', cwd: repo, prompt: 'echo:alone' });
    t.ok('単独の会話も元の場所で始まる', slash((await c.cmd('listSessions', {})).find((s) => s.id === C.sessionId)?.cwd ?? '') === repo);
    t.ok('削除した設定コマンドは protocol に無い', !COMMANDS.has('worktreeSettings') && !COMMANDS.has('setWorktreeSettings'));

    // ---- 4. 委譲: isolate を指定したときだけ作る・子への指示・完了通知・取り込み後の片付け
    const childLong = long(5000);
    const parentFrom = c.mark();
    const first = await c.runTurn({ backend: 'fake', cwd: repo, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', title: 'first', task: childLong }) });
    const firstTask = (await c.cmd('agentTasks')).find((r) => r.title === 'first');
    t.ok('書き手が居なければ、1 つ目の子は今の場所のまま（分けない）', firstTask && !firstTask.worktree && slash(firstTask.cwd) === repo, JSON.stringify(firstTask));
    // 1 つ目の子が repo で書き込み中に、2 つ目を委譲する → 分ける
    await sleep(1000);
    const second = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', title: 'second', task: 'echo:second-job' }) });
    const secondTask = (await c.cmd('agentTasks')).find((r) => r.title === 'second');
    t.ok('書き手が居ても isolate 省略の子は今の場所で走る', secondTask && !secondTask.worktree && slash(secondTask.cwd) === repo, JSON.stringify(secondTask));
    // isolate の明示: true は 1 つだけでも分ける・false は書き手が居ても分けない・読むだけの種類は分けない
    await quiet();
    const third = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_delegate', { kind: 'investigate', backend: 'fake', title: 'third', task: 'echo:read-only' }) });
    const thirdTask = (await c.cmd('agentTasks')).find((r) => r.title === 'third');
    t.ok('読むだけの種類（investigate）は、書き手が居ても分けない', thirdTask && !thirdTask.worktree, JSON.stringify(thirdTask));
    await quiet();
    const forced = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_delegate', { kind: 'investigate', backend: 'fake', title: 'forced', isolate: true, task: childLong }) });
    const forcedTask = (await c.cmd('agentTasks')).find((r) => r.title === 'forced');
    t.ok('isolate: true は、書き手が居なくても分ける', Boolean(forcedTask?.worktree), JSON.stringify(forcedTask?.worktree));
    // 子（forced）が worktree に変更を残して終わる → 未取り込みで残り、通知・status・一覧に出る
    const forcedPath = forcedTask.worktree.path;
    await sleep(500);
    await fs.writeFile(`${forcedPath}/feature.txt`, 'a\nb\n');
    sh(forcedPath, 'add', '.'); sh(forcedPath, 'commit', '-q', '-m', 'child: feature');
    await fs.writeFile(`${forcedPath}/extra.txt`, 'c\n');
    const refused = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', title: 'plain', isolate: false, task: 'echo:no-iso' }) });
    const plainTask = (await c.cmd('agentTasks')).find((r) => r.title === 'plain');
    t.ok('isolate: false は、書き手が居ても今の場所のまま', plainTask && !plainTask.worktree && slash(plainTask.cwd) === repo);
    const bad = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_delegate', { kind: 'implement', backend: 'fake', title: 'bad', isolate: 'yes', task: 'echo:x' }) });
    t.ok('isolate が真偽でなければ断る', /isolate/.test(JSON.stringify(bad.events.find((e) => e.type === 'tool.result')?.text ?? '')) && !(await c.cmd('agentTasks')).some((r) => r.title === 'bad'));
    void third; void refused;

    let forcedDone;
    for (let i = 0; i < 150 && !(forcedDone = (await c.cmd('agentTasks')).find((r) => r.title === 'forced' && ['completed', 'failed'].includes(r.status))); i++) await sleep(100);
    t.ok('変更を残した子の作業場所は残る', Boolean(forcedDone) && (await exists(forcedPath)) && forcedDone.workspace?.state === 'unmerged' && forcedDone.workspace.files === 2 && forcedDone.workspace.removed === false, JSON.stringify(forcedDone?.workspace));
    const notices = [];
    for (let i = 0; i < 80 && !notices.length; i++) { notices.push(...c.since(parentFrom).filter((e) => e.type === 'taskNotice' && /Pleiad タスク完了通知/.test(e.text) && e.text.includes(forcedPath))); await sleep(100); }
    t.ok('依頼元への完了通知に「作業場所: worktree <branch>（未取り込み · N ファイル）」', notices.some((n) => n.text.includes(`作業場所: worktree ${forcedTask.worktree.branch}（未取り込み · 2 ファイル）`)), notices.map((n) => n.text).join('\n---\n').slice(0, 700));
    for (let i = 0; i < 100 && (await c.cmd('running')).turns.length; i++) await sleep(100);
    await quiet();
    const asked = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_task_status', { taskId: forcedTask.taskId }) });
    const reply = (await c.cmd('loadSession', { sessionId: asked.sessionId })).messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
    t.ok('ply_task_status にも workspaceSummary と構造（ブランチ・場所・元・状態）', reply.includes(`"workspaceSummary":"作業場所: worktree ${forcedTask.worktree.branch}（未取り込み · 2 ファイル）`) && /"workspace":\{[^}]*"state":"unmerged"/.test(reply), reply.slice(0, 500));
    // 終わって通知が届いたタスクは running に載らない。画面は会話の分（tree）を読む
    const running = await c.cmd('running');
    const cards = await c.cmd('agentTasks', { sessionId: first.sessionId, tree: true });
    t.ok('会話の分の委譲の行に、台帳に残っている印（未取り込みの表示に使う）。running には載らない',
      cards.find((r) => r.taskId === forcedTask.taskId)?.worktree?.live === true && !running.tasks.some((r) => r.taskId === forcedTask.taskId), JSON.stringify(running.tasks.map((r) => r.taskId)));
    const panel2 = await c.cmd('gitPanel', { sessionId: first.sessionId });
    const leftTask = panel2.worktrees.leftovers.find((x) => x.branch === forcedTask.worktree.branch);
    t.ok('残っている worktree に出る: 取り込みを頼む相手は依頼元の会話', leftTask?.mergeSessionId === first.sessionId && leftTask.purpose === 'task' && leftTask.files === 2, JSON.stringify(leftTask));

    // 取り込み: 依頼元（ここではテストが代わりに）が元の場所へマージする。次のターンの終わりに片付く
    await fs.rm(`${forcedPath}/extra.txt`);
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge forced', forcedTask.worktree.branch);
    await quiet();
    await c.runTurn({ sessionId: first.sessionId, prompt: 'echo:after-merge' });
    for (let i = 0; i < 100 && ((await exists(forcedPath)) || branches().includes(forcedTask.worktree.branch)); i++) await sleep(100);
    t.ok('取り込んだ後は、ターンの終わりの片付けで自動で消える（フォルダー・ブランチ・台帳）', !(await exists(forcedPath)) && !branches().includes(forcedTask.worktree.branch) && !(await c.cmd('running')).tasks.find((r) => r.taskId === forcedTask.taskId)?.worktree?.live);
    await quiet();
    const afterStatus = await c.runTurn({ sessionId: first.sessionId, prompt: ply('ply_task_status', { taskId: forcedTask.taskId }) });
    const afterReply = (await c.cmd('loadSession', { sessionId: afterStatus.sessionId })).messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
    t.ok('片付いた後の ply_task_status は「片付け済み」', /作業場所: worktree pleiad\/ply-[0-9a-f]+（片付け済み）/.test(afterReply), afterReply.slice(0, 400));
  } finally {
    c.close();
    await server.stop?.();
    // 一時のリポジトリと worktree（<repo>.pleiad）を消す
    await fs.rm(`${scratch}/repo.pleiad`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
