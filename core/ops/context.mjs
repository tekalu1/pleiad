// context.*: コンテキスト（指示・Skills・外部 MCP をどこから読み、誰が担当するか）の設定、Pleiad の指示、会話ごとの読み込み直しと MCP の外し方（ADR 0095）。
// 画面の WS コマンド（contextSettings・setPlyInstructions など）はこの操作を呼ぶ薄い外側。本体はサーバーが ctx.context で渡す（core/server.mjs の opsDeps）。
//
// 危険度:
//   setSettings・setPlyInstructions は guarded。どちらも全部の会話のエージェントに渡る文脈を変える（どのフォルダーの指示・Skills を読むか、
//   担当を Pleiad にして Pleiad の MCP の登録をつなぐか、会話ごとに足す指示の本文）。同じ値を変える settings.set の
//   context.default・plyInstructions も guarded（ADR 0088）なので、こちらだけ緩めると抜け道になる。
//   refresh は write（その会話の固定した文脈を、今のファイルから読み直すだけ。読む場所は変わらない）。
//   setSessionMcp は write で、外した MCP を戻す向き（removed: false）だけ riskOf が guarded に上げる（戻すと次のターンでつなぎ直す）。
import { z } from 'zod';
import { agentT, t } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';
import { diffRows } from './settings.mjs';
import { byAgent, cwdFor, run, sessionFor } from './redact.mjs';

const D = (id, key) => `agent:ops.context.${id}.${key}`;
const A = (key) => `agent:ops.context.arg.${key}`;
const loose = z.record(z.string(), z.unknown());
const reason = z.string().max(500).optional().describe(A('reason'));

const needSession = (ctx, sessionId) => {
  const id = sessionFor(ctx, sessionId);
  if (!id && byAgent(ctx)) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return id;
};

/** setContextSettings の 1 か所の変更を、承認カードの前後にする（今の画面の形から、変える種類だけ） */
function contextChange(view, args) {
  const level = args.place ? (view?.places ?? []).find((p) => p.current) ?? null : view?.defaults ?? null;
  const where = args.place ? 'context.place' : 'context.default';
  if (args.remove) return diffRows(where, { path: args.place }, null);
  if (args.add) return diffRows(where, null, { path: args.place });
  if (Object.hasOwn(args, 'roots')) {
    const kinds = args.kind ? [args.kind] : Object.keys(level?.roots ?? {});
    return diffRows(`${where}.roots`, Object.fromEntries(kinds.map((k) => [k, level?.roots?.[k]?.value ?? null])), Object.fromEntries(kinds.map((k) => [k, args.roots])));
  }
  return diffRows(`${where}.${args.kind ?? ''}`, level?.kinds?.[args.kind]?.value ?? null, args.value ?? null);
}

