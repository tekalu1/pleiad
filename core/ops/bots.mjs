// bot の定義（S2。ADR 0109）の操作（`bots.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。
// handler は `ctx.bots`（core/bots-host.mjs の BotHost.opsDeps → core/bots/service.mjs）を呼ぶ。直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。
//
// 危険度（ADR 0082。human-only は承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングの 5 つだけ）:
//   bots.list / get      read
//   bots.create          write。agent（AI）が作るときは riskOf で guarded（承認カード。作られる承認モードの行つき。backend の既定が弱くなければ loosens）
//   bots.update          write。権限を広げる向き（フォルダーを足す・rw にする・送る先を足す・他の会話へ送るを ON にする・backend を変えて承認モードが強くなる）と、
//                        agent が人格を変える（bot 自身の人格を含む。外から来た文に押された bot が人格を書き換える足場になる）のは riskOf で guarded。
//                        名前・アイコン・人の人格の変更・モデル・エフォート・狭める向きは write
//   bots.setMode         human-only。承認モード（Antigravity の bot は yolo だけ）。AI には存在しないのと同じに見える
//   bots.delete          guarded（消す操作）。bot の会話は残り（Chats の一覧に戻る）、DM のチャンネルは archive
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { BotStoreError } from '../bots/store.mjs';

const D = (id, key) => `agent:ops.bots.${id}.${key}`;

/** BotStoreError を OpError にする（保存の側の失敗の code を、辞書にある code に写す）。ほかの例外はそのまま投げる */
function asOpError(ctx, err) {
  if (!(err instanceof BotStoreError)) return err;
  if (err.code === 'BOT_NOT_FOUND') return new OpError('BOT_NOT_FOUND', agentT(ctx.locale, 'ops.errors.BOT_NOT_FOUND', { id: err.id ?? '' }));
  if (err.code === 'BOT_NAME_TAKEN') return new OpError('BOT_NAME_TAKEN', agentT(ctx.locale, 'ops.errors.BOT_NAME_TAKEN', { name: err.name ?? '' }));
  return new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: err.detail ?? err.message }));
}
const guarded = (fn) => async (ctx, args) => { try { return await fn(ctx, args); } catch (e) { throw asOpError(ctx, e); } };

const folder = z.object({
  path: z.string().min(1).max(1000).describe(D('update', 'folderPath')),
  access: z.enum(['rw', 'ro']).optional().describe(D('update', 'folderAccess')),
});

const botShape = {
  id: z.string(), name: z.string(), icon: z.string(), iconImage: z.string(), persona: z.string(),
  backend: z.string(), model: z.string(), effort: z.string(), mode: z.string(),
  folders: z.array(z.object({ path: z.string(), access: z.enum(['rw', 'ro']) })),
  sendToOthers: z.boolean(), sendTargets: z.array(z.string()),
  pulse: z.object({ on: z.boolean(), everyMin: z.number(), backend: z.string(), model: z.string(), channelId: z.string() }),
  dmChannelId: z.string(), dmSessionId: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number(),
};
const botRow = z.object({
  ...botShape,
  usage: z.object({ weekTokens: z.number(), cacheRatio: z.number().nullable() }),
  state: z.enum(['idle', 'working', 'waiting']),
  sendTargetDetails: z.array(z.object({ sessionId: z.string(), title: z.string(), source: z.enum(['shown', 'created', 'manual']) })).optional(),
});

/** agent（bot 自身を含む AI）が人格を変えようとしているか。人格は毎ターン指示の最後に入るので、書き換えは権限を広げるのと同じ重さで承認にする */
const personaByAgent = (ctx, plan) => ctx.principal?.by === 'agent' && plan.rows.some((r) => r.path === 'persona' || r.path === 'iconImage');

/** 承認カードの bot の頭（受領証の元の before にも使う） */
const clip = (s, n = 80) => { const a = [...String(s ?? '')]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };

