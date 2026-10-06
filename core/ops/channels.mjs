// チャンネルと投稿・リアクション・スレッド（S1。ADR 0108）の操作（`channels.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。handler は `ctx.channels`（core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。
// 直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。bot の道具（投稿・リアクション）も list_ops / call_op から呼ぶ。
//
// 発言者（Author）は主体から決める（ADR 0007 の対称性）:
//   人（画面）                          → { kind: 'human' }
//   会話に束縛された AI                  → その会話が bot の会話なら { kind: 'bot', botId }、それ以外は { kind: 'agent', sessionId }
//   会話に束縛されない CLI・外の MCP      → NEEDS_UI（人として書かせない。画面へ誘導）
// post・react・stopThread は modeGate: false（読み取り・計画モードの bot も、自分のスレッド・DM への返事・リアクション・停止はできる）。post・react は、読み取り・計画のモードの会話からは
// その会話自身の居場所（bot の会話のスレッド・DM）の外へは断る（refuseReadOnlyElsewhere。ADR 0137）。心拍・夜の整理の隠れた会話（sidecar の bot.kind が pulse・learner）からの書き込みは、
// 全部 HIDDEN_CONVERSATION で断る（authorOf と markRead・wake の入口。独り言が投稿に漏れない。ADR 0126）。
// AI が作業場所（cwd）を決める・変えるのは riskOf で guarded（フォルダーを持たない bot の作業場所になるので、bots.update のフォルダーと同じ重さ）。
// post は、投稿の主体が AI（bot を含む）で、@ の宛先の bot の承認モードが主体の会話より強い（範囲・自律のどちらかが上）ときは、投稿は残すが起こさず、
// channels.wake（guarded。「<bot> は <モード> で動きます。起こしますか」の承認カード）を出す。人の投稿・同じか弱い bot への @ は確認なし。呼び合いの回数の上限は置かない（ADR 0109）。
// bot の会話に束縛された post は、threadId を省くとその会話のスレッド。チャンネルの流れへ書くのは threadId: null と new: true を一緒に渡したときだけ。
// bot が自分のスレッドへ書いた返事は、そのターンの最初の 1 件がターンの投稿に入り、2 件目からは新しい投稿（ADR 0117。決めるのは dispatch.claimPost）。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { authorKey, HIDDEN_BOT_KINDS } from '../channels/types.mjs';
import { ChannelError, HOME_ALIAS, LIMITS, THREADS_PER_CHANNEL_MAX } from '../channels/service.mjs';
import { THREAD_STATUS_MAX, THREAD_TITLE_MAX } from '../channels/threads.mjs';
import { groupTargets, expandGroups } from '../channels/group-mentions.mjs';
import { BUDGET_LIMITS, budgetOf, loosensBudget, normalizeBudget } from '../channels/budget.mjs';
import { OpError, defineOp } from './registry.mjs';
import { humanOnlyFields } from './host.mjs';
import { strongerMode } from '../bots/approval.mjs';
import { modePosition, scopeRank } from '../modes.mjs';

const D = (id, key) => `agent:ops.channels.${id}.${key}`;
/** channels.update の後の予算（不正な値は今の予算のまま。検査は service が投げる） */
const nextBudget = (channel, input) => { try { return normalizeBudget(input, channel.budget); } catch { return budgetOf(channel); } };
const channelId = (id) => z.string().min(1).describe(D(id, 'channelId'));
const postId = (id, key = 'postId') => z.string().min(1).describe(D(id, key));

/** ChannelError（service が投げる）を、辞書の文つきの OpError にする */
async function run(ctx, fn) {
  try { return await fn(); }
  catch (err) {
    if (err instanceof ChannelError) throw new OpError(err.code, agentT(ctx.locale, `ops.errors.${err.code}`, err.params));
    throw err;
  }
}

/**
 * 隠れた会話からのチャンネルの書き込みを断る。`channels.post` などは modeGate: false（読み取りのモードの bot も返事・リアクションはできる）なので、
 * 読み取りのモードで動く隠れた会話が、そのまま投稿できてしまう。独り言が人に見える場所へ漏れないよう、書き込みの入口で会話の種類を見る（ADR 0126）
 */
async function refuseHidden(ctx) {
  const sb = ctx.actor?.sessionId ? await ctx.botOfSession?.(ctx.actor.sessionId) : null;
  if (HIDDEN_BOT_KINDS.has(sb?.kind)) throw new OpError('HIDDEN_CONVERSATION', agentT(ctx.locale, 'ops.errors.HIDDEN_CONVERSATION'));
}

