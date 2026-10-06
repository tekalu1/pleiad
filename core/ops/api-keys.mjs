// apiKeys.*: 設定 › API キー（core/api-keys.mjs。ADR 0155）の状態と、キーそのものの確認。
// キーの値は返さない（登録の名前・プロバイダー・確認の結果・使っている所の名前だけ）。
// キーを入れる・消す・割り当てる（setApiKey・deleteApiKey・setApiKeyUse・resolveApiKeyGuide）は human-only の WS コマンド（秘密の値。ADR 0094）で、ここには出さない。
// 本体はサーバーが ctx.apiKeys で渡す（core/server.mjs）。
import { z } from 'zod';
import { defineOp, OpError } from './registry.mjs';
import { ApiKeyError } from '../api-keys.mjs';

const loose = z.record(z.string(), z.unknown());
const mapped = async (fn) => {
  try { return await fn(); }
  catch (e) { throw e instanceof ApiKeyError ? new OpError(e.code, e.message) : e; }
};

export const apiKeyOps = [
  // 設定 › API キーの画面と、AI が「どのキーがあり、どこで使っているか」を見るための読み取り
  defineOp({
    id: 'apiKeys.list',
    summary: 'agent:ops.apiKeys.list.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      migration: loose,
      storage: z.object({ encrypted: z.boolean(), backend: z.string().optional(), reason: z.string().optional() }).nullable(),
      keys: z.array(loose),
      uses: z.record(z.string(), z.string().nullable()),
      guide: loose.nullable(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['apikeys', 'list'] } },
    handler: (ctx) => mapped(() => ctx.apiKeys.list()),
  }),
  defineOp({
    id: 'apiKeys.check',
    summary: 'agent:ops.apiKeys.check.summary',
    risk: 'write',
    riskReason: 'Sends the saved key only to its own provider (OpenRouter GET /key, Cerebras GET /models) to see whether it is accepted, and records the result. Nothing is entered, no feature starts sending, and it costs nothing; a human pressing "check" does the same (ADR 0155)',
    input: z.object({ id: z.string().min(1).max(40).describe('agent:ops.apiKeys.check.id') }),
    output: z.object({ id: z.string(), ok: z.boolean().nullable(), code: z.string().optional(), at: z.string().optional() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['apikeys', 'check'], positional: ['id'] } },
    handler: (ctx, { id }) => mapped(() => ctx.apiKeys.check(id)),
  }),
];
