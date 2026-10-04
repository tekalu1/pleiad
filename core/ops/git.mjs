// git.*: 会話の作業場所の git の動き（読み取りだけ。ADR 0085・0105・0134）。右パネルの git の面・入力欄の上の札と同じ本体を通る（core/server.mjs の opsGit）。
// 作業場所は会話の cwd。会話の無い場所は、どれかの会話が使ったことのある場所だけ（任意のフォルダーで git を走らせない）。git が無い・git 管理外は null。
// 画面（人）には今までの形を返し（uiHandler）、AI・CLI にはファイルの一覧を limit / cursor で区切り、差分を統一差分の文字列にして切った形を返す。
// 履歴（git.history）・コミット（git.commit）・作業場所（git.worktrees・git.worktree）は、画面の「変更」「作業場所」タブの元で、AI・CLI も同じものを読める。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { clip, decodeCursor, encodeCursor, pageOf, PAGE_MAX } from './host.mjs';
import { maskTree, run } from './redact.mjs';

const D = (id, key) => `agent:ops.git.${id}.${key}`;
const A = (key) => `agent:ops.git.arg.${key}`;
const loose = z.record(z.string(), z.unknown());

/** git.diff: 差分の字数（既定・上限） */
export const DIFF_CHARS_DEFAULT = 20_000;
export const DIFF_CHARS_MAX = 100_000;
/** git.changes: AI に返す会話の git の出来事（新しい方から） */
export const TIMELINE_MAX = 20;
/** git.history: 1 ページの件数（既定・上限）。画面は 50 件ずつ読む */
export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 200;

const sessionId = z.string().max(200).nullable().optional().describe(A('sessionId'));
const cwd = z.string().max(4096).nullable().optional().describe(A('cwd'));
const range = z.enum(['uncommitted', 'session']).optional().describe(A('range'));
const hash = z.string().regex(/^[0-9a-f]{7,64}$/).describe(A('hash'));
const worktree = z.string().max(4096).optional().describe(A('worktree'));

/** 会話も場所も言わなければ、AI は自分の会話（人間の画面はどちらかを渡す） */
const where = (ctx, { sessionId: id, cwd: dir }) => (id || dir ? { sessionId: id, cwd: dir } : { sessionId: ctx.actor.sessionId ?? undefined });

/** パース済みの差分（{ hunks: [{ header, lines: [{ t, s }] }] }）を統一差分の文字列にする */
export const patchText = (hunks) => (hunks ?? []).map((h) => [h.header, ...(h.lines ?? []).map((l) => `${l.t}${l.s}`)].join('\n')).join('\n');

