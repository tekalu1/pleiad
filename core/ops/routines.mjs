// ルーティン（P2 の R1。ADR 0111。sessions.send は core/ops/conversations.mjs（ADR 0104）。bot の検査は P3 の X1 が足す。ADR 0113）の操作（`routines.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。handler は `ctx.routines`（core/bots-host.mjs の BotHost.opsDeps → core/routines/service.mjs）を呼ぶ。
// 直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。
//
// 危険度（ADR 0082・0111。human-only は承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングの 5 つだけ）:
//   routines.list / get      read
//   routines.create          write。AI が作るときは riskOf で guarded（承認カード。モードの行つき。弱くないモードなら loosens）
//   routines.update          write。広げる向き（頻度を上げる・モードを強くする・対象を広げる。出来事・webhook は回数に上限が無いので、時刻のトリガから変えるのも頻度を上げる向き）と、
//                            AI が指示（prompt）を変える（人格と同じ: 無人で動く指示を外から来た文に書き換えられる足場になる）のは guarded。それ以外は write
//   routines.pause           write（狭める向き）
//   routines.resume / run    guarded（動き出す。run は dryRun でも承認カードを出す）
//   routines.delete          guarded（消す操作。実行の履歴のスレッドは残る）
//   routines.rotateSecret    human-only（秘密の値。P3 の H1 が足す。ADR 0112）
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { authorOf } from './channels.mjs';
import { RoutineError, describeTrigger } from '../routines/service.mjs';
import { RoutineStoreError, NAME_MAX, PROMPT_MAX, APPROVAL_TIMEOUT_MAX_MIN } from '../routines/store.mjs';
import { INTERVAL_MAX_MINUTES } from '../routines/schedule.mjs';

const D = (id, key) => `agent:ops.routines.${id}.${key}`;
const routineId = (id) => z.string().min(1).max(100).describe(D(id, 'routineId'));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** ルーティンの失敗（service・store が投げる）を、辞書の文つきの OpError にする */
async function run(ctx, fn) {
  try { return await fn(); }
  catch (err) {
    if (err instanceof RoutineError) throw new OpError(err.code, agentT(ctx.locale, `ops.errors.${err.code}`, err.params));
    if (err instanceof RoutineStoreError && err.code === 'ROUTINE_NOT_FOUND') throw new OpError('ROUTINE_NOT_FOUND', agentT(ctx.locale, 'ops.errors.ROUTINE_NOT_FOUND', { id: err.id ?? '' }));
    if (err instanceof RoutineStoreError && err.code === 'ROUTINE_INVALID') throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: err.message }));
    throw err;
  }
}

const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), at: hhmm, weekdaysOnly: z.boolean().optional() }),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), at: hhmm }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(INTERVAL_MAX_MINUTES), window: z.object({ from: hhmm, to: hhmm }).optional() }),
  z.object({ kind: z.literal('cron'), expr: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('event'), on: z.enum(['done', 'failed', 'waiting']), scope: z.union([z.literal('all'), z.object({ sessionIds: z.array(z.string().min(1)).min(1).max(100) })]).optional() }),
  z.object({ kind: z.literal('webhook'), hookId: z.string().min(1).max(100) }),
]).describe('agent:ops.routines.create.trigger');

const lastShape = z.object({ at: z.number(), runId: z.string(), state: z.string(), postId: z.string().optional() });
const routineRow = z.object({
  id: z.string(), name: z.string(), botId: z.string(), channelId: z.string(), prompt: z.string(), trigger: z.unknown(),
  mode: z.string(), approvalTimeoutMin: z.number(), paused: z.boolean(), createdBy: z.unknown(), createdAt: z.number(),
  armedAt: z.number().optional(), last: lastShape.optional(), nextAt: z.number().nullable(),
});

const clip = (s, n = 80) => { const a = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };
/** 承認の受領証の元になる「前の値」。走るたびに変わる last・armedAt は入れない（入れると、承認のあとの実行で毎回聞き直しになる） */
const stable = (r) => (r ? { id: r.id, name: r.name, botId: r.botId, channelId: r.channelId, prompt: r.prompt, trigger: r.trigger, mode: r.mode, approvalTimeoutMin: r.approvalTimeoutMin, paused: r.paused } : null);

