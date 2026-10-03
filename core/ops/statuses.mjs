// statuses.*: 状態のグループ（会話の状態の器）の操作。グループは使われた時点で存在する（設計メモ §6）が、人が先に作った器と、その器のアイコンは statuses.json に残る。
// 画面（状態の見出しのメニュー）も AI も同じ store・同じイベントを通る（ADR 0007）。本体はサーバーが ctx.statuses で渡す（core/server.mjs の opsStatuses）。
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { fromHost, pageOf, PAGE_MAX } from './host.mjs';

const D = (id, key) => `agent:ops.statuses.${id}.${key}`;

export const statusOps = [
  defineOp({
    id: 'statuses.setIcon',
    summary: 'agent:ops.statuses.setIcon.summary',
    risk: 'write',
    riskReason: 'The icon is cosmetic: it only changes how a status group is drawn in the sidebar, and an empty icon puts it back. A human can set any group\'s icon, so an agent is treated the same (ADR 0082)',
    input: z.object({
      status: z.string().trim().min(1).max(60).describe(D('setIcon', 'status')),
      icon: z.string().max(16).describe(D('setIcon', 'icon')),
    }),
    output: z.object({ status: z.string(), icon: z.unknown() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['statuses', 'icon'], positional: ['status', 'icon'] } },
    legacyCommand: 'setStatusIcon',
    handler: (ctx, { status, icon }) => ctx.statuses.setIcon(status, icon),
  }),

  defineOp({
    id: 'statuses.create',
    summary: 'agent:ops.statuses.create.summary',
    risk: 'write',
    riskReason: 'Creates an empty status group (a name only). A human can create one too, so an agent is treated the same (ADR 0082)',
    input: z.object({ status: z.string().trim().min(1).max(60).describe(D('create', 'status')) }),
    output: z.object({ status: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['statuses', 'create'], positional: ['status'] } },
    legacyCommand: 'createStatus',
    handler: (ctx, { status }) => ctx.statuses.create(status, ctx.actor),
  }),

  // 使われた状態の一覧（既出順）。事前定義ではなく補完候補。会話の状態の選び方は sessions.setStatus
  defineOp({
    id: 'statuses.list',
    summary: 'agent:ops.statuses.list.summary',
    risk: 'read',
    input: z.object({
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(D('list', 'limit')),
      cursor: z.string().max(400).optional().describe(D('list', 'cursor')),
    }),
    output: z.object({ total: z.number().int(), statuses: z.array(z.object({ status: z.string(), count: z.number().int(), firstUsedAt: z.string().nullable(),
      lastUsedAt: z.string().nullable(), icon: z.string().nullable(), kept: z.boolean() })), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['statuses', 'list'] } },
    legacyCommand: 'listStatuses',
    handler: async (ctx, page) => {
      const { total, items, next } = pageOf(ctx, await fromHost(() => ctx.statuses.list()), page);
      return { total, statuses: items, next };
    },
    uiHandler: (ctx) => fromHost(() => ctx.statuses.list()),
  }),

  // グループの名前を替える（付いている会話の状態を全部、空にすればグループを消して状態を外す）。会話ごとに変更の記録が残る
  defineOp({
    id: 'statuses.rename',
    summary: 'agent:ops.statuses.rename.summary',
    risk: 'write',
    riskReason: 'Renames a status group: every conversation in it gets a change-log row (previous status, who, from where), and renaming back restores it. Emptying the name only removes the status label, no conversation is deleted. A human can do the same, so an agent is treated the same (ADR 0082)',
    input: z.object({
      from: z.string().trim().min(1).max(60).describe(D('rename', 'from')),
      to: z.string().trim().max(60).optional().describe(D('rename', 'to')),
    }),
    output: z.object({ moved: z.number().int() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['statuses', 'rename'], positional: ['from', 'to'] } },
    legacyCommand: 'renameStatus',
    handler: (ctx, { from, to }) => fromHost(() => ctx.statuses.rename(from, to ?? '', ctx.actor)),
  }),
];
