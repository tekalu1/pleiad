// 分けた作業場所（git worktree）の git 呼び出し（ADR 0089）。core/git-info.mjs の読み取り・隠し ref の土台に乗る。
//
// 作る・消す・ブランチを消すは、Pleiad が決めた形（ブランチ pleiad/<id>）のものだけ。強制の削除（worktree remove --force・branch -D）は持たない。
// 失敗は例外にせず { ok: false, error } を返す（呼び出し側が巻き戻す）。誤った引数（呼び出し側の誤り）だけ投げる。
import { ARCHIVE_PREFIX, commitTree, deleteRefs, execGit, headCommit, readGit, refSession, snapshotTree, updateRef } from './git-info.mjs';

const slash = (p) => String(p ?? '').replaceAll('\\', '/');
const BRANCH_RE = /^pleiad\/[a-z0-9][a-z0-9-]{1,30}$/;
export const isPleiadBranch = (b) => BRANCH_RE.test(String(b ?? ''));

/** `git worktree list --porcelain` → [{ path, head, branch, detached, locked, prunable }]。path は / 区切り */
export function parseWorktreeList(text) {
  const list = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: slash(line.slice(9).trim()), head: null, branch: null, detached: false, locked: false, prunable: false }; list.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return list;
}

/** 登録されている worktree の一覧。失敗は null */
export async function worktreeList(root) {
  const r = await execGit(root, ['worktree', 'list', '--porcelain']);
  return r.ok ? parseWorktreeList(r.stdout) : null;
}

/** startPoint のコミットからブランチ付きで worktree を作る */
export async function worktreeAdd(root, { path: dir, branch, startPoint }) {
  if (!isPleiadBranch(branch) || !dir || !/^[0-9a-f]{40,64}$/.test(String(startPoint ?? ''))) throw new Error('git: worktree add needs a pleiad/ branch, a path and a commit');
  const r = await execGit(root, ['worktree', 'add', '--quiet', '-b', branch, dir, startPoint], { timeout: 120_000 });
  return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout).trim().slice(0, 500) };
}

/** worktree を消す。強制しない（未コミット・未追跡・ロックがあれば git が断る）。busy はほかのプロセスが掴んでいるとき（やり直せば通ることがある） */
export async function worktreeRemove(root, dir) {
  if (!dir) throw new Error('git: worktree remove needs a path');
  const r = await execGit(root, ['worktree', 'remove', dir], { timeout: 120_000 });
  const error = r.ok ? null : (r.stderr || r.stdout).trim().slice(0, 500);
  return { ok: r.ok, error, busy: !r.ok && /permission denied|device or resource busy|used by another process|being used|EBUSY|unable to access|Directory not empty/i.test(error ?? '') };
}

/** 登録だけ残ってフォルダーの無い worktree を外す */
export async function worktreePrune(root) {
  return (await execGit(root, ['worktree', 'prune'])).ok;
}

/** ブランチの先頭（無ければ null） */
export async function branchTip(root, branch) {
  const r = await readGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** ブランチを消す（-d。今の HEAD か upstream に取り込み済みのときだけ git が消す）。消せたか */
export async function branchDelete(root, branch) {
  if (!isPleiadBranch(branch)) throw new Error('git: only pleiad/ branches');
  return (await execGit(root, ['branch', '-d', branch])).ok;
}

/**
 * 先頭が別のコミット（取り込み先のブランチ・退避の隠し ref）から辿れるブランチだけ、名前を外す（branch -D の代わり。コミットは辿れるまま残る）。
 * `branch -d` は今の HEAD にしか照らさないので、取り込み先が別のブランチのときの片付けに使う。tip が container の祖先でなければ何もしない
 */
export async function branchDeleteContained(root, branch, tip, container) {
  if (!isPleiadBranch(branch) || !tip || !container) return false;
  if ((await isAncestor(root, tip, container)) !== true) return false;
  return (await execGit(root, ['update-ref', '-d', `refs/heads/${branch}`, tip])).ok;
}

/**
 * 退避を撮って検証した後の「退避して消す」だけが使う強制の削除（worktree remove --force）。
 * 今の作業ツリーが退避と同じ tree であることを確かめてからでないと呼ばない（呼び出し側 core/worktrees.mjs の archive）
 */
export async function worktreeRemoveForced(root, dir) {
  if (!dir) throw new Error('git: worktree remove needs a path');
  const r = await execGit(root, ['worktree', 'remove', '--force', dir], { timeout: 120_000 });
  const error = r.ok ? null : (r.stderr || r.stdout).trim().slice(0, 500);
  return { ok: r.ok, error, busy: !r.ok && /permission denied|device or resource busy|used by another process|being used|EBUSY|unable to access|Directory not empty/i.test(error ?? '') };
}

/** コミットの tree（読めなければ null） */
export async function treeOf(root, commit) {
  const r = await readGit(root, ['rev-parse', '--verify', '-q', `${commit}^{tree}`]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** a が b の祖先（同じコミットを含む）か。コミットが読めないなどの失敗は null */
export async function isAncestor(root, a, b) {
  if (!a || !b) return null;
  const r = await readGit(root, ['merge-base', '--is-ancestor', a, b]);
  if (r.ok) return true;
  return r.code === 1 ? false : null;
}

/** from..to のコミット数。失敗は null */
export async function countCommits(root, from, to = 'HEAD') {
  const r = await readGit(root, ['rev-list', '--count', `${from}..${to}`]);
  return r.ok ? Number(r.stdout.trim()) || 0 : null;
}

/** 退避の隠し ref を作る（作業ツリー全体の撮影。親は worktree の HEAD なので、ブランチを消してもコミットは辿れる）。失敗は null */
export async function archiveWorktree(worktreeDir, root, id, stamp, meta = {}) {
  const tree = await snapshotTree(worktreeDir);
  if (!tree) return null;
  const parent = await headCommit(worktreeDir);
  // 作り直し（restore）に要る控えをコミットの本文に残す（台帳が消えた後も、退避だけで元に戻せる）
  const body = Object.entries(meta).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ')}`).join('\n');
  const commit = await commitTree(worktreeDir, tree, parent, `pleiad worktree archive\n\n${body}`);
  if (!commit) return null;
  const ref = `${ARCHIVE_PREFIX}${refSession(id)}/${stamp}`;
  return (await updateRef(root, ref, commit)) ? { ref, commit } : null;
}

/** 退避の控え（コミットの本文の `key: value` の行）。読めなければ null */
export async function archiveMeta(root, commit) {
  const r = await readGit(root, ['log', '-1', '--format=%B', commit]);
  if (!r.ok) return null;
  const meta = {};
  for (const line of r.stdout.split('\n')) { const m = /^([a-zA-Z]+): (.*)$/.exec(line); if (m) meta[m[1]] = m[2]; }
  return meta;
}

/** 退避の隠し ref の一覧 [{ ref, id, commit, at }] */
export async function listArchiveRefs(root) {
  const r = await readGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)', ARCHIVE_PREFIX]);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const [ref, commit, at] = line.split('\0');
    const m = /^refs\/pleiad\/archive\/([^/]+)\/(.+)$/.exec(ref ?? '');
    if (m) out.push({ ref, id: m[1], commit, at: Number(at) * 1000 });
  }
  return out;
}

/** 古い退避を消す */
export async function pruneArchiveRefs(root, maxAgeMs, now = Date.now()) {
  return deleteRefs(root, (await listArchiveRefs(root)).filter((r) => now - r.at > maxAgeMs).map((r) => r.ref));
}
