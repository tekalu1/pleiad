// チャンネルの保存と操作（S1 が埋める）。core/ops/channels.mjs の handler は `ctx.channels` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs。P0 は工場の名前と返りの形だけ（振る舞いは空）。
//
// createChannelService({ dir, emit, hooks, now }) → ChannelService
//   dir    … <data>/channels
//   emit   … (event) => void。channelsChanged・channelPost・channelReaction・channelThread・channelRead を出す（core/protocol.mjs の EVENTS。sessionId は付けなくてよい）
//   hooks  … 他のモジュールへの逆向きの口。host が bots-host.mjs で配線する（呼ぶだけ。無ければ何もしない）
//     posted(post, channel)       … 投稿を保存した後。誰を起こすかは S4（dispatch.onPosted）が決める
//     stopThread(args, author)    … [止める]。走っているターンを止めるのは S4（dispatch.stopThread）
//   now    … テストで時計を差し替える
//
// ChannelService（author は types.mjs の Author。操作の主体から ops が決めて渡す）:
//   start(): Promise<void>・stop(): void
//   list(): Promise<(Channel & { unread: number, mentions: number, threadsWorking: number })[]>
//   get({ channelId }): Promise<Channel>
//   read({ channelId, threadId?, before?, limit }): Promise<{ posts: Post[], threads: ThreadState[], nextBefore: string|null }>
//   search({ query, channelId?, limit }): Promise<{ hits: object[] }>
//   create({ name, purpose?, cwd?, members? }, author): Promise<Channel>
//   createDm({ bot }): Promise<Channel>                         … bot を作ったとき（S2 の bots.create が呼ぶ）
//   update({ channelId, name?, purpose?, cwd?, members?, memo? }, author): Promise<Channel>
//   archive({ channelId, on }, author): Promise<Channel>
//   post({ channelId, threadId?, text, new?, state?, presents?, turn?, taint?, routine?, mentions? }, author): Promise<Post>
//   edit({ channelId, postId, text?, state?, presents? }, author): Promise<Post>      … 自分の投稿だけ（検査は ops）
//   remove({ channelId, postId }, author): Promise<void>
//   react({ channelId, postId, emoji, on }, author): Promise<{ reactions: Post['reactions'] }>
//   markRead({ channelId, at }): Promise<void>
//   stopThread({ channelId, threadId }, author): Promise<ThreadState>
//   threads: { get(channelId, threadId): Promise<ThreadState|null>, update(channelId, threadId, patch): Promise<ThreadState> }
export function createChannelService({ dir, emit = () => {}, hooks = {}, now = Date.now } = {}) {
  const notYet = (name) => async () => { throw new Error(`channels.${name} is not implemented yet`); };
  return {
    dir, emit, hooks, now,
    async start() {},
    stop() {},
    async list() { return []; },
    get: notYet('get'), read: notYet('read'), async search() { return { hits: [] }; },
    create: notYet('create'), createDm: notYet('createDm'), update: notYet('update'), archive: notYet('archive'),
    post: notYet('post'), edit: notYet('edit'), remove: notYet('remove'), react: notYet('react'),
    async markRead() {}, stopThread: notYet('stopThread'),
    threads: { async get() { return null; }, update: notYet('threads.update') },
  };
}
