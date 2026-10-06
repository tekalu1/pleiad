// delegation.*: ply_agents と ply_control が同じ関門を通る。既存の ply_agents の名前と返り値は橋が保つ。
// 本体はサーバーが ctx.delegation で渡す。汎用の tasks/status は本文を一覧に載せず、結果は offset で読む。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { clip, fromHost, humanOnlyFields, pageOf, PAGE_MAX } from './host.mjs';

const D = (id, key) => `agent:ops.delegation.${id}.${key}`;
export const TASKS_MAX = 100;
/** delegation.instructions: 1 件の本文の字数 */
export const INSTRUCTION_CHARS = 1_000;

// changedBy: 依頼元が子の設定を替えた（ply_task_send の backend・model・effort。ADR 0134）なら 'parent'
const routingOf = (r) => (r?.target ? { kind: r.kind ?? null, mode: r.mode ?? null, backend: r.target.backend ?? null, model: r.target.model ?? null, changedBy: r.changed?.by ?? null } : null);

/** 一覧の 1 行。長い本文（依頼・結果）は載せない */
export const taskRow = (r) => ({
  taskId: r.taskId, title: r.title ?? null, host: r.host?.name ?? null, status: r.status, backend: r.backend ?? null, model: r.model ?? null, cwd: r.cwd ?? null,
  parentSessionId: r.parentSessionId ?? null, sessionId: r.sessionId ?? null, createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null,
  routing: routingOf(r.routing),
});

/**
 * delegation.tasks の行を選ぶ。parentSessionId はその会話から委譲したもの、tree を付けると子の会話がさらに委譲した子孫まで。
 * taskIds はその id の行だけ（ほかの条件と重ねる）
 */
function selectTasks(ctx, { parentSessionId, tree = false, taskIds }) {
  let rows = ctx.delegation?.list(tree ? undefined : parentSessionId) ?? [];
  if (parentSessionId && tree) {
    const byParent = new Map();
    for (const r of rows) byParent.set(r.parentSessionId, [...(byParent.get(r.parentSessionId) ?? []), r]);
    const keep = new Set(), seen = new Set([parentSessionId]), queue = [parentSessionId];
    while (queue.length) {
      for (const r of byParent.get(queue.shift()) ?? []) {
        keep.add(r.taskId);
        if (r.sessionId && !seen.has(r.sessionId)) { seen.add(r.sessionId); queue.push(r.sessionId); }
      }
    }
    rows = rows.filter((r) => keep.has(r.taskId));
  }
  if (taskIds) { const ids = new Set(taskIds); rows = rows.filter((r) => ids.has(r.taskId)); }
  return rows;
}

const row = z.object({ taskId: z.string(), title: z.string().nullable(), host: z.string().nullable().optional(), status: z.string(), backend: z.string().nullable(), model: z.string().nullable(), cwd: z.string().nullable(),
  parentSessionId: z.string().nullable(), sessionId: z.string().nullable(), createdAt: z.number().nullable(), updatedAt: z.number().nullable(),
  routing: z.object({ kind: z.string().nullable(), mode: z.string().nullable(), backend: z.string().nullable(), model: z.string().nullable(), changedBy: z.string().nullable() }).nullable() });

