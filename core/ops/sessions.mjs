// sessions.*: 会話に関する操作（検索・一覧・メタ・本文の範囲・題と状態）。
// 画面は WS の invoke から、MCP・CLI も同じ入口から呼ぶ。handler は人間の操作と同じ store・同じイベントを使う（ADR 0007）。
// 本体はサーバーが ctx.sessions で渡す（list・get・read・setTitle・setStatus。core/server.mjs の opsDeps）。
// sessions.search は会話の題・状態・場所・本文を探す（core/session-search.mjs。docs/design.md「セッション検索」）。ctx.app.searchSessions を呼ぶ。入力と出力の形が SearchInput / SearchResult。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { defineOp, OpError } from './registry.mjs';

const D = (id, key) => `agent:ops.sessions.${id}.${key}`;

// ---- 上限（定義に書く。AI が 1 回の呼び出しで読む量を抑える）
export const LIST_DEFAULT = 30;
export const LIST_MAX = 100;
/** sessions.read: messageId の前後それぞれの件数の上限 */
export const READ_SIDE_MAX = 20;
export const READ_SIDE_DEFAULT = 4;
/** sessions.read: 1 件の本文の字数（既定・上限）と、1 回の返りの本文の合計の上限 */
export const READ_CHARS_DEFAULT = 2_000;
export const READ_CHARS_MAX = 8_000;
export const READ_TOTAL_MAX = 40_000;
/** sessions.get の変更の記録（新しい方から）の件数 */
export const GET_CHANGES = 10;

// ---- 純粋な部分（tests/unit/ops-sessions.mjs が直接呼ぶ）

