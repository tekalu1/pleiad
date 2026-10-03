// remote.*・endpoints.*: リモートの状態と常駐の設定、互換の接続先の一覧（ADR 0095）。
// 画面の WS コマンド（remoteStatus・setRemoteResident・compatEndpoints）はこの操作を呼ぶ薄い外側。本体はサーバーが ctx.remote・ctx.endpoints で渡す。
// ペアリング・端末の取り消し・中継の設定・接続先の保存と既定は human-only（WS の除外表）で、ここには無い。
// 秘密（中継の登録の鍵・端末の鍵・接続先の API キー）はモジュールが返さない。agent には、ペアリングの確認の番号と URL のクエリも伏せる。
import { z } from 'zod';
import { SLEEP_MODES } from '../remote/resident.mjs';
import { defineOp } from './registry.mjs';
import { byAgent, MASK, maskUrl, run } from './redact.mjs';

const loose = z.record(z.string(), z.unknown());

/** agent に見せるリモートの状態: 中継の URL の秘密になりうる部分と、ペアリングの確認の番号（人が端末と見比べるもの）を伏せる */
function remoteShown(ctx, status) {
  if (!byAgent(ctx) || !status || typeof status !== 'object') return status;
  return {
    ...status,
    ...(typeof status.relayUrl === 'string' ? { relayUrl: maskUrl(status.relayUrl) } : {}),
    ...(status.pairing ? { pairing: { ...status.pairing, requests: (status.pairing.requests ?? []).map((r) => ({ ...r, ...(r.code ? { code: MASK } : {}) })) } } : {}),
  };
}

export const remoteOps = [
  defineOp({
    id: 'remote.status', summary: 'agent:ops.remote.status.summary', risk: 'read',
    input: z.object({}),
    output: z.object({ enabled: z.boolean(), connection: loose, devices: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['remote', 'status'] } },
    legacyCommand: 'remoteStatus',
    handler: (ctx) => run(ctx, async () => remoteShown(ctx, await ctx.remote.status())),
  }),
  defineOp({
    id: 'remote.setResident', summary: 'agent:ops.remote.setResident.summary', risk: 'write',
    riskReason: 'Only decides whether the desktop app keeps running in the tray and keeps the PC awake for remote devices; it does not pair, revoke or change the relay, and a human can undo it',
    input: z.object({
      keepRunning: z.boolean().optional().describe('agent:ops.remote.setResident.keepRunning'),
      sleep: z.enum(SLEEP_MODES).optional().describe('agent:ops.remote.setResident.sleep'),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['remote', 'resident'] } },
    legacyCommand: 'setRemoteResident',
    handler: (ctx, patch) => run(ctx, async () => remoteShown(ctx, await ctx.remote.setResident(patch))),
  }),
  defineOp({
    id: 'endpoints.list', summary: 'agent:ops.endpoints.list.summary', risk: 'read',
    input: z.object({ agent: z.string().max(40).optional().describe('agent:ops.endpoints.list.agent') }),
    output: z.object({ endpoints: z.array(loose), defaults: loose }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['endpoints', 'list'] } },
    legacyCommand: 'compatEndpoints',
    handler: (ctx, { agent }) => run(ctx, async () => {
      const r = await ctx.endpoints.list(agent);
      // キーは返さない（hasKey だけ）。agent には接続先の URL の秘密になりうる部分（userinfo・クエリ）も伏せる
      return byAgent(ctx) ? { ...r, endpoints: (r.endpoints ?? []).map((e) => ({ ...e, ...(typeof e.baseUrl === 'string' ? { baseUrl: maskUrl(e.baseUrl) } : {}) })) } : r;
    }),
  }),
];
