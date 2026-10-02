// 分けた作業場所を会話・委譲・画面につなぐ層（core/worktree-host.mjs。ADR 0088）。
// ぶつかりの判定（書き込みの範囲だけ・別のルート・圧縮・自分）・委譲で分けるかの判定（isolate・読むだけ・書き手・並列に呼ばれた委譲のまとめ数え）・
// 子の完了時の状態と片付け・準備中の子を片付けない・残っている作業場所の絞り込み・会話の cwd を戻す。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorktreeHost, writesScope, WRITING_KINDS } from '../../core/worktree-host.mjs';

export const name = 'worktree-host';
export const title = '分けた作業場所の層: ぶつかりの判定・委譲で分けるか・子の完了と片付け・準備中は消さない・残りの絞り込み・cwd を戻す（一時リポジトリ）';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const exists = (p) => fs.stat(p).then(() => true, () => false);
const slash = (p) => p.replaceAll('\\', '/');

const modes = { default: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'readonly', autonomy: 'ask' }, full: { scope: 'full', autonomy: 'never' } };
const turn = (sessionId, cwd, mode = 'default', extra = {}) => ({ info: { sessionId, cwd, mode }, key: sessionId, backend: { modes: () => modes }, ...extra });

export default async function (t) {
  const scratch = slash(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-wth-'))));
  try {
    const repo = `${scratch}/repo`, other = `${scratch}/other`, plain = `${scratch}/plain`;
    for (const dir of [repo, other]) {
      await fs.mkdir(dir, { recursive: true });
      sh(dir, 'init', '-q', '-b', 'main');
      await fs.writeFile(`${dir}/a.txt`, 'a\n');
      sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'first');
    }
    await fs.mkdir(plain);

    // ---- 台所の身代わり
    const sessions = new Map([['s-title', { title: 'リリースノートの下書き' }], ['s-child', { title: '子', delegation: { taskId: 'x' } }]]);
    const store = {
      getAll: async () => Object.fromEntries(sessions),
      get: async (id) => sessions.get(id) ?? {},
      recordChange: async (id, change) => { const s = sessions.get(id) ?? {}; sessions.set(id, { ...s, cwd: change.to, history: [...(s.history ?? []), change] }); },
      setSessionData: async (id, key, value) => { sessions.set(id, { ...(sessions.get(id) ?? {}), [key]: value }); },
    };
    const turns = new Map();
    let taskRows = [];
    const emitted = [];
    let wrote = false;
    const host = createWorktreeHost({ dataDir: `${scratch}/data`, store, turns: () => turns, tasks: () => taskRows, emit: (e) => emitted.push(e),
      reason: (key) => ({ reasonKey: key }), parentWrote: async () => wrote, windowMs: 40, worktreeOptions: { graceMs: 0, retryMs: [1] } });

    t.ok('書き込みの範囲の判定: workspace 以上だけ（読むだけは違う）', writesScope(modes.default) && writesScope(modes.full) && !writesScope(modes.plan) && WRITING_KINDS.has('implement') && !WRITING_KINDS.has('investigate'));

    // ---- ぶつかり
    turns.set('s-title', turn('s-title', repo));
    const c1 = await host.check({ sessionId: 'new', cwd: repo });
    t.ok('同じリポジトリで書き込みのターン: 別の会話の題が出る', c1.git && c1.canSplit && c1.conflicts.length === 1 && c1.conflicts[0].title === 'リリースノートの下書き' && c1.conflicts[0].child === false, JSON.stringify(c1));
    t.ok('自分のターンは数えない', (await host.check({ sessionId: 's-title', cwd: repo })).conflicts.length === 0);
    t.ok('読むだけの会話（writes: false）には何も出さない', (await host.check({ sessionId: 'new', cwd: repo, writes: false })).conflicts.length === 0);
    turns.set('s-title', turn('s-title', repo, 'plan'));
    t.ok('読むだけのモードのターンは書き手に数えない', (await host.check({ sessionId: 'new', cwd: repo })).conflicts.length === 0);
    turns.set('s-title', turn('s-title', repo, 'default', { compactTrigger: 'manual' }));
    t.ok('圧縮のターンは数えない', (await host.check({ sessionId: 'new', cwd: repo })).conflicts.length === 0);
    turns.set('s-title', turn('s-title', other));
    t.ok('別のリポジトリのターンは数えない', (await host.check({ sessionId: 'new', cwd: repo })).conflicts.length === 0);
    turns.set('s-child', turn('s-child', `${repo}/..`.replace(/\/[^/]+\/\.\.$/, '')));
    turns.delete('s-child');
    turns.set('s-child', turn('s-child', repo, 'full'));
    const c2 = await host.check({ sessionId: 'new', cwd: repo });
    t.ok('委譲の子のターンも書き手（child の印）', c2.conflicts.length === 1 && c2.conflicts[0].sessionId === 's-child' && c2.conflicts[0].child === true);
    t.ok('git でない場所は何も出さない', (await host.check({ sessionId: 'new', cwd: plain })).git === false);
    turns.clear();

    // ---- 分ける・分けた先は分けない・「いつも分ける」の保存
    const split = await host.split({ cwd: repo, sessionId: 's-a' });
    t.ok('分ける: 公開の形（id・ブランチ・場所・元）と cwd', split.ok && split.entry.branch === `pleiad/${split.entry.id}` && split.cwd === split.entry.path && split.entry.origin === repo && !('base' in split.entry), JSON.stringify(split));
    const inside = await host.check({ sessionId: 's-a', cwd: split.cwd });
    t.ok('分けた先では current・もう分けない・conflicts なし', inside.current?.id === split.entry.id && inside.canSplit === false && inside.conflicts.length === 0);
    t.ok('分けた作業場所の中からは分けられない（already-split）', (await host.split({ cwd: split.cwd })).reason === 'already-split');
    t.ok('「いつも分ける」は台帳と同じファイルに保存され、読み直しても残る', (await host.worktrees.setSettings({ always: true })).always === true && (await createWorktreeHost({ dataDir: `${scratch}/data`, store, turns: () => turns }).worktrees.getSettings()).always === true);
    await host.worktrees.setSettings({ always: false });

    // ---- 会話の cwd を戻す（消すとき）・予約の外し方
    sessions.set('s-a', { cwd: split.cwd, backend: 'fake', model: 'm', effort: '', nextSettings: { backend: 'fake', model: 'm', effort: '', cwd: split.cwd } });
    await host.release(split.entry, ['s-a']);
    t.ok('消す前の戻し: cwd を元の場所へ（変更履歴に残す・イベント）', sessions.get('s-a').cwd === repo && sessions.get('s-a').history.at(-1).field === 'cwd' && sessions.get('s-a').history.at(-1).by === 'ply' && sessions.get('s-a').history.at(-1).reasonKey === 'worktreeBack'
      && emitted.some((e) => e.type === 'cwd' && e.sessionId === 's-a' && e.cwd === repo));
    t.ok('予約の cwd だけを外す（ほかに変える物が無ければ予約ごと消える）', sessions.get('s-a').nextSettings === null && emitted.some((e) => e.type === 'nextSettings' && e.sessionId === 's-a' && e.nextSettings === null));
    sessions.set('s-b', { cwd: repo, backend: 'fake', model: 'm', effort: '', nextSettings: { backend: 'fake', model: 'other-model', effort: '', cwd: split.cwd } });
    await host.release(split.entry, ['s-b']);
    t.ok('モデルを変える予約が一緒なら、cwd だけを外して残す', sessions.get('s-b').nextSettings?.model === 'other-model' && !('cwd' in sessions.get('s-b').nextSettings));
    sessions.delete('s-a'); sessions.delete('s-b');
    t.ok('使っていなければ片付く', (await host.worktrees.settle(split.entry.id)).action === 'removed');

    // ---- 委譲で分けるか
    const owner = turn('owner', repo);
    const decide = (args = {}, ownerTurn = owner) => host.decideIsolation({ owner: 'owner', turn: ownerTurn, cwd: repo, kind: 'implement', writes: true, isolate: undefined, ...args });
    t.ok('isolate: false は分けない', (await decide({ isolate: false })).why === 'explicit');
    t.ok('isolate: true は分ける（書き手が居なくても・読むだけの種類でも）', (await decide({ isolate: true, kind: 'investigate' })).isolate === true);
    t.ok('git でなければ、isolate: true でも分けない（not-git）', (await decide({ isolate: true, cwd: plain })).why === 'not-git');
    t.ok('読むだけの種類・読むだけのモードは分けない', (await decide({ kind: 'review' })).why === 'readonly' && (await decide({ writes: false })).why === 'readonly');
    const alone = await decide();
    t.ok('書き手が居なければ分けない（子 1 つだけ）', alone.isolate === false && alone.why === 'alone', JSON.stringify(alone));
    turns.set('human', turn('human', repo));
    t.ok('同じリポジトリに別の書き手（人の会話）が居れば分ける', (await decide()).why === 'writers' && (await decide()).isolate === true);
    turns.clear();
    turns.set('s-child', turn('s-child', repo, 'full'));
    t.ok('走っている子（まだ分けていない）が居れば分ける', (await decide()).isolate === true);
    turns.clear();
    wrote = true;
    t.ok('依頼元が今のターンでファイルを変えていれば分ける', (await decide()).isolate === true);
    wrote = false;
    const results = await Promise.all([decide(), decide(), decide()]);
    t.ok('同じターンから並列に呼ばれた 3 つの委譲は、まとめて数えて全部分ける', results.every((r) => r.isolate && r.why === 'writers'), JSON.stringify(results));
    const sequential = [await decide(), await decide()];
    t.ok('続けて 1 つずつ呼んだ（前が済んだ）ときは、書き手が居なければ分けない', sequential.every((r) => r.isolate === false));
    const mixed = await Promise.all([decide(), decide({ isolate: false })]);
    t.ok('並列の中の isolate: false は、そのまま分けない', mixed[1].why === 'explicit');

    // ---- 子の作業場所: 準備中・完了・片付け
    const prepared = await host.createForTask({ cwd: repo, owner: 'owner', taskId: 'task-1' });
    t.ok('子の作業場所: 専用ブランチ・cwd', prepared.ok && /^pleiad\/ply-/.test(prepared.entry.branch) && prepared.cwd === prepared.entry.path);
    t.ok('子を台帳に載せる前（準備中）は、片付けの掃除でも消えない（task:starting）', (await host.sweep()).every((x) => x.action !== 'removed' || x.id !== prepared.entry.id) && (await exists(prepared.entry.path)));
    taskRows = [{ taskId: 'task-1', status: 'running', cwd: prepared.cwd, sessionId: 'child-1', pendingMessages: 0 }];
    sessions.set('child-1', { cwd: prepared.cwd });
    t.ok('走っている子が居る間は消えない', (await host.worktrees.settle(prepared.entry.id)).why === 'busy');
    await fs.writeFile(`${prepared.cwd}/w.txt`, 'x\n');
    sh(prepared.cwd, 'add', '.'); sh(prepared.cwd, 'commit', '-q', '-m', 'child');
    await fs.writeFile(`${prepared.cwd}/w2.txt`, 'y\n');
    const state1 = await host.taskState({ id: prepared.entry.id });
    t.ok('子の作業場所の状態: 未取り込み・ファイル数・場所・元', state1.state === 'unmerged' && state1.files === 2 && state1.ahead === 1 && state1.dirty === 1 && state1.origin === repo && state1.path === prepared.entry.path, JSON.stringify(state1));
    const done1 = await host.taskDone({ taskId: 'task-1', sessionId: 'child-1', worktree: { id: prepared.entry.id } });
    t.ok('完了: 自分（走っている印の子）に止められず、変更があれば残す（片付けていない）', done1.state === 'unmerged' && done1.removed === false && (await exists(prepared.entry.path)));
    t.ok('完了で残したときも、子の会話の cwd は戻さない（取り込みの間に追加の指示が来ても同じ場所）', sessions.get('child-1').cwd === prepared.cwd);
    // 残りの絞り込み
    taskRows = [{ taskId: 'task-1', status: 'completed', cwd: prepared.cwd, sessionId: 'child-1', pendingMessages: 0 }];
    const left = await host.leftovers({ cwd: repo });
    t.ok('残っている作業場所: 子の分（取り込みを頼む相手は依頼元）・ファイル名・ファイル数', left.length === 1 && left[0].id === prepared.entry.id && left[0].purpose === 'task' && left[0].mergeSessionId === 'owner' && left[0].files === 2 && left[0].fileNames.sort().join() === 'w.txt,w2.txt', JSON.stringify(left));
    t.ok('今いる場所は出さない', (await host.leftovers({ cwd: prepared.cwd })).length === 0);
    t.ok('別のリポジトリの分は出さない', (await host.leftovers({ cwd: other })).length === 0);
    taskRows = [{ taskId: 'task-1', status: 'running', cwd: prepared.cwd, sessionId: 'child-1', pendingMessages: 0 }];
    t.ok('走っているものがあれば出さない', (await host.leftovers({ cwd: repo })).length === 0);
    taskRows = [{ taskId: 'task-1', status: 'completed', cwd: prepared.cwd, sessionId: 'child-1', pendingMessages: 0 }];
    // 取り込んだ（元のブランチへ）→ 掃除で消え、子の会話の cwd は元の場所に戻る
    await fs.rm(`${prepared.cwd}/w2.txt`);
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge', prepared.entry.branch);
    await host.sweep();
    t.ok('取り込み済みなら、掃除で消える（終わったタスクの子の会話の cwd を元の場所へ戻してから）', !(await exists(prepared.entry.path)) && !(await host.worktrees.get(prepared.entry.id)) && sessions.get('child-1').cwd === repo);
    // 準備に失敗した子: 片付ける
    const failed = await host.createForTask({ cwd: repo, owner: 'owner', taskId: 'task-2' });
    t.ok('準備に失敗した子の作業場所は abandon で片付く（準備中の印を外して）', (await host.abandon(failed.entry.id)).action === 'removed' && !(await exists(failed.entry.path)));
    // 完了の状態: 変更の無い子は消える
    const empty = await host.createForTask({ cwd: repo, owner: 'owner', taskId: 'task-3' });
    taskRows = [{ taskId: 'task-3', status: 'running', cwd: empty.cwd, sessionId: 'child-3', pendingMessages: 0 }];
    sessions.set('child-3', { cwd: empty.cwd });
    const done3 = await host.taskDone({ taskId: 'task-3', sessionId: 'child-3', worktree: { id: empty.entry.id } });
    t.ok('変更の無い子は完了で消え、状態は「変更なし」・子の会話の cwd は元の場所へ', done3.state === 'empty' && done3.removed === true && sessions.get('child-3').cwd === repo && !(await exists(empty.entry.path)));
    t.ok('もう無い作業場所の状態は gone', (await host.taskState({ id: empty.entry.id, branch: empty.entry.branch })).state === 'gone');

    // ---- 退避と作り直し
    const arch = await host.createForTask({ cwd: repo, owner: 'owner', taskId: 'task-4' });
    taskRows = [{ taskId: 'task-4', status: 'completed', cwd: arch.cwd, sessionId: 'child-4', pendingMessages: 0 }];
    sessions.set('child-4', { cwd: arch.cwd });
    await fs.writeFile(`${arch.cwd}/draft.txt`, 'draft\n');
    const archived = await host.archive(arch.entry.id);
    t.ok('子の分の退避: 子の会話の cwd も戻してから消える', archived.action === 'removed' && sessions.get('child-4').cwd === repo && !(await exists(arch.entry.path)), JSON.stringify(archived));
    const back = await host.restore({ cwd: repo, ref: archived.ref });
    t.ok('作り直し: 元の種類（子）・元のタスク・内容が戻る', back.ok && (await fs.readFile(`${back.cwd}/draft.txt`, 'utf8')).trim() === 'draft' && back.entry.purpose === 'task' && back.entry.taskId === 'task-4', JSON.stringify(back));
    t.ok('作り直しは退避の ref だけ（ほかの ref は断る）', (await host.restore({ cwd: repo, ref: 'refs/heads/main' })).ok === false);
    await host.archive(back.entry.id);
  } finally {
    await fs.rm(`${scratch}/repo.pleiad`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
