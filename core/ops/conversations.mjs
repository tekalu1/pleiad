// sessions.* のうち、会話そのものの操作（作る・消す・止める・続ける・圧縮・次の設定・送信待ち・系譜・変更の記録・題の提案）。
// 画面の WS コマンド（newSession・deleteUnsentSession・abort・resume・compactConversation・cancelCompaction・setConversationAutoCompaction・
// setTurnSettings・listMessages・lineage・sessionChanges・suggestTitle）の中身はここへ移した。WS は同じ操作を呼ぶだけの外側（core/server.mjs の viaOp）。
// 本体（実際に会話を動かす処理）はサーバーが ctx.conversations で渡す（core/server.mjs の opsConversations）。
// 返り値は AI が 1 回で読める大きさに抑える（一覧は limit / cursor、本文は切る）。画面（人）には uiHandler で、画面が読む全量の形を返す（ADR 0091 追記）。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { familyOf } from '../lineage.mjs';
import { defineOp, OpError } from './registry.mjs';
import { fromHost, humanOnlyFields, pageOf, clip, PAGE_MAX } from './host.mjs';
import { changeRow, listRowOf } from './sessions.mjs';

const D = (id, key) => `agent:ops.sessions.${id}.${key}`;
/** sessions.outbox: 1 件の本文の字数 */
export const OUTBOX_CHARS = 500;

const sessionId = (id) => z.string().min(1).max(200).describe(D(id, 'sessionId'));
const optionalSessionId = (id) => z.string().min(1).max(200).optional().describe(D(id, 'sessionId'));
const limitField = (id) => z.number().int().min(1).max(PAGE_MAX).optional().describe(D(id, 'limit'));
const cursorField = (id) => z.string().max(400).optional().describe(D(id, 'cursor'));

/** AI は sessionId を省けば自分の会話。人間（画面）は省けない */
function targetOf(ctx, given) {
  const id = given ?? ctx.actor.sessionId;
  if (!id) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return id;
}
const missing = (ctx, id) => new OpError('SESSION_NOT_FOUND', agentT(ctx.locale, 'ops.errors.SESSION_NOT_FOUND', { id }));
const mustExist = async (ctx, id) => { if (!(await ctx.sessions.get(id))) throw missing(ctx, id); };

const outboxRow = (m) => {
  const text = String(m?.args?.prompt ?? m?.args?.text ?? '');
  return { id: String(m?.id ?? ''), status: String(m?.status ?? ''), at: m?.at ?? null, text: clip(text, OUTBOX_CHARS), truncated: text.length > OUTBOX_CHARS,
    attachments: Array.isArray(m?.args?.attached) ? m.args.attached.length : 0, error: m?.error ?? null, waiting: m?.waiting?.reason ?? null };
};

/** 画面の「変更の記録」が読む形（理由のキーと値も付く） */
const uiChange = ({ at, by, field, from, to, reason, reasonKey, reasonParams }) =>
  ({ at, by, field, from: from ?? null, to: to ?? null, reason: reason ?? null, ...(reasonKey ? { reasonKey, ...(reasonParams ? { reasonParams } : {}) } : {}) });

const change = z.object({ at: z.string(), by: z.string(), via: z.string().optional(), bySession: z.string().optional(), field: z.string(), from: z.unknown(), to: z.unknown(), reason: z.string().nullable() });
const listItem = z.object({ id: z.string(), title: z.string(), backend: z.string(), status: z.string().nullable(), cwd: z.string().nullable(),
  parent: z.string().nullable(), delegated: z.boolean(), lastModified: z.number().nullable(), createdAt: z.union([z.string(), z.number()]).nullable() });

