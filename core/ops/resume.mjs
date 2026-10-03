// Human control of limit recovery. The same handlers serve the screen and CLI.
import crypto from 'node:crypto';
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { agentT } from '../i18n.mjs';
import { parseAt } from '../send-schedule.mjs';

const id = z.string().min(1).max(200);
const uiCli = (path, positional) => ({ ui: true, mcp: false, cli: { path, ...(positional ? { positional } : {}) } });

export const resumeOps = [
  defineOp({ id: 'sessions.resume', summary: 'agent:ops.sessions.resume.summary', risk: 'write',
    riskReason: 'Only the screen and CLI expose this human initiated action.',
    legacyCommand: 'resume', input: z.object({ sessionId: id.describe('agent:ops.sessions.resume.sessionId') }), output: z.object({ sent: z.enum(['outbox', 'text']), count: z.number() }),
    surfaces: uiCli(['sessions', 'resume'], ['sessionId']),
    handler: (ctx, args) => ctx.limitResume.resume(args.sessionId) }),
  defineOp({ id: 'sessions.listMessages', summary: 'agent:ops.sessions.listMessages.summary', risk: 'read',
    legacyCommand: 'listMessages', input: z.object({ sessionId: id.describe('agent:ops.sessions.listMessages.sessionId') }), output: z.array(z.any()),
    surfaces: uiCli(['sessions', 'unsent'], ['sessionId']),
    handler: (ctx, args) => ctx.limitResume.messages(args.sessionId) }),
  defineOp({ id: 'sessions.schedules', summary: 'agent:ops.sessions.schedules.summary', risk: 'read',
    input: z.object({ sessionId: id.optional().describe('agent:ops.sessions.schedules.sessionId') }), output: z.array(z.any()),
    surfaces: uiCli(['sessions', 'schedules']), handler: (ctx, args) => ctx.limitResume.schedules(args.sessionId) }),
  defineOp({ id: 'sessions.cancelSchedule', summary: 'agent:ops.sessions.cancelSchedule.summary', risk: 'write',
    riskReason: 'Only the screen and CLI expose this human initiated action.',
    input: z.object({ id: id.describe('agent:ops.sessions.cancelSchedule.id') }),
    output: z.object({ cancelled: z.boolean(), entry: z.any().optional() }),
    surfaces: uiCli(['sessions', 'cancel-schedule'], ['id']),
    handler: (ctx, args) => ctx.limitResume.cancel(args.id) }),
  // 送信予定は人が決める。MCP には出さず、エージェントが CLI から呼ぶなら承認カードを挟む（guarded。ADR 0094）
  defineOp({ id: 'sessions.scheduleSend', summary: 'agent:ops.sessions.scheduleSend.summary', risk: 'guarded',
    confirm: (ctx, args) => agentT(ctx.locale, 'ops.sessions.scheduleSend.confirm', { session: args.sessionId, at: Number.isFinite(parseAt(args.at)) ? new Date(parseAt(args.at)).toISOString() : String(args.at), prompt: args.prompt.slice(0, 120) }),
    input: z.object({
      sessionId: id.describe('agent:ops.sessions.scheduleSend.sessionId'),
      prompt: z.string().min(1).max(200_000).describe('agent:ops.sessions.scheduleSend.prompt'),
      at: z.union([z.number(), z.string()]).describe('agent:ops.sessions.scheduleSend.at'),
      messageId: z.string().min(8).max(80).optional().describe('agent:ops.sessions.scheduleSend.messageId'),
      attachments: z.array(z.object({ path: z.string(), name: z.string().optional(), mime: z.string().optional() })).optional().describe('agent:ops.sessions.scheduleSend.attachments'),
      cwd: z.string().optional().describe('agent:ops.sessions.scheduleSend.cwd'),
      mode: z.string().optional().describe('agent:ops.sessions.scheduleSend.mode'),
    }),
    output: z.object({ id: z.string(), at: z.number(), messageId: z.string() }),
    surfaces: uiCli(['sessions', 'schedule-send'], ['sessionId']),
    handler: (ctx, args) => ctx.limitResume.scheduleSend({ ...args, messageId: args.messageId ?? `sched-${crypto.randomUUID()}` }, ctx.principal?.by ?? 'human') }),
  defineOp({ id: 'sessions.sendScheduledNow', summary: 'agent:ops.sessions.sendScheduledNow.summary', risk: 'guarded',
    confirm: (ctx, args) => agentT(ctx.locale, 'ops.sessions.sendScheduledNow.confirm', { id: args.id }),
    input: z.object({ id: id.describe('agent:ops.sessions.sendScheduledNow.id') }),
    output: z.object({ sent: z.boolean(), sessionId: z.string(), messageId: z.string() }),
    surfaces: uiCli(['sessions', 'send-scheduled-now'], ['id']),
    handler: (ctx, args) => ctx.limitResume.sendScheduledNow(args.id) }),
  defineOp({ id: 'resumeQueue.get', summary: 'agent:ops.resumeQueue.get.summary', risk: 'read',
    input: z.object({}), output: z.any(), surfaces: uiCli(['resume-queue', 'get']),
    handler: ctx => ctx.limitResume.queue() }),
  defineOp({ id: 'resumeQueue.set', summary: 'agent:ops.resumeQueue.set.summary', risk: 'write',
    riskReason: 'Only the screen and CLI expose this human initiated action.',
    input: z.object({ action: z.enum(['first', 'auto', 'stop', 'continue', 'release']).describe('agent:ops.resumeQueue.set.action'),
      sessionId: id.optional().describe('agent:ops.resumeQueue.set.sessionId'), enabled: z.boolean().optional().describe('agent:ops.resumeQueue.set.enabled') }),
    output: z.any(), surfaces: uiCli(['resume-queue', 'set']),
    handler: (ctx, args) => ctx.limitResume.setQueue(args) }),
];
