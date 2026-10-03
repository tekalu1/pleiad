// computer.*: コンピューターの操作（docs/computer-use.md）のうち、止める側。画面の「止める」と AI が同じ本体を通る（core/server.mjs の opsComputer）。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';

export const computerOps = [
  defineOp({
    id: 'computer.stop',
    summary: 'agent:ops.computer.stop.summary',
    risk: 'write',
    riskReason: 'Only stops a conversation\'s computer use (mouse and keyboard on this PC); it never starts or permits it. Stopping is allowed even from a read-only conversation so an agent can always halt it (ADR 0094)',
    modeGate: false,
    input: z.object({ sessionId: z.string().min(1).max(200).nullable().optional().describe('agent:ops.computer.stop.sessionId') }),
    output: z.object({ stopped: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['computer', 'stop'], positional: ['sessionId'] } },
    legacyCommand: 'computerStop',
    handler: (ctx, { sessionId }) => {
      const id = sessionId ?? ctx.actor.sessionId;
      // 画面は今の会話が無いときも送ってくる（止めるものが無い）
      if (!id && ctx.principal.by === 'human') return { stopped: false };
      if (!id) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
      return ctx.computer.stop(id);
    },
  }),
];
