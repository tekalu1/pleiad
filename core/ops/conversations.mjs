// sessions.* のうち、会話そのものの操作（作る・消す・止める・続ける・圧縮・次の設定・送信待ち・別の会話への送信・既読・系譜・変更の記録・題の提案）。
// 画面の WS コマンド（newSession・deleteUnsentSession・abort・resume・compactConversation・cancelCompaction・setConversationAutoCompaction・
// setTurnSettings・listMessages・messageAction・markRead・lineage・sessionChanges・suggestTitle）の中身はここへ移した。WS は同じ操作を呼ぶだけの外側（core/server.mjs の viaOp）。
// 本体（実際に会話を動かす処理）はサーバーが ctx.conversations で渡す（core/server.mjs の opsConversations）。
// 返り値は AI が 1 回で読める大きさに抑える（一覧は limit / cursor、本文は切る）。画面（人）には uiHandler で、画面が読む全量の形を返す（ADR 0091 追記）。
import { z } from 'zod';
import { agentT, t } from '../i18n.mjs';
import { familyOf } from '../lineage.mjs';
import { autonomyRank, modePosition, scopeRank } from '../modes.mjs';
import { defineOp, OpError } from './registry.mjs';
import { FAILED, fromHost, humanOnlyFields, pageOf, clip, PAGE_MAX } from './host.mjs';
import { changeRow, listRowOf } from './sessions.mjs';

const D = (id, key) => `agent:ops.sessions.${id}.${key}`;
/** sessions.listMessages: 1 件の本文の字数 */
export const OUTBOX_CHARS = 500;

// ---- 別の会話へ送る（sessions.send）の強さの比べ方と歯止め（ADR 0104）

/** sessions.send の本文の字数の上限 */
export const SEND_TEXT_MAX = 100_000;
/** 承認カードに出す本文の字数 */
const CARD_TEXT = 300;
/** 送信の連鎖の上限。人の発言から始まった会話どうしの送信が、この回数を超えて続いたら断る（会話どうしの往復が止まらないのを防ぐ） */
export const RELAY_HOPS_MAX = 3;
/** 同じ送り手（会話）からの送信の上限。windowMs の間に max 件まで */
export const SEND_RATE = Object.freeze({ max: 20, windowMs: 10 * 60_000 });

/** 宛先の承認の強さが送り手より強いか。範囲（scope）か自律（autonomy）のどちらかが送り手より上なら強い（宣言の無いモードは弱い側に倒す） */
export function strongerMode(target, sender) {
  const a = modePosition(target), b = modePosition(sender);
  return scopeRank(a.scope) > scopeRank(b.scope) || autonomyRank(a.autonomy) > autonomyRank(b.autonomy);
}

/** 送り手ごとの送信の数え上げ（時刻の窓）。now は単体の検査が差し替える */
export function createSendLimiter({ max = SEND_RATE.max, windowMs = SEND_RATE.windowMs, now = Date.now } = {}) {
  const sent = new Map();
  const recent = (key) => (sent.get(key) ?? []).filter((at) => now() - at < windowMs);
  return {
    allowed: (key) => recent(key).length < max,
    note: (key) => { const list = recent(key); list.push(now()); sent.set(key, list); },
  };
}
const sendLimiter = createSendLimiter();

/** Bot limits run after the shared guards and mode comparison, and again immediately before sending. */
async function botSendGuard(ctx, targetId) {
  const binding = ctx.actor.sessionId ? await ctx.botOfSession?.(ctx.actor.sessionId) : null;
  if (!binding?.botId) return null;
  const bot = await ctx.bots.get({ botId: binding.botId });
  const code = !bot || bot.sendToOthers === false ? 'BOT_SEND_DISABLED'
    : !bot.sendTargets.includes(targetId) ? 'BOT_SEND_TARGET' : null;
  if (code) {
    await Promise.resolve(ctx.conversations.refused?.({ actor: ctx.actor, op: ctx.op.id, sessionId: targetId, code })).catch(() => {});
    throw new OpError(code, agentT(ctx.locale, `ops.errors.${code}`, { id: targetId }));
  }
  return bot;
}

