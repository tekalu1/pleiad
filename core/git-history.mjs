// git の履歴・コミット・ステージの区別・作業場所の一覧の読み取り（docs/design.md「git の動き」、ADR 0134）。
// どれも読むだけ（core/git-info.mjs の許可表の内）。git パネルの「変更」タブ（グラフと範囲）と「作業場所」タブの元。
//   - 履歴: git log --branches --tags --remotes HEAD --topo-order。親・作者・日時・refs・題。Pleiad の隠し ref（refs/pleiad/）は混ぜない
//   - コミット 1 つの変更ファイル
//   - コミットしていない分の「ステージ済み」と「変更」の区別（index の tree と作業ツリーの tree を比べる）
//   - 作業場所（git worktree）の一覧と、1 つの中身
import * as git from './git-info.mjs';
import { isPleiadBranch, worktreeList } from './git-worktree.mjs';

export const HISTORY_DEFAULT = 50;
export const HISTORY_MAX = 200;
const HASH_RX = /^[0-9a-f]{7,64}$/;
export const isHash = (v) => typeof v === 'string' && HASH_RX.test(v);

const FIELD = '\x1f';
// 題は 300 字で切る（空行の無い長いメッセージでは %s が本文全体になり、200 件で出力が上限を超えるため）
const LOG_FORMAT = ['%H', '%P', '%an', '%at', '%D', '%<(300,trunc)%s'].join('%x1f');
export const BODY_MAX = 20_000;

/**
 * `git log --decorate=full` の %D → [{ kind: 'head'|'branch'|'remote'|'tag', name, pleiad?, detached? }]。
 * refs/heads・refs/remotes・refs/tags の 3 つだけ。refs/pleiad/ やスタッシュなど、ほかの ref は出さない
 */
export function parseRefs(decoration) {
  const out = [];
  for (const raw of String(decoration ?? '').split(', ')) {
    const item = raw.trim();
    if (!item) continue;
    if (item === 'HEAD') { out.push({ kind: 'head', name: null, detached: true }); continue; }
    if (item.startsWith('HEAD -> ')) {
      const ref = item.slice(8);
      if (ref.startsWith('refs/heads/')) out.push({ kind: 'head', name: ref.slice(11), ...(isPleiadBranch(ref.slice(11)) ? { pleiad: true } : {}) });
      continue;
    }
    if (item.startsWith('tag: refs/tags/')) out.push({ kind: 'tag', name: item.slice(15) });
    else if (item.startsWith('refs/heads/')) out.push({ kind: 'branch', name: item.slice(11), ...(isPleiadBranch(item.slice(11)) ? { pleiad: true } : {}) });
    else if (item.startsWith('refs/remotes/')) { const name = item.slice(13); if (!name.endsWith('/HEAD')) out.push({ kind: 'remote', name }); }
  }
  return out;
}

/** `git log -z --format=…` の出力 → [{ hash, short, parents, author, at, refs, subject }]（at はミリ秒） */
export function parseLog(text) {
  const commits = [];
  for (const record of String(text ?? '').split('\0')) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed) continue;
    const [hash, parents, author, at, refs, subject] = trimmed.split(FIELD);
    if (!isHash(hash)) continue;
    commits.push({ hash, short: hash.slice(0, 7), parents: parents ? parents.split(' ').filter(Boolean) : [], author: author ?? '', at: Number(at) * 1000 || 0, refs: parseRefs(refs), subject: (subject ?? '').trimEnd() });
  }
  return commits;
}

/**
 * 履歴の 1 ページ。skip 件読み飛ばして limit 件。次のページがあれば next（読み飛ばす件数）。HEAD がまだ無い（最初のコミット前）リポジトリは空
 * @returns {Promise<{ commits: object[], next: number|null, head: string|null } | null>} 読めなければ null
 */
export async function readHistory(root, { limit = HISTORY_DEFAULT, skip = 0 } = {}) {
  const head = await git.headCommit(root);
  const take = Math.min(Math.max(Number(limit) || HISTORY_DEFAULT, 1), HISTORY_MAX);
  const from = Math.max(Number(skip) || 0, 0);
  // refs/pleiad/ のターンの撮影は --branches --tags --remotes HEAD のどれにも入らない（--all は使わない）
  const r = await git.readGit(root, ['log', '--topo-order', '--decorate=full', '-z', `--max-count=${take + 1}`, `--skip=${from}`, `--format=${LOG_FORMAT}`, '--branches', '--tags', '--remotes', ...(head ? ['HEAD'] : []), '--'], { timeout: 8_000 });
  if (!r.ok) return null;
  const commits = parseLog(r.stdout);
  const more = commits.length > take;
  return { commits: commits.slice(0, take), next: more ? from + take : null, head };
}

