// sessions.*: 会話に関する操作。
// sessions.search は会話の題・状態・場所・本文を探す（core/session-search.mjs。docs/design.md「セッション検索」）。
// 画面は WS の invoke から、MCP・CLI も同じ入口から呼ぶ。入力と出力の形が SearchInput / SearchResult。
import { z } from 'zod';
import { defineOp, OpError } from './registry.mjs';

const D = (key) => `agent:ops.sessions.search.${key}`;

const stamp = z.union([z.string(), z.number()]);

const searchInput = z.object({
  query: z.string().max(2000).describe(D('query')),
  filters: z.object({
    backends: z.array(z.string()).max(20).optional().describe(D('backends')),
    cwd: z.string().optional().describe(D('cwd')),
    status: z.string().nullable().optional().describe(D('status')),
    since: stamp.optional().describe(D('since')),
    until: stamp.optional().describe(D('until')),
    speaker: z.enum(['any', 'user', 'assistant']).optional().describe(D('speaker')),
    includeDelegated: z.boolean().optional().describe(D('includeDelegated')),
    includeToolInputs: z.boolean().optional().describe(D('includeToolInputs')),
    sessionIds: z.array(z.string()).max(500).optional().describe(D('sessionIds')),
  }).strict().optional().describe(D('filters')),
  sort: z.enum(['relevance', 'recent']).optional().describe(D('sort')),
  limit: z.number().int().min(1).max(200).optional().describe(D('limit')),
  cursor: z.string().optional().describe(D('cursor')),
  hitsPerSession: z.number().int().min(1).max(10).optional().describe(D('hitsPerSession')),
});

const hit = z.object({
  uuid: z.string(),
  index: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool']),
  at: z.string(),
  excerpt: z.string(),
  ranges: z.array(z.tuple([z.number().int(), z.number().int()])),
});

const searchOutput = z.object({
  total: z.number().int(),
  partial: z.boolean(),
  nextCursor: z.string().optional(),
  sessions: z.array(z.object({
    sessionId: z.string(),
    title: z.string(),
    status: z.string().nullable(),
    cwd: z.string(),
    backend: z.string(),
    lastModified: z.number(),
    parentSessionId: z.string().optional(),
    score: z.number(),
    matched: z.array(z.enum(['title', 'status', 'place', 'message', 'toolInput'])),
    hitCount: z.number().int(),
    hits: z.array(hit),
  })),
});

export const sessionOps = [
  defineOp({
    id: 'sessions.search',
    summary: 'agent:ops.sessions.search.summary',
    risk: 'read',
    input: searchInput,
    output: searchOutput,
    surfaces: { ui: true, mcp: 'direct', cli: { path: ['sessions', 'search'], positional: 'query' } },
    // サーバーが ctx.app.searchSessions（core/session-search.mjs の search）を渡す。壊れた入力（語が多すぎる・cursor）は INVALID にする
    handler: async (ctx, args) => {
      try {
        return await ctx.app.searchSessions(args);
      } catch (e) {
        if (e instanceof TypeError || e instanceof RangeError) throw new OpError('INVALID', e.message);
        throw e;
      }
    },
  }),
];
