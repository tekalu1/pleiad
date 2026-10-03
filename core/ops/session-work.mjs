// sessions.* のうち、会話の中で動いているもの（バックグラウンドの処理・サブエージェント）を読む・止める操作と、
// エージェントの切り替え・グループの外し方（ADR 0096）。画面の WS コマンド（loadBackground・stopBackground・loadSubagent・findSubagent・
// switchBackend・setGrouped）はこの操作を呼ぶ薄い外側。本体はサーバーが ctx.sessionWork で渡す（core/server.mjs の opsSessionWork）。
// 画面（人）には今までの形を返し（uiHandler）、AI・CLI には一覧を limit / cursor で区切り、本文と出力を切った形を返す。
//
// 危険度:
//   switchBackend は guarded。sessions.setTurnSettings の backend（次のターンからの切り替え）と同じ理由（承認モードの掛かる範囲と既定のモードが変わる）で、
//   こちらだけ緩めると抜け道になる。切り替え先の最初の承認モードが今より緩くなる（例: Antigravity は全自動）切り替えは、AI からは NEEDS_UI で断る
//   （承認モードは人だけが決める。ADR 0094）。
//   stopBackground は write（裏の処理を 1 本止めるだけ。会話もターンも消えない）。他の会話のものも止められるので、読み取りの会話からは断る（sessions.abort と同じ）。
//   setGrouped は write（一覧の見え方だけ）。
import { z } from 'zod';
import { agentT, t } from '../i18n.mjs';
import { modePosition, scopeRank, autonomyRank } from '../modes.mjs';
import { defineOp, OpError } from './registry.mjs';
import { clip, FAILED, pageOf, PAGE_MAX } from './host.mjs';
import { byAgent, maskTree, run } from './redact.mjs';

const D = (id, key) => `agent:ops.sessions.${id}.${key}`;

/** 本文・出力の字数（既定・上限） */
export const WORK_CHARS_DEFAULT = 2_000;
export const WORK_OUTPUT_DEFAULT = 8_000;
export const WORK_CHARS_MAX = 20_000;

const sessionId = (id) => z.string().min(1).max(200).optional().describe(D(id, 'sessionId'));
const limit = (id) => z.number().int().min(1).max(PAGE_MAX).optional().describe(D(id, 'limit'));
const cursor = (id) => z.string().max(400).optional().describe(D(id, 'cursor'));
const maxChars = (id) => z.number().int().min(100).max(WORK_CHARS_MAX).optional().describe(D(id, 'maxChars'));

// 画面への今までの断りの文
const sessionRequired = () => t('session.required');
const idsRequired = () => t('background.idsRequired');
const agentIdsRequired = () => t('background.agentIdsRequired');

/** AI は sessionId を省けば自分の会話。画面は省けない（今までの文で断る） */
function target(ctx, given, humanText = sessionRequired) {
  if (given) return given;
  if (!byAgent(ctx)) throw new OpError(FAILED, humanText());
  if (!ctx.actor?.sessionId) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return ctx.actor.sessionId;
}
/** 画面の読み取りは id が揃っていなければ今までの文で断る */
const need = (ok, text) => { if (!ok) throw new OpError(FAILED, text()); };
/** 文字列の欄を、末尾を残して切る（出力は終わりの方が大事） */
const tailOf = (s, n) => (s.length > n ? s.slice(-n) : s);

/** 切り替え先の最初の承認モードが、今のモードよりどれかの軸で緩いか（範囲が広い・聞く回数が少ない） */
export function loosens(from, to) {
  const a = modePosition(from), b = modePosition(to);
  return scopeRank(b.scope) > scopeRank(a.scope) || autonomyRank(b.autonomy) > autonomyRank(a.autonomy);
}

