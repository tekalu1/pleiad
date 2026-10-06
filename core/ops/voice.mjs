// voice.*: 通話モード（core/voice/、docs/voice-call.md）の状態。キーの登録・削除は human-only の WS コマンド（setVoiceKey・deleteVoiceKey。秘密の値）で、ここには出さない。
// 設定（モデル・声・上限）は settings.set の voice（core/ops/settings.mjs）。
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { normalizeVoiceSettings } from '../voice/settings.mjs';

export const voiceOps = [
  // 設定 › 通話の画面と、AI が「通話が使えるか・今日どれだけ使ったか」を見るための読み取り。キーそのものは返さない（hasKey だけ）
  defineOp({
    id: 'voice.status',
    summary: 'agent:ops.voice.status.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({
      hasKey: z.boolean(),
      storage: z.object({ encrypted: z.boolean(), backend: z.string().optional(), reason: z.string().optional() }).nullable(),
      today: z.object({ callSeconds: z.number(), sttSeconds: z.number(), ttsChars: z.number() }),
      active: z.number().int(),
      settings: z.object({}).passthrough(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['voice', 'status'] } },
    handler: async (ctx) => ({ ...(await ctx.voice.status()), settings: normalizeVoiceSettings((await ctx.prefs?.())?.voice) }),
  }),
];
