// hooks.*: Hooks の定義を読む操作（各エージェントの元の設定ファイルと、Pleiad の hooks.json。core/hooks-config.mjs・core/ply-hooks.mjs）。
// 本体はサーバーが ctx.hooks で渡す（core/server.mjs の opsHooks）。読むだけで、コマンドは実行しない。
// AI へ返すコマンドの文字列は、形で分かる秘密（トークンらしい引数など）を伏せる（maskText）。画面の編集のシートは元の文字列が要るので伏せない。
import { z } from 'zod';
import { HOOK_AGENTS, maskText } from '../hooks-config.mjs';
import { defineOp } from './registry.mjs';

const D = (id, key) => `agent:ops.hooks.${id}.${key}`;
const masked = (ctx, value) => (ctx.principal.by === 'human' || typeof value?.command !== 'string' ? value : { ...value, command: maskText(value.command) });

export const hookOps = [
  defineOp({
    id: 'hooks.read',
    summary: 'agent:ops.hooks.read.summary',
    risk: 'read',
    input: z.object({
      agent: z.enum(HOOK_AGENTS).describe(D('read', 'agent')),
      scope: z.string().min(1).max(40).describe(D('read', 'scope')),
      base: z.string().max(4000).nullable().optional().describe(D('read', 'base')),
      file: z.string().max(4000).nullable().optional().describe(D('read', 'file')),
      loc: z.object({
        event: z.string().min(1).max(100),
        group: z.number().int().min(-1),
        handler: z.number().int().min(0),
        name: z.string().max(200).nullable().optional(),
      }).describe(D('read', 'loc')),
    }),
    output: z.object({
      agent: z.string(), scope: z.string(), path: z.string(), revision: z.string(), event: z.string(), name: z.string().nullable(), matcher: z.string().nullable(),
      command: z.string().nullable(), timeout: z.unknown(), async: z.boolean(), keys: z.array(z.string()), editable: z.boolean(), enabled: z.boolean().optional(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'read'] } },
    legacyCommand: 'readHook',
    handler: async (ctx, args) => masked(ctx, await ctx.hooks.read({ ...args, base: args.base ?? undefined, file: args.file ?? undefined })),
  }),

  defineOp({
    id: 'hooks.readPly',
    summary: 'agent:ops.hooks.readPly.summary',
    risk: 'read',
    input: z.object({ id: z.string().min(1).max(200).describe(D('readPly', 'id')) }),
    output: z.object({ id: z.string(), name: z.string(), agent: z.string(), event: z.string(), matcher: z.string(), command: z.string(), targets: z.array(z.string()), enabled: z.boolean() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'read-ply'], positional: ['id'] } },
    legacyCommand: 'readPlyHook',
    handler: async (ctx, { id }) => masked(ctx, await ctx.hooks.readPly(id)),
  }),
];
