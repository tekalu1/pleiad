// browser.*: エージェントのブラウザー（PC の Chrome）への接続（docs/inapp-browser.md「Chrome への接続」、ADR 0148・0153）。
// 引き継ぐ・戻す・止める（chromeTakeOver・chromeResume・chromeStop。core/chrome/control.mjs）は会話の窓ごとの操作で、画面とリモートの端末から呼ぶ（MCP・CLI には出さない。
// human-only は ADR 0094 の 5 つに限るので write。エージェントが自分の窓を引き継ぐ・戻す意味は無い）。
// 状態を読む操作（chromeStatus）だけが AI・CLI にも出る。つなぐ・切る・確認を前に出すは、設定 › ブラウザーの画面の操作で、
// ホストの PC の画面だけから呼べる（エージェントがつなぐ道は core の接続の案内 chromeConnection.demand が持つ）。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';

const STATES = ['off', 'setup', 'permission', 'denied', 'connected', 'unsupported'];
const stateShape = z.object({
  state: z.enum(STATES).describe('agent:ops.browser.chromeStatus.state'),
  reason: z.string().nullable().describe('agent:ops.browser.chromeStatus.reason'),
  dialog: z.boolean().describe('agent:ops.browser.chromeStatus.dialog'),
  product: z.string().nullable().describe('agent:ops.browser.chromeStatus.product'),
});

/** Electron の無いホスト（ctx.chrome が無い）と、OS の層が使えない OS では、状態は unsupported、操作は UNSUPPORTED で断る */
const unavailable = (ctx) => { throw new OpError('UNSUPPORTED', agentT(ctx.locale, 'ops.errors.chromeUnsupported')); };
const chromeOf = (ctx) => ctx.chrome ?? unavailable(ctx);
const mustBeSupported = (ctx) => {
  const chrome = chromeOf(ctx);
  if (chrome.status().state === 'unsupported') unavailable(ctx);
  return chrome;
};

const controlShape = z.object({
  sessionId: z.string().describe('agent:ops.browser.chromeControl.sessionId'),
  state: z.enum(['running', 'idle', 'stopped', 'paused']).describe('agent:ops.browser.chromeControl.state'),
  since: z.number().nullable().describe('agent:ops.browser.chromeControl.since'),
});
const controlInput = z.object({ sessionId: z.string().min(1).max(200).describe('agent:ops.browser.chromeControl.sessionId') });
/** 会話の窓の操作（引き継ぐ・戻す・止める）。Chrome の層が使えなければ UNSUPPORTED、引き継げる窓が無ければ NO_WINDOW */
const controlOf = (ctx) => {
  const control = ctx.chromeControl;
  if (!control || ctx.chrome?.status().state === 'unsupported') unavailable(ctx);
  return control;
};
async function controlRun(ctx, action, sessionId) {
  try { return await controlOf(ctx)[action](sessionId); }
  catch (error) {
    if (error?.code === 'NO_WINDOW') throw new OpError('NO_WINDOW', agentT(ctx.locale, 'ops.errors.chromeNoWindow'));
    throw error;
  }
}

export const browserOps = [
  defineOp({
    id: 'browser.chromeStatus',
    summary: 'agent:ops.browser.chromeStatus.summary',
    risk: 'read',
    input: z.object({}),
    output: stateShape,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['browser', 'status'] } },
    legacyCommand: 'chromeStatus',
    handler: (ctx) => ctx.chrome?.status() ?? { state: 'unsupported', reason: 'no-desktop', dialog: false, product: null },
  }),
  defineOp({
    id: 'browser.chromeConnect',
    summary: 'agent:ops.browser.chromeConnect.summary',
    risk: 'write',
    riskReason: 'Starts the connection to the Chrome on this PC; Chrome itself asks the user to allow it, and only the host PC\'s settings screen can call it (not on MCP or CLI)',
    input: z.object({}),
    output: stateShape,
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    legacyCommand: 'chromeConnect',
    handler: async (ctx) => mustBeSupported(ctx).connect(),
  }),
  defineOp({
    id: 'browser.chromeDisconnect',
    summary: 'agent:ops.browser.chromeDisconnect.summary',
    risk: 'write',
    riskReason: 'Closes the connection to Chrome (or stops waiting for it) and closes the permission prompt it opened; it never grants anything. Only the host PC\'s settings screen can call it',
    input: z.object({}),
    output: stateShape,
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    legacyCommand: 'chromeDisconnect',
    handler: (ctx) => mustBeSupported(ctx).disconnect(),
  }),
  defineOp({
    id: 'browser.chromeRaiseDialog',
    summary: 'agent:ops.browser.chromeRaiseDialog.summary',
    risk: 'write',
    riskReason: 'Brings Chrome\'s permission prompt to the front so the user can see it; it does not answer it. Only the host PC\'s settings screen can call it',
    input: z.object({}),
    output: z.object({ raised: z.boolean(), method: z.string() }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    legacyCommand: 'chromeRaiseDialog',
    handler: (ctx) => mustBeSupported(ctx).raiseDialog(),
  }),
  defineOp({
    id: 'browser.chromeTakeOver',
    summary: 'agent:ops.browser.chromeTakeOver.summary',
    risk: 'write',
    riskReason: 'Shows the Chrome window of the conversation to the user and pauses the browser commands of the agent until it is handed back; it never grants anything or touches the user own windows. Screen and remote devices only (not on MCP or CLI)',
    input: controlInput,
    output: controlShape,
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'chromeTakeOver',
    handler: (ctx, { sessionId }) => controlRun(ctx, 'takeOver', sessionId),
  }),
  defineOp({
    id: 'browser.chromeResume',
    summary: 'agent:ops.browser.chromeResume.summary',
    risk: 'write',
    riskReason: 'Hides the Chrome window of the conversation again and lets the browser commands of the agent through; it only ends a pause the user started. Screen and remote devices only (not on MCP or CLI)',
    input: controlInput,
    output: controlShape,
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'chromeResume',
    handler: (ctx, { sessionId }) => controlRun(ctx, 'resume', sessionId),
  }),
  defineOp({
    id: 'browser.chromeStop',
    summary: 'agent:ops.browser.chromeStop.summary',
    risk: 'write',
    riskReason: 'Closes the connection of the agent to its Chrome window and refuses reconnecting until the next message from the user; stopping is always safe. Screen and remote devices only (not on MCP or CLI)',
    input: controlInput,
    output: controlShape,
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'chromeStop',
    handler: (ctx, { sessionId }) => controlRun(ctx, 'stop', sessionId),
  }),
];
