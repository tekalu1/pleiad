// bot の記憶（S3。ADR 0110）の操作（`memory.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。
// handler は `ctx.memory`（core/memory/service.mjs。core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。
//
// 誰がしたか: 人は { kind: 'human' }、bot の会話に束縛された AI は { kind: 'bot', botId }、それ以外の会話の AI は { kind: 'agent', sessionId }。
// 束縛されない AI（外のターミナルの CLI・外の AI の MCP）は書き手にならない（NEEDS_UI）。
// bot が触れる層は 'user'（あなたについて）と自分の層だけ。層に 'self' と書けば自分の層（bot に束縛された会話だけ）。
// i18n-dynamic: agent:memory.reason.
import { z } from 'zod';
import { OpError, defineOp } from './registry.mjs';
import { agentT } from '../i18n.mjs';
import { MemoryError, QUOTE_MIN } from '../memory/guard.mjs';
import { USER_LAYER, oneLine } from '../memory/store.mjs';
import { MEMORY_KINDS, MEMORY_STATUSES, WEIGHT_MIN, WEIGHT_MAX } from '../memory/strength.mjs';

const D = (id, key) => `agent:ops.memory.${id}.${key}`;

const sourceInput = z.object({
  kind: z.enum(['post', 'message']).describe(D('write', 'source.kind')),
  channelId: z.string().max(120).optional().describe(D('write', 'source.channelId')),
  postId: z.string().max(120).optional().describe(D('write', 'source.postId')),
  threadId: z.string().max(120).optional().describe(D('write', 'source.threadId')),
  sessionId: z.string().max(120).optional().describe(D('write', 'source.sessionId')),
  messageId: z.string().max(200).optional().describe(D('write', 'source.messageId')),
  quote: z.string().min(QUOTE_MIN).max(600).describe(D('write', 'source.quote')),
}).strict();

// 種類・重み・状態（ADR 0118。どれも任意）と、今の強さ strength・薄れたか faded（list・search が付ける。保存しない）
const entryOut = z.object({
  id: z.string(), layer: z.string(), text: z.string(), why: z.string().optional(),
  sources: z.array(z.unknown()), at: z.number(), updatedAt: z.number(), by: z.unknown(), origBy: z.unknown().optional(),
  kind: z.enum(MEMORY_KINDS).optional(), weight: z.number().int().optional(), status: z.enum(MEMORY_STATUSES).optional(),
  strength: z.number().optional(), faded: z.boolean().optional(),
});
const tagInputs = (id) => ({
  kind: z.enum(MEMORY_KINDS).optional().describe(D(id, 'kind')),
  weight: z.number().int().min(WEIGHT_MIN).max(WEIGHT_MAX).optional().describe(D(id, 'weight')),
  status: z.enum(MEMORY_STATUSES).optional().describe(D(id, 'status')),
});
/** 種類・重み・状態のうち、今の行から変わるものがあるか */
const changesTags = (entry, args) => ['kind', 'weight', 'status'].some((key) => args[key] !== undefined && args[key] !== entry[key]);

const learnStatusOut = z.object({
  at: z.string(), paused: z.boolean(), running: z.boolean(), lastRunAt: z.number().nullable(), nextAt: z.number().nullable(),
  lastResult: z.object({ at: z.number(), read: z.number(), changed: z.number(), deferred: z.number().optional(), more: z.boolean().optional(), scoped: z.boolean().optional() }).nullable(),
  skip: z.object({ reason: z.string(), count: z.number(), at: z.number() }).nullable(),
  failure: z.object({ message: z.string(), count: z.number(), at: z.number(), retryAt: z.number() }).nullable(),
});

/** MemoryError → OpError（会話の言語の文）。ほかの例外はそのまま */
const asOpError = (ctx, err) => {
  if (!(err instanceof MemoryError)) return err;
  const reason = agentT(ctx.locale, `memory.reason.${err.reason}`);
  return new OpError(err.code, agentT(ctx.locale, `ops.errors.${err.code}`, { reason, id: err.detail }));
};
const guarded = async (ctx, fn) => { try { return await fn(); } catch (err) { throw asOpError(ctx, err); } };

/** 呼び出した主体: { author, botId }。author が無い（書けない）主体は NEEDS_UI。read は author なしで通す */
async function whoIs(ctx, { write = true } = {}) {
  if (ctx.principal?.by === 'human') return { author: { kind: 'human' }, botId: null, sessionId: null };
  const sessionId = ctx.actor?.sessionId ?? null;
  if (!sessionId) {
    if (write) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: ctx.op.id }));
    return { author: null, botId: null, sessionId: null };
  }
  const bot = await ctx.botOfSession?.(sessionId);
  return bot?.botId
    ? { author: { kind: 'bot', botId: bot.botId }, botId: bot.botId, sessionId }
    : { author: { kind: 'agent', sessionId }, botId: null, sessionId };
}

