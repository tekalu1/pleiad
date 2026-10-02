// テストが本体の git に分けた作業場所を残さないための守り（tests/lib/worktree-guard.mjs・AGENT_HOST_WORKTREES=off）。
// 一時のリポジトリで: 作業場所が増えたことを見つける・Pleiad のものではない worktree は数えない・off のときは作らない（git にも何も残さない）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorktrees } from '../../core/worktrees.mjs';
import { createWorktreeHost } from '../../core/worktree-host.mjs';
import { snapshotPleiadWorktrees, leakedWorktrees } from '../lib/worktree-guard.mjs';

export const name = 'worktree-leak-guard';
export const title = 'テストが本体の git に分けた作業場所を残さない守り: 増えた作業場所を見つける・他の worktree は数えない・off では作らない（一時リポジトリ）';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const slash = (p) => p.replaceAll('\\', '/');

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = slash(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-wt-guard-'))));
  const repo = `${scratch}/repo`;
  await fs.mkdir(repo, { recursive: true });
  try {
    sh(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(`${repo}/a.txt`, 'one\n');
    sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');
    const before = await snapshotPleiadWorktrees(repo);
    t.ok('最初は何も無い', before && before.dirs.length === 0 && before.branches.length === 0, JSON.stringify(before));

    // 作業の worktree（temporary/worktrees/ など）は数えない
    sh(repo, 'worktree', 'add', '-q', '-b', 'fix/other', `${scratch}/other-work`);
    t.ok('Pleiad のものではない worktree は増えたことにならない', leakedWorktrees(before, await snapshotPleiadWorktrees(repo)).length === 0);

    // off: 作らない（git に何も残さない）
    const off = createWorktrees({ dataDir: `${scratch}/data-off`, disabled: true });
    const refused = await off.create({ cwd: repo });
    t.ok('disabled の作成は reason: disabled で、git に何も作らない', refused.ok === false && refused.reason === 'disabled'
      && leakedWorktrees(before, await snapshotPleiadWorktrees(repo)).length === 0 && !await fs.stat(`${scratch}/repo.pleiad`).then(() => true, () => false), JSON.stringify(refused));
    const host = createWorktreeHost({ dataDir: `${scratch}/data-host`, store: { getAll: async () => ({}), get: async () => null }, turns: () => new Map(), worktreeOptions: { disabled: true } });
    const verdict = await host.decideIsolation({ owner: 's1', cwd: repo, kind: 'implement', isolate: true, writes: true });
    t.ok('disabled のホストは isolate: true でも分けない', verdict.isolate === false && verdict.why === 'disabled', JSON.stringify(verdict));

    // 作られれば、守りが見つける（片付ければ消える）
    const on = createWorktrees({ dataDir: `${scratch}/data-on`, graceMs: 0 });
    const made = await on.create({ cwd: repo });
    const after = await snapshotPleiadWorktrees(repo);
    const leaked = leakedWorktrees(before, after);
    t.ok('作られた分けた作業場所（置き場とブランチ）を残りとして見つける', made.ok && leaked.length === 2 && leaked[0] === made.entry.path && leaked[1] === `branch ${made.entry.branch}`, JSON.stringify(leaked));
    const settled = await on.settle(made.entry.id);
    t.ok('片付けると残りは無くなる', settled.action === 'removed' && leakedWorktrees(before, await snapshotPleiadWorktrees(repo)).length === 0, JSON.stringify(settled));
    t.ok('読めない git は「残り無し」（落とさない）', leakedWorktrees(null, after).length === 0 && (await snapshotPleiadWorktrees(`${scratch}/nope`)) === null);
  } finally {
    await fs.rm(`${scratch}/repo.pleiad`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
