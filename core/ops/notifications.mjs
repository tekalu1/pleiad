// notifications.*: 通知の一覧（受信箱。ADR 0149）。通知ボタンの面が読む・既読にする。
// 載せる種類・上限・既読の整合は core/notifications.mjs。handler は `ctx.notifications`（core/server.mjs の opsDeps）を呼ぶ。
// 画面・AI・CLI が同じ本体を通る。書くのは既読の印だけ（通知そのものは出来事から core が作る）。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

const D = (id, key) => `agent:ops.notifications.${id}.${key}`;

const target = z.object({
  sessionId: z.string().optional(), uuid: z.string().optional(),
  channelId: z.string().optional(), threadId: z.string().optional(), postId: z.string().optional(),
});
const item = z.object({
  id: z.string(), seq: z.number().int(), kind: z.enum(['wait', 'failed', 'done', 'mention']), at: z.number(), unread: z.boolean(),
  resolvedAt: z.number().optional(), outcome: z.string().optional(), target,
  actor: z.object({ kind: z.string(), name: z.string(), icon: z.string().optional() }).optional(),
  ask: z.string().optional(), title: z.string().optional(), channelName: z.string().optional(), threadTitle: z.string().optional(),
});
const counts = { unread: z.number().int(), waiting: z.number().int() };

export const notificationOps = [
  defineOp({
    id: 'notifications.list',
    summary: 'agent:ops.notifications.list.summary',
    risk: 'read',
    input: z.object({
      filter: z.enum(['all', 'wait', 'mention']).optional().describe(D('list', 'filter')),
      before: z.number().int().positive().optional().describe(D('list', 'before')),
      limit: z.number().int().min(1).max(100).optional().describe(D('list', 'limit')),
    }),
    output: z.object({ items: z.array(item), hasMore: z.boolean(), ...counts }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['notifications', 'list'] } },
    handler: (ctx, args) => ctx.notifications.list(args),
  }),

  defineOp({
    id: 'notifications.count',
    summary: 'agent:ops.notifications.count.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object(counts),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['notifications', 'count'] } },
    handler: (ctx) => ctx.notifications.counts(),
  }),

  defineOp({
    id: 'notifications.markRead',
    summary: 'agent:ops.notifications.markRead.summary',
    risk: 'write',
    riskReason: 'Marks notifications as read (by id, or all of them). It only changes the bell badge and the unread dots of the list; it neither deletes a notification nor touches the conversation or channel it points to',
    input: z.object({
      ids: z.array(z.string().min(1)).max(200).optional().describe(D('markRead', 'ids')),
      all: z.boolean().optional().describe(D('markRead', 'all')),
    }),
    output: z.object({ changed: z.number().int(), ...counts }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['notifications', 'mark-read'] } },
    handler: (ctx, args) => {
      const { changed } = ctx.notifications.markRead(args);
      return { changed, ...ctx.notifications.counts() };
    },
  }),
];