export const routineOps = [
  defineOp({
    id: 'routines.list', summary: D('list', 'summary'), risk: 'read', input: z.object({}),
    output: z.object({ routines: z.array(routineRow) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'list'] } },
    handler: async (ctx) => ({ routines: await ctx.routines.list() }),
  }),

  defineOp({
    id: 'routines.get', summary: D('get', 'summary'), risk: 'read',
    input: z.object({ routineId: routineId('get') }),
    output: routineRow,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'get'], positional: ['routineId'] } },
    handler: (ctx, { routineId: id }) => run(ctx, async () => {
      const r = await ctx.routines.get({ routineId: id });
      if (!r) throw new RoutineError('ROUTINE_NOT_FOUND', { id });
      return r;
    }),
  }),

  defineOp({
    id: 'routines.create', summary: D('create', 'summary'), risk: 'write',
    riskReason: 'A new routine only stores a definition: a trigger, an instruction and a bot to run it. It runs in the approval mode it is given (by default the bot\'s own; only a person can raise a bot\'s mode, bots.setMode). A human can create one from the screen, so an agent is treated the same unless it is an AI creating work that will run unattended: riskOf raises that to guarded, and the card shows the mode it will run in',
    input: z.object({
      name: z.string().trim().min(1).max(NAME_MAX).describe(D('create', 'name')),
      botId: z.string().min(1).max(100).describe(D('create', 'botId')),
      channelId: z.string().min(1).max(100).describe(D('create', 'channelId')),
      prompt: z.string().min(1).max(PROMPT_MAX).describe(D('create', 'prompt')),
      trigger,
      mode: z.string().max(40).optional().describe(D('create', 'mode')),   // 空は「省略」（bot の今のモード）
      approvalTimeoutMin: z.number().int().min(1).max(APPROVAL_TIMEOUT_MAX_MIN).optional().describe(D('create', 'approvalTimeoutMin')),
      paused: z.boolean().optional().describe(D('create', 'paused')),
      reason: z.string().max(500).optional().describe(D('create', 'reason')),
    }),
    output: routineRow,
    riskOf: (ctx) => (ctx.principal?.by === 'agent' ? 'guarded' : 'write'),
    confirm: async (ctx, args) => {
      const plan = await run(ctx, () => ctx.routines.planCreate(args));
      return {
        before: null, loosens: Boolean(plan.loosens),
        rows: [{ path: 'name', before: null, after: args.name }, { path: 'trigger', before: null, after: describeTrigger(args.trigger) },
          { path: 'mode', before: null, after: plan.label }, { path: 'prompt', before: null, after: clip(args.prompt) }],
      };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'create'] } },
    handler: (ctx, { reason: _reason, ...input }) => run(ctx, async () => ctx.routines.create(input, await authorOf(ctx))),
  }),

  defineOp({
    id: 'routines.update', summary: D('update', 'summary'), risk: 'write',
    riskReason: 'Changing the name, the bot, the channel or the wait for approval, or narrowing the trigger (fewer runs), the mode or the scope, only changes a definition. Raising the frequency, strengthening the mode or widening the conversations an event trigger watches is raised to guarded by riskOf, and so is an AI rewriting the instruction (it runs unattended, and text from outside could rewrite it)',
    input: z.object({
      routineId: routineId('update'),
      name: z.string().trim().min(1).max(NAME_MAX).optional().describe(D('update', 'name')),
      botId: z.string().min(1).max(100).optional().describe(D('update', 'botId')),
      channelId: z.string().min(1).max(100).optional().describe(D('update', 'channelId')),
      prompt: z.string().min(1).max(PROMPT_MAX).optional().describe(D('update', 'prompt')),
      trigger: trigger.optional(),
      mode: z.string().max(40).optional().describe(D('update', 'mode')),   // 空は「変えない」
      approvalTimeoutMin: z.number().int().min(1).max(APPROVAL_TIMEOUT_MAX_MIN).optional().describe(D('update', 'approvalTimeoutMin')),
      reason: z.string().max(500).optional().describe(D('update', 'reason')),
    }),
    output: routineRow,
    riskOf: async (ctx, args) => {
      const plan = await run(ctx, () => ctx.routines.planUpdate(args));
      return plan.loosens || (ctx.principal?.by === 'agent' && plan.rows.some((r) => r.path === 'prompt')) ? 'guarded' : 'write';
    },
    confirm: async (ctx, args) => {
      const plan = await run(ctx, () => ctx.routines.planUpdate(args));
      return { before: stable(plan.routine), rows: plan.rows, loosens: plan.loosens || (ctx.principal?.by === 'agent' && plan.rows.some((r) => r.path === 'prompt')) };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'update'], positional: ['routineId'] } },
    handler: (ctx, { reason: _reason, ...input }) => run(ctx, async () => ctx.routines.update(input, await authorOf(ctx))),
  }),

  defineOp({
    id: 'routines.pause', summary: D('pause', 'summary'), risk: 'write',
    riskReason: 'Pausing only narrows what runs: the routine stops firing until it is resumed. A run already going is not stopped (use channels.stopThread)',
    input: z.object({ routineId: routineId('pause') }),
    output: routineRow,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'pause'], positional: ['routineId'] } },
    handler: (ctx, { routineId: id }) => run(ctx, () => ctx.routines.pause({ routineId: id })),
  }),

  defineOp({
    id: 'routines.resume', summary: D('resume', 'summary'), risk: 'guarded',
    input: z.object({ routineId: routineId('resume'), reason: z.string().max(500).optional().describe(D('resume', 'reason')) }),
    output: routineRow,
    confirm: async (ctx, { routineId: id }) => {
      const r = await run(ctx, () => ctx.routines.get({ routineId: id }));
      if (!r) throw new OpError('ROUTINE_NOT_FOUND', agentT(ctx.locale, 'ops.errors.ROUTINE_NOT_FOUND', { id }));
      return { before: stable(r), loosens: false, rows: [{ path: 'resume', before: r.name, after: describeTrigger(r.trigger) }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'resume'], positional: ['routineId'] } },
    handler: (ctx, { routineId: id }) => run(ctx, () => ctx.routines.resume({ routineId: id })),
  }),

  defineOp({
    id: 'routines.run', summary: D('run', 'summary'), risk: 'guarded',
    input: z.object({
      routineId: routineId('run'),
      dryRun: z.boolean().optional().describe(D('run', 'dryRun')),
      reason: z.string().max(500).optional().describe(D('run', 'reason')),
    }),
    output: z.unknown(),
    confirm: async (ctx, { routineId: id, dryRun }) => {
      const r = await run(ctx, () => ctx.routines.get({ routineId: id }));
      if (!r) throw new OpError('ROUTINE_NOT_FOUND', agentT(ctx.locale, 'ops.errors.ROUTINE_NOT_FOUND', { id }));
      return { before: stable(r), loosens: false, rows: [{ path: dryRun ? 'dryRun' : 'run', before: null, after: r.name }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'run'], positional: ['routineId'] } },
    handler: (ctx, { routineId: id, dryRun }) => run(ctx, async () => ctx.routines.run({ routineId: id, dryRun: dryRun === true }, await authorOf(ctx))),
  }),

  defineOp({
    id: 'routines.delete', summary: D('delete', 'summary'), risk: 'guarded',
    input: z.object({ routineId: routineId('delete'), reason: z.string().max(500).optional().describe(D('delete', 'reason')) }),
    output: z.object({ routineId: z.string(), deleted: z.boolean() }),
    confirm: async (ctx, { routineId: id }) => {
      const r = await run(ctx, () => ctx.routines.get({ routineId: id }));
      return { before: stable(r), loosens: false, rows: [{ path: 'routine', before: r ? r.name : id, after: null }] };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['routines', 'delete'], positional: ['routineId'] } },
    handler: (ctx, { routineId: id }) => run(ctx, async () => { await ctx.routines.remove({ routineId: id }); return { routineId: id, deleted: true }; }),
  }),
];