const rejectLayer = (ctx) => new OpError('MEMORY_REJECTED', agentT(ctx.locale, 'ops.errors.MEMORY_REJECTED', { reason: agentT(ctx.locale, 'memory.reason.layer') }));

/** 層の名前を決める。'self' は bot の会話の自分の層。bot は 'user' と自分の層だけ */
function layerOf(ctx, who, layer) {
  const name = layer === 'self' ? who.botId : layer;
  if (!name) throw rejectLayer(ctx);
  if (who.botId && name !== USER_LAYER && name !== who.botId) throw rejectLayer(ctx);
  return name;
}

/** 検索の範囲。層の指定があればその層、無ければ bot は自分の 2 層・それ以外は全部（undefined） */
const scopeOf = (ctx, who, layer) => (layer ? { layer: layerOf(ctx, who, layer) } : who.botId ? { layers: [USER_LAYER, who.botId] } : {});

/** 名指しの id が、この主体に見える記憶か（bot は 'user' と自分の層だけ。見えないものは無いのと同じに） */
async function visibleEntry(ctx, who, id) {
  const entry = await ctx.memory.get({ id });
  if (!entry || (who.botId && entry.layer !== USER_LAYER && entry.layer !== who.botId)) {
    throw new OpError('MEMORY_NOT_FOUND', agentT(ctx.locale, 'ops.errors.MEMORY_NOT_FOUND', { id }));
  }
  return entry;
}

const callCtx = (ctx, who) => ({ sessions: ctx.sessions, botOfSession: ctx.botOfSession, sessionId: who.sessionId, locale: ctx.locale });