export const gitOps = [
  defineOp({
    id: 'git.status', summary: 'agent:ops.git.status.summary', risk: 'read',
    input: z.object({ sessionId, cwd, summary: z.boolean().optional().describe(D('status', 'brief')), fresh: z.boolean().optional().describe(D('status', 'fresh')) }),
    output: z.object({ git: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'status'] } },
    legacyCommand: 'gitStatus',
    handler: (ctx, args) => run(ctx, () => ctx.git.status({ ...args, ...where(ctx, args) })),
  }),
  defineOp({
    id: 'git.changes', summary: 'agent:ops.git.changes.summary', risk: 'read',
    input: z.object({
      sessionId, cwd, range,
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(A('limit')),
      cursor: z.string().max(400).optional().describe(A('cursor')),
      // 画面だけが使う軽い問い合わせ（changes: 変更の一覧だけ。light: 分けた作業場所の一覧を計算しない）
      only: z.enum(['changes', 'light']).optional().describe(D('changes', 'only')),
    }),
    output: z.object({ git: loose.nullable() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'changes'] } },
    legacyCommand: 'gitPanel',
    // 画面のパネルは開いたときに、片付けられる分けた作業場所を片付ける（sweep）
    uiHandler: (ctx, args) => ctx.git.panel(args, { sweep: true }),
    handler: (ctx, { limit, cursor, only: _only, ...args }) => run(ctx, async () => {
      const got = await ctx.git.panel({ ...args, ...where(ctx, args) }, { sweep: false });
      if (!got?.git) return { git: null };
      const page = pageOf(ctx, got.changes?.files ?? [], { limit, cursor });
      const timeline = Array.isArray(got.timeline) ? got.timeline : [];
      return maskTree({
        git: got.git, worktrees: got.worktrees ?? null,
        changes: got.changes ? { range: got.changes.range, hasSession: got.changes.hasSession, total: got.changes.total, failed: got.changes.failed === true, files: page.items, next: page.next } : null,
        timeline: timeline.slice(-TIMELINE_MAX), timelineTotal: timeline.length,
      });
    }),
  }),
  defineOp({
    id: 'git.diff', summary: 'agent:ops.git.diff.summary', risk: 'read',
    input: z.object({
      sessionId, cwd, range,
      // 画面は path が無くても diff: null で返す（今までどおり）。AI・CLI は必須
      path: z.string().max(4096).optional().describe(D('diff', 'path')),
      maxChars: z.number().int().min(100).max(DIFF_CHARS_MAX).optional().describe(A('maxChars')),
      // 範囲の代わりに、押したコミット・2 つのコミットの間・ステージ済み／変更のどちらかを選べる
      commit: hash.optional().describe(D('diff', 'commit')),
      from: hash.optional().describe(D('diff', 'from')),
      to: hash.optional().describe(D('diff', 'to')),
      stage: z.enum(['staged', 'work']).optional().describe(D('diff', 'stage')),
      orig: z.string().max(4096).optional().describe(D('diff', 'orig')),
      worktree,
      // 以下は画面だけが使う（畳んだ行を開く・前後の行数）
      context: z.number().int().min(0).max(1000).optional().describe(D('diff', 'context')),
      after: z.boolean().optional().describe(D('diff', 'after')),
    }),
    output: z.object({ diff: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'diff'], positional: ['path'] } },
    legacyCommand: 'gitDiff',
    uiHandler: (ctx, args) => ctx.git.diff(args),
    handler: (ctx, { maxChars = DIFF_CHARS_DEFAULT, context: _context, after: _after, ...args }) => run(ctx, async () => {
      if (!args.path) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'path: required' }));
      const got = (await ctx.git.diff({ ...args, ...where(ctx, args) }))?.diff;
      if (!got) return { diff: null };
      const patch = patchText(got.hunks);
      return maskTree({ diff: { range: got.range, path: got.path, binary: got.binary === true, patch: clip(patch, maxChars), truncated: got.truncated === true || patch.length > maxChars } });
    }),
  }),
  defineOp({
    id: 'git.history', summary: 'agent:ops.git.history.summary', risk: 'read',
    input: z.object({
      sessionId, cwd,
      limit: z.number().int().min(1).max(HISTORY_PAGE_MAX).optional().describe(A('limit')),
      cursor: z.string().max(400).optional().describe(A('cursor')),
    }),
    output: z.object({ history: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'history'] } },
    legacyCommand: 'gitHistory',
    uiHandler: (ctx, args) => historyOf(ctx, args),
    handler: (ctx, args) => run(ctx, async () => maskTree(await historyOf(ctx, { ...args, ...where(ctx, args) }))),
  }),
  defineOp({
    id: 'git.commit', summary: 'agent:ops.git.commit.summary', risk: 'read',
    input: z.object({
      sessionId, cwd, hash,
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(A('limit')),
      cursor: z.string().max(400).optional().describe(A('cursor')),
    }),
    output: z.object({ commit: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'commit'], positional: ['hash'] } },
    legacyCommand: 'gitCommit',
    uiHandler: (ctx, args) => ctx.git.commit(args),
    handler: (ctx, { limit, cursor, ...args }) => run(ctx, async () => {
      const got = (await ctx.git.commit({ ...args, ...where(ctx, args) }))?.commit;
      if (!got) return { commit: null };
      const page = pageOf(ctx, got.files ?? [], { limit, cursor });
      return maskTree({ commit: { ...got, files: page.items, next: page.next } });
    }),
  }),
  defineOp({
    id: 'git.worktrees', summary: 'agent:ops.git.worktrees.summary', risk: 'read',
    input: z.object({ sessionId, cwd }),
    output: z.object({ worktrees: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'worktrees'] } },
    legacyCommand: 'gitWorktrees',
    uiHandler: (ctx, args) => ctx.git.worktrees(args),
    handler: (ctx, args) => run(ctx, async () => maskTree(await ctx.git.worktrees({ ...args, ...where(ctx, args) }))),
  }),
  defineOp({
    id: 'git.worktree', summary: 'agent:ops.git.worktree.summary', risk: 'read',
    input: z.object({ sessionId, cwd, worktree: z.string().max(4096).describe(A('worktree')), limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(A('limit')) }),
    output: z.object({ worktree: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'worktree'], positional: ['worktree'] } },
    legacyCommand: 'gitWorktree',
    uiHandler: (ctx, args) => ctx.git.worktree(args),
    handler: (ctx, { limit = 30, ...args }) => run(ctx, async () => {
      const got = (await ctx.git.worktree({ ...args, ...where(ctx, args) }))?.worktree;
      if (!got) return { worktree: null };
      // 数千ファイルになりうるので、それぞれ先頭から limit 件に切る（合計は total）
      const cut = (g) => ({ ...g, files: (g?.files ?? []).slice(0, limit), more: (g?.files?.length ?? 0) > limit });
      return maskTree({ worktree: { ...got, committed: cut(got.committed), uncommitted: cut(got.uncommitted) } });
    }),
  }),
];

/** git.history の本体（画面も AI も同じ形）。cursor は読み飛ばす件数 */
async function historyOf(ctx, { limit = HISTORY_PAGE_DEFAULT, cursor, ...args }) {
  const skip = cursor === undefined ? 0 : decodeCursor(cursor);
  if (skip === null) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.badCursor'));
  const got = (await ctx.git.history({ ...args, limit, skip }))?.history;
  if (!got) return { history: null };
  const { next, ...rest } = got;
  return { history: { ...rest, next: next == null ? null : encodeCursor(next) } };
}
