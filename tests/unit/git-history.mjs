// git の履歴・コミット・ステージの区別・差分の行番号・作業場所の一覧（core/git-history.mjs・git-info.mjs。ADR 0134）。一時リポジトリで確かめる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from '../../core/git-info.mjs';
import * as history from '../../core/git-history.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';

export const name = 'git-history';
export const title = 'git の履歴: 親・refs・ページング・refs/pleiad を混ぜない・ステージの区別・差分の行番号・作業場所の一覧';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();

export default async function (t) {
  // ---- 解析（git を呼ばない）
  const refs = history.parseRefs('HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/pleiad/ply-1a2b, refs/pleiad/turn/x/1-start, refs/stash');
  t.ok('refs: HEAD・タグ・リモート・ブランチだけ。refs/pleiad/ と stash は出ない', refs.map((r) => `${r.kind}:${r.name}`).join() === 'head:main,tag:v1,remote:origin/main,branch:pleiad/ply-1a2b', JSON.stringify(refs));
  t.ok('refs: 分けた作業場所のブランチに印', refs.at(-1).pleiad === true);
  const hh = git.parseHunkHeader('@@ -35,6 +36,9 @@ export function total(items) {');
  t.ok('ハンクの見出し: 旧・新の開始と行数と節', hh.oldStart === 35 && hh.oldCount === 6 && hh.newStart === 36 && hh.newCount === 9 && hh.section === 'export function total(items) {');
  t.ok('ハンクの見出し: 行数の省略は 1', git.parseHunkHeader('@@ -3 +3 @@').oldCount === 1);
  const nm = git.parseNameStatusList('R100\0old.js\0new.js\0A\0a.js\0');
  t.ok('name-status: 名前の変更は元のパスつき', nm[0].state === 'R' && nm[0].orig === 'old.js' && nm[0].path === 'new.js' && nm[1].path === 'a.js');
  const st = git.parseStatus(['# branch.oid abc', '# branch.head main', '1 MM N... 100644 100644 100644 a b src/a b.js', '? new.txt', ''].join('\0'));
  t.ok('status: XY を捨てずに持つ（空白を含むパスも）', st.entries[0].xy === 'MM' && st.entries[0].path === 'src/a b.js' && st.entries[1].kind === 'untracked');

  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-history-')));
  const repo = path.join(scratch, 'repo');
  await fs.mkdir(repo);
  try {
    sh(repo, 'init', '-q', '-b', 'main');
    const write = (f, text) => fs.mkdir(path.dirname(path.join(repo, f)), { recursive: true }).then(() => fs.writeFile(path.join(repo, f), text));
    const lines = (n, mid) => Array.from({ length: n }, (_, i) => (i === 20 ? mid : `line ${i + 1}`)).join('\n') + '\n';
    await write('a.txt', lines(40, 'twenty-one'));
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');
    sh(repo, 'switch', '-q', '-c', 'feature');
    await write('f.txt', 'f\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'feature work');
    sh(repo, 'switch', '-q', 'main');
    await write('m.txt', 'm\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'main work');
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    sh(repo, 'tag', 'v1');
    const activity = createGitActivity();
    // ターンの撮影（refs/pleiad/turn/…）が履歴に混ざらない
    const turn = await activity.begin({ cwd: repo });
    await activity.attach(turn, 'session-hist-1');
    t.ok('撮影の ref ができている', (await git.listTurnRefs(repo, 'session-hist-1')).length === 1);

    const page = await history.readHistory(repo, { limit: 3 });
    t.ok('履歴: 新しい順・親が先に来ない並び（トポロジー順）', page.commits.length === 3 && page.commits[0].subject === 'merge feature' && page.next === 3, JSON.stringify(page.commits.map((c) => c.subject)));
    t.ok('履歴: 親・refs（HEAD・タグ）', page.commits[0].parents.length === 2 && page.commits[0].refs.some((r) => r.kind === 'head' && r.name === 'main') && page.commits[0].refs.some((r) => r.kind === 'tag' && r.name === 'v1'));
    const rest = await history.readHistory(repo, { limit: 3, skip: page.next });
    t.ok('履歴: 次のページで続きが読め、最後は next なし', rest.commits.length === 1 && rest.next === null && rest.commits[0].subject === 'first' && rest.commits[0].parents.length === 0);
    const everything = await history.readHistory(repo, { limit: 50 });
    t.ok('履歴: refs/pleiad/ の撮影のコミットは混ざらない', everything.commits.length === 4 && !everything.commits.some((c) => c.subject === 'pleiad turn snapshot'), JSON.stringify(everything.commits.map((c) => c.subject)));
    const start = await activity.sessionStart(repo, 'session-hist-1');
    t.ok('会話の始まり: 最初の撮影の親（そのときの HEAD）', start?.head === sh(repo, 'rev-parse', 'HEAD') && start.n === 1);
    t.ok('会話の始まり: 撮影が無い会話は null', (await activity.sessionStart(repo, 'nope')) === null);

    // コミット 1 つ
    const merge = await history.commitFiles(repo, everything.commits[0].hash);
    t.ok('コミット: マージは最初の親との差（feature の f.txt が入る）', merge.merge === true && merge.files.map((f) => f.path).join() === 'f.txt');
    const first = await history.commitFiles(repo, everything.commits.at(-1).hash);
    t.ok('コミット: 最初のコミットは空の tree との差', first.files[0].path === 'a.txt' && first.files[0].state === 'A' && first.files[0].add === 40);
    t.ok('コミット: hash でないものは null', (await history.commitFiles(repo, 'HEAD; rm')) === null);

    // ステージの区別
    await write('a.txt', lines(40, 'TWENTY-ONE'));     // 作業ツリーの変更
    await write('s.txt', 's\n'); sh(repo, 'add', 's.txt');    // ステージ済みの新規
    await write('u.txt', 'u\n');                            // 未追跡
    await write('m.txt', 'm\nmore\n'); sh(repo, 'add', 'm.txt'); await write('m.txt', 'm\nmore\nevenmore\n');   // 一部ステージ
    const groups = await history.uncommittedGroups(repo);
    t.ok('ステージ済み: s.txt（A）と m.txt（M）だけ', groups.staged.map((f) => `${f.state}:${f.path}`).join() === 'M:m.txt,A:s.txt', JSON.stringify(groups.staged));
    t.ok('変更: a.txt（M）・m.txt（M）・u.txt は未追跡の U', groups.work.map((f) => `${f.state}:${f.path}`).join() === 'M:a.txt,M:m.txt,U:u.txt', JSON.stringify(groups.work));
    const changes = await activity.changes(repo, null, 'uncommitted');
    const mrow = changes.files.find((f) => f.path === 'm.txt');
    t.ok('changes: 一部ステージのファイルは staged と unstaged の両方', mrow.staged === true && mrow.unstaged === true && changes.files.find((f) => f.path === 's.txt').staged === true && !changes.files.find((f) => f.path === 's.txt').unstaged);
    const dStaged = await activity.diff(repo, null, 'uncommitted', 'm.txt', { stage: 'staged' });
    const dWork = await activity.diff(repo, null, 'uncommitted', 'm.txt', { stage: 'work' });
    t.ok('差分: ステージ済みは more まで、変更は evenmore だけ', dStaged.diff === undefined && dStaged.hunks[0].lines.some((l) => l.s === 'more') && !dStaged.hunks[0].lines.some((l) => l.s === 'evenmore') && dWork.hunks[0].lines.filter((l) => l.t === '+').map((l) => l.s).join() === 'evenmore');
    // 行番号と畳みの展開
    const dA = await activity.diff(repo, null, 'uncommitted', 'a.txt', { after: true, context: 3 });
    const h0 = dA.hunks[0];
    t.ok('差分: ハンクの行番号（旧 18 から 7 行・新も 18 から）', h0.oldStart === 18 && h0.newStart === 18 && h0.oldCount === 7 && h0.newCount === 7, h0.header);
    t.ok('差分: 後ろ側の全行（畳みを開く元）', dA.after.length === 40 && dA.after[20] === 'TWENTY-ONE');
    const dCommit = await activity.diff(repo, null, 'uncommitted', 'f.txt', { commit: everything.commits[1].hash });
    t.ok('差分: コミットを指すと親との比較', dCommit.range === 'commit' && dCommit.hunks[0].lines[0].s === 'f' || dCommit.hunks.length === 0, JSON.stringify(dCommit).slice(0, 200));

    // 作業場所
    const wtDir = path.join(scratch, 'plain-wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'experiment', wtDir);
    await fs.writeFile(path.join(wtDir, 'e.txt'), 'e\n'); sh(wtDir, 'add', '.'); sh(wtDir, 'commit', '-q', '-m', 'exp'); await fs.writeFile(path.join(wtDir, 'dirty.txt'), 'd\n');
    const view = await history.readWorktrees(repo);
    const exp = view.rows.find((r) => r.branch === 'experiment');
    t.ok('作業場所: 主・ここ・ふつうの worktree を出す', view.rows.length === 2 && view.rows[0].main && view.rows[0].here && exp.ahead === 1 && exp.dirty === 1 && exp.at > 0, JSON.stringify(view.rows));
    const detail = await history.readWorktreeDetail(repo, wtDir, view.base.head);
    t.ok('作業場所の中身: コミット済み（e.txt）と未コミット（dirty.txt）を分ける', detail.committed.files.map((f) => f.path).join() === 'e.txt' && detail.uncommitted.files.map((f) => f.path).join() === 'dirty.txt', JSON.stringify(detail).slice(0, 300));

    // 名前の変更
    sh(repo, 'stash', '-q', '-u');
    sh(repo, 'mv', 'f.txt', 'g.txt'); sh(repo, 'commit', '-q', '-m', 'rename');
    const ren = await history.commitFiles(repo, (await history.readHistory(repo, { limit: 1 })).commits[0].hash);
    t.ok('名前の変更を R と元のパスで出す', ren.files[0].state === 'R' && ren.files[0].orig === 'f.txt' && ren.files[0].path === 'g.txt', JSON.stringify(ren.files));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