/** コミット 1 つの情報（本文を含む）。コミットでなければ null */
export async function readCommit(root, hash) {
  if (!isHash(hash)) return null;
  const r = await git.readGit(root, ['log', '-1', '--decorate=full', '-z', `--format=${LOG_FORMAT}${FIELD}%b`, hash, '--']);
  if (!r.ok) return null;
  const [head] = String(r.stdout).split('\0');
  const parts = head.replace(/^\n+/, '').split(FIELD);
  const commit = parseLog(parts.slice(0, 6).join(FIELD))[0];
  if (!commit) return null;
  const body = (parts[6] ?? '').trim();
  return { ...commit, body: body.slice(0, BODY_MAX), ...(body.length > BODY_MAX ? { bodyTruncated: true } : {}) };
}

/** コミットの変更ファイル（親との差。マージは最初の親。最初のコミットは空の tree）。名前の変更も見つける */
export async function commitFiles(root, hash) {
  const commit = await readCommit(root, hash);
  if (!commit) return null;
  const diff = await git.diffFiles(root, commit.parents[0] ?? git.EMPTY_TREE, commit.hash, { renames: true });
  if (!diff) return null;
  return { commit, merge: commit.parents.length > 1, ...diff };
}

/**
 * コミットしていない分を「ステージ済み」と「変更」に分ける。index の tree を間に挟み、
 * ステージ済み = HEAD と index、変更 = index と作業ツリー（未追跡を含む。.gitignore は守る。新しく現れたファイルは U）。
 * index を tree にできない（競合が残っている）ときは、ステージ済みを空にして全部を変更に入れる。失敗は null
 */
export async function uncommittedGroups(root) {
  const head = (await git.headCommit(root)) ?? git.EMPTY_TREE;
  const [index, work] = await Promise.all([git.indexTree(root), git.snapshotTree(root)]);
  if (!work) return null;
  const [staged, changed] = await Promise.all([
    index ? git.diffFiles(root, head, index, { renames: true }) : { files: [], total: { files: 0, add: 0, del: 0 } },
    git.diffFiles(root, index ?? head, work),
  ]);
  if (!staged || !changed) return null;
  const files = changed.files.map((f) => (f.state === 'A' ? { ...f, state: 'U' } : f));
  return { index, tree: work, staged: staged.files, work: files };
}

/** 一つの tree-ish が、あるコミットを指す完全な hash か（見つからなければ null） */
export async function resolveCommit(root, rev) {
  if (!isHash(rev)) return null;
  const r = await git.readGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------- 作業場所

/**
 * root の git worktree の一覧に、それぞれの状態を足す。here は panel を開いている作業場所。
 * base は主の作業場所（一覧の先頭）の今の HEAD で、ahead は base にない自分のコミットの数。上限 30
 * @returns {Promise<{ base: { path, branch, head }|null, rows: object[] }|null>}
 */
export async function readWorktrees(root, { limit = 30 } = {}) {
  const list = await worktreeList(root);
  if (!list) return null;
  const sameDir = (a, b) => String(a).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() === String(b).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const main = list[0] ?? null;
  const rows = await Promise.all(list.slice(0, limit).map(async (w, index) => {
    const row = { path: w.path, branch: w.branch, head: w.head ? w.head.slice(0, 7) : null, detached: w.detached, locked: w.locked, prunable: w.prunable,
      main: index === 0, here: sameDir(w.path, root), exists: true, dirty: 0, ahead: 0, behind: 0, at: null };
    if (w.prunable) return { ...row, exists: false };
    const status = await git.readStatus(w.path);
    if (!status) return { ...row, exists: false };
    row.dirty = status.dirty;
    if (index > 0 && main?.head && w.head) {
      const [counts, last] = await Promise.all([
        git.readGit(root, ['rev-list', '--left-right', '--count', `${main.head}...${w.head}`]),
        git.readGit(root, ['log', '-1', '--format=%ct', w.head]),
      ]);
      if (counts.ok) { const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number); row.behind = behind || 0; row.ahead = ahead || 0; }
      const ms = last.ok ? Number(last.stdout.trim()) * 1000 : NaN;
      if (Number.isFinite(ms)) row.at = ms;
    }
    return row;
  }));
  return { base: main ? { path: main.path, branch: main.branch, head: main.head } : null, rows, total: list.length };
}

/** 作業場所 1 つの中身。主の作業場所の HEAD との分岐点からのコミット済みの変更と、コミットしていない変更のファイル */
export async function readWorktreeDetail(root, dir, baseHead) {
  const head = await git.headCommit(dir);
  const tree = await git.snapshotTree(dir);
  let from = null;
  if (head && baseHead) {
    const mb = await git.readGit(root, ['merge-base', baseHead, head]);
    if (mb.ok && mb.stdout.trim() && mb.stdout.trim() !== head) from = mb.stdout.trim();
  }
  const [committed, uncommitted] = await Promise.all([
    from ? git.diffFiles(root, from, head, { renames: true }) : null,
    tree ? git.diffFiles(dir, head ?? git.EMPTY_TREE, tree) : null,
  ]);
  return {
    head, base: from,
    committed: committed ? { files: committed.files, total: committed.total } : { files: [], total: { files: 0, add: 0, del: 0 } },
    uncommitted: uncommitted ? { files: uncommitted.files, total: uncommitted.total } : { files: [], total: { files: 0, add: 0, del: 0 } },
    failed: !tree,
  };
}
