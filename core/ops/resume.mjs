// Human control of limit recovery. The same handlers serve the screen and CLI.
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { fromHost } from './host.mjs';

const id = z.string().min(1).max(200);
const uiCli = (path, positional) => ({ ui: true, mcp: false, cli: { path, ...(positional ? { positional } : {}) } });

export const resumeOps = [
  // 中断した会話を続ける（保留の送信待ちを送り直すか、「続けて」の文を送る）。続きは、その会話の承認モードで動く（ADR 0091 追記）
  defineOp({ id: 'sessions.resume', summary: 'agent:ops.sessions.resume.summary', risk: 'write', scope: 'session',
    riskReason: 'Resuming sends only what the conversation already queued, or the fixed "continue" text, and the turn runs under that conversation\'s own approval mode, which this call cannot change. A human can resume any conversation, so an agent is treated the same',
    legacyCommand: 'resume', input: z.object({ sessionId: id.describe('agent:ops.sessions.resume.sessionId') }), output: z.object({ sent: z.enum(['outbox', 'text']), count: z.number() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'resume'], positional: ['sessionId'] } },
    handler: (ctx, args) => fromHost(() => ctx.limitResume.resume(args.sessionId)) }),
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
