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
];
