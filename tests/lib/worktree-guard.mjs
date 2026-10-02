// テストが、このリポジトリの git に分けた作業場所（git worktree。ADR 0089）を残していないかの見張り。
//
// 分けた作業場所は <リポジトリ>.pleiad/<id>・ブランチ pleiad/<id> に作られ、リポジトリの Git の登録は worktree 同士で共有される。
// cwd がこのリポジトリのテストが作ると、片付けの前にサーバーを止めたとき（一時の台帳ごと消えるので誰も片付けない）、
// 開発中のリポジトリに残る。テストは一時の git リポジトリだけで作業場所を作る（tests/lib/server.mjs は既定で AGENT_HOST_WORKTREES=off）。
// 並行して動く別の作業の worktree（temporary/worktrees/ など）は数えない: Pleiad が作った印（<…>.pleiad/ の置き場・pleiad/ のブランチ）だけを見る。
// 本物の Pleiad が同じリポジトリで作った分は見分けられない（その間のテストが落ちる）。見分け方は docs/dev-verification.md「テスト」。
import { execFile } from 'node:child_process';

const git = (root, args) => new Promise((resolve) => {
  execFile('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (err, stdout) => resolve(err ? null : stdout));
});
const slash = (p) => String(p ?? '').replaceAll('\\', '/');

/** root の git に今ある、Pleiad の分けた作業場所（置き場）とブランチ。読めなければ null */
export async function snapshotPleiadWorktrees(root) {
  const [list, branches] = await Promise.all([
    git(root, ['worktree', 'list', '--porcelain']),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pleiad/']),
  ]);
  if (list == null || branches == null) return null;
  const dirs = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => slash(l.slice(9).trim())).filter((p) => /\.pleiad\/[^/]+$/.test(p));
  return { dirs: dirs.sort(), branches: branches.split('\n').map((s) => s.trim()).filter(Boolean).sort() };
}

/** before の後に増えたもの（人が読める形）。どちらかが読めなければ空 */
export function leakedWorktrees(before, after) {
  if (!before || !after) return [];
  return [...after.dirs.filter((d) => !before.dirs.includes(d)), ...after.branches.filter((b) => !before.branches.includes(b)).map((b) => `branch ${b}`)];
}
