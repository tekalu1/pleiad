// app.*: Pleiad 全体の状態を読む操作。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

export const appOps = [
  defineOp({
    id: 'app.status',
    summary: 'agent:ops.app.status.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      version: z.string(),
      protocolVersion: z.number().int(),
      startedAt: z.number(),
      locale: z.object({ setting: z.string(), lang: z.string() }),
      running: z.number().int(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['status'] } },
    // 版・起動時刻・画面の言語・走っている作業の数。サーバーが ctx.app.status を渡す
    handler: (ctx) => ctx.app.status(),
  }),

  defineOp({
    id: 'app.running',
    summary: 'agent:ops.app.running.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      count: z.number().int(),
      turns: z.array(z.object({ sessionId: z.string().nullable(), backend: z.string().nullable(), title: z.string().nullable() })),
      tasks: z.array(z.object({ taskId: z.string(), status: z.string(), parentSessionId: z.string().nullable() })),
      waiting: z.number().int(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['running'] } },
    // いま走っている作業（会話のターン・委譲の子・承認待ちの数）。サーバーが ctx.app.running を渡す
    handler: (ctx) => ctx.app.running(),
  }),
];
