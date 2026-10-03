// チャンネルと投稿・リアクション・スレッド（S1。ADR 0095）の操作（`channels.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。handler は `ctx.channels`（core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。
// 直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。bot の道具（投稿・リアクション）も list_ops / call_op から呼ぶ。
//
// 発言者（Author）は主体から決める（ADR 0007 の対称性）:
//   人（画面）                          → { kind: 'human' }
//   会話に束縛された AI                  → その会話が bot の会話なら { kind: 'bot', botId }、それ以外は { kind: 'agent', sessionId }
//   会話に束縛されない CLI・外の MCP      → NEEDS_UI（人として書かせない。画面へ誘導）
// post・react・stopThread は modeGate: false（読み取り・計画モードの bot も返事・リアクション・停止はできる）。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { authorKey } from '../channels/types.mjs';
import { ChannelError, LIMITS } from '../channels/service.mjs';
import { OpError, defineOp } from './registry.mjs';

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
    riskReason: 'Creates an empty channel (a name, purpose, default folder and member list). It runs nothing by itself, and a human can create one too, so an agent is treated the same (ADR 0082)',
    input: z.object({
      name: z.string().trim().min(1).max(LIMITS.name + 1).describe(D('create', 'name')),
      purpose: z.string().max(LIMITS.purpose).optional().describe(D('create', 'purpose')),
      cwd: z.string().max(LIMITS.cwd).nullable().optional().describe(D('create', 'cwd')),
      members: z.array(z.string().min(1)).max(LIMITS.members).optional().describe(D('create', 'members')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'create'], positional: ['name'] } },
    handler: async (ctx, args) => run(ctx, async () => ctx.channels.create(args, await authorOf(ctx))),
  }),
  defineOp({
    id: 'channels.update', summary: D('update', 'summary'), risk: 'write',
    riskReason: 'Edits a channel\'s name, purpose, default folder, members or house rules. Members only decide who is listed there; waking a bot still needs an explicit @ in a post. A human can do the same, so an agent is treated the same (ADR 0082)',
    input: z.object({
      channelId: channelId('update'),
      name: z.string().trim().min(1).max(LIMITS.name + 1).optional().describe(D('update', 'name')),
      purpose: z.string().max(LIMITS.purpose).optional().describe(D('update', 'purpose')),
      cwd: z.string().max(LIMITS.cwd).nullable().optional().describe(D('update', 'cwd')),
      members: z.array(z.string().min(1)).max(LIMITS.members).optional().describe(D('update', 'members')),
      memo: z.string().max(LIMITS.memo).optional().describe(D('update', 'memo')),
    }),
    output: z.unknown(),
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
    riskReason: 'Writing a message in a channel is what a human and a bot are for, so it is allowed even from a read-only or plan-mode bot. It only adds a post; an explicit @ may wake another bot, which runs in that bot\'s own approval mode (ADR 0096)',
    input: z.object({
      channelId: channelId('post'),
      threadId: z.string().min(1).optional().describe(D('post', 'threadId')),
      text: z.string().min(1).max(LIMITS.text).describe(D('post', 'text')),
      new: z.boolean().optional().describe(D('post', 'new')),
      state: z.enum(['checking']).optional().describe(D('post', 'state')),
    }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'post'], positional: ['channelId', 'text'] } },
    handler: async (ctx, { state, ...args }) => {
      const author = await authorOf(ctx);
      // 要確認の印は、実行を担う bot（ルーティンの実行を含む）だけが付けられる
      return run(ctx, () => ctx.channels.post({ ...args, ...(state && author.kind === 'bot' ? { state } : {}) }, author));
    },
  }),
  defineOp({
    id: 'channels.edit', summary: D('edit', 'summary'), risk: 'write',
    riskReason: 'Edits only the caller\'s own post (a human their own, a bot its own, an agent its own conversation\'s)',
    input: z.object({ channelId: channelId('edit'), postId: postId('edit'), text: z.string().min(1).max(LIMITS.text).describe(D('edit', 'text')) }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'edit'], positional: ['channelId', 'postId', 'text'] } },
    handler: async (ctx, args) => run(ctx, async () => ctx.channels.edit(args, await ownPost(ctx, args))),
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
    input: z.object({ channelId: channelId('markRead'), at: z.number().int().min(0).optional().describe(D('markRead', 'at')) }),
    output: z.unknown(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['channels', 'mark-read'], positional: ['channelId'] } },
    handler: (ctx, { channelId: id, at }) => run(ctx, () => ctx.channels.markRead({ channelId: id, at: at ?? Date.now() })),
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
