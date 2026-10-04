// i18n-dynamic: agent:brain.loop.
// bot の頭の中（思考の流れ・気がかり・心拍。ADR 0126）の操作（`brain.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// handler は `ctx.brain`（core/brain/store.mjs）と `ctx.pulse`（core/brain/pulse.mjs）を呼ぶ（core/bots-host.mjs の BotHost.opsDeps）。直のツール（mcp: 'direct'）は足さない。
//
// 誰がしたか: 人は botId を渡す。bot の会話に束縛された AI は自分の bot だけ（botId は省ける。別の bot のものは BOT_NOT_FOUND と同じに見せる）。
//   bot でない会話の AI（Chats の AI）は読める（記憶と同じ扱い。ADR 0110）。
// 危険度: view・list は read。気がかりの足す・手放す・眠らせる（止める向き）は write。起こす（pause: false）・［今すぐ］（beat）は AI が呼ぶと guarded
//   （自発の動きを増やす向き。人は write）。流れを消す（clear）は guarded（記録を消す。人は承認なしで通る）。
// 心拍の ON・間隔は bots.update の pulse（広げる向きは guarded）。ここでは足さない。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { OpError, defineOp } from './registry.mjs';
import { parseWakeOn, parseTime, LOOP_TEXT_MAX } from '../brain/answer.mjs';

const D = (id, key) => `agent:ops.brain.${id}.${key}`;
const botIdArg = (id, optional = false) => { const s = z.string().min(1).max(100).describe(D(id, 'botId')); return optional ? s.optional() : s; };

/** 呼び出した主体と、対象の botId。bot の会話に束縛されていれば自分の bot だけ */
async function target(ctx, botId) {
  const sessionId = ctx.principal?.by === 'agent' ? ctx.actor?.sessionId ?? null : null;
  const sb = sessionId ? await ctx.botOfSession?.(sessionId) : null;
  const own = sb?.botId ?? null;
  const id = botId ?? own;
  if (!id || (own && id !== own)) throw new OpError('BOT_NOT_FOUND', agentT(ctx.locale, 'ops.errors.BOT_NOT_FOUND', { id: String(botId ?? '') }));
  const bot = await ctx.bots.get({ botId: id });
  if (!bot) throw new OpError('BOT_NOT_FOUND', agentT(ctx.locale, 'ops.errors.BOT_NOT_FOUND', { id }));
  return { bot, sb };
}

const streamOut = (r) => ({ seq: r.seq, at: r.at, kind: r.kind, text: r.text ?? '', refs: r.refs ?? [], taint: r.taint ?? null, tokens: r.tokens ?? null, meta: r.meta ?? null });
const loopOut = (l) => ({ id: l.id, status: l.status, text: l.text, wakeOn: l.wakeOn ?? null, due: l.due ?? null, taint: l.taint ?? null, createdAt: l.createdAt ?? l.updatedAt, updatedAt: l.updatedAt });

const loopInput = {
  wakeOn: z.union([z.string().max(100), z.object({ thread: z.string().max(80).optional(), word: z.string().max(40).optional(), at: z.union([z.number(), z.string()]).optional() })]).optional().describe(D('loopAdd', 'wakeOn')),
  due: z.union([z.number(), z.string().max(40)]).optional().describe(D('loopAdd', 'due')),
};

