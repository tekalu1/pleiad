// チャンネルと投稿・リアクション・スレッド（S1。ADR 0108）の操作（`channels.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。handler は `ctx.channels`（core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。
// 直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。bot の道具（投稿・リアクション）も list_ops / call_op から呼ぶ。
//
// 発言者（Author）は主体から決める（ADR 0007 の対称性）:
//   人（画面）                          → { kind: 'human' }
//   会話に束縛された AI                  → その会話が bot の会話なら { kind: 'bot', botId }、それ以外は { kind: 'agent', sessionId }
//   会話に束縛されない CLI・外の MCP      → NEEDS_UI（人として書かせない。画面へ誘導）
// post・react・stopThread は modeGate: false（読み取り・計画モードの bot も返事・リアクション・停止はできる）。
// AI が作業場所（cwd）を決める・変えるのは riskOf で guarded（フォルダーを持たない bot の作業場所になるので、bots.update のフォルダーと同じ重さ）。
// post は、投稿の主体が AI（bot を含む）で、@ の宛先の bot の承認モードが主体の会話より強い（範囲・自律のどちらかが上）ときは、投稿は残すが起こさず、
// channels.wake（guarded。「<bot> は <モード> で動きます。起こしますか」の承認カード）を出す。人の投稿・同じか弱い bot への @ は確認なし。呼び合いの回数の上限は置かない（ADR 0109）。
// bot の会話に束縛された post は、threadId を省くとその会話のスレッド。チャンネルの流れへ書くのは threadId: null と new: true を一緒に渡したときだけ。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { authorKey } from '../channels/types.mjs';
import { ChannelError, LIMITS } from '../channels/service.mjs';
import { OpError, defineOp } from './registry.mjs';
import { strongerMode } from '../bots/approval.mjs';

const D = (id, key) => `agent:ops.channels.${id}.${key}`;
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

/** 操作の主体 → 投稿の発言者 */
export async function authorOf(ctx) {
  const { actor } = ctx;
  if (actor?.by === 'human') return { kind: 'human' };
  if (!actor?.sessionId) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: ctx.op?.id ?? 'channels' }));
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
    : (await ctx.channels.mentionsOf(text)).filter((m) => m !== 'you' && m !== author.botId);
  const subject = await ctx.modeOf?.(ctx.actor.sessionId);
  const held = [];
  for (const id of new Set(ids)) {
    const target = await ctx.bots.approvalOf({ botId: id });
    if (target && strongerMode(target.entry, subject)) held.push(id);
  }
  return held;
}