export const delegationOps = [
  defineOp({
    id: 'delegation.tasks',
    summary: 'agent:ops.delegation.tasks.summary',
    risk: 'read',
    input: z.object({
      parentSessionId: z.string().max(200).optional().describe(D('tasks', 'parentSessionId')),
      tree: z.boolean().optional().describe(D('tasks', 'tree')),
      taskIds: z.array(z.string().max(200)).max(TASKS_MAX).optional().describe(D('tasks', 'taskIds')),
      status: z.string().max(40).optional().describe(D('tasks', 'status')),
      limit: z.number().int().min(1).max(TASKS_MAX).optional().describe(D('tasks', 'limit')),
    }),
    output: z.object({ total: z.number().int(), tasks: z.array(row) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['delegation', 'tasks'] } },
    legacyCommand: 'agentTasks',
    handler: (ctx, { status, limit = 20, ...pick }) => {
      const all = selectTasks(ctx, pick).filter((r) => !status || r.status === status).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return { total: all.length, tasks: all.slice(0, limit).map(taskRow) };
    },
    // 画面は、依頼の本文以外の全部の欄（通知・承認・作業場所・振り分けの記録）を持つ行を、件数の上限なしで読む。
    // 会話の分（tree）・指定の行（taskIds）は委譲カードとバックグラウンドの一覧に使う形で、結果の本文と拒否の記録を載せない
    // （running は過去のタスクを配らない。docs/agent-delegation.md「保存・画面・再起動」）
    uiHandler: (ctx, { status, ...pick }) => {
      const rows = selectTasks(ctx, pick).filter((r) => !status || r.status === status);
      if (!pick.tree && !pick.taskIds) return rows;
      return rows.map(({ result, resultOffset, resultLength, nextOffset, rejections, ...r }) => r);
    },
  }),

  defineOp({
    id: 'delegation.status',
    summary: 'agent:ops.delegation.status.summary',
    risk: 'read',
    input: z.object({
      taskId: z.string().min(1).max(200).describe(D('status', 'taskId')),
      offset: z.number().int().min(0).optional().describe(D('status', 'offset')),
    }),
    output: row.extend({ result: z.string(), resultOffset: z.number().int(), resultLength: z.number().int(), nextOffset: z.number().int().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['delegation', 'status'], positional: ['taskId'] } },
    handler: (ctx, { taskId, offset = 0 }) => {
      const r = ctx.delegation?.get(taskId, offset);
      if (!r) throw new OpError('TASK_NOT_FOUND', agentT(ctx.locale, 'ops.errors.TASK_NOT_FOUND', { id: taskId }));
      return { ...taskRow(r), result: r.result ?? '', resultOffset: r.resultOffset ?? 0, resultLength: r.resultLength ?? 0, nextOffset: r.nextOffset ?? null };
    },
  }),

  ...[
    { id: 'delegate', tool: 'ply_delegate', risk: 'write', input: z.object({
      kind: z.string().optional().describe(D('delegate', 'kind')),
      task: z.string().min(1).max(60000).describe(D('delegate', 'task')),
      title: z.string().max(200).optional().describe(D('delegate', 'title')),
      backend: z.string().optional().describe(D('delegate', 'backend')),
      context: z.string().max(60000).optional().describe(D('delegate', 'context')),
      cwd: z.string().optional().describe(D('delegate', 'cwd')),
      model: z.string().optional().describe(D('delegate', 'model')),
      effort: z.string().optional().describe(D('delegate', 'effort')),
      isolate: z.boolean().optional().describe(D('delegate', 'isolate')),
      host: z.string().max(200).optional().describe(D('delegate', 'host')),
    }) },
    { id: 'taskStatus', tool: 'ply_task_status', risk: 'read', input: z.object({ taskId: z.string().min(1).describe(D('taskStatus', 'taskId')),
      offset: z.number().int().min(0).optional().describe(D('taskStatus', 'offset')) }) },
    { id: 'taskWait', tool: 'ply_task_wait', risk: 'read', input: z.object({ taskId: z.string().min(1).describe(D('taskWait', 'taskId')),
      seconds: z.number().int().min(1).max(30).optional().describe(D('taskWait', 'seconds')) }) },
    // message を省けば設定だけ替える（backend・model・effort のどれかが要る。確かめるのは server の taskSettingsPlan）
    { id: 'taskSend', tool: 'ply_task_send', risk: 'write', input: z.object({ taskId: z.string().min(1).describe(D('taskSend', 'taskId')),
      message: z.string().min(1).optional().describe(D('taskSend', 'message')),
      backend: z.string().min(1).max(40).optional().describe(D('taskSend', 'backend')),
      model: z.string().max(200).optional().describe(D('taskSend', 'model')),
      effort: z.string().max(40).optional().describe(D('taskSend', 'effort')) }) },
    // 画面は、どの会話の委譲でも止められる（人の操作）。AI は自分が委譲した子だけ（ply_task_cancel）
    { id: 'taskCancel', tool: 'ply_task_cancel', risk: 'write', modeGate: false, input: z.object({ taskId: z.string().min(1).describe(D('taskCancel', 'taskId')) }),
      legacyCommand: 'cancelAgentTask', ui: (ctx, { taskId }) => fromHost(() => ctx.delegation.cancel(taskId)) },
    { id: 'taskList', tool: 'ply_task_list', risk: 'read', input: z.object({}) },
    // 画面は、設定の「使用量」の 1 エージェント分（使用枠とこの PC での実績）。AI は委譲先を選ぶのに要る分だけ（ply_usage）
    { id: 'usage', tool: 'ply_usage', risk: 'read', input: z.object({ backend: z.string().optional().describe(D('usage', 'backend')) }),
      legacyCommand: 'providerUsage', ui: (ctx, { backend }) => fromHost(() => ctx.delegation.providerUsage(backend)) },
  ].map(({ id, tool, risk, input, modeGate, legacyCommand, ui }) => defineOp({
    id: `delegation.${id}`, summary: D(id, 'summary'), risk,
    ...(risk === 'read' ? { output: z.unknown() } : { riskReason: id === 'taskCancel'
      ? 'Cancellation stops only a child owned by this conversation; it is allowed in read-only mode to let an agent stop its child.'
      : 'The owner can start or instruct only its own child, and the existing delegation checks still enforce mode inheritance and escalation approval.' }),
    ...(modeGate === false ? { modeGate: false } : {}),
    input, surfaces: { ui: Boolean(ui), mcp: 'catalog', cli: true },
    ...(legacyCommand ? { legacyCommand } : {}), ...(ui ? { uiHandler: ui } : {}),
    handler: (ctx, args) => {
      if (!ctx.actor.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI'));
      return ctx.delegation.call(ctx.actor.sessionId, tool, args, ctx.locale);
    },
  })),

  // 子への追加の指示の履歴（本文は 1,000 字まで）。新しい順
  defineOp({
    id: 'delegation.instructions',
    summary: 'agent:ops.delegation.instructions.summary',
    risk: 'read',
    input: z.object({
      taskId: z.string().min(1).max(200).describe(D('instructions', 'taskId')),
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(D('instructions', 'limit')),
      cursor: z.string().max(400).optional().describe(D('instructions', 'cursor')),
    }),
    output: z.object({ taskId: z.string(), revision: z.number().int(), total: z.number().int(), next: z.string().nullable(),
      instructions: z.array(z.object({ id: z.string(), at: z.number().nullable(), state: z.string(), text: z.string(), truncated: z.boolean() })) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['delegation', 'instructions'], positional: ['taskId'] } },
    legacyCommand: 'agentTaskInstructions',
    handler: (ctx, { taskId, ...page }) => {
      const r = ctx.delegation?.instructions(taskId);
      if (!r) throw new OpError('TASK_NOT_FOUND', agentT(ctx.locale, 'ops.errors.TASK_NOT_FOUND', { id: taskId }));
      const { total, items, next } = pageOf(ctx, [...r.instructions].reverse(), page);
      return { taskId: r.taskId, revision: r.revision, total, next,
        instructions: items.map((x) => ({ id: String(x.id), at: x.at ?? null, state: String(x.state ?? ''), text: clip(x.text, INSTRUCTION_CHARS), truncated: String(x.text ?? '').length > INSTRUCTION_CHARS })) };
    },
    uiHandler: (ctx, { taskId }) => {
      const r = ctx.delegation.instructions(taskId);
      if (!r) throw new OpError('TASK_NOT_FOUND', agentT(ctx.locale, 'ops.errors.TASK_NOT_FOUND', { id: taskId }));
      return r;
    },
  }),

  // ホストに任せた子の会話の経過を読む（docs/remote.md §4.5「経過の読み出し」、ADR 0146）。詳細を開いている画面（人）だけが呼ぶ。
  // ホストの口 /agent の view を、端末の main の橋で運ぶ。見せる範囲（この端末が任せた子とその子孫）の絞り込みはホストがする。
  // AI の道具（MCP・CLI）には出さない: 子の会話の中身は、AI には ply_task_status の結果の要約までしか渡さない
  defineOp({
    id: 'delegation.hostView',
    summary: 'agent:ops.delegation.hostView.summary',
    risk: 'read',
    input: z.object({
      taskId: z.string().min(1).max(200).describe(D('hostView', 'taskId')),
      hostId: z.string().max(200).optional().describe(D('hostView', 'hostId')),
      cursor: z.object({ from: z.number().int().min(0), check: z.number() }).nullable().optional().describe(D('hostView', 'cursor')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx) => { throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: ctx.op.id })); },
    uiHandler: (ctx, args) => {
      if (!ctx.delegation?.hostView) throw new OpError('UNAVAILABLE', agentT(ctx.locale, 'delegation.remote.unavailable'));
      return ctx.delegation.hostView(args);
    },
  }),

  // 別の候補で同じ依頼をやり直す（新しい子のタスクを作る）。AI は自分が委譲した子だけ。承認モードが強くなる（依頼元より強い子になる）ときの
  // 確認（approved）と、Claude のアカウントの選択（account）は人だけ: AI が渡すと、または確認が要ると NEEDS_UI で画面へ誘導する
  defineOp({
    id: 'delegation.retry',
    summary: 'agent:ops.delegation.retry.summary',
    risk: 'write',
    riskReason: 'Starts a new child from a request the caller already made, on a candidate that is usable now. An agent can only retry its own children, the child never gets a stronger approval mode than the requester (that needs the user: NEEDS_UI), and the account choice and the escalation approval are for a person only. A human can retry any task',
    scope: 'session',
    input: z.object({
      taskId: z.string().min(1).max(200).describe(D('retry', 'taskId')),
      candidate: z.string().min(1).max(200).describe(D('retry', 'candidate')),
      stop: z.boolean().optional().describe(D('retry', 'stop')),
      account: z.string().max(200).optional().describe(D('retry', 'account')),
      approved: z.boolean().optional().describe(D('retry', 'approved')),
    }),
    output: z.object({ task: z.object({ taskId: z.string(), status: z.string(), backend: z.string().nullable(), model: z.string().nullable() }).passthrough() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['delegation', 'retry'], positional: ['taskId', 'candidate'] } },
    legacyCommand: 'retryAgentTask',
    handler: async (ctx, args) => {
      humanOnlyFields(ctx, args, ['account', 'approved']);
      if (!ctx.actor.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: ctx.op.id }));
      const own = ctx.delegation.get(args.taskId);
      if (!own || own.parentSessionId !== ctx.actor.sessionId) throw new OpError('TASK_NOT_FOUND', agentT(ctx.locale, 'ops.errors.TASK_NOT_FOUND', { id: args.taskId }));
      const r = await fromHost(() => ctx.delegation.retry(args));
      if (r.confirm) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: `${ctx.op.id} (${r.confirm.mode})` }));
      return { task: taskRow(r.task) };
    },
    uiHandler: (ctx, args) => fromHost(() => ctx.delegation.retry(args)),
  }),

  // 委譲先の自動振り分けの今の状態（設定・使える候補・警告）。判定器のキーは持たない（登録の有無だけ）。設定を変えるのは settings.set の delegationRouting
  defineOp({
    id: 'delegation.routing',
    summary: 'agent:ops.delegation.routing.summary',
    risk: 'read',
    input: z.object({
      refresh: z.boolean().optional().describe(D('routing', 'refresh')),
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(D('routing', 'limit')),
      cursor: z.string().max(400).optional().describe(D('routing', 'cursor')),
    }),
    output: z.object({ settings: z.unknown(), warnings: z.array(z.unknown()), keys: z.record(z.string(), z.object({ hasKey: z.boolean(), keyRef: z.string().nullable().optional() })), total: z.number().int(), candidates: z.array(z.unknown()), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['delegation', 'routing'] } },
    legacyCommand: 'delegationRouting',
    handler: async (ctx, { refresh, ...page }) => {
      const state = await fromHost(() => ctx.delegation.routing({ refresh }));
      const { total, items, next } = pageOf(ctx, state.candidates ?? [], page);
      return { settings: state.settings, warnings: state.warnings ?? [], keys: state.keys, total, candidates: items, next };
    },
    uiHandler: (ctx, { refresh }) => fromHost(() => ctx.delegation.routing({ refresh })),
  }),
];
