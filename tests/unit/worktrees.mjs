// 分けた作業場所（core/worktrees.mjs・git-worktree.mjs。ADR 0089）。一時リポジトリで実際に作って消す。
// 作成と失敗時の巻き戻し・片付けの判定（変更なし／取り込み済み／未取り込み）・使用中は消さない・
// ReparsePoint（ジャンクション）を外してから消す（リンク先が残る）・退避の隠し ref・台帳と git の突き合わせ。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as git from '../../core/git-info.mjs';
import * as wtgit from '../../core/git-worktree.mjs';
import { createWorktrees, findLinks, unlinkAll, insideDir, sameDir } from '../../core/worktrees.mjs';

export const name = 'worktrees';
export const title = '分けた作業場所: 作成・失敗の巻き戻し・片付けの判定・リンクを外してから消す・使用中は消さない・退避・突き合わせ（一時リポジトリ）';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
const exists = (p) => fs.stat(p).then(() => true, () => false);
const slash = (p) => p.replaceAll('\\', '/');

export default async function (t) {
  const scratch = slash(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-wt-')));
  try {
    const repo = `${scratch}/repo`;
    const makeRepo = async (dir, { ignore = true } = {}) => {
      await fs.mkdir(dir, { recursive: true });
      sh(dir, 'init', '-q', '-b', 'main');
      await fs.mkdir(`${dir}/core`);
      await fs.writeFile(`${dir}/core/a.mjs`, 'one\ntwo\n');
      if (ignore) await fs.writeFile(`${dir}/.gitignore`, 'node_modules\n');
      sh(dir, 'add', '-A');
      sh(dir, 'commit', '-q', '-m', 'init');
    };
    await makeRepo(repo);
    const realRepo = slash(await fs.realpath(repo));
    const dataDir = `${scratch}/data`;
    const state = { busy: [], attached: [], released: [], fail: null };
    const make = (extra = {}) => createWorktrees({ dataDir, retryMs: [1, 1], sleep: async () => {},
      users: async () => { if (state.fail) throw new Error('boom'); return { busy: state.busy, attached: state.attached }; },
      release: async (entry, ids) => { state.released.push([entry.id, ids]); }, ...extra });
    let wts = make();

    // ---- 作る
    const created = await wts.create({ cwd: repo, sessionId: 's1', purpose: 'conversation' });
    const e = created.entry;
    t.ok('作成: リポジトリの隣の <名前>.pleiad/<id>・ブランチ pleiad/<id>・ベースは今の HEAD',
      created.ok && e.path === `${realRepo}.pleiad/${e.id}` && e.origin === realRepo && /^ply-[0-9a-f]{4}$/.test(e.id) && e.branch === `pleiad/${e.id}` && e.base === sh(repo, 'rev-parse', 'HEAD').trim() && e.baseBranch === 'main' && e.state === 'ready', JSON.stringify(created));
    t.ok('作成: git に登録され、ブランチ付き（detached ではない）で、依存は張らない', (await wtgit.worktreeList(repo)).some((w) => w.path === e.path && w.branch === e.branch && !w.detached) && !(await exists(`${e.path}/node_modules`)));
    t.ok('作成: 台帳に残る（worktrees.json）・ユーザーのブランチの先頭は動かない', JSON.parse(await fs.readFile(`${dataDir}/worktrees.json`, 'utf8')).entries[e.id].path === e.path && sh(repo, 'rev-parse', 'main').trim() === e.base);
    t.ok('作成: 分けた作業場所の中からは分けない（already-split）・git 管理外は not-git', (await wts.create({ cwd: e.path })).reason === 'already-split' && (await wts.create({ cwd: scratch })).reason === 'not-git');
    const emptyRepo = `${scratch}/empty`;
    await fs.mkdir(emptyRepo); sh(emptyRepo, 'init', '-q', '-b', 'main');
    t.ok('作成: コミットの無いリポジトリは no-commits（作れない）', (await wts.create({ cwd: emptyRepo })).reason === 'no-commits' && !(await exists(`${scratch}/empty.pleiad`)));
    t.ok('台帳: パスで引ける・サブフォルダーは入口の中', (await wts.byPath(`${e.path}/core`))?.id === e.id && (await wts.byPath(repo)) === null && insideDir(`${e.path}/core`, e.path) && !insideDir(`${e.path}2`, e.path) && sameDir('D:\\A\\b/', 'd:/a/b'));
    const sub = await wts.create({ cwd: `${repo}/core` });
    t.ok('サブフォルダーから分けると、中でも同じサブフォルダーが cwd になる', sub.ok && sub.entry.origin === `${realRepo}/core` && wts.cwdOf(sub.entry) === `${sub.entry.path}/core` && (await exists(wts.cwdOf(sub.entry))), JSON.stringify(sub));
    // 変更なし → 消す（片付けの判定のため先にこの 2 つを消しておく）
    const s1 = await wts.settle(sub.entry.id);
    t.ok('変更なしは自動で消える（フォルダー・登録・ブランチ・台帳）', s1.action === 'removed' && s1.kind === 'empty' && !(await exists(sub.entry.path)) && !(await wtgit.branchTip(repo, sub.entry.branch)) && !(await wts.get(sub.entry.id)), JSON.stringify(s1));

    // ---- 失敗の巻き戻し
    const stuck = `${scratch}/stuck`;
    await makeRepo(stuck);
    await fs.writeFile(`${scratch}/stuck.pleiad`, 'a file is in the way');     // 置き場のフォルダーが作れない
    const failed = await wts.create({ cwd: stuck });
    t.ok('作成の失敗: 孤児を残さない（台帳・ブランチ・登録が無い）', failed.ok === false && failed.reason === 'git' && (await wts.list()).every((x) => x.root !== slash(stuck)) && sh(stuck, 'branch', '--list', 'pleiad/*').trim() === '' && (await wtgit.worktreeList(stuck)).length === 1, JSON.stringify(failed));
    await fs.rm(`${scratch}/stuck.pleiad`);

    // 作成中のまま落ちた（台帳に creating・git は作成済み・フォルダーあり）→ 起動時の突き合わせで巻き戻る
    const crashed = await wts.create({ cwd: repo });
    const ledgerPath = `${dataDir}/worktrees.json`;
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    ledger.entries[crashed.entry.id].state = 'creating';
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    wts = make();
    const rec = await wts.reconcile();
    t.ok('起動時: 作成中のまま残ったものは巻き戻す（フォルダー・登録・ブランチ・台帳）', rec.rolledBack.join() === crashed.entry.id && !(await exists(crashed.entry.path)) && !(await wtgit.branchTip(repo, crashed.entry.branch)) && !(await wts.get(crashed.entry.id)) && (await wts.get(e.id))?.state === 'ready', JSON.stringify(rec));

    // 片付けの途中で落ちた（removing）: フォルダーが無ければ終わらせ、あれば通常の状態に戻す
    const half = await wts.create({ cwd: repo });
    const half2 = await wts.create({ cwd: repo });
    sh(repo, 'worktree', 'remove', half.entry.path);                         // フォルダーと登録だけ先に消えた
    const l2 = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    l2.entries[half.entry.id].state = 'removing'; l2.entries[half2.entry.id].state = 'removing';
    await fs.writeFile(ledgerPath, JSON.stringify(l2));
    wts = make();
    const rec2 = await wts.reconcile();
    t.ok('起動時: 片付けの途中は、フォルダーが無ければ終わらせ（ブランチも外す）、あれば ready に戻す', rec2.finished.join() === half.entry.id && rec2.restored.join() === half2.entry.id
      && !(await wts.get(half.entry.id)) && (await wts.get(half2.entry.id))?.state === 'ready' && !(await wtgit.branchTip(repo, half.entry.branch)), JSON.stringify(rec2));
    // フォルダーも登録も無いものは台帳から外す。フォルダーはあるのに git が知らないものは中身に触れず台帳から外す
    await fs.rm(half2.entry.path, { recursive: true, force: true }); sh(repo, 'worktree', 'prune');
    const l3 = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    l3.entries[e.id].path = l3.entries[e.id].path;                           // 変えない
    await fs.writeFile(ledgerPath, JSON.stringify(l3));
    wts = make();
    const rec3 = await wts.reconcile();
    t.ok('起動時: フォルダーも登録も無いものは台帳から外す（残りは触らない）', rec3.dropped.join() === half2.entry.id && (await wts.get(e.id))?.state === 'ready', JSON.stringify(rec3));
    const ghost = await wts.create({ cwd: repo });
    sh(repo, 'worktree', 'remove', ghost.entry.path);
    await fs.mkdir(ghost.entry.path, { recursive: true });
    await fs.writeFile(`${ghost.entry.path}/keep.txt`, 'mine');
    const rec4 = await wts.reconcile();
    t.ok('起動時: フォルダーはあるのに git が知らないものは、中身に触れず台帳から外す', rec4.dropped.includes(ghost.entry.id) && (await exists(`${ghost.entry.path}/keep.txt`)));
    await fs.rm(ghost.entry.path, { recursive: true, force: true });
    sh(repo, 'branch', '-q', '-d', ghost.entry.branch);

    // ---- 片付けの判定
    await fs.writeFile(`${e.path}/note.txt`, 'wip\n');
    const info1 = await wts.inspect(e, { files: true });
    const k1 = await wts.settle(e.id);
    t.ok('未追跡のファイルがあれば未取り込み（残す・ファイル数）', wts.classify(info1) === 'unmerged' && info1.dirty === 1 && info1.files === 1 && k1.action === 'kept' && k1.kind === 'unmerged' && (await exists(e.path)), JSON.stringify([info1, k1]));
    sh(e.path, 'add', '-A'); sh(e.path, 'commit', '-q', '-m', 'wip');
    const info2 = await wts.inspect(e, { files: true });
    t.ok('コミットしても、元のブランチに入っていなければ未取り込み（新しいコミット 1・ファイル 1）', wts.classify(info2) === 'unmerged' && info2.ahead === 1 && info2.merged === false && info2.dirty === 0 && info2.files === 1 && (await wts.settle(e.id)).action === 'kept', JSON.stringify(info2));
    t.ok('台帳の「残す」: kept の印（自動の片付けの対象から外れる）', (await wts.keep(e.id, true), (await wts.get(e.id)).kept === true) && (await wts.sweep()).every((x) => x.id !== e.id) && (await wts.keep(e.id, false), (await wts.get(e.id)).kept === false));

    // 使っているものがあれば、取り込み済みでも消さない
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge', e.branch);
    const info3 = await wts.inspect(e);
    t.ok('元のブランチに取り込み済み（merged）', info3.merged === true && info3.dirty === 0 && wts.classify(info3) === 'merged', JSON.stringify(info3));
    state.busy = ['turn:s1'];
    t.ok('走っているターン・シェル・委譲の子があれば、取り込み済みでも消さない', (await wts.settle(e.id)).why === 'busy' && (await exists(e.path)));
    state.busy = []; state.attached = [{ sessionId: 's1', kind: 'cwd' }];
    t.ok('cwd がそこにある会話が居て、外してよい指定が無ければ消さない', (await wts.settle(e.id)).why === 'attached' && (await exists(e.path)));
    state.attached = []; state.fail = true;
    t.ok('使っているものが分からない（問い合わせの失敗）なら消さない', (await wts.settle(e.id)).why === 'unknown' && (await exists(e.path)));
    state.fail = null; state.attached = [{ sessionId: 's1', kind: 'cwd' }];
    const done = await wts.settle(e.id, { release: ['s1'] });
    t.ok('外してよい会話を指定すると、その会話の cwd を戻してから消す（フォルダー・ブランチ・台帳）', done.action === 'removed' && done.kind === 'merged' && state.released.length === 1 && state.released[0][0] === e.id && state.released[0][1].join() === 's1'
      && !(await exists(e.path)) && !(await wtgit.branchTip(repo, e.branch)) && !(await wts.get(e.id)), JSON.stringify([done, state.released]));
    state.attached = [];

    // 取り込み先が今のブランチではないとき（merge 先は baseBranch。ルートの HEAD は別のブランチ）も、取り込み済みとして消せる
    sh(repo, 'branch', 'side');
    const w2 = (await wts.create({ cwd: repo })).entry;
    await fs.writeFile(`${w2.path}/b.txt`, 'b\n');
    sh(w2.path, 'add', '-A'); sh(w2.path, 'commit', '-q', '-m', 'b');
    sh(repo, 'merge', '-q', '--ff-only', w2.branch);                         // main に取り込む
    sh(repo, 'switch', '-q', 'side');                                        // ルートは別のブランチへ
    const i4 = await wts.inspect(w2);
    t.ok('ルートが別のブランチにいても、元のブランチ（main）への取り込みを見る', i4.merged === true && wts.classify(i4) === 'merged', JSON.stringify(i4));
    const s4 = await wts.settle(w2.id);
    t.ok('取り込み先が今の HEAD でなくても、ブランチの名前まで外して消える', s4.action === 'removed' && !(await wtgit.branchTip(repo, w2.branch)) && !s4.branchLeft, JSON.stringify(s4));
    sh(repo, 'switch', '-q', 'main');

    // ---- リンクを外してから消す
    const shared = `${scratch}/shared-deps`;
    await fs.mkdir(`${shared}/pkg`, { recursive: true });
    await fs.writeFile(`${shared}/pkg/index.js`, 'module.exports = 1');
    await fs.writeFile(`${shared}/marker.txt`, 'keep me');
    const w3 = (await wts.create({ cwd: repo })).entry;
    await fs.symlink(shared, `${w3.path}/node_modules`, 'junction');          // Windows ではジャンクション、ほかでは symlink
    await fs.mkdir(`${w3.path}/core/node_modules`, { recursive: true });
    await fs.symlink(`${shared}/pkg`, `${w3.path}/core/node_modules/link`, 'junction');
    const found = await findLinks(w3.path);
    t.ok('ReparsePoint の列挙: 入れ子の中のリンクも見つけ、先は辿らない', found.ok && found.links.map(slash).sort().join() === [`${w3.path}/core/node_modules/link`, `${w3.path}/node_modules`].join(), JSON.stringify(found));
    // 外せなければ消さずに中止する（unlink も rmdir も失敗する io を差し込む）
    const stuckIo = { ...fs, unlink: async () => { throw Object.assign(new Error('perm'), { code: 'EBUSY' }); }, rmdir: async () => { throw Object.assign(new Error('perm'), { code: 'EBUSY' }); } };
    const wStuck = make({ io: stuckIo });
    const aborted = await wStuck.settle(w3.id);
    t.ok('リンクを外せなければ中止（フォルダーも、リンク先も、ブランチも残る・台帳は ready のまま）', aborted.action === 'failed' && aborted.why === 'links' && (await exists(w3.path)) && (await exists(`${shared}/marker.txt`)) && (await wtgit.branchTip(repo, w3.branch)) && (await wts.get(w3.id)).state === 'ready', JSON.stringify(aborted));
    wts = make();
    const removed3 = await wts.settle(w3.id);
    t.ok('リンクだけを外してから消す: ジャンクションの先の中身（node_modules の実体）は残る', removed3.action === 'removed' && !(await exists(w3.path))
      && (await fs.readFile(`${shared}/marker.txt`, 'utf8')) === 'keep me' && (await fs.readFile(`${shared}/pkg/index.js`, 'utf8')) === 'module.exports = 1', JSON.stringify(removed3));
    const direct = `${scratch}/direct`;
    await fs.mkdir(`${direct}/in`, { recursive: true });
    await fs.symlink(shared, `${direct}/in/lnk`, 'junction');
    const ul = await unlinkAll(direct);
    t.ok('unlinkAll: 外したリンクの先は残り、リンクだけが無くなる', ul.ok && ul.removed.length === 1 && !(await exists(`${direct}/in/lnk`)) && (await exists(`${shared}/marker.txt`)) && (await exists(`${direct}/in`)));

    // ---- 掴まれている（EBUSY）: やり直し・だめなら「残っている」
    let attempts = 0;
    const flaky = make({ remove: async (root, dir) => (++attempts < 3 ? { ok: false, busy: true, error: 'Permission denied' } : wtgit.worktreeRemove(root, dir)) });
    const w4 = (await flaky.create({ cwd: repo })).entry;
    const r4 = await flaky.settle(w4.id);
    t.ok('掴まれていても数回やり直して消える', r4.action === 'removed' && attempts === 3 && !(await exists(w4.path)), JSON.stringify([r4, attempts]));
    const stubborn = make({ remove: async () => ({ ok: false, busy: true, error: 'Permission denied' }) });
    const w5 = (await stubborn.create({ cwd: repo })).entry;
    const r5 = await stubborn.settle(w5.id);
    t.ok('やり直してもだめなら「残っている」: failed・busy・台帳は ready のまま・フォルダーもブランチも残る', r5.action === 'failed' && r5.why === 'busy' && (await stubborn.get(w5.id)).state === 'ready' && (await exists(w5.path)) && (await wtgit.branchTip(repo, w5.branch)), JSON.stringify(r5));
    wts = make();
    t.ok('強制の削除は使わない: 削除に --force を渡す口は退避だけ', (await wts.settle(w5.id)).action === 'removed');

    // ---- 台帳が Pleiad の決めた形でなければ消さない
    const w6 = (await wts.create({ cwd: repo })).entry;
    const l6 = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    l6.entries[w6.id].path = `${scratch}/important`;
    await fs.mkdir(`${scratch}/important`, { recursive: true });
    await fs.writeFile(`${scratch}/important/data.txt`, 'x');
    await fs.writeFile(ledgerPath, JSON.stringify(l6));
    wts = make();
    t.ok('台帳のパスが決めた形でなければ触らない（unowned）', (await wts.archive(w6.id)).why === 'unowned' && (await exists(`${scratch}/important/data.txt`)));
    l6.entries[w6.id].path = w6.path;
    await fs.writeFile(ledgerPath, JSON.stringify(l6));
    wts = make();

    // ---- 退避して消す
    await fs.writeFile(`${w6.path}/draft.txt`, 'unsaved work\n');
    await fs.writeFile(`${w6.path}/core/a.mjs`, 'one\ntwo\nthree\n');
    sh(w6.path, 'add', 'core/a.mjs'); sh(w6.path, 'commit', '-q', '-m', 'three');
    await fs.writeFile(`${w6.path}/more.txt`, 'more\n');
    await fs.mkdir(`${w6.path}/node_modules`, { recursive: true });
    await fs.writeFile(`${w6.path}/node_modules/ignored.js`, 'ignored');
    const tipBefore = sh(w6.path, 'rev-parse', 'HEAD').trim();
    state.busy = ['shell:s9'];
    t.ok('退避: 使っているものがあれば消さない', (await wts.archive(w6.id)).why === 'busy' && (await exists(w6.path)));
    state.busy = [];
    const arch = await wts.archive(w6.id);
    const refs = await wtgit.listArchiveRefs(repo);
    t.ok('退避して消す: 隠し ref refs/pleiad/archive/<id>/<時刻> に作業ツリー全体（未追跡含む）を撮ってから、フォルダーとブランチを消す',
      arch.action === 'removed' && refs.length === 1 && refs[0].ref === arch.ref && arch.ref.startsWith(`refs/pleiad/archive/${w6.id}/`) && !(await exists(w6.path)) && !(await wtgit.branchTip(repo, w6.branch)) && arch.branchLeft === false && !(await wts.get(w6.id)), JSON.stringify([arch, refs]));
    t.ok('退避の中身: 未コミット・未追跡のファイルとコミットが復元できる（.gitignore のものは含まない）',
      sh(repo, 'show', `${arch.ref}:draft.txt`) === 'unsaved work\n' && sh(repo, 'show', `${arch.ref}:more.txt`) === 'more\n' && sh(repo, 'show', `${arch.ref}:core/a.mjs`).endsWith('three\n')
      && sh(repo, 'merge-base', '--is-ancestor', tipBefore, arch.ref) === '' && !sh(repo, 'ls-tree', '-r', '--name-only', arch.ref).includes('node_modules'));
    t.ok('退避の ref はブランチ一覧に出ず、ユーザーの main は動かない', !/pleiad\/ply/.test(sh(repo, 'branch', '--list')) && sh(repo, 'rev-parse', 'main').trim() === sh(repo, 'rev-parse', 'HEAD').trim());
    t.ok('退避は 90 日を過ぎたら掃除される', (await wtgit.pruneArchiveRefs(repo, 90 * 86400_000, Date.now() + 100 * 86400_000)) === 1 && (await wtgit.listArchiveRefs(repo)).length === 0);

    // 台帳を全部片付けたら、置き場の <repo>.pleiad は空になって消える
    for (const x of await wts.list()) await wts.settle(x.id, { release: ['s1', 's9'] });
    t.ok('全部片付いたら置き場のフォルダーも消える', !(await exists(`${scratch}/repo.pleiad`)) || (await fs.readdir(`${scratch}/repo.pleiad`)).length === 0);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