/** 自分の投稿だけ直せる・消せる（人は人の投稿、bot はその bot の投稿、AI はその会話の投稿） */
async function ownPost(ctx, args) {
  const author = await authorOf(ctx);
  const post = await run(ctx, () => ctx.channels.getPost({ channelId: args.channelId, postId: args.postId }));
  if (!post || post.deletedAt) throw new OpError('POST_NOT_FOUND', agentT(ctx.locale, 'ops.errors.POST_NOT_FOUND', { id: args.postId }));
  if (authorKey(post.author) !== authorKey(author)) throw new OpError('NOT_YOUR_POST', agentT(ctx.locale, 'ops.errors.NOT_YOUR_POST', { id: args.postId }));
  return author;
}

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
    handler: (ctx, args) => run(ctx, () => ctx.channels.get(args)),
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
    handler: (ctx, args) => run(ctx, () => ctx.channels.read(args)),
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
    riskReason: 'Edits a channel\'s name, purpose, default folder, members or house rules. Members only decide who is listed there; waking a bot still needs an explicit @ in a post. A human can do the same, so an agent is treated the same (ADR 0082), except that an AI changing the default folder is raised to guarded by riskOf: that folder becomes the working place of bots that have no folders of their own',
    input: z.object({
      channelId: channelId('update'),
      name: z.string().trim().min(1).max(LIMITS.name + 1).optional().describe(D('update', 'name')),
      purpose: z.string().max(LIMITS.purpose).optional().describe(D('update', 'purpose')),
      cwd: z.string().max(LIMITS.cwd).nullable().optional().describe(D('update', 'cwd')),
      members: z.array(z.string().min(1)).max(LIMITS.members).optional().describe(D('update', 'members')),
      memo: z.string().max(LIMITS.memo).optional().describe(D('update', 'memo')),
    }),
    output: z.unknown(),
    riskOf: async (ctx, args) => {
      if (ctx.principal?.by !== 'agent' || args.cwd === undefined) return 'write';
      const channel = await run(ctx, () => ctx.channels.get({ channelId: args.channelId }));
      return args.cwd && args.cwd !== (channel.cwd ?? null) ? 'guarded' : 'write';   // 外す（null）・同じ値は広げないので write
    },
    confirm: async (ctx, args) => {
      const channel = await run(ctx, () => ctx.channels.get({ channelId: args.channelId }));
      return { before: channel.cwd ?? null, loosens: true, rows: [{ path: 'cwd', before: channel.cwd ?? null, after: args.cwd || null }] };
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
    id: 'channels.post', summary: D('post', 'summary'), risk: 'write', modeGate: false,
    riskReason: 'Writing a message in a channel is what a human and a bot are for, so it is allowed even from a read-only or plan-mode bot. It only adds a post; an explicit @ may wake another bot, which runs in that bot\'s own approval mode (ADR 0109)',
    input: z.object({
      channelId: channelId('post'),
      threadId: z.string().min(1).nullable().optional().describe(D('post', 'threadId')),
      text: z.string().min(1).max(LIMITS.text).describe(D('post', 'text')),
      new: z.boolean().optional().describe(D('post', 'new')),
      state: z.enum(['checking']).optional().describe(D('post', 'state')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'post'], positional: ['channelId', 'text'] } },
    handler: async (ctx, { state, threadId, ...args }) => {
      const author = await authorOf(ctx);
      // bot の会話のスレッドの中の会話（スレッド・同じチャンネル）では、threadId を省いたらそのスレッド。流れへの新しい投稿は threadId: null と new: true を明示したときだけ
      // （落とした threadId が新しいスレッドを作って、元のスレッドの［止める］から外れるのを防ぐ）
      const sb = author.kind === 'bot' ? await boundBot(ctx) : null;
      const inThread = Boolean(sb?.threadId) && sb.channelId === args.channelId;
      if (inThread && threadId === null && args.new !== true) {
        throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.INVALID', { detail: 'threadId: null writes to the channel flow, which is not the thread of this conversation; pass new: true with it. Omit threadId to write to this thread' }));
      }
      const target = inThread && threadId === undefined ? sb.threadId : threadId;
      const origin = inThread && target === null ? { channelId: sb.channelId, threadId: sb.threadId } : undefined;
      // 起こす宛先に強い bot がいれば、投稿は残して起こさず、承認（channels.wake）を出す。人の投稿は確認しない
      const held = author.kind === 'human' ? [] : await run(ctx, () => strongTargets(ctx, args.channelId, args.text, author));
      // 要確認の印は、実行を担う bot（ルーティンの実行を含む）だけが付けられる
      const saved = await run(ctx, () => ctx.channels.post({
        ...args, ...(sb?.taint ? { taint: sb.taint } : {}), ...(target !== undefined ? { threadId: target } : {}), ...(state && author.kind === 'bot' ? { state } : {}),
        ...(author.kind === 'human' ? {} : { hold: held }), ...(origin ? { origin } : {}),
      }, author));
      // ターンの投稿の置き換え（進捗）では誰も起こさない。@ はターンの終わりの返事で解かれ、そこで同じ確認を通る
      if (!held.length || saved.turn) return saved;
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
    handler: async (ctx, args) => run(ctx, async () => ({ ...(await ctx.wake({ channelId: args.channelId, postId: args.postId, botId: args.botId })), botId: args.botId })),
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
    riskReason: 'A reaction is one emoji on a post, added or removed by its own author. It is allowed from a read-only or plan-mode bot like a reply',
    input: z.object({
      channelId: channelId('react'), postId: postId('react'),
      emoji: z.string().min(1).max(32).describe(D('react', 'emoji')),
      on: z.boolean().optional().describe(D('react', 'on')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'react'], positional: ['channelId', 'postId', 'emoji'] } },
    handler: async (ctx, { on = true, ...args }) => run(ctx, async () => ctx.channels.react({ ...args, on }, await authorOf(ctx))),
  }),
  defineOp({
    id: 'channels.markRead', summary: D('markRead', 'summary'), risk: 'write',
    riskReason: 'Moves the read position of a channel forward (never back). It only changes unread badges and does not touch any post',
    input: z.object({ channelId: channelId('markRead'), at: z.number().int().positive().optional().describe(D('markRead', 'at')) }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'mark-read'], positional: ['channelId'] } },
    // at は今を超えない（既読の位置は進める向きにしか動かないので、未来の時刻を 1 回入れられると、そのチャンネルの未読の印が二度と付かなくなる）
    handler: (ctx, { channelId: id, at }) => run(ctx, () => ctx.channels.markRead({ channelId: id, at: Math.min(at ?? Date.now(), Date.now()) })),
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