export const sessionWorkOps = [
  defineOp({
    id: 'sessions.switchBackend',
    summary: 'agent:ops.sessions.switchBackend.summary',
    risk: 'guarded',
    scope: 'session',
    input: z.object({ sessionId: sessionId('switchBackend'), backend: z.string().min(1).max(40).describe(D('switchBackend', 'backend')) }),
    output: z.object({ sessionId: z.string(), backend: z.string() }),
    // AI から: 無い会話・知らないエージェントは承認カードの前に断り、承認モードが緩くなる切り替えは人の画面へ（NEEDS_UI）
    riskOf: async (ctx, { sessionId: given, backend }) => {
      if (!byAgent(ctx)) return 'guarded';
      const plan = await ctx.sessionWork.switchPlan(target(ctx, given), backend);
      if (!plan) throw new OpError('SESSION_NOT_FOUND', agentT(ctx.locale, 'ops.errors.SESSION_NOT_FOUND', { id: given ?? ctx.actor.sessionId }));
      if (!plan.to) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: `backend: ${backend}` }));
      if (plan.from.backend !== plan.to.backend && loosens(plan.from.position, plan.to.position))
        throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: `${ctx.op.id} (mode: ${plan.from.mode} → ${plan.to.mode})` }));
      return 'guarded';
    },
    confirm: async (ctx, { sessionId: given, backend }) => {
      const id = target(ctx, given);
      const plan = await ctx.sessionWork.switchPlan(id, backend);
      return { key: null, before: { sessionId: id, backend: plan?.from.backend ?? null, mode: plan?.from.mode ?? null },
        rows: [{ path: 'backend', before: JSON.stringify(plan?.from.backend ?? null), after: JSON.stringify(backend) }, { path: 'mode', before: JSON.stringify(plan?.from.mode ?? null), after: JSON.stringify(plan?.to?.mode ?? null) }],
        note: t('opsApproval.switchBackend', { title: plan?.title || id, backend: plan?.to?.label ?? backend }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'switch-backend'], positional: ['backend'] } },
    legacyCommand: 'switchBackend',
    handler: (ctx, { sessionId: given, backend }) => run(ctx, () => ctx.sessionWork.switchBackend(target(ctx, given), backend)),
  }),

  defineOp({
    id: 'sessions.setGrouped',
    summary: 'agent:ops.sessions.setGrouped.summary',
    risk: 'write',
    riskReason: 'Only takes a conversation out of its group in the list (or puts it back); nothing in the conversation changes (ADR 0096)',
    scope: 'session',
    input: z.object({ sessionId: sessionId('setGrouped'), ungrouped: z.boolean().describe(D('setGrouped', 'ungrouped')) }),
    output: z.object({ sessionId: z.string(), ungrouped: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'set-grouped'], positional: ['ungrouped'] } },
    legacyCommand: 'setGrouped',
    handler: (ctx, { sessionId: given, ungrouped }) => run(ctx, () => ctx.sessionWork.setGrouped(target(ctx, given), ungrouped)),
  }),

  // ---- バックグラウンドの処理（端末・裏のエージェント）
  defineOp({
    id: 'sessions.background',
    summary: 'agent:ops.sessions.background.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({
      sessionId: sessionId('background'),
      taskId: z.string().min(1).max(200).optional().describe(D('background', 'taskId')),
      maxChars: maxChars('background'),
    }),
    output: z.object({ tasks: z.array(z.record(z.string(), z.unknown())).optional(), task: z.record(z.string(), z.unknown()).nullable().optional() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'background'] } },
    legacyCommand: 'loadBackground',
    uiHandler: (ctx, { sessionId: id, taskId }) => { need(id && taskId, idsRequired); return ctx.sessionWork.background(id, taskId); },
    handler: (ctx, { sessionId: given, taskId, maxChars: chars = WORK_OUTPUT_DEFAULT }) => run(ctx, async () => {
      const id = target(ctx, given);
      if (!taskId) return maskTree({ tasks: await ctx.sessionWork.backgroundTasks(id) });
      const { task } = await ctx.sessionWork.background(id, taskId);
      if (!task) return { task: null };
      const cut = Object.fromEntries(Object.entries(task).map(([k, v]) => [k, typeof v === 'string' && v.length > chars ? tailOf(v, chars) : v]));
      const long = Object.values(task).some((v) => typeof v === 'string' && v.length > chars);
      return maskTree({ task: { ...cut, ...(long ? { truncated: true } : {}) } });
    }),
  }),

  defineOp({
    id: 'sessions.stopBackground',
    summary: 'agent:ops.sessions.stopBackground.summary',
    risk: 'write',
    riskReason: 'Only stops one background task (a terminal or a background agent) of a conversation; the conversation and its turns stay. It can stop another conversation\'s task, so it follows the caller\'s approval mode (refused in read-only), like sessions.abort (ADR 0096)',
    scope: 'session',
    input: z.object({ sessionId: sessionId('stopBackground'), taskId: z.string().min(1).max(200).describe(D('stopBackground', 'taskId')) }),
    output: z.object({ stopped: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'stop-background'], positional: ['taskId'] } },
    legacyCommand: 'stopBackground',
    handler: (ctx, { sessionId: given, taskId }) => run(ctx, () => ctx.sessionWork.stopBackground(target(ctx, given, idsRequired), taskId)),
  }),

  // ---- サブエージェント（会話の中の委譲ツールが生んだ子）
  defineOp({
    id: 'sessions.subagents',
    summary: 'agent:ops.sessions.subagents.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({
      sessionId: sessionId('subagents'),
      toolId: z.string().min(1).max(200).optional().describe(D('subagents', 'toolId')),
      limit: limit('subagents'), cursor: cursor('subagents'),
    }),
    output: z.object({ agentId: z.string().nullable().optional(), subagents: z.array(z.record(z.string(), z.unknown())).optional() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'subagents'] } },
    legacyCommand: 'findSubagent',
    uiHandler: (ctx, { sessionId: id, toolId }) => { need(id && toolId, agentIdsRequired); return ctx.sessionWork.findSubagent(id, toolId); },
    handler: (ctx, { sessionId: given, toolId, limit: n, cursor: c }) => run(ctx, async () => {
      const id = target(ctx, given, agentIdsRequired);
      if (toolId) return ctx.sessionWork.findSubagent(id, toolId);
      const page = pageOf(ctx, await ctx.sessionWork.subagents(id), { limit: n, cursor: c });
      return { total: page.total, subagents: page.items, next: page.next };
    }),
  }),

  defineOp({
    id: 'sessions.readSubagent',
    summary: 'agent:ops.sessions.readSubagent.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({
      sessionId: sessionId('readSubagent'),
      agentId: z.string().min(1).max(200).describe(D('readSubagent', 'agentId')),
      limit: limit('readSubagent'), cursor: cursor('readSubagent'), maxChars: maxChars('readSubagent'),
    }),
    output: z.object({ agentId: z.string(), sessionId: z.string(), messages: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'read-subagent'], positional: ['agentId'] } },
    legacyCommand: 'loadSubagent',
    uiHandler: (ctx, { sessionId: id, agentId }) => { need(id && agentId, agentIdsRequired); return ctx.sessionWork.readSubagent(id, agentId); },
    handler: (ctx, { sessionId: given, agentId, limit: n, cursor: c, maxChars: chars = WORK_CHARS_DEFAULT }) => run(ctx, async () => {
      const id = target(ctx, given, agentIdsRequired);
      const got = await ctx.sessionWork.readSubagent(id, agentId);
      const page = pageOf(ctx, got.messages ?? [], { limit: n, cursor: c });
      const text = (s) => String(s ?? '');
      return maskTree({
        agentId: got.agentId, sessionId: got.sessionId, origin: got.origin ?? null,
        prompt: got.prompt == null ? null : clip(got.prompt, chars), total: page.total, next: page.next,
        messages: page.items.map((m) => ({ role: m.role, at: m.at ?? null, text: clip(m.text, chars), ...(text(m.text).length > chars ? { truncated: true } : {}),
          ...(m.tools?.length ? { tools: m.tools } : {}), ...(m.model ? { model: m.model } : {}) })),
      });
    }),
  }),
];
