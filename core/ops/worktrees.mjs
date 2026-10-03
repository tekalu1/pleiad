// worktrees.*: 分けた作業場所（git worktree。ADR 0089）の操作。画面（入力欄の注記・右パネルの「残っている作業場所」・設定）も AI も同じ本体を通る。
// 本体はサーバーが ctx.worktrees で渡す（core/server.mjs の opsWorktrees。core/worktree-host.mjs）。作業場所の id は分けたときの返り値と、委譲の子の結果（ply_task_status）に出る。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

const D = (id, key) => `agent:ops.worktrees.${id}.${key}`;
const worktreeId = (id) => z.string().min(1).max(200).describe(D(id, 'id'));
const sessionId = (id) => z.string().max(200).nullable().optional().describe(D(id, 'sessionId'));
const cwd = (id) => z.string().max(4000).nullable().optional().describe(D(id, 'cwd'));

/** 会話も場所も言わなければ、AI は自分の会話（人間の画面はどちらかを渡す） */
const place = (ctx, args) => (args.sessionId || args.cwd ? args : { ...args, sessionId: ctx.actor.sessionId ?? undefined });

export const worktreeOps = [
  defineOp({
    id: 'worktrees.split',
    summary: 'agent:ops.worktrees.split.summary',
    risk: 'write',
    riskReason: 'Creates a new git worktree and branch next to the repository; the original working tree is untouched and an unused, unchanged worktree is cleaned up automatically. It only accepts a place some conversation has used. A human can split from the composer, so an agent is treated the same (ADR 0094)',
    input: z.object({ sessionId: sessionId('split'), cwd: cwd('split') }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'split'] } },
    legacyCommand: 'worktreeSplit',
    handler: (ctx, args) => ctx.worktrees.split(place(ctx, args)),
  }),

  defineOp({
    id: 'worktrees.discard',
    summary: 'agent:ops.worktrees.discard.summary',
    risk: 'write',
    riskReason: 'Removes the worktree only when nothing would be lost: no changes, or already merged into its base. A worktree with unmerged changes, or one a conversation or shell is using, is kept (action: kept), so no work is thrown away (ADR 0094)',
    input: z.object({ id: worktreeId('discard') }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'discard'], positional: ['id'] } },
    legacyCommand: 'worktreeDiscard',
    handler: (ctx, { id }) => ctx.worktrees.discard(id),
  }),

  defineOp({
    id: 'worktrees.keep',
    summary: 'agent:ops.worktrees.keep.summary',
    risk: 'write',
    riskReason: 'Only marks a worktree to be kept out of the automatic cleanup (or clears the mark); nothing is created or removed (ADR 0094)',
    input: z.object({ id: worktreeId('keep'), kept: z.boolean().optional().describe(D('keep', 'kept')) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'keep'], positional: ['id'] } },
    legacyCommand: 'worktreeKeep',
    handler: (ctx, { id, kept }) => ctx.worktrees.keep(id, kept !== false),
  }),

  defineOp({
    id: 'worktrees.archive',
    summary: 'agent:ops.worktrees.archive.summary',
    risk: 'write',
    riskReason: 'Snapshots the whole working tree (including untracked files) into a hidden ref before removing it, checks the snapshot matches, and refuses while a conversation or shell uses it. worktrees.restore brings it back for 90 days (ADR 0089, 0094)',
    input: z.object({ id: worktreeId('archive') }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'archive'], positional: ['id'] } },
    legacyCommand: 'worktreeArchive',
    handler: (ctx, { id }) => ctx.worktrees.archive(id),
  }),

  defineOp({
    id: 'worktrees.restore',
    summary: 'agent:ops.worktrees.restore.summary',
    risk: 'write',
    riskReason: 'Creates a new worktree from an archive ref (refs/pleiad/archive/ only); nothing existing is overwritten (ADR 0094)',
    input: z.object({ ref: z.string().min(1).max(500).describe(D('restore', 'ref')), sessionId: sessionId('restore'), cwd: cwd('restore') }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'restore'], positional: ['ref'] } },
    legacyCommand: 'worktreeRestore',
    handler: (ctx, args) => ctx.worktrees.restore(place(ctx, args)),
  }),

  defineOp({
    id: 'worktrees.setSettings',
    summary: 'agent:ops.worktrees.setSettings.summary',
    risk: 'write',
    riskReason: 'Whether to always split without asking when another conversation is writing to the same repository. Either way the original working tree is not touched, and it does not change any approval mode or permission (ADR 0094)',
    input: z.object({ always: z.boolean().describe(D('setSettings', 'always')) }),
    output: z.object({ always: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'settings'], positional: ['always'] } },
    legacyCommand: 'setWorktreeSettings',
    handler: (ctx, { always }) => ctx.worktrees.setSettings({ always }),
  }),

  // ---- 読む（ADR 0096）。入力欄の上の 1 行・チップの元（worktreeCheck）と、「いつも分ける」の今の値（worktreeSettings）
  defineOp({
    id: 'worktrees.check',
    summary: 'agent:ops.worktrees.check.summary',
    risk: 'read',
    input: z.object({
      sessionId: sessionId('check'), cwd: cwd('check'),
      backend: z.string().max(40).optional().describe(D('check', 'backend')),
      mode: z.string().max(60).optional().describe(D('check', 'mode')),
    }),
    output: z.object({ git: z.boolean(), current: z.unknown(), conflicts: z.array(z.unknown()), canSplit: z.boolean(), always: z.boolean() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'check'] } },
    legacyCommand: 'worktreeCheck',
    handler: (ctx, args) => ctx.worktrees.check(place(ctx, args)),
  }),

  defineOp({
    id: 'worktrees.settings',
    summary: 'agent:ops.worktrees.settings.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({ always: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['worktrees', 'get-settings'] } },
    legacyCommand: 'worktreeSettings',
    handler: (ctx) => ctx.worktrees.getSettings(),
  }),
];
