// compatEndpoints.*: 互換の接続先（core/compat-endpoints.mjs。設定 › エージェント）のうち、秘密を入力しない操作。
// キーを入れる確認・保存（compatEndpointCheck・compatEndpointSave）と既定の切り替え（compatEndpointDefault）は human-only（ADR 0094）で、ここには無い。
// 本体はサーバーが ctx.compat で渡す（core/server.mjs の opsCompat）。キーはどの返り値にも入らない。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

const D = (id, key) => `agent:ops.compatEndpoints.${id}.${key}`;

export const compatOps = [
  defineOp({
    id: 'compatEndpoints.recheck',
    summary: 'agent:ops.compatEndpoints.recheck.summary',
    risk: 'write',
    riskReason: 'Re-runs the connection check of a saved endpoint with its saved URL and key (nothing is entered) and records the result and the model list. A failed check makes conversations on that endpoint stop instead of silently falling back, which is the same as a human pressing "check again" (ADR 0094)',
    input: z.object({ id: z.string().min(1).max(200).describe(D('recheck', 'id')) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['endpoints', 'recheck'], positional: ['id'] } },
    legacyCommand: 'compatEndpointRecheck',
    handler: (ctx, { id }) => ctx.compat.recheck(id),
  }),

  defineOp({
    id: 'compatEndpoints.delete',
    summary: 'agent:ops.compatEndpoints.delete.summary',
    // 消すとキーも消え、人がキーを入れ直さないと戻せない。既定だった接続先なら、新しい会話の既定は公式に戻る（別の接続先へは替わらない）
    risk: 'guarded',
    input: z.object({ id: z.string().min(1).max(200).describe(D('delete', 'id')), reason: z.string().max(500).optional().describe(D('delete', 'reason')) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['endpoints', 'delete'], positional: ['id'] } },
    legacyCommand: 'compatEndpointDelete',
    // 承認カードの一文（PC の画面の言語）。受領証の前の値は、その接続先の今の形（消えていれば null）
    confirm: async (ctx, { id }) => {
      const e = await ctx.compat.get(id);
      return { note: ctx.compat.deleteNote(e ?? { id, name: id }), before: e ? { id: e.id, name: e.name, agent: e.agent, baseUrl: e.baseUrl ?? null } : null };
    },
    handler: (ctx, { id }) => ctx.compat.remove(id),
  }),
];
