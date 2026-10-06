// drafts.*: 入力欄の書きかけのサーバーの写し（ADR 9101 の F35。core/drafts.mjs）。スレッドの入力欄が端末の写しを追いかけて書く。
// 画面の道具（AI・CLI には出さない）。handler は ctx.drafts（core/server.mjs の opsDeps）を呼ぶ。
import { z } from 'zod';
import { OpError, defineOp } from './registry.mjs';
import { agentT } from '../i18n.mjs';
import { DRAFT_KEY_MAX, DRAFT_TEXT_MAX } from '../drafts.mjs';

const D = (id, key) => `agent:ops.drafts.${id}.${key}`;
const key = (id) => z.string().min(1).max(DRAFT_KEY_MAX).describe(D(id, 'key'));
const needUi = (ctx) => { if (ctx.principal?.by !== 'human' || !ctx.drafts) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI')); };

export const draftOps = [
  defineOp({
    id: 'drafts.save', summary: D('save', 'summary'), risk: 'write',
    riskReason: 'Keeps your own unsent text for a composer so you can continue it on another device. It sends nothing and changes no conversation',
    input: z.object({ key: key('save'), text: z.string().max(DRAFT_TEXT_MAX).describe(D('save', 'text')), at: z.number().optional().describe(D('save', 'at')) }),
    output: z.object({ saved: z.boolean(), at: z.number() }),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: async (ctx, args) => { needUi(ctx); return ctx.drafts.save(args); },
  }),
  defineOp({
    id: 'drafts.load', summary: D('load', 'summary'), risk: 'read',
    input: z.object({ key: key('load') }),
    output: z.object({ text: z.string(), at: z.number() }).nullable(),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: async (ctx, args) => { needUi(ctx); return ctx.drafts.load(args); },
  }),
];
