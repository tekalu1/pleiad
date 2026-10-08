// browser.*: エージェントのブラウザー（PC の Chrome）への接続（docs/inapp-browser.md「Chrome への接続」、ADR 0148・0153）。
// 引き継ぐ・戻す・止める（chromeTakeOver・chromeResume・chromeStop。core/chrome/control.mjs）は会話の窓ごとの操作で、画面とリモートの端末から呼ぶ（MCP・CLI には出さない。
// human-only は ADR 0094 の 5 つに限るので write。エージェントが自分の窓を引き継ぐ・戻す意味は無い）。
// 状態を読む操作（chromeStatus）だけが AI・CLI にも出る。つなぐ・切る・確認を前に出すは、設定 › ブラウザーの画面の操作で、
// ホストの PC の画面だけから呼べる（エージェントがつなぐ道は core の接続の案内 chromeConnection.demand が持つ）。
// 引き継ぐ（chromeTakeOver）は by: 'device' でリモートの端末から操作する（窓は PC に見せず、端末の映像の箱の大きさでページを描き、映像のセッションで入力を送る）。
// ビューアの⋯「Chrome で開く（エージェントの窓へ）」（chromeOpen）は、会話の窓に URL を開く。ホストの PC の画面だけ。エージェントには知らせない。
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
  error: z.string().nullable().describe('agent:ops.browser.chromeControl.error'),
  by: z.enum(['pc', 'device']).nullable().describe('agent:ops.browser.chromeControl.by'),
});
const sessionIdShape = z.string().min(1).max(200).describe('agent:ops.browser.chromeControl.sessionId');
const controlInput = z.object({ sessionId: sessionIdShape });
const takeOverInput = z.object({
  sessionId: sessionIdShape,
  by: z.enum(['pc', 'device']).optional().describe('agent:ops.browser.chromeTakeOver.by'),
  width: z.number().positive().max(10000).optional().describe('agent:ops.browser.chromeTakeOver.width'),
  height: z.number().positive().max(10000).optional().describe('agent:ops.browser.chromeTakeOver.height'),
  scale: z.number().positive().max(10).optional().describe('agent:ops.browser.chromeTakeOver.scale'),
});
/** 会話の窓の操作（引き継ぐ・戻す・止める）。Chrome の層が使えなければ UNSUPPORTED、引き継げる窓が無ければ NO_WINDOW */
const controlOf = (ctx) => {
  const control = ctx.chromeControl;
  if (!control || ctx.chrome?.status().state === 'unsupported') unavailable(ctx);
  return control;
};
async function controlRun(ctx, action, sessionId, options) {
  try { return await controlOf(ctx)[action](sessionId, options); }
  catch (error) {
    if (error?.code === 'NO_WINDOW') throw new OpError('NO_WINDOW', agentT(ctx.locale, 'ops.errors.chromeNoWindow'));
    if (error?.code === 'INVALID') throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.chromeDeviceSize'));
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
    input: takeOverInput,
    output: controlShape,
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'chromeTakeOver',
    handler: (ctx, { sessionId, by, width, height, scale }) => controlRun(ctx, 'takeOver', sessionId, by === 'device' ? { by, width, height, scale } : { by: 'pc' }),
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
  defineOp({
    id: 'browser.chromeOpen',
    summary: 'agent:ops.browser.chromeOpen.summary',
    risk: 'write',
    riskReason: 'Opens a web page the user chose in the Chrome window of the conversation (waiting for Chrome to allow the connection if needed); the agent is not told and nothing is granted. Only the host PC\'s screen can call it (not on MCP or CLI)',
    input: z.object({
      sessionId: sessionIdShape,
      url: z.string().min(1).max(8192).describe('agent:ops.browser.chromeOpen.url'),
    }),
    output: z.object({ sessionId: z.string(), targetId: z.string() }),
    surfaces: { ui: true, mcp: false, cli: false },
    hostScreenOnly: true,
    legacyCommand: 'chromeOpen',
    handler: async (ctx, { sessionId, url }) => {
      const chrome = mustBeSupported(ctx);
      if (!/^https?:\/\//i.test(url)) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.chromeOpenUrl'));
      if (!chrome.open) unavailable(ctx);
      const { targetId } = await chrome.open(sessionId, url);
      return { sessionId, targetId };
    },
  }),
];
