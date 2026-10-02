// delegation.*: 委譲の子のタスク（ply_delegate が作ったもの）を読む。段階 1 は読むだけ（作る・止める・送るは ply_agents の口のまま。移行は段階 3）。
// 本体はサーバーが ctx.delegation で渡す（core/agent-tasks.mjs の list・get）。依頼の本文・結果の全文は返さず、結果は offset で読む。
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
];