export const brainOps = [
  defineOp({
    id: 'brain.view',
    summary: D('view', 'summary'),
    risk: 'read',
    input: z.object({
      botId: botIdArg('view', true),
      limit: z.number().int().min(1).max(200).optional().describe(D('view', 'limit')),
      before: z.number().int().optional().describe(D('view', 'before')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['brain', 'view'], positional: ['botId'] } },
    handler: async (ctx, { botId, limit = 60, before }) => {
      const { bot } = await target(ctx, botId);
      const status = await ctx.pulse.status(bot.id);
      return {
        botId: bot.id, pulse: bot.pulse, status,
        stream: ctx.brain.list(bot.id, { limit, ...(before != null ? { before } : {}) }).map(streamOut),
        loops: ctx.brain.loops(bot.id, 'open').map(loopOut),
        closed: [...ctx.brain.loops(bot.id, 'resolved'), ...ctx.brain.loops(bot.id, 'dropped')].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map(loopOut),
        total: ctx.brain.count(bot.id),
      };
    },
  }),

  defineOp({
    id: 'brain.loopAdd',
    summary: D('loopAdd', 'summary'),
    risk: 'write',
    riskReason: 'Adds one unfinished concern (a short note of at most 200 characters, with an optional wake condition and due time) to the bot\'s own list. It runs nothing by itself; the bot reads it again when it wakes. A bot can only change its own list, and a human can do the same, so an agent is treated the same (ADR 0126)',
    input: z.object({
      botId: botIdArg('loopAdd', true),
      text: z.string().trim().min(1).max(LOOP_TEXT_MAX).describe(D('loopAdd', 'text')),
      ...loopInput,
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['brain', 'loop-add'], positional: ['text'] } },
    handler: async (ctx, { botId, text, wakeOn, due }) => {
      const { bot, sb } = await target(ctx, botId);
      const now = Date.now();
      const { applied } = ctx.brain.applyLoops(bot.id, [{ op: 'add', text, wakeOn: parseWakeOn(wakeOn, now), due: parseTime(due, now) }], { taint: sb?.taint ?? null });
      for (const a of applied) ctx.brain.append(bot.id, { kind: 'loop', text: agentT(ctx.locale, 'brain.loop.add', { text: a.text }), refs: [a.id], taint: sb?.taint ?? null });
      return { id: applied[0]?.id ?? null, applied };
    },
  }),

  defineOp({
    id: 'brain.loopResolve',
    summary: D('loopResolve', 'summary'),
    risk: 'write',
    riskReason: 'Marks one of the bot\'s own concerns as resolved or dropped. It only changes a note in the bot\'s list, and a human can do the same, so an agent is treated the same (ADR 0126)',
    input: z.object({
      botId: botIdArg('loopResolve', true),
      id: z.string().min(1).max(40).describe(D('loopResolve', 'id')),
      status: z.enum(['resolved', 'dropped']).optional().describe(D('loopResolve', 'status')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['brain', 'loop-resolve'], positional: ['id'] } },
    handler: async (ctx, { botId, id, status = 'resolved' }) => {
      const { bot, sb } = await target(ctx, botId);
      const { applied } = ctx.brain.applyLoops(bot.id, [{ op: status === 'dropped' ? 'drop' : 'resolve', id }], { taint: sb?.taint ?? null });
      if (!applied.length) throw new OpError('NOT_FOUND', agentT(ctx.locale, 'ops.errors.NOT_FOUND', { id }));
      for (const a of applied) ctx.brain.append(bot.id, { kind: 'loop', text: agentT(ctx.locale, `brain.loop.${a.op}`, { text: a.text }), refs: [a.id] });
      return { id, status };
    },
  }),

  defineOp({
    id: 'brain.pause',
    summary: D('pause', 'summary'),
    risk: 'write',
    riskReason: 'Putting a bot to sleep (paused: true) stops its heartbeat and only narrows what runs. Waking it (paused: false) lets it act by itself again, so riskOf raises that to guarded when an AI asks; a human can do either',
    input: z.object({ botId: botIdArg('pause'), paused: z.boolean().describe(D('pause', 'paused')), reason: z.string().max(500).optional().describe(D('pause', 'reason')) }),
    output: z.unknown(),
    riskOf: (ctx, args) => (ctx.principal?.by === 'agent' && args.paused === false ? 'guarded' : 'write'),
    confirm: async (ctx, args) => {
      const { bot } = await target(ctx, args.botId);
      return { before: { paused: ctx.brain.state(bot.id).paused }, loosens: true, rows: [{ path: 'pulse.paused', before: String(ctx.brain.state(bot.id).paused), after: String(args.paused) }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['brain', 'pause'], positional: ['botId'] } },
    handler: async (ctx, { botId, paused }) => {
      const { bot } = await target(ctx, botId);
      const state = ctx.pulse.pause(bot.id, paused);
      return { botId: bot.id, paused: state.paused, nextAt: state.nextAt };
    },
  }),

  defineOp({
    id: 'brain.beat',
    summary: D('beat', 'summary'),
    risk: 'write',
    riskReason: 'Runs one heartbeat of a bot now (the sieve, and maybe one call to the cheap model). It is counted in the channel budget like any other heartbeat and cannot pass a paused bot or an empty budget. A human can press it; an AI calling it makes the bot act by itself, so riskOf raises that to guarded (ADR 0126)',
    input: z.object({ botId: botIdArg('beat'), reason: z.string().max(500).optional().describe(D('beat', 'reason')) }),
    output: z.unknown(),
    riskOf: (ctx) => (ctx.principal?.by === 'agent' ? 'guarded' : 'write'),
    confirm: async (ctx, args) => {
      const { bot } = await target(ctx, args.botId);
      return { before: null, loosens: true, rows: [{ path: 'beat', before: null, after: `${bot.icon} ${bot.name}`.trim() }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['brain', 'beat'], positional: ['botId'] } },
    handler: async (ctx, { botId }) => {
      const { bot } = await target(ctx, botId);
      const r = await ctx.pulse.beat(bot.id, { force: true });
      return { botId: bot.id, ran: r.ran, gate: r.gate ?? null, did: r.did ?? null, skipped: r.skipped ?? null, error: r.error ?? null };
    },
  }),

  defineOp({
    id: 'brain.clear',
    summary: D('clear', 'summary'),
    risk: 'guarded',
    input: z.object({ botId: botIdArg('clear'), reason: z.string().max(500).optional().describe(D('clear', 'reason')) }),
    output: z.unknown(),
    confirm: async (ctx, args) => {
      const { bot } = await target(ctx, args.botId);
      return { before: { total: ctx.brain.count(bot.id) }, loosens: false, rows: [{ path: 'brain', before: String(ctx.brain.count(bot.id)), after: '0' }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['brain', 'clear'], positional: ['botId'] } },
    handler: async (ctx, { botId }) => {
      const { bot } = await target(ctx, botId);
      return { botId: bot.id, ...ctx.brain.clear(bot.id) };
    },
  }),
];