/**
 * 読み取り・計画のモードの会話からの書き込み（post・react）は、その会話自身の居場所（bot の会話のスレッド・DM）にだけ許す（ADR 0137）。
 * modeGate: false のままだと、モードを見ずに通ってしまう（Chats の読み取りの AI も、bot の読み取りのモードも、どのチャンネルにも書けた）。
 * 居場所の外（別のスレッド・チャンネルの流れ・bot でない AI の会話）は READ_ONLY_MODE で断る。人・読み取りでないモードの会話は何もしない。
 * where = { channelId, threadId? }（threadId は書く先のスレッドの根の id。DM は見ない）。post は書く先、react は付ける投稿のあるスレッド
 */
async function refuseReadOnlyElsewhere(ctx, where) {
  if (ctx.principal?.by !== 'agent' || !ctx.actor?.sessionId) return;
  if (scopeRank(modePosition(await ctx.modeOf?.(ctx.actor.sessionId)).scope) > scopeRank('readonly')) return;
  const sb = await boundBot(ctx);
  if (sb) {
    if (sb.threadId && sb.channelId === where.channelId && (where.threadId ?? null) === sb.threadId) return;
    const channel = await ctx.channels.get({ channelId: where.channelId }).catch(() => null);
    if (channel?.kind === 'dm' && channel.botId === sb.botId) return;
  }
  throw new OpError('READ_ONLY_MODE', agentT(ctx.locale, 'ops.errors.READ_ONLY_CHANNEL', { id: ctx.op?.id ?? 'channels' }));
}

/** 操作の主体 → 投稿の発言者。隠れた会話（心拍・夜の整理）は断る */
export async function authorOf(ctx) {
  const { actor } = ctx;
  if (actor?.by === 'human') return { kind: 'human' };
  if (!actor?.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: ctx.op?.id ?? 'channels' }));
  await refuseHidden(ctx);
  const bot = await ctx.botOfSession?.(actor.sessionId);
  return bot?.botId ? { kind: 'bot', botId: bot.botId } : { kind: 'agent', sessionId: actor.sessionId };
}

/** 束縛された会話が bot の会話なら、その sidecar の bot（botId・kind・channelId・threadId）。そうでなければ null */
const boundBot = async (ctx) => (ctx.actor?.sessionId ? (await ctx.botOfSession?.(ctx.actor.sessionId)) ?? null : null);

/** この投稿が起こす宛先の bot のうち、動く承認モードが投稿の主体の会話より強いものの id（確認が要る）。route（core/bots/dispatch.mjs）と同じ宛先の決め方 */
async function strongTargets(ctx, channelId, text, author) {
  if (!ctx.bots?.approvalOf || !ctx.channels.mentionsOf) return [];
  const channel = await ctx.channels.get({ channelId }).catch(() => null);
  if (!channel || channel.archivedAt) return [];
  const ids = channel.kind === 'dm'
    ? (author.kind === 'bot' || !channel.botId ? [] : [channel.botId])
    : (await ctx.channels.mentionsOf(text, author)).filter((m) => m !== 'you' && m !== author.botId);
  const subject = await ctx.modeOf?.(ctx.actor.sessionId);
  const held = [];
  for (const id of new Set(ids)) {
    const target = await ctx.bots.approvalOf({ botId: id });
    if (target && strongerMode(target.entry, subject)) held.push(id);
  }
  return held;
}

/** 添付の実物を確かめて記録の形にする（置き場の中のファイル・読んでよいホストのファイル）。読めないものがあれば全体を断る */
async function describeFiles(ctx, list) {
  if (!ctx.describeAttachments) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'attachments are not available here' }));
  const { files, rejected } = await ctx.describeAttachments(list);
  if (rejected.length) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: `cannot attach: ${rejected.join(', ')}` }));
  return files;
}

/** 自分の投稿だけ直せる・消せる（人は人の投稿、bot はその bot の投稿、AI はその会話の投稿） */
async function ownPost(ctx, args) {
  const author = await authorOf(ctx);
  const post = await run(ctx, () => ctx.channels.getPost({ channelId: args.channelId, postId: args.postId }));
  if (!post || post.deletedAt) throw new OpError('POST_NOT_FOUND', agentT(ctx.locale, 'ops.errors.POST_NOT_FOUND', { id: args.postId }));
  if (authorKey(post.author) !== authorKey(author)) throw new OpError('NOT_YOUR_POST', agentT(ctx.locale, 'ops.errors.NOT_YOUR_POST', { id: args.postId }));
  return author;
}

