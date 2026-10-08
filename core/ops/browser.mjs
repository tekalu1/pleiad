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
import { PROFILE_BROWSERS } from '../../web/chrome-profile-model.mjs';

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

const PROFILE_BUSY = ['operating', 'waiting', 'human'];
const profileRefShape = z.object({ browser: z.string(), dir: z.string() });
const profileListShape = z.object({
  profiles: z.array(z.object({ browser: z.string(), dir: z.string(), name: z.string(), note: z.string() })).describe('agent:ops.browser.listProfiles.profiles'),
  current: profileRefShape.nullable().describe('agent:ops.browser.listProfiles.current'),
  busy: z.enum(PROFILE_BUSY).nullable().describe('agent:ops.browser.listProfiles.busy'),
});
/** プロフィールの本体（Chrome の層が無いホストは UNSUPPORTED） */
const profilesOf = (ctx) => (ctx.chromeProfiles && ctx.chrome?.status().state !== 'unsupported' ? ctx.chromeProfiles : unavailable(ctx));
/** 対象の会話。エージェントは省けば自分の会話で、ほかの会話は指せない。画面は省けない（一覧だけは会話なしで読める） */
function profileSession(ctx, given, { optional = false } = {}) {
  const own = ctx.actor?.sessionId ?? null;
  if (ctx.principal.by === 'agent') {
    if (given && given !== own) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.chromeProfileOwnSession'));
    if (!own && !optional) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
    return own;
  }
  if (!given && !optional) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return given ?? null;
}
function profileError(ctx, error) {
  // i18n-dynamic: agent:ops.errors.chromeProfileBusy.
  if (error?.code === 'BUSY') return new OpError('BUSY', agentT(ctx.locale, `ops.errors.chromeProfileBusy.${error.detail?.reason}`), { reason: error.detail?.reason });
  if (error?.code === 'NOT_FOUND') return new OpError('PROFILE_NOT_FOUND', agentT(ctx.locale, 'ops.errors.chromeProfileNotFound', { profile: error.detail?.profile ?? '' }));
  if (error?.code === 'AMBIGUOUS') return new OpError('INVALID', agentT(ctx.locale, 'ops.errors.chromeProfileAmbiguous', { profile: error.detail?.profile ?? '' }));
  return error;
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
    id: 'browser.chromeCloseWindow',
    summary: 'agent:ops.browser.chromeCloseWindow.summary',
    risk: 'write',
    riskReason: 'Closes only the dedicated Chrome windows of this conversation and records the last image. Screen and remote devices only (not on MCP or CLI)',
    input: controlInput,
    output: z.object({ closed: z.boolean(), failed: z.boolean().optional() }),
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'chromeCloseWindow',
    handler: async (ctx, { sessionId }) => {
      const chrome = mustBeSupported(ctx);
      if (!chrome.closeWindow) unavailable(ctx);
      return chrome.closeWindow(sessionId);
    },
  }),
  defineOp({
    id: 'browser.chromeWindows',
    summary: 'agent:ops.browser.chromeWindows.summary',
    risk: 'read',
    input: controlInput,
    output: z.array(z.object({ sessionId: z.string(), taskId: z.string().nullable(), title: z.string().nullable(), windows: z.number(), profile: profileRefShape.nullable(), profileName: z.string().nullable(), state: z.string() })),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: (ctx, { sessionId }) => mustBeSupported(ctx).windows(sessionId),
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
  // Chrome のプロフィール（第 10 段。docs/inapp-browser.md「プロフィール」）。本体は core/chrome/profile-choice.mjs（ply_browser の list_browser_profiles・use_browser_profile もここを通る）。
  // 画面・端末は会話を指定して、エージェントは自分の会話だけ。名前は ADR 0091 の追記で残した browser.listProfiles・browser.useProfile
  defineOp({
    id: 'browser.listProfiles',
    summary: 'agent:ops.browser.listProfiles.summary',
    risk: 'read',
    input: z.object({ sessionId: sessionIdShape.optional() }),
    output: profileListShape,
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['browser', 'profiles'] } },
    handler: async (ctx, { sessionId }) => {
      const choice = profilesOf(ctx);
      return choice.list({ sessionId: profileSession(ctx, sessionId, { optional: true }), by: ctx.principal.by });
    },
  }),
  defineOp({
    id: 'browser.useProfile',
    summary: 'agent:ops.browser.useProfile.summary',
    risk: 'write',
    riskReason: 'Picks which existing Chrome profile the next windows of this conversation open in; open windows stay, site permissions are kept per profile, and nothing is copied between profiles. Allowed from read-only conversations too (ADR 0091)',
    modeGate: false,
    input: z.object({
      sessionId: sessionIdShape.optional(),
      browser: z.enum(PROFILE_BROWSERS).optional().describe('agent:ops.browser.useProfile.browser'),
      profile: z.string().min(1).max(200).describe('agent:ops.browser.useProfile.profile'),
    }),
    output: z.object({ browser: z.string(), dir: z.string(), name: z.string(), changed: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['browser', 'use-profile'], positional: ['profile'] } },
    handler: async (ctx, { sessionId, browser, profile }) => {
      const choice = profilesOf(ctx);
      const id = profileSession(ctx, sessionId);
      try { return await choice.use({ sessionId: id, browser: browser ?? null, profile, by: ctx.principal.by }); }
      catch (error) { throw profileError(ctx, error); }
    },
  }),
];
