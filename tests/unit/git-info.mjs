// ホストの git の問い合わせ（core/git-info.mjs・git-timeline.mjs・git-activity.mjs。ADR 0085）。
// 状態の解析・差分の解析・コマンドの結果からのタイムライン・隠し ref の作成と掃除を、一時リポジトリで確かめる。
// ユーザーの index・HEAD・ブランチに触れないこと、git 管理外は null になることも見る。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from '../../core/git-info.mjs';
import { createGitActivity } from '../../core/git-activity.mjs';
import { eventsFromCall, timelineOf, shellWords, createCallTracker, commandOf } from '../../core/git-timeline.mjs';

export const name = 'git-info';
export const title = 'git の動き: 状態・差分の解析、コマンド結果からのタイムライン、隠し ref の撮影と掃除（一時リポジトリ）';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });

export default async function (t) {
  // ---- 解析（git を呼ばない）
  const st = git.parseStatus([
    '# branch.oid 3f2a9c1d4e5f60718293a4b5c6d7e8f901234567', '# branch.head fix/token', '# branch.upstream origin/fix/token', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb core/auth.mjs', '2 R. N... 100644 100644 100644 aaa bbb R100 new.mjs', 'old.mjs', 'u UU N... 1 2 3 4 aaa bbb ccc x.mjs', '? scratch.txt', '? other.txt', ''].join('\0'));
  t.ok('status: ブランチ・upstream・ahead/behind', st.branch === 'fix/token' && st.upstream === 'origin/fix/token' && st.ahead === 2 && st.behind === 1, JSON.stringify(st));
  t.ok('status: 変更・競合・未追跡の数（名前の変更は元のパスを数えない）', st.changed === 2 && st.conflicts === 1 && st.untracked === 2 && st.dirty === 5, JSON.stringify(st));
  const detached = git.parseStatus('# branch.oid abc\0# branch.head (detached)\0');
  t.ok('status: 分離した HEAD と最初のコミット前', detached.detached && detached.branch === null && git.parseStatus('# branch.oid (initial)\0# branch.head main\0').oid === null);
  const files = git.parseNumstat('3\t1\tcore/a.mjs\0-\t-\timg.png\0');
  t.ok('numstat: 行数とバイナリ', files.length === 2 && files[0].add === 3 && files[0].del === 1 && files[1].binary === true && files[1].add === 0, JSON.stringify(files));
  t.ok('name-status: 新規・変更・削除', [...git.parseNameStatus('A\0new.txt\0M\0a.txt\0D\0gone.txt\0')].map(([p, s]) => `${p}:${s}`).join() === 'new.txt:A,a.txt:M,gone.txt:D');
  const parsed = git.parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn\n keep\n-old\n+new\n\\ No newline at end of file\n');
  t.ok('統一差分: ヘッダーを捨て、行を + - 空白で分ける', parsed.hunks.length === 1 && parsed.hunks[0].header.startsWith('@@ -1,2') && parsed.hunks[0].lines.map((l) => l.t).join('') === ' -+', JSON.stringify(parsed));

  // ---- タイムライン（git を呼ばない）
  t.ok('語の分割: 引用符・連結', shellWords('git add a && git commit -m "fix: a b" ; echo x').join('|') === 'git|add|a|&&|git|commit|-m|fix: a b|;|echo|x');
  t.ok('checkout -b / switch -c / 前置きの -C', eventsFromCall({ command: 'git checkout -b fix/x', text: "Switched to a new branch 'fix/x'" })[0]?.branch === 'fix/x'
    && eventsFromCall({ command: 'git -C repo switch -c feat/y', text: '' })[0]?.branch === 'feat/y'
    && eventsFromCall({ command: 'git switch --create z', text: '' })[0]?.branch === 'z');
  t.ok('チェックアウトだけ・ブランチの切り替えだけは作成にしない', eventsFromCall({ command: 'git checkout main', text: '' }).length === 0 && eventsFromCall({ command: 'git switch main', text: '' }).length === 0);
  const commit = eventsFromCall({ command: 'git add a && git commit -m "fix: a"', text: '[fix/x 3f2a9c1abc] fix: a\n 1 file changed, 2 insertions(+)\n' });
  t.ok('commit: [ブランチ hash] 件名（hash は 7 桁）', commit.length === 1 && commit[0].kind === 'commit' && commit[0].branch === 'fix/x' && commit[0].hash === '3f2a9c1' && commit[0].subject === 'fix: a', JSON.stringify(commit));
  t.ok('commit: 最初のコミット (root-commit)', eventsFromCall({ command: 'git commit -m a', text: '[main (root-commit) abcdef0] a\n' })[0]?.hash === 'abcdef0');
  t.ok('commit: 失敗・何もコミットしていない結果は拾わない', eventsFromCall({ command: 'git commit -m a', text: 'nothing to commit', isError: false }).length === 0
    && eventsFromCall({ command: 'git commit -m a', text: '[main abcdef0] a', isError: true }).length === 0
    && eventsFromCall({ command: 'git commit -m a', text: 'exit=1\n[main abcdef0] a' }).length === 0);
  t.ok('commit: git commit でないコマンドの出力に似た行は拾わない', eventsFromCall({ command: 'echo "[main abcdef0] fake"', text: '[main abcdef0] fake' }).length === 0);
  const pr = eventsFromCall({ command: 'gh pr create --title "x" --body "y"', text: 'https://github.com/example/pleiad/pull/128\n' });
  t.ok('gh pr create: URL と番号', pr.length === 1 && pr[0].kind === 'pr' && pr[0].number === 128 && pr[0].url.endsWith('/pull/128'), JSON.stringify(pr));
  t.ok('PowerShell の ; 連結', eventsFromCall({ command: 'git checkout -b a; git commit -m b', text: '[a 1234567] b' }).map((e) => e.kind).join() === 'branch,commit');
  t.ok('入力の command / CommandLine / 配列', commandOf({ command: 'git status' }) === 'git status' && commandOf({ CommandLine: 'git log' }) === 'git log' && commandOf({ command: ['git', 'status'] }) === 'git status' && commandOf({}) === null);
  const line = timelineOf([
    { role: 'user', text: 'x', uuid: 'u0', at: '2026-10-03T03:00:00Z' },
    { role: 'assistant', uuid: 'a1', at: '2026-10-03T03:31:00Z', toolCalls: [{ id: 't1', name: 'Bash', input: { command: 'git checkout -b fix/token-refresh' }, result: { text: 'Switched', isError: false } }] },
    { role: 'assistant', uuid: 'a2', at: '2026-10-03T03:38:00Z', toolCalls: [{ id: 't2', name: 'Bash', input: { command: 'git commit -m "fix"' }, result: { text: '[fix/token-refresh 3f2a9c1] fix\n', isError: false } },
      { id: 't3', name: 'Bash', input: { command: 'gh pr create' }, result: null }] },
    { role: 'assistant', uuid: 'a3', at: '2026-10-03T03:39:00Z', toolCalls: [{ id: 't4', name: 'Bash', input: { command: 'gh pr create' }, result: { text: 'https://github.com/e/p/pull/9', isError: false } }] },
  ]);
  t.ok('タイムライン: 時刻順・各行に会話の場所（uuid）・結果の無い呼び出しは出さない', line.map((e) => e.kind).join() === 'branch,commit,pr' && line[1].uuid === 'a2' && line[1].toolId === 't2' && line[2].at === '2026-10-03T03:39:00Z', JSON.stringify(line));
  const tracker = createCallTracker();
  tracker.track({ type: 'tool.start', id: 'x', name: 'Bash', input: { command: 'gh pr create' } });
  tracker.track({ type: 'tool.result', id: 'x', text: 'https://github.com/e/p/pull/7', isError: false });
  t.ok('ターンの追跡: tool.start と tool.result を id で組にする', tracker.events().length === 1 && tracker.events()[0].number === 7);

  // ---- 本物の git（一時リポジトリ）
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-git-info-'));
  const repo = path.join(scratch, 'repo');
  try {
    await fs.mkdir(path.join(repo, 'core'), { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'core', 'auth.mjs'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-nogit-'));
    t.ok('git 管理外は null（状態・ルート・撮影）', await git.repoInfo(outside) === null && await git.readStatus(outside) === null && await createGitActivity().begin({ cwd: outside }) === null);
    await fs.rm(outside, { recursive: true, force: true });

    const info = await git.repoInfo(path.join(repo, 'core'));
    // 一時フォルダーは短い名前（CI の RUNNER~1）で返ることがあり、git は長い名前で答える。比べる前に実名へ直す
    t.ok('ルートは cwd がサブディレクトリでも取れる・普通のリポジトリは linked でない', info?.root.toLowerCase() === realpathSync.native(repo).replaceAll('\\', '/').toLowerCase() && info.linked === false, JSON.stringify(info));

    const activity = createGitActivity();
    const sid = 'session-aaaa-1';
    const headBefore = sh(repo, 'rev-parse', 'HEAD').trim();

    // ターン 1: ファイルを変え、新規を足し、ブランチを作ってコミットする
    const turn1 = await activity.begin({ cwd: path.join(repo, 'core') });
    t.ok('ターンの始まり: 撮影できる（tree と commit、親は HEAD）', Boolean(turn1?.startTree && turn1.startCommit) && sh(repo, 'rev-parse', `${turn1.startCommit}^`).trim() === headBefore);
    await activity.attach(turn1, sid);
    t.ok('start の ref が書かれる（refs/pleiad/turn/<id>/1-start）', sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/turn/').trim() === `refs/pleiad/turn/${sid}/1-start`);
    await fs.writeFile(path.join(repo, 'core', 'auth.mjs'), 'one\nTWO\nthree\nfour\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'a\nb\n');
    await fs.writeFile(path.join(repo, 'ignored.txt'), 'x\n');
    sh(repo, 'checkout', '-q', '-b', 'fix/token');
    sh(repo, 'add', 'core/auth.mjs'); sh(repo, 'commit', '-q', '-m', 'fix: token');
    const summary1 = await activity.finish(turn1, sid, [{ kind: 'branch', branch: 'fix/token' }, { kind: 'pr', number: 5, url: 'https://github.com/e/p/pull/5' }]);
    t.ok('ターンの終わり: 要約（ブランチ・コミット・PR）', summary1?.branch === 'fix/token' && summary1.commitCount === 1 && summary1.commits[0].subject === 'fix: token' && summary1.pr?.number === 5 && summary1.created === true, JSON.stringify(summary1));
    t.ok('要約のファイル数と行数は始まりの撮影との差（新規ファイルも数え、.gitignore のものは数えない）', summary1.files === 2 && summary1.add === 4 && summary1.del === 1, JSON.stringify(summary1));
    t.ok('end の ref も書かれる', sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/pleiad/turn/').trim().split('\n').sort().join() === `refs/pleiad/turn/${sid}/1-end,refs/pleiad/turn/${sid}/1-start`);

    // ユーザーの HEAD・ブランチ・index・作業ツリーは撮影で動かない（コミットしたのは自分）
    t.ok('撮影はユーザーの index に触れない（ステージしていない new.txt がそのまま）', sh(repo, 'status', '--porcelain').includes('?? new.txt') && !sh(repo, 'diff', '--cached', '--name-only').includes('new.txt'));
    t.ok('撮影はブランチ一覧に出ない', sh(repo, 'branch', '--list').split('\n').filter(Boolean).length === 2 && !/pleiad/.test(sh(repo, 'branch', '-a')));
    t.ok('撮影の commit は HEAD の履歴に入らない', !sh(repo, 'log', '--oneline').includes('pleiad turn snapshot'));

    // ターン 2: 何も変えない → 要約なし、最初でない start は残さない
    const turn2 = await activity.begin({ cwd: repo });
    await activity.attach(turn2, sid);
    const summary2 = await activity.finish(turn2, sid, []);
    const refs2 = (await git.listTurnRefs(info.root, sid)).map((r) => `${r.n}-${r.kind}`).join();
    t.ok('何も動かなかったターンは要約なし・start の ref も残さない', summary2 === null && refs2 === '1-start,1-end', refs2);

    // ターン 3: 1 つ編集するだけ → 番号は 2 から（max + 1）
    const turn3 = await activity.begin({ cwd: repo });
    await activity.attach(turn3, sid);
    await fs.writeFile(path.join(repo, 'new.txt'), 'a\nb\nc\n');
    const summary3 = await activity.finish(turn3, sid, []);
    t.ok('ファイルだけ変えたターンは要約（コミット・ブランチ変更なし）', summary3?.files === 1 && summary3.add === 1 && summary3.del === 0 && summary3.commitCount === 0 && summary3.n === 2, JSON.stringify(summary3));

    // パネル
    const unc = await activity.changes(repo, sid, 'uncommitted');
    t.ok('パネル「コミットしていない分」: HEAD と今の差（新規含む）', unc?.range === 'uncommitted' && unc.files.map((f) => `${f.state}:${f.path}`).join() === 'A:new.txt' && unc.total.add === 3, JSON.stringify(unc));
    const ses = await activity.changes(repo, sid, 'session');
    t.ok('パネル「この会話の間」: 最初の start と今の差（コミットした分も入る）', ses?.range === 'session' && ses.hasSession && ses.files.map((f) => f.path).join() === 'core/auth.mjs,new.txt' && ses.total.add === 5, JSON.stringify(ses));
    const none = await activity.changes(repo, 'unknown-session', 'session');
    t.ok('撮影の無い会話は「この会話の間」が使えず、コミットしていない分に戻る', none?.range === 'uncommitted' && none.hasSession === false);
    const d = await activity.diff(repo, sid, 'session', 'core/auth.mjs');
    t.ok('差分: ハンクの行（+ − 空白）', d?.hunks.length === 1 && d.hunks[0].lines.some((l) => l.t === '-' && l.s === 'two') && d.hunks[0].lines.some((l) => l.t === '+' && l.s === 'TWO') && !d.binary, JSON.stringify(d));
    await fs.writeFile(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
    const bin = await activity.diff(repo, sid, 'uncommitted', 'bin.dat');
    t.ok('バイナリは本文を返さない', bin?.binary === true && bin.hunks.length === 0, JSON.stringify(bin));
    t.ok('パスのグロブは文字どおりに扱う（*.txt は 1 ファイルにも当たらない）', (await activity.diff(repo, sid, 'uncommitted', '*.txt'))?.hunks.length === 0);

    // 要約（委譲カードと完了通知）
    const sum = await activity.summary(repo, sid);
    t.ok('summary: 状態と、会話の間のファイル数・コミット数', sum?.branch === 'fix/token' && sum.session?.commits === 1 && sum.session.files === 3, JSON.stringify(sum));
    t.ok('summary: 撮影が無ければ session は null', (await activity.summary(repo, 'nothing'))?.session === null);

    // 状態
    const status = await activity.status(repo, { fresh: true });
    t.ok('状態: ブランチ・変更の数（未追跡含む）・upstream なし', status.branch === 'fix/token' && status.dirty === 2 && status.upstream === null && status.ahead === null, JSON.stringify(status));

    // 掃除
    t.ok('30 日より古い ref は掃除される', (await git.pruneTurnRefs(info.root, 30 * 24 * 60 * 60 * 1000, Date.now() + 40 * 24 * 60 * 60 * 1000)) > 0 && (await git.listTurnRefs(info.root)).length === 0);
    // 会話を消したら ref も消える
    const turn4 = await activity.begin({ cwd: repo });
    await activity.attach(turn4, 'session-bbbb-2');
    await activity.attach(await activity.begin({ cwd: repo }), 'session-cccc-3');
    t.ok('会話の ref を消すと、その会話の分だけ消える', (await activity.forget(repo, 'session-bbbb-2')) === 1 && (await git.listTurnRefs(info.root)).map((r) => r.session).join() === 'session-cccc-3');

    // worktree
    const wt = path.join(scratch, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'pleiad/ply-1', wt);
    const wtInfo = await git.repoInfo(wt);
    t.ok('git worktree は linked（worktree）で、状態のブランチも取れる', wtInfo?.linked === true && (await git.readStatus(wt))?.branch === 'pleiad/ply-1');
    const wturn = await activity.begin({ cwd: wt });
    await activity.attach(wturn, 'session-dddd-4');
    await fs.writeFile(path.join(wt, 'x.txt'), 'x\n');
    const wsum = await activity.finish(wturn, 'session-dddd-4', []);
    t.ok('worktree でも撮影・要約ができる（ref は共有の .git に書かれる）', wsum?.files === 1 && wsum.linked === true && (await git.listTurnRefs(info.root, 'session-dddd-4')).length === 2);

    // 初回のコミット前のリポジトリ
    const fresh = path.join(scratch, 'fresh');
    await fs.mkdir(fresh);
    sh(fresh, 'init', '-q', '-b', 'main');
    const fturn = await activity.begin({ cwd: fresh });
    await activity.attach(fturn, 'session-eeee-5');
    await fs.writeFile(path.join(fresh, 'a.txt'), 'a\n');
    const fsum = await activity.finish(fturn, 'session-eeee-5', []);
    const fchanges = await activity.changes(fresh, 'session-eeee-5', 'uncommitted');
    t.ok('コミット前のリポジトリでも動く（親なしの撮影・空の tree との差）', fsum?.files === 1 && fchanges?.files[0]?.path === 'a.txt', JSON.stringify([fsum, fchanges]));

    // 追い越し: 書く操作は refs/pleiad だけ・読み取り以外は断る
    let threw = 0;
    try { git.readGit(repo, ['commit', '-m', 'x']); } catch { threw++; }
    try { await git.updateRef(repo, 'refs/heads/main', headBefore); } catch { threw++; }
    t.ok('許可していない git のサブコマンドと refs/pleiad/ 以外への update-ref は投げる', threw === 2);
    t.ok('ユーザーのブランチの先頭は撮影で動いていない', sh(repo, 'rev-parse', 'main').trim() === headBefore);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