export const memoryOps = [
  defineOp({
    id: 'memory.list',
    summary: 'agent:ops.memory.list.summary',
    risk: 'read',
    input: z.object({ layer: z.string().min(1).max(80).describe(D('list', 'layer')) }),
    output: z.array(entryOut),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['memory', 'list'], positional: ['layer'] } },
    handler: async (ctx, { layer }) => {
      const who = await whoIs(ctx, { write: false });
      return ctx.memory.list({ layer: layerOf(ctx, who, layer) });
    },
  }),

  defineOp({
    id: 'memory.search',
    summary: 'agent:ops.memory.search.summary',
    risk: 'read',
    input: z.object({
      query: z.string().min(1).max(200).describe(D('search', 'query')),
      layer: z.string().min(1).max(80).optional().describe(D('search', 'layer')),
      limit: z.number().int().min(1).max(8).optional().describe(D('search', 'limit')),
    }),
    output: z.array(entryOut),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['memory', 'search'], positional: ['query'] } },
    handler: async (ctx, { query, layer, limit }) => {
      const who = await whoIs(ctx, { write: false });
      return ctx.memory.search({ query, limit: limit ?? 5, ...scopeOf(ctx, who, layer) });
    },
  }),

  defineOp({
    id: 'memory.write',
    summary: 'agent:ops.memory.write.summary',
    risk: 'write',
    riskReason: 'Adds one short line to a bot\'s memory. The code checks it instead of an approval card: it must rest on something a human said, and it is refused if it looks like a URL, a command or an instruction, or repeats something that was forgotten. A human can edit or forget it, and it only adds a note, so it also works from read-only and plan modes',
    modeGate: false,
    input: z.object({
      layer: z.string().min(1).max(80).describe(D('write', 'layer')),
      text: z.string().min(1).max(2000).describe(D('write', 'text')),
      why: z.string().max(600).optional().describe(D('write', 'why')),
      sources: z.array(sourceInput).max(8).default([]).describe(D('write', 'sources')),
      ...tagInputs('write'),
    }),
    output: entryOut,
    surfaces: { ui: true, mcp: 'catalog', cli: false },
    handler: async (ctx, args) => {
      const who = await whoIs(ctx);
      const layer = layerOf(ctx, who, args.layer);
      return guarded(ctx, () => ctx.memory.write({ layer, text: args.text, why: args.why, sources: args.sources, kind: args.kind, weight: args.weight, status: args.status },
        who.author, callCtx(ctx, who)));
    },
  }),

  defineOp({
    id: 'memory.edit',
    summary: 'agent:ops.memory.edit.summary',
    risk: 'write',
    riskReason: 'Rewrites one line of memory. An AI is held to the same checks as when writing (it needs a human\'s words as grounds when the text changes), and the log keeps who changed it (and, when the author changes, the original author) and the old text can be read from the log. A human can edit it the same way. An AI rewriting the text of a line a person wrote is raised to guarded by riskOf, so the user approves it first',
    input: z.object({
      id: z.string().min(1).max(80).describe(D('edit', 'id')),
      text: z.string().min(1).max(2000).optional().describe(D('edit', 'text')),
      why: z.string().max(600).optional().describe(D('edit', 'why')),
      sources: z.array(sourceInput).max(8).optional().describe(D('edit', 'sources')),
      ...tagInputs('edit'),
    }),
    output: entryOut,
    // 人が書いた行の本文・種類・重み・状態を AI が変えるときだけ承認（自分・ほかの AI が書いた行、理由だけの直しは write）。
    // 重みと種類は、その記憶が会話の始まりに渡るか（薄れるか）を決めるので、本文と同じに扱う（ADR 0118）
    riskOf: async (ctx, args) => {
      if (ctx.principal?.by !== 'agent' || (args.text === undefined && args.kind === undefined && args.weight === undefined && args.status === undefined)) return 'write';
      const who = await whoIs(ctx, { write: false });
      const entry = await ctx.memory.get({ id: args.id });
      if (!entry || (who.botId && entry.layer !== USER_LAYER && entry.layer !== who.botId)) return 'write';   // 見えない記憶は handler が MEMORY_NOT_FOUND にする
      const rewrites = (args.text !== undefined && oneLine(args.text) !== entry.text) || changesTags(entry, args);
      return entry.by?.kind === 'human' && rewrites ? 'guarded' : 'write';
    },
    confirm: async (ctx, args) => {
      const entry = await ctx.memory.get({ id: args.id });
      const rows = [
        ...(args.text !== undefined ? [{ path: 'text', before: entry?.text ?? null, after: oneLine(args.text) }] : []),
        ...['kind', 'weight', 'status'].filter((key) => args[key] !== undefined).map((key) => ({ path: key, before: entry?.[key] ?? null, after: args[key] })),
      ];
      return { note: agentT(ctx.locale, 'ops.memory.edit.confirm'), before: entry?.text ?? null, loosens: false, rows };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['memory', 'edit'], positional: ['id'] } },
    handler: async (ctx, args) => {
      const who = await whoIs(ctx);
      await visibleEntry(ctx, who, args.id);
      return guarded(ctx, () => ctx.memory.edit({ id: args.id, text: args.text, why: args.why, sources: args.sources, kind: args.kind, weight: args.weight, status: args.status },
        who.author, callCtx(ctx, who)));
    },
  }),

  defineOp({
    id: 'memory.forget',
    summary: 'agent:ops.memory.forget.summary',
    risk: 'guarded',
    input: z.object({ id: z.string().min(1).max(80).describe(D('forget', 'id')) }),
    output: entryOut,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['memory', 'forget'], positional: ['id'] } },
    confirm: async (ctx, { id }) => {
      const entry = await ctx.memory.get({ id });
      return { note: agentT(ctx.locale, 'ops.memory.forget.confirm', { text: entry?.text ?? id }), before: entry?.text ?? null };
    },
    handler: async (ctx, { id }) => {
      const who = await whoIs(ctx);
      await visibleEntry(ctx, who, id);
      return guarded(ctx, () => ctx.memory.forget({ id }, who.author, callCtx(ctx, who)));
    },
  }),

  // 夜の記憶の整理の様子（最後に走った時刻・結果・次の予定・飛ばした回数と理由・失敗）。bot のページの記憶の見出しに出す（ADR 0118）
  defineOp({
    id: 'memory.learnStatus',
    summary: 'agent:ops.memory.learnStatus.summary',
    risk: 'read',
    input: z.object({}),
    output: learnStatusOut,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['memory', 'learn-status'] } },
    handler: async (ctx) => ctx.memoryLearner.status(),
  }),

  // 忘れた直後の「元に戻す」。画面の「元に戻す」の帯と、AI・CLI の両方に出す（全機能は AI も使える）。誰が戻したかは log.jsonl の by に残る
  defineOp({
    id: 'memory.unforget',
    summary: 'agent:ops.memory.unforget.summary',
    risk: 'write',
    riskReason: 'Brings back the line of memory that was forgotten last (with its grounds) and lifts the tombstone. It only restores what was already in memory and the log records who did it, so it is a write for an AI too. A bot sees only the user layer and its own layer',
    input: z.object({ id: z.string().min(1).max(80).describe(D('unforget', 'id')) }),
    output: entryOut,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['memory', 'unforget'], positional: ['id'] } },
    handler: async (ctx, { id }) => {
      const who = await whoIs(ctx);
      const gone = await ctx.memory.forgotten({ id });
      if (gone && who.botId && gone.layer !== USER_LAYER && gone.layer !== who.botId) {
        throw new OpError('MEMORY_NOT_FOUND', agentT(ctx.locale, 'ops.errors.MEMORY_NOT_FOUND', { id }));
      }
      return guarded(ctx, () => ctx.memory.unforget({ id }, who.author, callCtx(ctx, who)));
    },
  }),
];
