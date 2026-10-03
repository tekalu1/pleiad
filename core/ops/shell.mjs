// shell.*: 会話のシェル（入力欄の `!`。ADR 0054・0055・0105）。画面の runShell・stopShell・skipShell はこの操作を呼ぶ薄い外側（core/server.mjs の opsShell）。
// 走らせた行と結果は人が `!` で走らせたものと同じ形で会話に残り、次の発言と一緒にその会話のエージェントへ渡る（「渡さない」は shell.skip）。
//
// 危険度:
//   run は guarded。任意のコマンドを会話の作業場所で動かす。承認が要る会話では承認カード、承認なしの会話（bypass・YOLO）は確認なしで通して会話の記録に残す。
//   stop は write（走っている行を止めるだけ。止めた行は「止めました」とそれまでの出力で残る）。
//   skip は write（次の発言で渡すかの印だけ。コマンドは動かさない）。
// AI には、終わるまで待った結果（waitMs まで。既定 30 秒）を、出力の末尾を切って返す。画面には今までどおりすぐ runId を返す（出力は shell.* の出来事で流れる）。
import crypto from 'node:crypto';
import { z } from 'zod';
import { agentT, t } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { byAgent, run } from './redact.mjs';

const D = (id, key) => `agent:ops.shell.${id}.${key}`;

export const SHELL_WAIT_DEFAULT = 30_000;
export const SHELL_WAIT_MAX = 120_000;
/** AI に返す出力の字数（stdout・stderr それぞれ。末尾を残す） */
export const SHELL_OUTPUT_CHARS = 8_000;

const runId = (id) => z.string().regex(/^[a-zA-Z0-9-]{8,80}$/).describe(D(id, 'runId'));
const sessionId = (id) => z.string().min(1).max(200).optional().describe(D(id, 'sessionId'));

/** AI は sessionId を省けば自分の会話。人間（画面）は省けない（今までどおりサーバーが断る） */
const target = (ctx, given) => {
  const id = given ?? (byAgent(ctx) ? ctx.actor?.sessionId : undefined);
  if (!id && byAgent(ctx)) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return id;
};
const tail = (text) => {
  const s = typeof text === 'string' ? text : '';
  return s.length > SHELL_OUTPUT_CHARS ? { text: s.slice(-SHELL_OUTPUT_CHARS), cut: true } : { text: s, cut: false };
};

export const shellOps = [
  defineOp({
    id: 'shell.run',
    summary: 'agent:ops.shell.run.summary',
    risk: 'guarded',
    scope: 'session',
    input: z.object({
      sessionId: sessionId('run'),
      command: z.string().min(1).max(20_000).describe(D('run', 'command')),
      cwd: z.string().max(8192).optional().describe(D('run', 'cwd')),
      runId: runId('run').optional(),
      waitMs: z.number().int().min(0).max(SHELL_WAIT_MAX).optional().describe(D('run', 'waitMs')),
      reason: z.string().max(500).optional().describe(D('run', 'reason')),
    }),
    // 承認カード: どの会話で何を動かすか。受領証の元は会話とそのエージェント（承認の間に会話のエージェントが替われば聞き直す）
    approvalWords: 'shell',
    confirm: async (ctx, { sessionId: given, command }) => {
      const id = target(ctx, given);
      const where = await ctx.shell.describe(id);
      return { key: null, before: { sessionId: id, backend: where.backend, cwd: where.cwd }, rows: [{ path: 'shell.command', before: '""', after: JSON.stringify(command) }],
        note: t('opsApproval.shellRun', { title: where.title || id, cwd: where.cwd ?? '' }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['shell', 'run'], positional: ['command'] } },
    legacyCommand: 'runShell',
    uiHandler: (ctx, { sessionId: id, runId: given, command, cwd }) => ctx.shell.run({ sessionId: id, runId: given, command, cwd }),
    handler: (ctx, { sessionId: given, command, cwd, runId: given2, waitMs = SHELL_WAIT_DEFAULT }) => run(ctx, async () => {
      const id = target(ctx, given);
      const started = await ctx.shell.run({ sessionId: id, runId: given2 ?? `ply-${crypto.randomUUID()}`, command, cwd });
      if (started.duplicate || waitMs === 0) return { runId: started.runId, status: started.duplicate ? 'duplicate' : 'running' };
      const done = await ctx.shell.wait(started.runId, waitMs);
      if (!done) return { runId: started.runId, status: 'running' };
      const out = tail(done.stdout), err = tail(done.stderr);
      return { runId: started.runId, status: 'done', exitCode: done.exitCode ?? null, stdout: out.text, ...(done.stderr != null ? { stderr: err.text } : {}),
        truncated: done.truncated === true || out.cut || err.cut, timedOut: done.timedOut === true, stopped: done.stopped === true, durationMs: done.durationMs ?? null,
        ...(done.error ? { error: done.error } : {}) };
    }),
  }),

  defineOp({
    id: 'shell.stop',
    summary: 'agent:ops.shell.stop.summary',
    risk: 'write',
    riskReason: 'Only stops a running shell line; the line stays in the conversation as stopped with the output so far. It starts nothing (ADR 0105)',
    scope: 'session',
    input: z.object({ runId: runId('stop') }),
    output: z.object({ stopped: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['shell', 'stop'], positional: ['runId'] } },
    legacyCommand: 'stopShell',
    handler: (ctx, { runId: id }) => ctx.shell.stop(id),
  }),

  defineOp({
    id: 'shell.skip',
    summary: 'agent:ops.shell.skip.summary',
    risk: 'write',
    riskReason: 'Only marks whether a shell line is handed to the conversation\'s agent with the next message (ADR 0055); no command runs (ADR 0105)',
    scope: 'session',
    input: z.object({ sessionId: sessionId('skip'), runId: runId('skip'), skip: z.boolean().describe(D('skip', 'skip')) }),
    output: z.object({ runId: z.string(), skip: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['shell', 'skip'], positional: ['runId', 'skip'] } },
    legacyCommand: 'skipShell',
    handler: (ctx, { sessionId: given, runId: id, skip }) => run(ctx, () => ctx.shell.skip({ sessionId: target(ctx, given), runId: id, skip })),
  }),
];