export const contextOps = [
  defineOp({
    id: 'context.settings', summary: 'agent:ops.context.settings.summary', risk: 'read',
    input: z.object({ cwd: z.string().max(4096).optional().describe(A('cwd')) }),
    output: z.object({ defaults: loose, places: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'settings'] } },
    legacyCommand: 'contextSettings',
    handler: async (ctx, { cwd }) => run(ctx, async () => ctx.context.view((await cwdFor(ctx, cwd)) ?? null)),
  }),
  defineOp({
    id: 'context.setSettings', summary: 'agent:ops.context.setSettings.summary', risk: 'guarded',
    input: z.object({
      place: z.string().max(4096).nullable().optional().describe(D('setSettings', 'place')),
      kind: z.enum(['instruction', 'skill', 'mcp']).optional().describe(D('setSettings', 'kind')),
      value: z.unknown().optional().describe(D('setSettings', 'value')),
      roots: z.array(z.string().max(4096)).max(50).nullable().optional().describe(D('setSettings', 'roots')),
      add: z.boolean().optional().describe(D('setSettings', 'add')),
      remove: z.boolean().optional().describe(D('setSettings', 'remove')),
      cwd: z.string().max(4096).optional().describe(A('cwd')),
      reason,
    }),
    confirm: async (ctx, { reason: _r, ...args }) => {
      const view = await ctx.context.view(args.place ?? null).catch(() => null);
      return { key: null, before: view, rows: contextChange(view, args), note: t('opsApproval.contextSettings', { place: args.place ?? t('opsApproval.everywhere') }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'set'] } },
    legacyCommand: 'setContextSettings',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, () => ctx.context.set(args, ctx.actor)),
  }),
  defineOp({
    id: 'context.plyInstructions', summary: 'agent:ops.context.plyInstructions.summary', risk: 'read',
    input: z.object({}),
    output: z.object({ items: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'instructions'] } },
    legacyCommand: 'plyInstructions',
    handler: (ctx) => run(ctx, () => ctx.context.plyInstructions()),
  }),
  defineOp({
    id: 'context.setPlyInstructions', summary: 'agent:ops.context.setPlyInstructions.summary', risk: 'guarded',
    input: z.object({
      action: z.enum(['save', 'toggle', 'delete', 'reset', 'order']).describe(D('setPlyInstructions', 'action')),
      id: z.string().max(100).optional().describe(D('setPlyInstructions', 'id')),
      name: z.string().max(200).optional().describe(D('setPlyInstructions', 'name')),
      body: z.string().max(20000).optional().describe(D('setPlyInstructions', 'body')),
      target: z.string().max(20).optional().describe(D('setPlyInstructions', 'target')),
      agents: z.array(z.string().max(40)).max(10).optional().describe(D('setPlyInstructions', 'agents')),
      on: z.boolean().optional().describe(D('setPlyInstructions', 'on')),
      ids: z.array(z.string().max(100)).max(100).optional().describe(D('setPlyInstructions', 'ids')),
      reason,
    }),
    confirm: async (ctx, { reason: _r, ...action }) => {
      const before = ctx.context.plyInstructionItems();
      let after = null;
      try { after = ctx.context.previewPlyInstructions(action); } catch { after = null; }
      const pick = (list) => (list ? Object.fromEntries(list.map((i) => [i.id, { on: i.on !== false, ...(i.name ? { name: i.name } : {}), ...(i.body ? { body: i.body } : {}), ...(i.target ? { target: i.target } : {}) }])) : null);
      return { key: null, before, rows: diffRows('plyInstructions', pick(before), pick(after)), note: t('opsApproval.plyInstructions'), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'set-instructions'] } },
    legacyCommand: 'setPlyInstructions',
    handler: (ctx, { reason: _r, ...action }) => run(ctx, () => ctx.context.setPlyInstructions(action, ctx.actor)),
  }),
  defineOp({
    id: 'context.refresh', summary: 'agent:ops.context.refresh.summary', risk: 'write', scope: 'session',
    riskReason: 'Re-reads the pinned instructions and Skills of one conversation from the same places; it does not change where they are read from or who owns them',
    input: z.object({ sessionId: z.string().max(200).optional().describe(A('sessionId')) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'refresh'] } },
    legacyCommand: 'refreshContext',
    handler: (ctx, { sessionId }) => run(ctx, async () => { await ctx.context.refresh(needSession(ctx, sessionId)); return { ok: true }; }),
  }),
  defineOp({
    id: 'context.setSessionMcp', summary: 'agent:ops.context.setSessionMcp.summary', risk: 'write', scope: 'session',
    riskReason: 'Removing an MCP server from one conversation only narrows what it can call; putting it back (removed: false) is raised to guarded by riskOf (it is connected again on the next turn)',
    riskOf: (_ctx, { removed }) => (removed === false ? 'guarded' : 'write'),
    input: z.object({
      sessionId: z.string().max(200).optional().describe(A('sessionId')),
      name: z.string().min(1).max(128).describe(D('setSessionMcp', 'name')),
      removed: z.boolean().optional().describe(D('setSessionMcp', 'removed')),
      reason,
    }),
    confirm: async (ctx, { sessionId, name, removed }) => {
      const id = sessionFor(ctx, sessionId);
      const list = id ? await ctx.context.removedMcp(id).catch(() => []) : [];
      return { key: null, before: list, rows: [{ path: `context.session.mcp.${name}`, before: JSON.stringify(list.includes(name) ? 'removed' : 'on'), after: JSON.stringify(removed === false ? 'on' : 'removed') }],
        note: t('opsApproval.sessionMcp', { name }), loosens: removed === false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['context', 'session-mcp'], positional: ['name'] } },
    legacyCommand: 'setSessionMcp',
    handler: (ctx, { sessionId, name, removed }) => run(ctx, async () => { await ctx.context.setSessionMcp(needSession(ctx, sessionId), name, removed !== false); return { ok: true }; }),
  }),
];