/**
 * 一時チャットの呼び名（channelId: 'home'）を実体の id へ解く（ADR 9101）。make: 無ければ作る（人の投稿。最初に bot へ話しかけたとき）。
 * 無いまま読むと、空の一時チャットとして返す（empty）か、見つからないで断る
 */
async function homeArgs(ctx, args, { make = false } = {}) {
  if (args.channelId !== HOME_ALIAS) return args;
  const home = make ? await ctx.channels.ensureHome() : await ctx.channels.home?.();
  return home ? { ...args, channelId: home.id } : null;
}
const notFound = (ctx, id) => new OpError('CHANNEL_NOT_FOUND', agentT(ctx.locale, 'ops.errors.CHANNEL_NOT_FOUND', { id }));

export const channelOps = [
  defineOp({
    id: 'channels.list', summary: D('list', 'summary'), risk: 'read', input: z.object({}),
    output: z.object({ channels: z.array(z.unknown()) }),
    surfaces: { ui: true, mcp: 'catalog', cli: true },
    handler: async (ctx) => ({ channels: await ctx.channels.list() }),
  }),
  defineOp({
    id: 'channels.get', summary: D('get', 'summary'), risk: 'read',
    input: z.object({ channelId: channelId('get') }), output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'get'], positional: ['channelId'] } },
    handler: async (ctx, args) => {
      const where = await homeArgs(ctx, args);
      if (!where) throw notFound(ctx, args.channelId);
      return run(ctx, () => ctx.channels.get(where));
    },
  }),
  defineOp({
    id: 'channels.read', summary: D('read', 'summary'), risk: 'read',
    input: z.object({
      channelId: channelId('read'),
      threadId: z.string().min(1).optional().describe(D('read', 'threadId')),
      before: z.string().min(1).optional().describe(D('read', 'before')),
      limit: z.number().int().min(1).max(LIMITS.readMax).optional().describe(D('read', 'limit')),
    }),
    output: z.object({ posts: z.array(z.unknown()), threads: z.array(z.unknown()), summaries: z.unknown(), nextBefore: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'read'], positional: ['channelId'] } },
    handler: async (ctx, args) => {
      const where = await homeArgs(ctx, args);
      // 一時チャットにまだ投稿が無い（実体を作っていない）: 空の流れ
      if (!where) return { posts: [], threads: [], summaries: {}, nextBefore: null };
      return run(ctx, () => ctx.channels.read(where));
    },
  }),
  defineOp({
    // スレッドの索引: チャンネルごとの最近のスレッド（題・最後の動き・返信の数・未読・状態・作業中の bot）。脇の 2 つの並べ方の材料
    id: 'channels.threads', summary: D('threads', 'summary'), risk: 'read',
    input: z.object({
      channelId: z.string().min(1).optional().describe(D('threads', 'channelId')),
      perChannel: z.number().int().min(1).max(THREADS_PER_CHANNEL_MAX).optional().describe(D('threads', 'perChannel')),
      all: z.boolean().optional().describe(D('threads', 'all')),
    }),
    output: z.object({ threads: z.array(z.unknown()), totals: z.record(z.string(), z.number().int()) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'threads'] } },
    handler: (ctx, args) => run(ctx, () => ctx.channels.threadIndex(args)),
  }),
  defineOp({
    id: 'channels.setThreadStatus', summary: D('setThreadStatus', 'summary'), risk: 'write',
    riskReason: 'Sets or clears the status label of a thread (the same status groups as conversations). It only changes how the sidebar groups the thread; no post or bot is touched. A human can do the same, so an agent is treated the same (ADR 0082)',
    input: z.object({
      channelId: channelId('setThreadStatus'), threadId: postId('setThreadStatus', 'threadId'),
      status: z.string().trim().max(THREAD_STATUS_MAX).describe(D('setThreadStatus', 'status')),
    }),
    output: z.object({ channelId: z.string(), threadId: z.string(), status: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'thread-status'], positional: ['channelId', 'threadId', 'status'] } },
    handler: async (ctx, args) => run(ctx, async () => { await refuseHidden(ctx); return ctx.channels.setThreadStatus(args, await authorOf(ctx)); }),
  }),
  defineOp({
    id: 'channels.setThreadTitle', summary: D('setThreadTitle', 'summary'), risk: 'write',
    riskReason: 'Sets or clears the title shown for a thread. The root post is not changed, and clearing it goes back to the first line of the root post. A human can do the same, so an agent is treated the same (ADR 0082)',
    input: z.object({
      channelId: channelId('setThreadTitle'), threadId: postId('setThreadTitle', 'threadId'),
      title: z.string().max(THREAD_TITLE_MAX).describe(D('setThreadTitle', 'title')),
    }),
    output: z.object({ channelId: z.string(), threadId: z.string(), title: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'thread-title'], positional: ['channelId', 'threadId', 'title'] } },
    handler: async (ctx, args) => run(ctx, async () => { await refuseHidden(ctx); return ctx.channels.setThreadTitle(args, await authorOf(ctx)); }),
  }),
  defineOp({
    // スレッドの bot の会話の設定を、このスレッドだけ変える（入力欄の宛先の bot のチップ。ADR 9101）。承認モードは人だけ（bots.setMode と同じ）
    id: 'channels.threadSettings', summary: D('threadSettings', 'summary'), risk: 'write',
    riskReason: 'Changes how one bot runs in one thread (model, effort, approval mode, working folder) from its next turn. The bot\'s defaults are not changed. The approval mode is human-only like bots.setMode, and the working folder must be one the bot may use',
    input: z.object({
      channelId: channelId('threadSettings'), threadId: postId('threadSettings', 'threadId'),
      botId: z.string().min(1).describe(D('threadSettings', 'botId')),
      model: z.string().max(200).optional().describe(D('threadSettings', 'model')),
      effort: z.string().max(40).optional().describe(D('threadSettings', 'effort')),
      mode: z.string().max(40).optional().describe(D('threadSettings', 'mode')),
      cwd: z.string().max(LIMITS.cwd).optional().describe(D('threadSettings', 'cwd')),
    }),
    output: z.object({ sessionId: z.string(), backend: z.string(), model: z.string(), effort: z.string(), mode: z.string(), cwd: z.string() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'thread-settings'], positional: ['channelId', 'threadId', 'botId'] } },
    handler: async (ctx, args) => run(ctx, async () => {
      await refuseHidden(ctx);
      humanOnlyFields(ctx, args, ['mode']);
      if (args.cwd !== undefined) {
        const bot = await ctx.bots.get({ botId: args.botId });
        const channel = await ctx.channels.get({ channelId: args.channelId });
        const allowed = [...(bot?.folders ?? []).map((f) => f.path), ...(channel?.cwd ? [channel.cwd] : [])];
        const norm = (p) => String(p ?? '').split(String.fromCharCode(92)).join('/').replace(/[/]+$/, '').toLowerCase();
        if (allowed.length && !allowed.some((p) => norm(p) === norm(args.cwd))) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'cwd must be one of the bot\'s folders or the channel folder' }));
      }
      return ctx.threadSettings(args);
    }),
  }),
  defineOp({
    // スレッドへの返信を日時を指定して送る（入力欄の送信の日時。ADR 9101・0103）。AI には作らせない（sessions.scheduleSend と同じ）
    id: 'channels.schedulePost', summary: D('schedulePost', 'summary'), risk: 'guarded',
    approvalWords: 'schedule',
    confirm: (ctx, args) => agentT(ctx.locale, 'ops.channels.schedulePost.confirm', { thread: args.threadId, at: String(args.at), text: String(args.text ?? '').slice(0, 120) }),
    input: z.object({
      channelId: channelId('schedulePost'), threadId: postId('schedulePost', 'threadId'),
      text: z.string().min(1).max(LIMITS.text).describe(D('schedulePost', 'text')),
      at: z.union([z.number(), z.string()]).describe(D('schedulePost', 'at')),
      clientId: z.string().min(8).max(100).describe(D('schedulePost', 'clientId')),
      attachments: z.array(z.object({ path: z.string().min(1), name: z.string().optional(), mime: z.string().optional() })).max(LIMITS.attachments).optional().describe(D('schedulePost', 'attachments')),
      to: z.string().min(1).max(80).optional().describe(D('schedulePost', 'to')),
    }),
    output: z.object({ id: z.string(), at: z.number() }),
    surfaces: { ui: true, mcp: false, cli: { path: ['channels', 'schedule-post'], positional: ['channelId', 'threadId', 'text'] } },
    handler: async (ctx, args) => run(ctx, async () => {
      if ((await authorOf(ctx)).kind !== 'human') throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI'));
      const files = args.attachments?.length ? await describeFiles(ctx, args.attachments) : undefined;
      return ctx.schedulePost({ ...args, ...(files ? { attachments: files } : {}) });
    }),
  }),
  defineOp({
    id: 'channels.threadBudget', summary: D('threadBudget', 'summary'), risk: 'read',
    input: z.object({ channelId: channelId('threadBudget'), threadId: postId('threadBudget', 'threadId') }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'thread-budget'], positional: ['channelId', 'threadId'] } },
    handler: async (ctx, args) => (await ctx.threadBudget?.(args)) ?? null,
  }),
  defineOp({
    id: 'channels.search', summary: D('search', 'summary'), risk: 'read',
    input: z.object({
      query: z.string().trim().min(1).max(200).describe(D('search', 'query')),
      channelId: z.string().min(1).optional().describe(D('search', 'channelId')),
      limit: z.number().int().min(1).max(LIMITS.searchMax).optional().describe(D('search', 'limit')),
    }),
    output: z.object({ hits: z.array(z.unknown()) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'search'], positional: ['query'] } },
    handler: (ctx, args) => run(ctx, () => ctx.channels.search(args)),
  }),

  defineOp({
    id: 'channels.create', summary: D('create', 'summary'), risk: 'write',
    riskReason: 'Creates an empty channel (a name, purpose, default folder and member list). It runs nothing by itself, and a human can create one too, so an agent is treated the same (ADR 0082). An AI setting a default folder is raised to guarded by riskOf, because that folder becomes the working place of bots that have no folders of their own',
    input: z.object({
      name: z.string().trim().min(1).max(LIMITS.name + 1).describe(D('create', 'name')),
      purpose: z.string().max(LIMITS.purpose).optional().describe(D('create', 'purpose')),
      cwd: z.string().max(LIMITS.cwd).nullable().optional().describe(D('create', 'cwd')),
      members: z.array(z.string().min(1)).max(LIMITS.members).optional().describe(D('create', 'members')),
    }),
    output: z.unknown(),
    riskOf: (ctx, args) => (ctx.principal?.by === 'agent' && args.cwd ? 'guarded' : 'write'),
    confirm: (_ctx, args) => ({ before: null, loosens: true, rows: [{ path: 'name', before: null, after: args.name }, { path: 'cwd', before: null, after: args.cwd ?? null }] }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'create'], positional: ['name'] } },
    handler: async (ctx, args) => run(ctx, async () => ctx.channels.create(args, await authorOf(ctx))),
  }),
  defineOp({
    id: 'channels.update', summary: D('update', 'summary'), risk: 'write',
    riskReason: 'Edits a channel\'s name, purpose, default folder, members, house rules or budget. Members only decide who is listed there; waking a bot still needs an explicit @ in a post. A human can do the same, so an agent is treated the same (ADR 0082), except two changes riskOf raises to guarded for an AI: changing the default folder (it becomes the working place of bots that have no folders of their own) and loosening the budget (removing it or raising the daily budget or the thread share), since the budget is what stops bots from calling each other (ADR 0119)',
    input: z.object({
      channelId: channelId('update'),
      name: z.string().trim().min(1).max(LIMITS.name + 1).optional().describe(D('update', 'name')),
      purpose: z.string().max(LIMITS.purpose).optional().describe(D('update', 'purpose')),
      cwd: z.string().max(LIMITS.cwd).nullable().optional().describe(D('update', 'cwd')),
      members: z.array(z.string().min(1)).max(LIMITS.members).optional().describe(D('update', 'members')),
      memo: z.string().max(LIMITS.memo).optional().describe(D('update', 'memo')),
      budget: z.object({
        daily: z.number().min(0).max(BUDGET_LIMITS.dailyMax).nullable().optional().describe(D('update', 'budgetDaily')),
        perThread: z.number().min(BUDGET_LIMITS.perThreadMin).max(BUDGET_LIMITS.perThreadMax).optional().describe(D('update', 'budgetPerThread')),
      }).optional().describe(D('update', 'budget')),
    }),
    output: z.unknown(),
    riskOf: async (ctx, args) => {
      if (ctx.principal?.by !== 'agent' || (args.cwd === undefined && args.budget === undefined)) return 'write';
      const channel = await run(ctx, () => ctx.channels.get({ channelId: args.channelId }));
      if (args.cwd !== undefined && args.cwd && args.cwd !== (channel.cwd ?? null)) return 'guarded';   // 外す（null）・同じ値は広げないので write
      // 予算を外す・上げるのは、bot どうしの呼びかけの歯止めを緩める向き（ADR 0119）
      if (args.budget !== undefined && channel.kind === 'channel' && loosensBudget(channel.budget, nextBudget(channel, args.budget))) return 'guarded';
      return 'write';
    },
    confirm: async (ctx, args) => {
      const channel = await run(ctx, () => ctx.channels.get({ channelId: args.channelId }));
      const rows = [];
      if (args.cwd !== undefined) rows.push({ path: 'cwd', before: channel.cwd ?? null, after: args.cwd || null });
      if (args.budget !== undefined) {
        const before = budgetOf(channel), after = nextBudget(channel, args.budget);
        rows.push({ path: 'budget.daily', before: before.daily, after: after.daily }, { path: 'budget.perThread', before: before.perThread, after: after.perThread });
      }
      return { before: channel.cwd ?? null, loosens: true, rows };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'update'], positional: ['channelId'] } },
    handler: async (ctx, args) => run(ctx, async () => ctx.channels.update(args, await authorOf(ctx))),
  }),
  defineOp({
    id: 'channels.archive', summary: D('archive', 'summary'), risk: 'write',
    riskReason: 'Archiving only hides a channel from the list and stops new posts; nothing is deleted and `on: false` brings it back',
    input: z.object({ channelId: channelId('archive'), on: z.boolean().describe(D('archive', 'on')) }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'archive'], positional: ['channelId'] } },
    handler: async (ctx, args) => run(ctx, async () => ctx.channels.archive(args, await authorOf(ctx))),
  }),

  defineOp({
    id: 'channels.wakePreview', summary: D('wakePreview', 'summary'), risk: 'read',
    input: z.object({ channelId: channelId('wakePreview'), threadId: z.string().min(1).nullable().optional().describe(D('wakePreview', 'threadId')), text: z.string().max(LIMITS.text).describe(D('wakePreview', 'text')) }),
    output: z.object({ required: z.boolean(), botIds: z.array(z.string()) }),
    surfaces: { ui: true, mcp: 'catalog', cli: false },
    handler: async (ctx, args) => run(ctx, async () => {
      const channel = await ctx.channels.get({ channelId: args.channelId });
      const mentions = await ctx.channels.mentionsOf(args.text, { kind: 'human' });
      const group = await groupTargets(ctx.channels, channel, args.threadId, mentions);
      return { required: group.groups, botIds: group.groups ? expandGroups(mentions, group.botIds).filter((id) => !['you', 'here', 'everyone'].includes(id)) : [] };
    }),
  }),
  defineOp({
    id: 'channels.post', summary: D('post', 'summary'), risk: 'write', modeGate: false,
    riskReason: 'Writing a message in a channel is what a human and a bot are for, so a read-only or plan-mode bot may reply in its own thread or DM (the handler refuses any other place with READ_ONLY_MODE; ADR 0137). It only adds a post; an explicit @ may wake another bot, which runs in that bot\'s own approval mode (ADR 0109)',
    input: z.object({
      channelId: channelId('post'),
      threadId: z.string().min(1).nullable().optional().describe(D('post', 'threadId')),
      text: z.string().min(1).max(LIMITS.text).describe(D('post', 'text')),
      attachments: z.array(z.object({ path: z.string().min(1), name: z.string().optional(), mime: z.string().optional() })).max(LIMITS.attachments).optional().describe(D('post', 'attachments')),
      new: z.boolean().optional().describe(D('post', 'new')),
      state: z.enum(['checking']).optional().describe(D('post', 'state')),
      confirmedWake: z.array(z.string()).optional().describe(D('post', 'confirmedWake')),
      to: z.string().min(1).max(80).optional().describe(D('post', 'to')),
      clientId: z.string().min(8).max(100).optional().describe(D('post', 'clientId')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'post'], positional: ['channelId', 'text'] } },
    handler: async (ctx, { state, threadId, attachments, confirmedWake, to, clientId, ...input }) => {
      const author = await authorOf(ctx);
      const args = await homeArgs(ctx, input, { make: author.kind === 'human' });
      if (!args) throw notFound(ctx, input.channelId);
      if (clientId && author.kind !== 'human') throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'clientId is only for a human post' }));
      if (clientId) args.clientId = clientId;
      // 宛先のチップ（to）は人だけ。bot・AI は本文の @ で呼ぶ（強さの確認が @ を数える）
      if (to && author.kind !== 'human') throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'to is only for a human post; write @name in the text instead' }));
      if (to) args.to = to;
      const files = attachments?.length ? await describeFiles(ctx, attachments) : null;
      let groupMentions;
      if (author.kind === 'human') {
        const channel = await run(ctx, () => ctx.channels.get({ channelId: args.channelId }));
        const mentions = await ctx.channels.mentionsOf(args.text, author);
        const group = await groupTargets(ctx.channels, channel, threadId, mentions);
        if (group.groups) {
          const targets = expandGroups(mentions, group.botIds).filter((id) => !['you', 'here', 'everyone'].includes(id));
          if (JSON.stringify(confirmedWake) !== JSON.stringify(targets)) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'wake targets changed; confirm again' }));
          groupMentions = expandGroups(mentions, group.botIds);
        }
      }
      // bot の会話のスレッドの中の会話（スレッド・同じチャンネル）では、threadId を省いたらそのスレッド。流れへの新しい投稿は threadId: null と new: true を明示したときだけ
      // （落とした threadId が新しいスレッドを作って、元のスレッドの［止める］から外れるのを防ぐ）
      const sb = author.kind === 'bot' ? await boundBot(ctx) : null;
      const inThread = Boolean(sb?.threadId) && sb.channelId === args.channelId;
      if (inThread && threadId === null && args.new !== true) {
        throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'threadId: null writes to the channel flow, which is not the thread of this conversation; pass new: true with it. Omit threadId to write to this thread' }));
      }
      const target = inThread && threadId === undefined ? sb.threadId : threadId;
      const origin = inThread && target === null ? { channelId: sb.channelId, threadId: sb.threadId } : undefined;
      await refuseReadOnlyElsewhere(ctx, { channelId: args.channelId, threadId: target });
      // 起こす宛先に強い bot がいれば、投稿は残して起こさず、承認（channels.wake）を出す。人の投稿は確認しない
      const held = author.kind === 'human' ? [] : await run(ctx, () => strongTargets(ctx, args.channelId, args.text, author));
      // 要確認の印は、実行を担う bot（ルーティンの実行を含む）だけが付けられる
      const saved = await run(ctx, () => ctx.channels.post({
        ...args, ...(files ? { attachments: files } : {}), ...(groupMentions ? { mentions: groupMentions } : {}), ...(sb?.taint ? { taint: sb.taint } : {}), ...(target !== undefined ? { threadId: target } : {}), ...(state && author.kind === 'bot' ? { state } : {}),
        ...(author.kind === 'human' ? {} : { hold: held }), ...(origin ? { origin } : {}),
        ...(author.kind === 'bot' ? { bySession: ctx.actor.sessionId } : {}),
      }, author));
      // 起こす宛先に強い bot がいれば承認を出す。ターンの投稿に入った返事（ADR 0117）も同じ
      if (!held.length) return saved;
      const wake = [];
      for (const botId of held) {
        const r = await ctx.registry.invoke(ctx.principal, 'channels.wake', { channelId: args.channelId, postId: saved.id, botId }, ctx);
        wake.push({ botId, status: r.pending ? 'pending' : r.ok ? (r.result?.woken ? 'woken' : 'notWoken') : 'denied', ...(r.pending ? { requestId: r.result.requestId, message: r.result.message } : r.ok ? {} : { code: r.code, message: r.error }) });
      }
      return { ...saved, wake };
    },
  }),
  defineOp({
    id: 'channels.wake', summary: D('wake', 'summary'), risk: 'guarded',
    input: z.object({
      channelId: channelId('wake'), postId: postId('wake'),
      botId: z.string().min(1).describe(D('wake', 'botId')),
      reason: z.string().max(500).optional().describe(D('wake', 'reason')),
    }),
    output: z.unknown(),
    // 起こす bot の動くモードを見せる（承認カード）。bot が無ければここで断る（承認のあとに変わったら聞き直す: before にモードを入れる）
    riskOf: async (ctx, args) => {
      if (!(await ctx.bots.approvalOf({ botId: args.botId }))) throw new OpError('BOT_NOT_FOUND', agentT(ctx.locale, 'ops.errors.BOT_NOT_FOUND', { id: args.botId }));
      return 'guarded';
    },
    confirm: async (ctx, args) => {
      const bot = await ctx.bots.approvalOf({ botId: args.botId });
      const who = `${bot.icon} ${bot.name}`.trim();
      return {
        note: agentT(ctx.locale, 'ops.channels.wake.confirm', { bot: who, mode: bot.label }),
        before: { botId: bot.id, mode: bot.mode }, loosens: true,
        rows: [{ path: 'wake', before: null, after: who }, { path: 'mode', before: null, after: bot.label }],
      };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'wake'], positional: ['channelId', 'postId', 'botId'] } },
    handler: async (ctx, args) => run(ctx, async () => { await refuseHidden(ctx); return { ...(await ctx.wake({ channelId: args.channelId, postId: args.postId, botId: args.botId })), botId: args.botId }; }),
  }),
  defineOp({
    id: 'channels.edit', summary: D('edit', 'summary'), risk: 'write',
    riskReason: 'Edits only the caller\'s own post (a human their own, a bot its own, an agent its own conversation\'s)',
    input: z.object({ channelId: channelId('edit'), postId: postId('edit'), text: z.string().min(1).max(LIMITS.text).describe(D('edit', 'text')) }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'edit'], positional: ['channelId', 'postId', 'text'] } },
    handler: async (ctx, args) => run(ctx, async () => {
      const author = await ownPost(ctx, args);
      const sb = author.kind === 'bot' ? await boundBot(ctx) : null;
      return ctx.channels.edit({ ...args, ...(sb?.taint ? { taint: sb.taint } : {}) }, author);
    }),
  }),
  defineOp({
    id: 'channels.delete', summary: D('delete', 'summary'), risk: 'write',
    riskReason: 'Deletes only the caller\'s own post (the thread keeps its shape with a "deleted" row), so unlike deleting someone else\'s data it cannot widen what an agent can do',
    input: z.object({ channelId: channelId('delete'), postId: postId('delete') }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'delete'], positional: ['channelId', 'postId'] } },
    handler: async (ctx, args) => run(ctx, async () => { await ctx.channels.remove(args, await ownPost(ctx, args)); return { deleted: true }; }),
  }),
  defineOp({
    id: 'channels.react', summary: D('react', 'summary'), risk: 'write', modeGate: false,
    riskReason: 'A reaction is one emoji on a post, added or removed by its own author. It is allowed from a read-only or plan-mode bot on posts of its own thread or DM, like a reply (ADR 0137)',
    input: z.object({
      channelId: channelId('react'), postId: postId('react'),
      emoji: z.string().min(1).max(32).describe(D('react', 'emoji')),
      on: z.boolean().optional().describe(D('react', 'on')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'react'], positional: ['channelId', 'postId', 'emoji'] } },
    handler: async (ctx, { on = true, ...args }) => run(ctx, async () => {
      const author = await authorOf(ctx);
      const post = await ctx.channels.getPost({ channelId: args.channelId, postId: args.postId }).catch(() => null);
      if (post) await refuseReadOnlyElsewhere(ctx, { channelId: args.channelId, threadId: post.threadId ?? post.id });   // スレッドの根は自分の id がスレッドの id
      return ctx.channels.react({ ...args, on }, author);
    }),
  }),
  defineOp({
    id: 'channels.markRead', summary: D('markRead', 'summary'), risk: 'write',
    riskReason: 'Moves the read position of a channel forward (never back). It only changes unread badges and does not touch any post',
    input: z.object({ channelId: channelId('markRead'), threadId: z.string().min(1).optional().describe(D('markRead', 'threadId')),
      at: z.number().int().positive().optional().describe(D('markRead', 'at')) }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'mark-read'], positional: ['channelId'] } },
    // at は今を超えない（既読の位置は進める向きにしか動かないので、未来の時刻を 1 回入れられると、そのチャンネルの未読の印が二度と付かなくなる）
    handler: (ctx, { channelId: id, threadId, at }) => run(ctx, async () => { await refuseHidden(ctx); return ctx.channels.markRead({ channelId: id, threadId, at: Math.min(at ?? Date.now(), Date.now()) }); }),
  }),
  defineOp({
    id: 'channels.stopThread', summary: D('stopThread', 'summary'), risk: 'write', modeGate: false,
    riskReason: 'Stopping only narrows what runs: it aborts the bots\' running turns in the thread and keeps them from being woken until a human writes again. It is allowed from a read-only or plan-mode bot',
    input: z.object({ channelId: channelId('stopThread'), threadId: postId('stopThread', 'threadId') }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'stop-thread'], positional: ['channelId', 'threadId'] } },
    handler: async (ctx, args) => run(ctx, async () => ctx.channels.stopThread(args, await authorOf(ctx))),
  }),
];
