// ply_browser の操作。MCP のツール名と返り値は既存の橋で保ち、実行だけを一覧に通す。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';

export const browserOps = [
  defineOp({
    id: 'browser.listProfiles', summary: 'agent:ops.browser.listProfiles.summary', risk: 'read',
    input: z.object({}), output: z.unknown(),
    surfaces: { ui: false, mcp: 'catalog', cli: true },
    handler: (ctx) => {
      if (!ctx.actor.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI'));
      return ctx.browser.call(ctx.actor.sessionId, 'list_browser_profiles', {}, ctx.locale);
    },
  }),
  defineOp({
    id: 'browser.useProfile', summary: 'agent:ops.browser.useProfile.summary', risk: 'write',
    riskReason: 'The profile switch changes only the active browser storage area for this conversation; it does not grant access to a new permission or copy data between profiles.',
    modeGate: false,
    input: z.object({ profile: z.string().min(1).describe('agent:ops.browser.useProfile.profile') }),
    surfaces: { ui: false, mcp: 'catalog', cli: true },
    handler: (ctx, args) => {
      if (!ctx.actor.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI'));
      return ctx.browser.call(ctx.actor.sessionId, 'use_browser_profile', args, ctx.locale);
    },
  }),
  defineOp({
    id: 'browser.setProfile', summary: 'agent:ops.browser.setProfile.summary', risk: 'write',
    riskReason: 'Selecting a browser profile only changes which existing storage area this conversation uses and can be reversed.',
    input: z.object({ sessionId: z.string().min(1).describe('agent:ops.browser.setProfile.sessionId'),
      profile: z.string().min(1).describe('agent:ops.browser.setProfile.profile') }),
    surfaces: { ui: true, mcp: 'catalog', cli: true }, legacyCommand: 'setBrowserProfile',
    handler: (ctx, args) => ctx.browser.setProfile(args.sessionId, args.profile),
  }),
];