export const botOps = [
  defineOp({
    id: 'bots.list',
    summary: 'agent:ops.bots.list.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({ bots: z.array(botRow) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['bots', 'list'] } },
    handler: guarded(async (ctx) => ({ bots: await ctx.bots.overview() })),
  }),

  defineOp({
    id: 'bots.get',
    summary: 'agent:ops.bots.get.summary',
    risk: 'read',
    input: z.object({ botId: z.string().min(1).max(100).describe(D('get', 'botId')) }),
    output: botRow,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['bots', 'get'], positional: ['botId'] } },
    handler: guarded(async (ctx, { botId }) => (await ctx.bots.overview({ botId }))[0]),
  }),

  defineOp({
    id: 'bots.create',
    summary: 'agent:ops.bots.create.summary',
    risk: 'write',
    riskReason: 'A new bot starts in the default approval mode of its backend (the weakest one that can write to its workspace and asks each time; Antigravity has only a fully automatic one) with no folders; only a person can raise the mode (bots.setMode). When an AI creates one, riskOf raises it to guarded so the user approves it first, and the card shows the mode it will start in',
    input: z.object({
      name: z.string().min(1).max(64).describe(D('create', 'name')),
      icon: z.string().max(32).optional().describe(D('create', 'icon')),
      iconImage: z.string().max(2000).optional().describe(D('create', 'iconImage')),
      persona: z.string().max(12000).optional().describe(D('create', 'persona')),
      backend: z.string().max(40).optional().describe(D('create', 'backend')),
      model: z.string().max(200).optional().describe(D('create', 'model')),
      effort: z.string().max(40).optional().describe(D('create', 'effort')),
      reason: z.string().max(500).optional().describe(D('create', 'reason')),
    }),
    riskOf: (ctx) => (ctx.principal?.by === 'agent' ? 'guarded' : 'write'),
    // 承認カードに、作られる承認モード（backend の既定）も出す。弱くないモード（Antigravity の yolo など）なら loosens
    confirm: async (ctx, args) => {
      const plan = await ctx.bots.planCreate(args).catch(() => null);
      return {
        before: null, loosens: Boolean(plan?.loosens),
        rows: [{ path: 'name', before: null, after: args.name }, { path: 'icon', before: null, after: args.icon ?? '🤖' },
          ...(args.backend ? [{ path: 'backend', before: null, after: args.backend }] : []),
          ...(plan ? [{ path: 'mode', before: null, after: plan.label }] : []),
          ...(args.persona ? [{ path: 'persona', before: null, after: clip(args.persona) }] : [])],
      };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['bots', 'create'] } },
    handler: guarded(async (ctx, { reason: _reason, ...input }) => {
      const bot = await ctx.bots.create(input, ctx.principal?.by === 'agent' ? { kind: 'agent', sessionId: ctx.actor?.sessionId ?? '' } : { kind: 'human' });
      return (await ctx.bots.overview({ botId: bot.id }))[0];
    }),
  }),

  defineOp({
    id: 'bots.update',
    summary: 'agent:ops.bots.update.summary',
    risk: 'write',
    riskReason: 'Changing the name, emoji icon, model or effort, or narrowing the folders and send targets, only changes a bot definition. Widening what a bot can touch (adding a folder or send target, turning send-to-others on, a backend with a stronger approval mode), turning the heartbeat on or making it more frequent (the bot then acts by itself, ADR 0126), and an AI changing a persona or image icon (its own included) are raised to guarded by riskOf',
    input: z.object({
      botId: z.string().min(1).max(100).describe(D('update', 'botId')),
      name: z.string().min(1).max(64).optional().describe(D('update', 'name')),
      icon: z.string().max(32).optional().describe(D('update', 'icon')),
      iconImage: z.string().max(2000).nullable().optional().describe(D('update', 'iconImage')),
      persona: z.string().max(12000).optional().describe(D('update', 'persona')),
      backend: z.string().max(40).optional().describe(D('update', 'backend')),
      model: z.string().max(200).optional().describe(D('update', 'model')),
      effort: z.string().max(40).optional().describe(D('update', 'effort')),
      folders: z.array(folder).max(20).optional().describe(D('update', 'folders')),
      sendToOthers: z.boolean().optional().describe(D('update', 'sendToOthers')),
      sendTargets: z.array(z.string().min(1).max(200)).max(100).optional().describe(D('update', 'sendTargets')),
      pulse: z.object({
        on: z.boolean().optional().describe(D('update', 'pulseOn')),
        everyMin: z.number().int().min(5).max(60).optional().describe(D('update', 'pulseEveryMin')),
        backend: z.string().max(40).optional().describe(D('update', 'pulseBackend')),
        model: z.string().max(200).optional().describe(D('update', 'pulseModel')),
        channelId: z.string().max(100).optional().describe(D('update', 'pulseChannelId')),
      }).optional().describe(D('update', 'pulse')),
      reason: z.string().max(500).optional().describe(D('update', 'reason')),
    }),
    riskOf: async (ctx, args) => {
      try {
        const plan = await ctx.bots.planUpdate(args);
        return plan.loosens || personaByAgent(ctx, plan) ? 'guarded' : 'write';
      } catch (e) { throw asOpError(ctx, e); }
    },
    confirm: async (ctx, args) => {
      try { const plan = await ctx.bots.planUpdate(args); return { before: plan.before, rows: plan.rows, loosens: plan.loosens || personaByAgent(ctx, plan) }; }
      catch (e) { throw asOpError(ctx, e); }
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['bots', 'update'], positional: ['botId'] } },
    handler: guarded(async (ctx, { reason: _reason, ...input }) => {
      const bot = await ctx.bots.update(input, ctx.principal?.by === 'agent' ? { kind: 'agent', sessionId: ctx.actor?.sessionId ?? '' } : { kind: 'human' });
      return (await ctx.bots.overview({ botId: bot.id }))[0];
    }),
  }),

  // 承認モードは人だけが決める（ADR 0082）。agent の一覧・list_ops・呼び出しのどれにも無い。Antigravity の bot は yolo だけ
  defineOp({
    id: 'bots.setMode',
    summary: 'agent:ops.bots.setMode.summary',
    risk: 'human-only',
    input: z.object({
      botId: z.string().min(1).max(100).describe(D('setMode', 'botId')),
      mode: z.string().min(1).max(40).describe(D('setMode', 'mode')),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: guarded(async (ctx, { botId, mode }) => {
      const bot = await ctx.bots.setMode({ botId, mode }, { kind: 'human' });
      return (await ctx.bots.overview({ botId: bot.id }))[0];
    }),
  }),

  defineOp({
    id: 'bots.delete',
    summary: 'agent:ops.bots.delete.summary',
    risk: 'guarded',
    input: z.object({
      botId: z.string().min(1).max(100).describe(D('delete', 'botId')),
      reason: z.string().max(500).optional().describe(D('delete', 'reason')),
    }),
    confirm: async (ctx, { botId }) => {
      const bot = await ctx.bots.get({ botId });
      return { before: bot ? { id: bot.id, name: bot.name } : null, loosens: false, rows: [{ path: 'bot', before: bot ? `${bot.icon} ${bot.name}` : botId, after: null }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['bots', 'delete'], positional: ['botId'] } },
    handler: guarded(async (ctx, { botId }) => {
      await ctx.bots.remove({ botId }, ctx.principal?.by === 'agent' ? { kind: 'agent', sessionId: ctx.actor?.sessionId ?? '' } : { kind: 'human' });
      return { botId, deleted: true };
    }),
  }),
];
