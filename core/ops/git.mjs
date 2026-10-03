// git.*: 会話の作業場所の git の動き（読み取りだけ。ADR 0085・0105）。右パネルの git の面・入力欄の上の札と同じ本体を通る（core/server.mjs の opsGit）。
// 作業場所は会話の cwd。会話の無い場所は、どれかの会話が使ったことのある場所だけ（任意のフォルダーで git を走らせない）。git が無い・git 管理外は git: null。
// 画面（人）には今までの形を返し（uiHandler）、AI・CLI にはファイルの一覧を limit / cursor で区切り、差分を統一差分の文字列にして切った形を返す。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { clip, pageOf, PAGE_MAX } from './host.mjs';
import { maskTree, run } from './redact.mjs';

const D = (id, key) => `agent:ops.git.${id}.${key}`;
const A = (key) => `agent:ops.git.arg.${key}`;
const loose = z.record(z.string(), z.unknown());

/** git.diff: 差分の字数（既定・上限） */
export const DIFF_CHARS_DEFAULT = 20_000;
export const DIFF_CHARS_MAX = 100_000;
/** git.changes: AI に返す会話の git の出来事（新しい方から） */
export const TIMELINE_MAX = 20;

const sessionId = z.string().max(200).nullable().optional().describe(A('sessionId'));
const cwd = z.string().max(4096).nullable().optional().describe(A('cwd'));
const range = z.enum(['uncommitted', 'session']).optional().describe(A('range'));

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
    }),
    output: z.object({ git: loose.nullable() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'changes'] } },
    legacyCommand: 'gitPanel',
    // 画面のパネルは開いたときに、片付けられる分けた作業場所を片付ける（sweep）
    uiHandler: (ctx, args) => ctx.git.panel(args, { sweep: true }),
    handler: (ctx, { limit, cursor, ...args }) => run(ctx, async () => {
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
    }),
    output: z.object({ diff: loose.nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['git', 'diff'], positional: ['path'] } },
    legacyCommand: 'gitDiff',
    uiHandler: (ctx, args) => ctx.git.diff(args),
    handler: (ctx, { maxChars = DIFF_CHARS_DEFAULT, ...args }) => run(ctx, async () => {
      if (!args.path) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'path: required' }));
      const got = (await ctx.git.diff({ ...args, ...where(ctx, args) }))?.diff;
      if (!got) return { diff: null };
      const patch = patchText(got.hunks);
      return maskTree({ diff: { range: got.range, path: got.path, binary: got.binary === true, patch: clip(patch, maxChars), truncated: got.truncated === true || patch.length > maxChars } });
    }),
  }),
];
