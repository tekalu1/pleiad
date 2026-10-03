// delegation.*: ply_agents と ply_control が同じ関門を通る。既存の ply_agents の名前と返り値は橋が保つ。
// 本体はサーバーが ctx.delegation で渡す。汎用の tasks/status は本文を一覧に載せず、結果は offset で読む。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';

const D = (id, key) => `agent:ops.delegation.${id}.${key}`;
export const TASKS_MAX = 100;

const routingOf = (r) => (r?.target ? { kind: r.kind ?? null, mode: r.mode ?? null, backend: r.target.backend ?? null, model: r.target.model ?? null } : null);

/** 一覧の 1 行。長い本文（依頼・結果）は載せない */
export const taskRow = (r) => ({
  taskId: r.taskId, title: r.title ?? null, status: r.status, backend: r.backend ?? null, model: r.model ?? null, cwd: r.cwd ?? null,
  parentSessionId: r.parentSessionId ?? null, sessionId: r.sessionId ?? null, createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null,
  routing: routingOf(r.routing),
});

const row = z.object({ taskId: z.string(), title: z.string().nullable(), status: z.string(), backend: z.string().nullable(), model: z.string().nullable(), cwd: z.string().nullable(),
  parentSessionId: z.string().nullable(), sessionId: z.string().nullable(), createdAt: z.number().nullable(), updatedAt: z.number().nullable(),
  routing: z.object({ kind: z.string().nullable(), mode: z.string().nullable(), backend: z.string().nullable(), model: z.string().nullable() }).nullable() });

export const delegationOps = [
  defineOp({
    id: 'delegation.tasks',
    summary: 'agent:ops.delegation.tasks.summary',
    risk: 'read',
    input: z.object({
      parentSessionId: z.string().max(200).optional().describe(D('tasks', 'parentSessionId')),
      status: z.string().max(40).optional().describe(D('tasks', 'status')),
      limit: z.number().int().min(1).max(TASKS_MAX).optional().describe(D('tasks', 'limit')),
    }),
    output: z.object({ total: z.number().int(), tasks: z.array(row) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['delegation', 'tasks'] } },
    handler: (ctx, { parentSessionId, status, limit = 20 }) => {
      const all = (ctx.delegation?.list(parentSessionId) ?? []).filter((r) => !status || r.status === status).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return { total: all.length, tasks: all.slice(0, limit).map(taskRow) };
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
    }) },
    { id: 'taskStatus', tool: 'ply_task_status', risk: 'read', input: z.object({ taskId: z.string().min(1).describe(D('taskStatus', 'taskId')),
      offset: z.number().int().min(0).optional().describe(D('taskStatus', 'offset')) }) },
    { id: 'taskWait', tool: 'ply_task_wait', risk: 'read', input: z.object({ taskId: z.string().min(1).describe(D('taskWait', 'taskId')),
      seconds: z.number().int().min(1).max(30).optional().describe(D('taskWait', 'seconds')) }) },
    { id: 'taskSend', tool: 'ply_task_send', risk: 'write', input: z.object({ taskId: z.string().min(1).describe(D('taskSend', 'taskId')),
      message: z.string().min(1).describe(D('taskSend', 'message')) }) },
    { id: 'taskCancel', tool: 'ply_task_cancel', risk: 'write', modeGate: false, input: z.object({ taskId: z.string().min(1).describe(D('taskCancel', 'taskId')) }) },
    { id: 'taskList', tool: 'ply_task_list', risk: 'read', input: z.object({}) },
    { id: 'usage', tool: 'ply_usage', risk: 'read', input: z.object({ backend: z.string().optional().describe(D('usage', 'backend')) }) },
  ].map(({ id, tool, risk, input, modeGate }) => defineOp({
    id: `delegation.${id}`, summary: D(id, 'summary'), risk,
    ...(risk === 'read' ? { output: z.unknown() } : { riskReason: id === 'taskCancel'
      ? 'Cancellation stops only a child owned by this conversation; it is allowed in read-only mode to let an agent stop its child.'
      : 'The owner can start or instruct only its own child, and the existing delegation checks still enforce mode inheritance and escalation approval.' }),
    ...(modeGate === false ? { modeGate: false } : {}),
    input, surfaces: { ui: false, mcp: 'catalog', cli: true },
    handler: (ctx, args) => {
      if (!ctx.actor.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI'));
      return ctx.delegation.call(ctx.actor.sessionId, tool, args, ctx.locale);
    },
  })),
];