export const conversationOps = [
  defineOp({
    id: 'sessions.new',
    summary: 'agent:ops.sessions.new.summary',
    risk: 'write',
    riskReason: 'Only creates an empty draft conversation; nothing runs until a person sends a message in it. The approval mode and the endpoint are inherited or the defaults: an agent cannot choose them (NEEDS_UI), and an account cannot be chosen at all here. A human can create one too, so an agent is treated the same (ADR 0082)',
    input: z.object({
      sourceSessionId: z.string().min(1).max(200).optional().describe(D('new', 'sourceSessionId')),
      backend: z.string().max(40).optional().describe(D('new', 'backend')),
      model: z.string().max(200).optional().describe(D('new', 'model')),
      effort: z.string().max(40).optional().describe(D('new', 'effort')),
      mode: z.string().max(60).optional().describe(D('new', 'mode')),
      cwd: z.string().max(8192).optional().describe(D('new', 'cwd')),
      status: z.string().max(60).optional().describe(D('new', 'status')),
      draft: z.string().max(2_000_000).optional().describe(D('new', 'draft')),
      endpoint: z.string().max(200).optional().describe(D('new', 'endpoint')),
    }),
    output: z.object({ sessionId: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'new'] } },
    legacyCommand: 'newSession',
    handler: (ctx, args) => {
      humanOnlyFields(ctx, args, ['mode', 'endpoint']);
      return fromHost(() => ctx.conversations.create(args));
    },
  }),

  // 送っていない（下書きだけの）会話を消す。送った会話は消せない（サーバーが断る）。消すので guarded: 会話に承認カードを出す
  defineOp({
    id: 'sessions.deleteUnsent',
    summary: 'agent:ops.sessions.deleteUnsent.summary',
    risk: 'guarded',
    scope: 'session',
    input: z.object({ sessionId: sessionId('deleteUnsent') }),
    output: z.object({ sessionId: z.string(), deleted: z.boolean() }),
    // 無い会話は承認カードを出す前に断る（riskOf の失敗は code で返る）
    riskOf: async (ctx, { sessionId: id }) => { await mustExist(ctx, id); return 'guarded'; },
    confirm: async (ctx, { sessionId: id }) => {
      const found = await ctx.sessions.get(id);
      if (!found) throw missing(ctx, id);
      return { note: agentT(ctx.locale, 'ops.sessions.deleteUnsent.card', { title: found.row.title || id }), before: { id, unsent: Boolean(found.row.unsent) } };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'deleteUnsent'], positional: ['sessionId'] } },
    legacyCommand: 'deleteUnsentSession',
    handler: async (ctx, { sessionId: id }) => {
      await fromHost(() => ctx.conversations.deleteUnsent(id));
      return { sessionId: id, deleted: true };
    },
  }),

  // 会話のターンを止める。止められるのはこのホストで動いている会話だけ。他の会話も止められるので write（読み取りの会話からは断る）。
  // AI は理由（reason）を必ず書き、止めた会話の変更の記録（field: abort）に誰が・どこから・なぜを残す。sessionId を省くと全部を止める口は画面だけ
  defineOp({
    id: 'sessions.abort',
    summary: 'agent:ops.sessions.abort.summary',
    risk: 'write',
    riskReason: 'Stopping a turn loses no data: the interrupted turn stays in the conversation and a person can resume it. It can stop another conversation, so it follows the caller\'s approval mode (refused in read-only) and the agent must give a reason, which is kept in the stopped conversation\'s change log with who and from where. Only conversations of this host can be stopped; stopping all of them is the screen only',
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('abort'),
      kind: z.enum(['user', 'update', 'quit']).optional().describe(D('abort', 'kind')),
      reason: z.string().trim().min(1).max(500).optional().describe(D('abort', 'reason')),
    }),
    output: z.object({ aborted: z.number().int(), reason: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'abort'], positional: ['sessionId'] } },
    legacyCommand: 'abort',
    handler: async (ctx, { sessionId: given, kind, reason }) => {
      if (ctx.principal.by === 'human') return fromHost(() => ctx.conversations.abort({ sessionId: given, kind }));
      const id = targetOf(ctx, given);
      if (!reason) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'reason: required' }));
      await mustExist(ctx, id);
      return fromHost(() => ctx.conversations.abort({ sessionId: id, kind: 'user', note: reason, actor: ctx.actor }));
    },
  }),

  // 中断した会話を続ける（保留の送信待ちを送り直すか、「続けて」の文を送る）。続けるのは、その会話の承認モードの範囲
  defineOp({
    id: 'sessions.resume',
    summary: 'agent:ops.sessions.resume.summary',
    risk: 'write',
    riskReason: 'Resuming sends only what the conversation already queued, or the fixed "continue" text, and the turn runs under that conversation\'s own approval mode, which this call cannot change. A human can resume any conversation, so an agent is treated the same',
    scope: 'session',
    input: z.object({ sessionId: sessionId('resume') }),
    output: z.object({ sent: z.string(), count: z.number().int() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'resume'], positional: ['sessionId'] } },
    legacyCommand: 'resume',
    handler: (ctx, { sessionId: id }) => fromHost(() => ctx.conversations.resume(id)),
  }),

  defineOp({
    id: 'sessions.compact',
    summary: 'agent:ops.sessions.compact.summary',
    risk: 'write',
    riskReason: 'Compaction summarises the model\'s context to free room; the transcript stays as it is. It starts when the conversation is idle (or queues behind the running turn). A human can compact any conversation, so an agent is treated the same',
    scope: 'session',
    input: z.object({ sessionId: sessionId('compact') }),
    output: z.object({ status: z.enum(['started', 'queued']) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'compact'], positional: ['sessionId'] } },
    legacyCommand: 'compactConversation',
    handler: (ctx, { sessionId: id }) => fromHost(() => ctx.conversations.compact(id)),
  }),

  defineOp({
    id: 'sessions.cancelCompaction',
    summary: 'agent:ops.sessions.cancelCompaction.summary',
    risk: 'write',
    riskReason: 'Only cancels a compaction that is scheduled or queued; nothing is lost. A human can cancel it too, so an agent is treated the same',
    scope: 'session',
    input: z.object({ sessionId: sessionId('cancelCompaction') }),
    output: z.object({ cancelled: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'cancelCompaction'], positional: ['sessionId'] } },
    legacyCommand: 'cancelCompaction',
    handler: (ctx, { sessionId: id }) => fromHost(() => ctx.conversations.cancelCompaction(id)),
  }),

  defineOp({
    id: 'sessions.setAutoCompaction',
    summary: 'agent:ops.sessions.setAutoCompaction.summary',
    risk: 'write',
    riskReason: 'Turns the automatic compaction of one conversation off or on; the host-wide setting (compaction.auto) is separate. A human can do the same, so an agent is treated the same',
    scope: 'session',
    input: z.object({ sessionId: optionalSessionId('setAutoCompaction'), off: z.boolean().describe(D('setAutoCompaction', 'off')) }),
    output: z.object({ off: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'autoCompaction'], positional: ['sessionId'] } },
    legacyCommand: 'setConversationAutoCompaction',
    handler: (ctx, { sessionId: given, off }) => fromHost(() => ctx.conversations.setAutoCompaction(targetOf(ctx, given), off)),
  }),

  // 次のターンから効く設定の予約（エージェント・モデル・思考の強さ・作業フォルダー）。承認モード・アカウント・接続先は人だけ（AI は NEEDS_UI）。
  // 作業フォルダーとエージェントを替えるのは、AI 自身の権限の範囲（承認モードが当たる場所・エージェントごとの既定のモード）を変えるので guarded
  defineOp({
    id: 'sessions.setTurnSettings',
    summary: 'agent:ops.sessions.setTurnSettings.summary',
    risk: 'write',
    riskReason: 'Reserves the model and the thinking effort for the next turn only; it can be cancelled or changed again. Changing the working folder or the agent moves the area the approval mode applies to and the default mode, so riskOf raises those to guarded; the approval mode, the account, the endpoint and "remember as default" are for a person only',
    riskOf: async (ctx, args) => {
      if ((args.cwd === undefined && args.backend === undefined) || args.cancel === true) return 'write';
      await mustExist(ctx, targetOf(ctx, args.sessionId));   // 無い会話は承認カードを出す前に断る
      return 'guarded';
    },
    confirm: async (ctx, args) => {
      const id = targetOf(ctx, args.sessionId);
      const found = await ctx.sessions.get(id);
      if (!found) throw missing(ctx, id);
      const rows = [];
      if (args.cwd !== undefined) rows.push({ path: 'cwd', before: String(found.row.cwd ?? ''), after: String(args.cwd) });
      if (args.backend !== undefined) rows.push({ path: 'backend', before: String(found.row.backend ?? ''), after: String(args.backend) });
      return { rows, loosens: true, before: { cwd: found.row.cwd ?? null, backend: found.row.backend ?? null } };
    },
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('setTurnSettings'),
      backend: z.string().max(40).optional().describe(D('setTurnSettings', 'backend')),
      model: z.string().max(200).optional().describe(D('setTurnSettings', 'model')),
      effort: z.string().max(40).optional().describe(D('setTurnSettings', 'effort')),
      cwd: z.string().max(8192).optional().describe(D('setTurnSettings', 'cwd')),
      cancel: z.boolean().optional().describe(D('setTurnSettings', 'cancel')),
      mode: z.string().max(60).optional().describe(D('setTurnSettings', 'mode')),
      account: z.string().max(200).optional().describe(D('setTurnSettings', 'account')),
      endpoint: z.string().max(200).optional().describe(D('setTurnSettings', 'endpoint')),
      rememberModel: z.boolean().optional().describe(D('setTurnSettings', 'remember')),
      rememberEffort: z.boolean().optional().describe(D('setTurnSettings', 'remember')),
      rememberMode: z.boolean().optional().describe(D('setTurnSettings', 'remember')),
    }),
    output: z.object({ backend: z.string(), model: z.string(), effort: z.string(), mode: z.string().optional(), cwd: z.string().optional() }).passthrough().nullable(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'next'], positional: ['sessionId'] } },
    legacyCommand: 'setTurnSettings',
    handler: (ctx, args) => {
      humanOnlyFields(ctx, args, ['mode', 'account', 'endpoint', 'rememberModel', 'rememberEffort', 'rememberMode']);
      return fromHost(() => ctx.conversations.setTurnSettings({ ...args, sessionId: targetOf(ctx, args.sessionId) }));
    },
  }),

  // 題の提案。会話の中身から短い題を作らせるだけで、会話は変えない（返った題を付けるのは sessions.setTitle）。会話のアカウントで小さな 1 回を回す
  defineOp({
    id: 'sessions.suggestTitle',
    summary: 'agent:ops.sessions.suggestTitle.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({ sessionId: optionalSessionId('suggestTitle') }),
    output: z.object({ title: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'suggestTitle'], positional: ['sessionId'] } },
    legacyCommand: 'suggestTitle',
    handler: (ctx, { sessionId: given }) => fromHost(() => ctx.conversations.suggestTitle(targetOf(ctx, given))),
  }),

  // 送信待ち（まだエージェントに渡っていない発言）。本文は 500 字まで
  defineOp({
    id: 'sessions.outbox',
    summary: 'agent:ops.sessions.outbox.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({ sessionId: optionalSessionId('outbox'), limit: limitField('outbox'), cursor: cursorField('outbox') }),
    output: z.object({ total: z.number().int(), messages: z.array(z.object({ id: z.string(), status: z.string(), at: z.string().nullable(), text: z.string(), truncated: z.boolean(),
      attachments: z.number().int(), error: z.string().nullable(), waiting: z.string().nullable() })), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'outbox'], positional: ['sessionId'] } },
    legacyCommand: 'listMessages',
    handler: async (ctx, { sessionId: given, ...page }) => {
      const id = targetOf(ctx, given);
      await mustExist(ctx, id);
      const { total, items, next } = pageOf(ctx, await ctx.conversations.outbox(id), page);
      return { total, messages: items.map(outboxRow), next };
    },
    uiHandler: (ctx, { sessionId: id }) => ctx.conversations.outbox(id),
  }),

  // 変更の記録（時刻・誰が・前 → 後・理由）。新しい方から
  defineOp({
    id: 'sessions.changes',
    summary: 'agent:ops.sessions.changes.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({ sessionId: optionalSessionId('changes'), limit: limitField('changes'), cursor: cursorField('changes') }),
    output: z.object({ total: z.number().int(), changes: z.array(change), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'changes'], positional: ['sessionId'] } },
    legacyCommand: 'sessionChanges',
    handler: async (ctx, { sessionId: given, ...page }) => {
      const id = targetOf(ctx, given);
      const history = await ctx.sessions.history(id);
      if (history === null) throw missing(ctx, id);
      const { total, items, next } = pageOf(ctx, [...history].reverse(), page);
      return { total, changes: items.map(changeRow), next };
    },
    uiHandler: async (ctx, { sessionId: id }) => ({ changes: ((await ctx.sessions.history(id)) ?? []).map(uiChange) }),
  }),

  // 同じ根を持つ会話（分岐の家族）。根から幅優先、200 件まで
  defineOp({
    id: 'sessions.lineage',
    summary: 'agent:ops.sessions.lineage.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({ sessionId: optionalSessionId('lineage'), limit: limitField('lineage'), cursor: cursorField('lineage') }),
    output: z.object({ rootId: z.string(), total: z.number().int(), sessions: z.array(listItem.partial().required({ id: true })), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'lineage'], positional: ['sessionId'] } },
    legacyCommand: 'lineage',
    handler: async (ctx, { sessionId: given, ...page }) => {
      const id = targetOf(ctx, given);
      const rows = await ctx.sessions.list();
      if (!rows.some((r) => r.id === id)) throw missing(ctx, id);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const { rootId, ids } = familyOf(rows, id);
      const { total, items, next } = pageOf(ctx, ids, page);
      return { rootId, total, sessions: items.map((x) => (byId.has(x) ? listRowOf(byId.get(x)) : { id: x })), next };
    },
    uiHandler: async (ctx, { sessionId: id }) => {
      const rows = await ctx.sessions.list();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const { rootId, ids } = familyOf(rows, id);
      return { rootId, sessions: ids.map((x) => byId.get(x) ?? { id: x, parent: null }) };
    },
  }),
];
