// 委譲の子の分けた作業場所（ADR 0089）: 子への指示の追記・完了時の状態（row.workspace）・完了通知と ply_task_status の 1 行・
// isolate の型の検査・片付け済みの言い方・作り直しで row.worktree を替える。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks, workspaceLine } from '../../core/agent-tasks.mjs';
import { agentTools } from '../../core/agent-bridge.mjs';

export const name = 'agent-tasks-workspace';
export const title = '委譲の分けた作業場所: 子への指示・完了通知と status の「作業場所」の行（未取り込み・片付け済み）・isolate の検査・ツールの定義';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(15); } throw new Error('timeout'); }

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-ws-'));
  const wt = { id: 'ply-7f3a', branch: 'pleiad/ply-7f3a', path: 'D:/dev/pleiad.pleiad/ply-7f3a', origin: 'D:/dev/pleiad', baseBranch: 'main' };
  let seq = 0, live = { state: 'unmerged', files: 3, branch: wt.branch, path: wt.path, origin: wt.origin };
  const prompts = [];
  const manager = await createAgentTasks({
    dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
    prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend, cwd: a.isolate ? wt.path : 'D:/dev/pleiad', ...(a.isolate ? { worktree: wt } : {}) }),
    execute: async (task, prompt) => {
      prompts.push(prompt);
      return { outcome: 'ok', text: 'done', ...(task.worktree ? { workspace: { ...wt, state: 'unmerged', files: 3, removed: false } } : {}) };
    },
    workspaceState: async () => live,
    ready: async () => false,
  });
  try {
    // ---- 子への指示: 作業場所の中だけに書く・元の場所の絶対パスに書かない・コミットする
    const plain = await manager.call('p1', 'ply_delegate', { backend: 'fake', task: 'plain job' });
    await until(() => manager.get(plain.taskId).status === 'completed');
    t.ok('分けていない子には作業場所の指示も行も足さない', prompts[0] === 'plain job' && !manager.get(plain.taskId).worktree);
    const iso = await manager.call('p1', 'ply_delegate', { backend: 'fake', task: 'iso job', isolate: true }, undefined, 'ja');
    await until(() => manager.get(iso.taskId).status === 'completed');
    t.ok('分けた子の最初の依頼に作業場所の指示が付く（作業場所・ブランチ・元・コミット）', prompts[1].startsWith('iso job') && prompts[1].includes(wt.path) && prompts[1].includes(wt.branch) && prompts[1].includes(wt.origin)
      && /作業はこの作業場所の中だけ/.test(prompts[1]) && /絶対パスに書かない/.test(prompts[1]) && /コミットする/.test(prompts[1]), prompts[1]);
    t.ok('ply_delegate の返り値にも作業場所（依頼元が知る）', iso.worktree?.branch === wt.branch && iso.worktree.origin === wt.origin);
    const withCtx = await manager.call('p1', 'ply_delegate', { backend: 'fake', task: 'ctx job', context: '背景', isolate: true }, undefined, 'ja');
    await until(() => manager.get(withCtx.taskId).status === 'completed');
    t.ok('コンテキストと一緒でも、指示は最後に付く', prompts[2].includes('背景') && prompts[2].endsWith('依頼元がする。') && prompts[2].indexOf('背景') < prompts[2].indexOf('分けた作業場所'), prompts[2]);
    t.ok('isolate が真偽でなければ断る', await manager.call('p1', 'ply_delegate', { backend: 'fake', task: 'x', isolate: 'yes' }, undefined, 'ja').then(() => false, (e) => /isolate/.test(e.message)));

    // ---- 完了の状態と status の 1 行
    const row = manager.get(iso.taskId);
    t.ok('完了の記録に作業場所の状態（未取り込み・ファイル数・片付けていない）', row.workspace?.state === 'unmerged' && row.workspace.files === 3 && row.workspace.removed === false, JSON.stringify(row.workspace));
    const status = await manager.call('p1', 'ply_task_status', { taskId: iso.taskId }, undefined, 'ja');
    t.ok('ply_task_status: 今の状態の 1 行と構造', status.workspaceSummary.startsWith(`作業場所: 分けた作業場所 ${wt.branch}（未取り込み · 3 ファイル）`) && status.workspace.state === 'unmerged' && status.workspace.path === wt.path && status.workspace.origin === wt.origin, JSON.stringify(status));
    live = { state: 'merged', files: 0, branch: wt.branch };
    t.ok('取り込まれた後は「取り込み済み。片付けました」', (await manager.call('p1', 'ply_task_status', { taskId: iso.taskId }, undefined, 'ja')).workspaceSummary === `作業場所: 分けた作業場所 ${wt.branch}（取り込み済み。片付けました）`);
    live = { state: 'gone', files: 0, branch: wt.branch };
    const gone = await manager.call('p1', 'ply_task_wait', { taskId: iso.taskId, seconds: 1 }, undefined, 'ja');
    t.ok('片付いた後（未取り込みだったもの）は「片付け済み」', gone.workspaceSummary === `作業場所: 分けた作業場所 ${wt.branch}（片付け済み）`, gone.workspaceSummary);
    live = null;
    t.ok('状態が引けないときは完了時の状態から言う', (await manager.call('p1', 'ply_task_status', { taskId: iso.taskId }, undefined, 'ja')).workspaceSummary.includes('未取り込み · 3 ファイル'));
    const plainStatus = await manager.call('p1', 'ply_task_status', { taskId: plain.taskId }, undefined, 'ja');
    t.ok('分けていない子の status には作業場所の行が無い', !('workspaceSummary' in plainStatus) && !('workspace' in plainStatus));

    // ---- 文（言語）
    const ja = (state) => workspaceLine('ja', wt, state);
    t.ok('未取り込み: 場所と元・取り込みは依頼元の作業', ja({ state: 'unmerged', files: 2, branch: wt.branch, path: wt.path, origin: wt.origin }) === `作業場所: 分けた作業場所 ${wt.branch}（未取り込み · 2 ファイル）\n  場所: ${wt.path}（元: ${wt.origin}）。取り込みは依頼元の作業です`);
    t.ok('変更なし・取り込み済み・片付け済み・不明', ja({ state: 'empty' }).includes('変更なし。片付けました') && ja({ state: 'merged' }).includes('取り込み済み。片付けました') && ja({ state: 'gone', removedAs: 'empty' }).includes('変更なし。片付けました')
      && ja({ state: 'gone', removedAs: 'unmerged' }).includes('片付け済み') && ja({ state: 'unknown' }).includes('状態を確かめられません') && ja(null).includes('状態を確かめられません'));
    t.ok('英語の文', workspaceLine('en', wt, { state: 'unmerged', files: 2, branch: wt.branch, path: wt.path, origin: wt.origin }).startsWith(`Workspace: separate workspace ${wt.branch} (not merged · 2 files)`.replace('2 files', '2 files')) || /not merged/.test(workspaceLine('en', wt, { state: 'unmerged', files: 2 })));
    t.ok('作業場所が無ければ空', workspaceLine('ja', null, null) === '');

    // ---- ツールの定義
    const tool = agentTools('ja').find((x) => x.name === 'ply_delegate');
    t.ok('ply_delegate の引数に isolate（真偽・任意）。説明にも書いてある', tool.inputSchema.properties.isolate?.type === 'boolean' && !tool.inputSchema.required.includes('isolate') && /isolate/.test(tool.description));
    t.ok('英語の説明にも isolate', /isolate/.test(agentTools('en').find((x) => x.name === 'ply_delegate').description));
  } finally {
    manager.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
