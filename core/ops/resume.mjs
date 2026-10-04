// Human control of limit recovery. The same handlers serve the screen and CLI.
import crypto from 'node:crypto';
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { agentT } from '../i18n.mjs';
import { parseAt } from '../send-schedule.mjs';
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
    input: z.object({ id: id.describe('agent:ops.sessions.cancelSchedule.id') }),
    output: z.object({ cancelled: z.boolean(), entry: z.any().optional() }),
    surfaces: uiCli(['sessions', 'cancel-schedule'], ['id']),
    handler: (ctx, args) => ctx.limitResume.cancel(args.id) }),
  // 送信予定は人が決める。MCP には出さず、エージェントが CLI から呼ぶなら承認カードを挟む（guarded。ADR 0103）
  defineOp({ id: 'sessions.scheduleSend', summary: 'agent:ops.sessions.scheduleSend.summary', risk: 'guarded',
    approvalWords: 'schedule',
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
    approvalWords: 'sendNow',
    confirm: (ctx, args) => agentT(ctx.locale, 'ops.sessions.sendScheduledNow.confirm', { id: args.id }),
    input: z.object({ id: id.describe('agent:ops.sessions.sendScheduledNow.id') }),
    output: z.object({ sent: z.boolean(), sessionId: z.string(), messageId: z.string() }),
    surfaces: uiCli(['sessions', 'send-scheduled-now'], ['id']),
    handler: (ctx, args) => ctx.limitResume.sendScheduledNow(args.id) }),
  // 上限で止まった会話の自動再開を会話ごとに入れる・外す（会話末尾の［再開しない］。ADR 0129）
  defineOp({ id: 'sessions.setAutoResume', summary: 'agent:ops.sessions.setAutoResume.summary', risk: 'write',
    riskReason: 'Only the screen and CLI expose this human initiated action.',
    input: z.object({ sessionId: id.describe('agent:ops.sessions.setAutoResume.sessionId'), enabled: z.boolean().describe('agent:ops.sessions.setAutoResume.enabled') }),
    output: z.object({ sessionId: z.string(), enabled: z.boolean() }),
    surfaces: uiCli(['sessions', 'set-auto-resume'], ['sessionId']),
    handler: (ctx, args) => ctx.limitResume.setAuto(args.sessionId, args.enabled) }),
];