const delegationParentOf = (row) => row?.delegation?.parentSessionId ?? null;

/**
 * sessions.send の歯止め。承認カードを出す前（riskOf）と送る直前（handler）の 2 回確かめる。
 * 断るときは送り手の会話の変更の記録に残す（ctx.conversations.refused）。返り値は { found: 宛先, hops: この送信の連鎖の数 }
 */
async function sendGuard(ctx, targetId) {
  const sender = ctx.actor.sessionId ?? null;
  const refuse = async (code, params = {}) => {
    await Promise.resolve(ctx.conversations.refused?.({ actor: ctx.actor, op: ctx.op.id, sessionId: targetId, code })).catch(() => {});
    return new OpError(code, agentT(ctx.locale, `ops.errors.${code}`, { id: targetId, ...params }));
  };
  if (sender && targetId === sender) throw await refuse('SEND_SELF');
  const found = await ctx.sessions.get(targetId);
  if (!found) throw missing(ctx, targetId);
  if (sender) {
    // 委譲の親子は委譲の道具で話す（子への追加の指示は ply_task_send、子の結果は依頼元へ自動で届く）。2 つの道具をまたぐ往復を作らない
    if (delegationParentOf(found.row) === sender) throw await refuse('SEND_TO_CHILD');
    if (delegationParentOf((await ctx.sessions.get(sender))?.row) === targetId) throw await refuse('SEND_TO_PARENT');
  }
  const hops = (sender ? await ctx.conversations.relayHops(sender) : 0) + 1;
  if (hops > RELAY_HOPS_MAX) throw await refuse('RELAY_LIMIT', { max: RELAY_HOPS_MAX });
  if (!sendLimiter.allowed(sender ?? '')) throw await refuse('SEND_RATE', { max: SEND_RATE.max, minutes: SEND_RATE.windowMs / 60_000 });
  return { found, hops };
}

/**
 * 宛先で次に走るときの承認の強さが、呼び出した会話より強いか。強いなら guarded（承認カード）。
 * 人は比べない。会話に束縛されていない呼び出しは比べる強さが無いので guarded（policy が NEEDS_UI にする）
 */
async function sendRisk(ctx, targetId) {
  if (ctx.principal.by !== 'agent') return 'write';
  if (!ctx.actor.sessionId) return 'guarded';
  const sender = await ctx.modeOf?.(ctx.actor.sessionId);
  return (await ctx.conversations.modesOf(targetId)).some((m) => strongerMode(m, sender)) ? 'guarded' : 'write';
}