const lastModifiedOf = (row) => (Number.isFinite(row?.lastModified) ? row.lastModified : 0);
export const parentIdOf = (row) => (typeof row?.parent === 'string' ? row.parent : row?.parent?.sessionId ?? null);
const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 新しい順、同じ時刻なら id の昇順。ページ送りの順序を決める */
const order = (a, b) => (lastModifiedOf(b) - lastModifiedOf(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const encodeCursor = (row) => Buffer.from(JSON.stringify([lastModifiedOf(row), row.id])).toString('base64url');
export function decodeCursor(cursor) {
  try {
    const [at, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (Number.isFinite(at) && typeof id === 'string') return { at, id };
  } catch { /* 下で INVALID */ }
  return null;
}

/** 一覧の 1 行（外へ出す欄だけ。アカウント・接続先・下書きなどは出さない） */
export const listRowOf = (row) => ({
  id: row.id, title: row.title ?? '', backend: row.backend, status: row.status ?? null, cwd: row.cwd ?? null, parent: parentIdOf(row),
  delegated: Boolean(row.delegation), lastModified: row.lastModified ?? null, createdAt: row.createdAt ?? null,
});

/**
 * 絞り込みとページ送り。rows は会話の一覧（server.mjs の sessionList。まだ送っていない下書きは除く）。
 * cursor は直前の最後の行の（更新時刻・id）。そこより後ろから返すので、間に会話が増えても重複・取りこぼしが出にくい。
 */
export function pageSessions(rows, { backend, cwd, status, parent, query, includeDelegated = true, limit = LIST_DEFAULT, cursor } = {}) {
  const after = cursor === undefined ? null : decodeCursor(cursor);
  if (cursor !== undefined && !after) throw new OpError('INVALID', 'cursor');
  const needle = query ? fold(query).trim() : '';
  const root = cwd ? normPath(cwd) : '';
  const picked = rows.filter((r) => r && !r.unsent)
    .filter((r) => !backend || r.backend === backend)
    .filter((r) => status === undefined || (r.status ?? null) === (status === '' ? null : status))
    .filter((r) => !parent || parentIdOf(r) === parent)
    .filter((r) => includeDelegated || !r.delegation)
    .filter((r) => !root || (normPath(r.cwd) === root || normPath(r.cwd).startsWith(`${root}/`)))
    .filter((r) => !needle || fold(r.title).includes(needle))
    .sort(order);
  const start = after ? picked.findIndex((r) => order({ id: after.id, lastModified: after.at }, r) < 0) : 0;
  const rest = start < 0 ? [] : picked.slice(start);
  const page = rest.slice(0, limit);
  return { total: picked.length, sessions: page.map(listRowOf), next: rest.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

/**
 * messageId の前後の発言を返す。messageId を省けば末尾（最後の発言を中心にする）。
 * 1 件は maxChars 字まで、合計は READ_TOTAL_MAX 字まで。超えた分は切り、truncated・hasMoreAfter で知らせる。
 */
export function readWindow(messages, { messageId, before = READ_SIDE_DEFAULT, after = READ_SIDE_DEFAULT, maxChars = READ_CHARS_DEFAULT } = {}) {
  const list = messages.filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'));
  if (!list.length) return { total: 0, from: 0, to: 0, messages: [], hasMoreBefore: false, hasMoreAfter: false };
  const anchor = messageId === undefined ? list.length - 1 : list.findIndex((m) => m.uuid === messageId);
  if (anchor < 0) throw new OpError('MESSAGE_NOT_FOUND', 'message');
  const lo = Math.max(0, anchor - before), hi = Math.min(list.length - 1, anchor + after);
  let budget = READ_TOTAL_MAX;
  const out = [];
  let stoppedAt = null;
  for (let i = lo; i <= hi; i++) {
    if (budget <= 0) { stoppedAt = i; break; }
    const m = list[i];
    const full = String(m.text ?? '');
    const text = full.slice(0, Math.min(maxChars, budget));
    budget -= text.length;
    const tools = Array.isArray(m.toolCalls) ? m.toolCalls.map((c) => c?.name).filter(Boolean) : Array.isArray(m.tools) ? m.tools.filter((x) => typeof x === 'string') : [];
    out.push({ index: i, uuid: m.uuid ?? null, role: m.role, at: m.at ?? null, text, truncated: text.length < full.length, ...(tools.length ? { tools } : {}) });
  }
  return { total: list.length, from: lo, to: out.length ? out[out.length - 1].index : lo, messages: out, hasMoreBefore: lo > 0, hasMoreAfter: (stoppedAt ?? hi + 1) < list.length };
}

/** 変更の記録の 1 行（新しい方から GET_CHANGES 件）。誰が・どこから・どの会話の AI かを残す */
export const changeRow = (c) => ({ at: c.at, by: c.by, ...(c.via ? { via: c.via } : {}), ...(c.bySession ? { bySession: c.bySession } : {}),
  field: c.field, from: c.from ?? null, to: c.to ?? null, reason: c.reason ?? null });

// ---- 操作

// ---- sessions.search（本文まで探す）
const DS = (key) => `agent:ops.sessions.search.${key}`;

const stamp = z.union([z.string(), z.number()]);

const searchInput = z.object({
  query: z.string().max(2000).describe(DS('query')),
  filters: z.object({
    backends: z.array(z.string()).max(20).optional().describe(DS('backends')),
    cwd: z.string().optional().describe(DS('cwd')),
    status: z.string().nullable().optional().describe(DS('status')),
    since: stamp.optional().describe(DS('since')),
    until: stamp.optional().describe(DS('until')),
    speaker: z.enum(['any', 'user', 'assistant']).optional().describe(DS('speaker')),
    includeDelegated: z.boolean().optional().describe(DS('includeDelegated')),
    includeToolInputs: z.boolean().optional().describe(DS('includeToolInputs')),
    sessionIds: z.array(z.string()).max(500).optional().describe(DS('sessionIds')),
  }).strict().optional().describe(DS('filters')),
  sort: z.enum(['relevance', 'recent']).optional().describe(DS('sort')),
  limit: z.number().int().min(1).max(200).optional().describe(DS('limit')),
  cursor: z.string().optional().describe(DS('cursor')),
  hitsPerSession: z.number().int().min(1).max(10).optional().describe(DS('hitsPerSession')),
});

const hit = z.object({
  uuid: z.string(),
  index: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool']),
  at: z.string(),
  excerpt: z.string(),
  ranges: z.array(z.tuple([z.number().int(), z.number().int()])),
});

const searchOutput = z.object({
  total: z.number().int(),
  partial: z.boolean(),
  nextCursor: z.string().optional(),
  sessions: z.array(z.object({
    sessionId: z.string(),
    title: z.string(),
    status: z.string().nullable(),
    cwd: z.string(),
    backend: z.string(),
    lastModified: z.number(),
    parentSessionId: z.string().optional(),
    score: z.number(),
    matched: z.array(z.enum(['title', 'status', 'place', 'message', 'toolInput'])),
    hitCount: z.number().int(),
    hits: z.array(hit),
  })),
});

const searchOps = [
  defineOp({
    id: 'sessions.search',
    summary: 'agent:ops.sessions.search.summary',
    risk: 'read',
    input: searchInput,
    output: searchOutput,
    surfaces: { ui: true, mcp: 'direct', cli: { path: ['sessions', 'search'], positional: 'query' } },
    // サーバーが ctx.app.searchSessions（core/session-search.mjs の search）を渡す。壊れた入力（語が多すぎる・cursor）は INVALID にする
    handler: async (ctx, args) => {
      try {
        return await ctx.app.searchSessions(args);
      } catch (e) {
        if (e instanceof TypeError || e instanceof RangeError) throw new OpError('INVALID', e.message);
        throw e;
      }
    },
  }),
];

// ---- 会話の一覧・メタ・本文・題と状態
const sessionId = (id) => z.string().min(1).max(200).describe(D(id, 'sessionId'));
const optionalSessionId = (id) => z.string().min(1).max(200).optional().describe(D(id, 'sessionId'));
const reasonFields = (id) => ({
  reasonKey: z.string().max(80).optional().describe(D(id, 'reasonKey')),
  reasonParams: z.record(z.string(), z.unknown()).optional().describe(D(id, 'reasonParams')),
  backend: z.string().max(40).optional().describe(D(id, 'backend')),
});

/** AI は sessionId を省けば自分の会話。人間（画面）は省けない */
function targetOf(ctx, given) {
  const id = given ?? ctx.actor.sessionId;
  if (!id) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.sessionRequired'));
  return id;
}
const missing = (ctx, id) => new OpError('SESSION_NOT_FOUND', agentT(ctx.locale, 'ops.errors.SESSION_NOT_FOUND', { id }));

const listItem = z.object({ id: z.string(), title: z.string(), backend: z.string(), status: z.string().nullable(), cwd: z.string().nullable(),
  parent: z.string().nullable(), delegated: z.boolean(), lastModified: z.number().nullable(), createdAt: z.union([z.string(), z.number()]).nullable() });

export const sessionOps = [
  ...searchOps,

  defineOp({
    id: 'sessions.list',
    summary: 'agent:ops.sessions.list.summary',
    risk: 'read',
    input: z.object({
      backend: z.string().max(40).optional().describe(D('list', 'backend')),
      cwd: z.string().max(4096).optional().describe(D('list', 'cwd')),
      status: z.string().max(200).optional().describe(D('list', 'status')),
      parent: z.string().max(200).optional().describe(D('list', 'parent')),
      query: z.string().max(200).optional().describe(D('list', 'query')),
      includeDelegated: z.boolean().optional().describe(D('list', 'includeDelegated')),
      limit: z.number().int().min(1).max(LIST_MAX).optional().describe(D('list', 'limit')),
      cursor: z.string().max(400).optional().describe(D('list', 'cursor')),
    }),
    output: z.object({ total: z.number().int(), sessions: z.array(listItem), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'list'] } },
    handler: async (ctx, args) => {
      try { return pageSessions(await ctx.sessions.list(), args); }
      catch (e) { if (e instanceof OpError && e.code === 'INVALID') throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.badCursor')); throw e; }
    },
  }),

  defineOp({
    id: 'sessions.get',
    summary: 'agent:ops.sessions.get.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({ sessionId: sessionId('get') }),
    output: listItem.extend({ mode: z.string().nullable(), model: z.string().nullable(), effort: z.string().nullable(), children: z.array(z.string()),
      changes: z.array(z.object({ at: z.string(), by: z.string(), via: z.string().optional(), bySession: z.string().optional(), field: z.string(), from: z.unknown(), to: z.unknown(), reason: z.string().nullable() })) }),
    surfaces: { ui: true, mcp: 'direct', cli: { path: ['sessions', 'get'], positional: ['sessionId'] } },
    handler: async (ctx, { sessionId: id }) => {
      const found = await ctx.sessions.get(id);
      if (!found) throw missing(ctx, id);
      const { row, children, history } = found;
      return { ...listRowOf(row), mode: row.mode ?? null, model: row.model || null, effort: row.effort || null, children,
        changes: (history ?? []).slice(-GET_CHANGES).reverse().map(changeRow) };
    },
  }),

  defineOp({
    id: 'sessions.read',
    summary: 'agent:ops.sessions.read.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({
      sessionId: sessionId('read'),
      messageId: z.string().min(1).max(200).optional().describe(D('read', 'messageId')),
      before: z.number().int().min(0).max(READ_SIDE_MAX).optional().describe(D('read', 'before')),
      after: z.number().int().min(0).max(READ_SIDE_MAX).optional().describe(D('read', 'after')),
      maxChars: z.number().int().min(100).max(READ_CHARS_MAX).optional().describe(D('read', 'maxChars')),
    }),
    output: z.object({ total: z.number().int(), from: z.number().int(), to: z.number().int(), hasMoreBefore: z.boolean(), hasMoreAfter: z.boolean(),
      messages: z.array(z.object({ index: z.number().int(), uuid: z.string().nullable(), role: z.string(), at: z.string().nullable(), text: z.string(), truncated: z.boolean(), tools: z.array(z.string()).optional() })) }),
    surfaces: { ui: true, mcp: 'direct', cli: { path: ['sessions', 'read'], positional: ['sessionId'] } },
    handler: async (ctx, { sessionId: id, ...window }) => {
      const messages = await ctx.sessions.read(id);
      if (messages === null) throw missing(ctx, id);
      try { return { sessionId: id, ...readWindow(messages, window) }; }
      catch (e) { if (e instanceof OpError && e.code === 'MESSAGE_NOT_FOUND') throw new OpError('MESSAGE_NOT_FOUND', agentT(ctx.locale, 'ops.errors.MESSAGE_NOT_FOUND', { id: window.messageId })); throw e; }
    },
  }),

  defineOp({
    id: 'sessions.setTitle',
    summary: 'agent:ops.sessions.setTitle.summary',
    risk: 'write',
    riskReason: "The title change is kept in the conversation's change log (previous value, reason, who changed it) and can be undone. A human can change another conversation's title too, so an agent is treated the same (ADR 0082)",
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('setTitle'),
      title: z.string().trim().min(1).max(200).describe(D('setTitle', 'title')),
      reason: z.string().max(500).optional().describe(D('setTitle', 'reason')),
      ...reasonFields('setTitle'),
    }),
    output: z.object({ sessionId: z.string(), title: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'rename'], positional: ['sessionId', 'title'] } },
    legacyCommand: 'setTitle',
    handler: async (ctx, { sessionId: given, title, reason, reasonKey, reasonParams, backend }) => {
      const id = targetOf(ctx, given);
      if (!(await ctx.sessions.get(id))) throw missing(ctx, id);
      await ctx.sessions.setTitle(id, title, { actor: ctx.actor, reason: ctx.principal.by === 'human' ? (ctx.sessions.clientReason?.({ reason, reasonKey, reasonParams }) ?? reason) : reason, backend });
      return { sessionId: id, title };
    },
  }),

  defineOp({
    id: 'sessions.setStatus',
    summary: 'agent:ops.sessions.setStatus.summary',
    risk: 'write',
    riskReason: "The status change is kept in the conversation's change log (previous value, reason, who changed it) and can be undone. A human can change another conversation's status too, so an agent is treated the same (ADR 0082)",
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('setStatus'),
      status: z.string().trim().max(60).describe(D('setStatus', 'status')),
      reason: z.string().max(500).optional().describe(D('setStatus', 'reason')),
      alone: z.boolean().optional().describe(D('setStatus', 'alone')),
      icon: z.string().max(16).optional().describe(D('setStatus', 'icon')),
      ...reasonFields('setStatus'),
    }),
    output: z.object({ sessionId: z.string(), status: z.string(), moved: z.array(z.string()) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'status'], positional: ['sessionId', 'status'] } },
    legacyCommand: 'setStatus',
    handler: async (ctx, { sessionId: given, status, reason, alone, icon, reasonKey, reasonParams, backend }) => {
      const id = targetOf(ctx, given);
      if (!(await ctx.sessions.get(id))) throw missing(ctx, id);
      const moved = await ctx.sessions.setStatus(id, status, { actor: ctx.actor, reason: ctx.principal.by === 'human' ? (ctx.sessions.clientReason?.({ reason, reasonKey, reasonParams }) ?? reason) : reason, alone, backend });
      if (icon) await ctx.statuses.setIcon(status, icon, ctx.actor);
      return { sessionId: id, status, moved };
    },
  }),

  // 会話を分ける（画面の「ここから分岐」と同じ経路）。親の履歴をそのまま写した新しい会話ができるだけで、親は変わらない。分岐は親と同じ承認モードで始まる
  defineOp({
    id: 'sessions.fork',
    summary: 'agent:ops.sessions.fork.summary',
    risk: 'write',
    riskReason: 'Forking only creates a new conversation as a copy of the history; the parent is untouched and the copy starts with the same approval mode as the parent, so no gate is loosened. A human can fork any conversation, so an agent is treated the same (ADR 0082)',
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('fork'),
      upToMessageId: z.string().min(1).max(200).optional().describe(D('fork', 'upToMessageId')),
      beforeMessageId: z.string().min(1).max(200).optional().describe(D('fork', 'beforeMessageId')),
      title: z.string().trim().min(1).max(200).optional().describe(D('fork', 'title')),
      reason: z.string().max(500).optional().describe(D('fork', 'reason')),
      ...reasonFields('fork'),
    }),
    output: z.object({ sessionId: z.string(), parent: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'fork'], positional: ['sessionId'] } },
    legacyCommand: 'fork',
    handler: async (ctx, { sessionId: given, upToMessageId, beforeMessageId, title, reason, reasonKey, reasonParams, backend }) => {
      const id = targetOf(ctx, given);
      if (!(await ctx.sessions.get(id))) throw missing(ctx, id);
      const forked = await ctx.sessions.fork({ sessionId: id, upToMessageId, beforeMessageId, title,
        reason: ctx.principal.by === 'human' ? (ctx.sessions.clientReason?.({ reason, reasonKey, reasonParams }).reason ?? reason) : reason, backend }, { actor: ctx.actor });
      return { sessionId: forked.sessionId, parent: id };
    },
  }),

  // 会話のモデルを替える。走っているターンにも即時に伝える（できるエージェントだけ）。人間の操作は、新しい会話の既定のモデルとしても覚える
  defineOp({
    id: 'sessions.setModel',
    summary: 'agent:ops.sessions.setModel.summary',
    risk: 'write',
    riskReason: "Picks among the models the agent offers (or the model list of the conversation's endpoint); it does not touch the approval mode or the endpoint. The change is kept in the conversation's change log and can be switched back. The default for new conversations is remembered only from a human's change (ADR 0094)",
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('setModel'),
      model: z.string().max(200).describe(D('setModel', 'model')),
      reason: z.string().max(500).optional().describe(D('setModel', 'reason')),
      ...reasonFields('setModel'),
    }),
    output: z.object({ sessionId: z.string(), model: z.string(), live: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'model'], positional: ['sessionId', 'model'] } },
    legacyCommand: 'setModel',
    handler: async (ctx, { sessionId: given, model, reason, reasonKey, reasonParams, backend }) => {
      const id = targetOf(ctx, given);
      // 画面はまだ送っていない下書きのモデルも替える（一覧に出ない）。AI は在る会話だけ
      if (ctx.principal.by !== 'human' && !(await ctx.sessions.get(id))) throw missing(ctx, id);
      const { live } = await ctx.sessions.setModel(id, model, { actor: ctx.actor, reason: ctx.principal.by === 'human' ? (ctx.sessions.clientReason?.({ reason, reasonKey, reasonParams }) ?? reason) : reason, backend });
      return { sessionId: id, model, live };
    },
  }),
];
