// statuses.*: 状態のグループ（会話の状態の器）の操作。グループは使われた時点で存在する（設計メモ §6）が、人が先に作った器と、その器のアイコンは statuses.json に残る。
// 画面（状態の見出しのメニュー）も AI も同じ store・同じイベントを通る（ADR 0007）。本体はサーバーが ctx.statuses で渡す（core/server.mjs の opsStatuses）。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

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
];