/** 承認カードの一文と受領証の元（宛先の承認モードが承認の前と変わっていたら聞き直す） */
async function sendCard(ctx, targetId, key, params) {
  const found = await ctx.sessions.get(targetId);
  if (!found) throw missing(ctx, targetId);
  const modes = await ctx.conversations.modesOf(targetId);
  const mode = modes.map((m) => m?.label).find(Boolean) ?? '';
  // loosens: 確認なしで進む会話を代わりに動かせるので、カードに「確認なしでできることが増える」の一行を出す
  return { note: agentT(ctx.locale, key, { title: found.row.title || targetId, mode, ...params }), loosens: true, before: { id: targetId, modes: modes.map(modePosition) } };
}

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
/** 画面（人）の読み取り: 会話の指定が無ければ、今までの文で断る（コマンドの code は付けない） */
const needSession = (id) => { if (!id) throw new OpError(FAILED, t('session.required')); return id; };
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
    handler: async (ctx, args) => {
      humanOnlyFields(ctx, args, ['mode', 'endpoint']);
      const binding = ctx.actor.sessionId ? await ctx.botOfSession?.(ctx.actor.sessionId) : null;
      const made = await fromHost(() => ctx.conversations.create(args));
      if (binding?.botId) await ctx.bots.addSendTargets({ botId: binding.botId, sessionIds: [made.sessionId], source: 'created' });
      return made;
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
    approvalWords: 'sessionDelete',
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
    approvalWords: 'turnSettings',
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
    id: 'sessions.listMessages',
    summary: 'agent:ops.sessions.listMessages.summary',
    risk: 'read',
    scope: 'session',
    input: z.object({ sessionId: optionalSessionId('listMessages'), limit: limitField('listMessages'), cursor: cursorField('listMessages') }),
    output: z.object({ total: z.number().int(), messages: z.array(z.object({ id: z.string(), status: z.string(), at: z.string().nullable(), text: z.string(), truncated: z.boolean(),
      attachments: z.number().int(), error: z.string().nullable(), waiting: z.string().nullable() })), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'unsent'], positional: ['sessionId'] } },
    legacyCommand: 'listMessages',
    handler: async (ctx, { sessionId: given, ...page }) => {
      const id = targetOf(ctx, given);
      await mustExist(ctx, id);
      const { total, items, next } = pageOf(ctx, await ctx.conversations.outbox(id), page);
      return { total, messages: items.map(outboxRow), next };
    },
    uiHandler: (ctx, { sessionId: id }) => ctx.conversations.outbox(id),
  }),

  // 別の会話にメッセージを送る（AI・CLI・HTTP の口。ADR 0104）。画面の送信（WS の sendMessage）と同じ送信待ちに積み、宛先の会話の承認モードで走る。
  // 宛先の履歴には「<送り手> があなたの代わりに送信」の印で出る（人の発言と見分ける）。画面の送信は添付・巻き戻し・承認モードの欄を持つので WS のまま
  defineOp({
    id: 'sessions.send',
    summary: 'agent:ops.sessions.send.summary',
    risk: 'write',
    riskReason: 'The message runs under the target conversation\'s own approval mode, the same as when a person types it there; it is queued like the screen\'s send and the target\'s history marks it as sent on the user\'s behalf by the sender. When the target\'s approval mode is stronger than the caller\'s (scope or autonomy higher), riskOf raises it to guarded so an agent cannot borrow a stronger conversation. Sending to itself, across a delegation (parent and child), past a relay chain of 3 or over 20 sends in 10 minutes is refused',
    riskOf: async (ctx, { sessionId: id }) => {
      await sendGuard(ctx, id);
      const risk = await sendRisk(ctx, id);
      await botSendGuard(ctx, id);
      return risk;
    },
    approvalWords: 'send',
    confirm: (ctx, { sessionId: id, text }) => sendCard(ctx, id, 'ops.sessions.send.card', { text: clip(text, CARD_TEXT) }),
    scope: 'session',
    input: z.object({
      sessionId: sessionId('send'),
      text: z.string().trim().min(1).max(SEND_TEXT_MAX).describe(D('send', 'text')),
      reason: z.string().trim().min(1).max(500).optional().describe(D('send', 'reason')),
    }),
    output: z.object({ sessionId: z.string(), messageId: z.string(), status: z.string() }),
    surfaces: { ui: false, mcp: 'catalog', cli: { path: ['sessions', 'send'], positional: ['sessionId', 'text'] } },
    handler: async (ctx, { sessionId: id, text, reason }) => {
      const { hops } = await sendGuard(ctx, id);
      const bot = await botSendGuard(ctx, id);
      const own = ctx.actor.sessionId ? (await ctx.sessions.get(ctx.actor.sessionId))?.row : null;
      // 宛先の履歴に出す送り手。bot の会話は name・icon を足す（送り手の表示）
      const sentBy = { by: ctx.actor.by, ...(ctx.actor.via ? { via: ctx.actor.via } : {}),
        ...(own ? { sessionId: own.id, title: own.title ?? '', backend: own.backend ?? null } : {}), ...(bot ? { botId: bot.id, name: bot.name, icon: bot.icon } : {}), hops };
      sendLimiter.note(ctx.actor.sessionId ?? '');
      const item = await fromHost(() => ctx.conversations.send({ sessionId: id, text, sentBy, reason: reason ?? null, actor: ctx.actor }));
      return { sessionId: id, messageId: item.id, status: item.status };
    },
  }),

  // 送信待ちの 1 件を取り消す・送り直す（画面の「取り消す」「再送する」）。送り直しは宛先の会話の承認モードで走るので、sessions.send と同じく
  // 呼び出した会話より強い会話では guarded
  defineOp({
    id: 'sessions.messageAction',
    summary: 'agent:ops.sessions.messageAction.summary',
    risk: 'write',
    riskReason: 'Cancelling only withdraws a message that has not reached the agent (it stays in the outbox as cancelled); retrying re-sends one that failed or was held. A person does the same from the screen. A retry runs under the target conversation\'s approval mode, so riskOf raises it to guarded when that is stronger than the caller\'s, the same as sessions.send',
    riskOf: async (ctx, { sessionId: given, action }) => {
      if (ctx.principal.by !== 'agent') return 'write';
      const id = targetOf(ctx, given);
      await mustExist(ctx, id);   // 無い会話は承認カードを出す前に断る
      return action === 'retry' ? sendRisk(ctx, id) : 'write';
    },
    approvalWords: 'resend',
    confirm: (ctx, { sessionId: given, messageId }) => sendCard(ctx, targetOf(ctx, given), 'ops.sessions.messageAction.card', { messageId }),
    scope: 'session',
    input: z.object({
      sessionId: optionalSessionId('messageAction'),
      messageId: z.string().min(1).max(200).describe(D('messageAction', 'messageId')),
      action: z.enum(['cancel', 'retry']).describe(D('messageAction', 'action')),
    }),
    output: z.object({ sessionId: z.string(), messageId: z.string(), status: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'messageAction'], positional: ['sessionId', 'messageId', 'action'] } },
    legacyCommand: 'messageAction',
    handler: async (ctx, { sessionId: given, messageId, action }) => {
      const id = targetOf(ctx, given);
      if (!(await ctx.conversations.outbox(id)).some((m) => m.id === messageId))
        throw new OpError('MESSAGE_NOT_FOUND', agentT(ctx.locale, 'ops.errors.MESSAGE_NOT_FOUND', { id: messageId }));
      await fromHost(() => ctx.conversations.messageAction(id, messageId, action));
      const item = (await ctx.conversations.outbox(id)).find((m) => m.id === messageId);
      return { sessionId: id, messageId, status: String(item?.status ?? '') };
    },
    // 画面は送信待ちの全部を読み直す（今までの返り）
    uiHandler: async (ctx, { sessionId: id, messageId, action }) => {
      await fromHost(() => ctx.conversations.messageAction(needSession(id), messageId, action));
      return ctx.conversations.outbox(id);
    },
  }),

  // 完了を確認した印（既読）。ホストに 1 つで、どの画面・端末にも同じ。at を省くと今の完了まで。巻き戻らない（大きい方だけ）
  defineOp({
    id: 'sessions.markRead',
    summary: 'agent:ops.sessions.markRead.summary',
    risk: 'write',
    riskReason: 'Only the "seen" mark of a finished turn, a display state shared by the screens; the conversation does not change and the mark never goes back. A person sets it by opening the conversation',
    scope: 'session',
    input: z.object({
      sessionId: sessionId('markRead'),
      at: z.number().int().positive().optional().describe(D('markRead', 'at')),
    }),
    output: z.object({ sessionId: z.string(), readAt: z.number().nullable(), changed: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['sessions', 'markRead'], positional: ['sessionId'] } },
    legacyCommand: 'markRead',
    handler: async (ctx, { sessionId: id, at }) => {
      await mustExist(ctx, id);
      return ctx.conversations.markRead(id, at);
    },
    // 画面は変わった分（[[sessionId, readAt]]）を読む（今までの返り）
    uiHandler: async (ctx, { sessionId: id, at }) => {
      const { changed, readAt } = await ctx.conversations.markRead(needSession(id), at);
      return { reads: changed ? [[id, readAt]] : [] };
    },
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
    uiHandler: async (ctx, { sessionId: id }) => ({ changes: ((await ctx.sessions.history(needSession(id))) ?? []).map(uiChange) }),
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
      needSession(id);
      const rows = await ctx.sessions.list();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const { rootId, ids } = familyOf(rows, id);
      return { rootId, sessions: ids.map((x) => byId.get(x) ?? { id: x, parent: null }) };
    },
  }),
];
