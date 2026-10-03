// Human control of limit recovery. The same handlers serve the screen and CLI.
import { z } from 'zod';
import { defineOp } from './registry.mjs';

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
    input: z.object({ id: id.describe('agent:ops.sessions.cancelSchedule.id') }), output: z.object({ cancelled: z.boolean() }),
    surfaces: uiCli(['sessions', 'cancel-schedule'], ['id']),
    handler: (ctx, args) => ctx.limitResume.cancel(args.id) }),
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
