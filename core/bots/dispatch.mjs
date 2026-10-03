// bot を起こす・配る（S4 が埋める）。投稿の @ から会話を決め、途中送信・ターンの投稿の更新・止める・トークンの集計までを持つ。
// core/bots-host.mjs がこれを束ね、core/server.mjs のつなぎ目（turnExtras・onTurnEvent・onTurnEnd・onPermission・onCompacted・start）は
// ここへ届く。P0 は工場の名前と返りの形だけ（振る舞いは空。bot の会話が無い間は何もしない）。
//
// createDispatcher({ channels, bots, memory, host, emit, now }) → Dispatcher
//   channels / bots / memory … 各サービス（core/channels/service.mjs ほか）
//   host … core/server.mjs が createBotHost に渡す道具の束（core/bots-host.mjs の HostTools）。会話を作る・走らせる・止める・途中送信するのに使う
//   emit … 全接続へ出す（sessionId: null）。会話ごとの出来事は host.emitSession
//
// Dispatcher:
//   start(): Promise<void>                                          … 届ける前の出来事の戻し（delivering → unknown、pending を配り直す）
//   stop(): void
//   onPosted(post, channel): Promise<void>                          … channels.post の後。@ で bot を起こす（ChannelService.hooks.posted）
//   stopThread({ channelId, threadId }, author): Promise<ThreadState> … [止める]（ChannelService.hooks.stopThread）
//   turnExtras(turn): Promise<{ botInstructions: string|null, notes: string[] }>
//       … bot の会話のターンの人格（bots の botInstructions）と末尾（memory.turnContext の notes）。bot の会話でなければ { null, [] }
//   onTurnEvent(turn, event): void                                  … bot の会話の分だけ。text.end・usage・activity・present・permission・turnResult・userMessage.delivered / dropped
//   onTurnEnd(turn, { outcome, text, presents }): Promise<void>     … ターンの投稿を確定し、たまった出来事をまとめて渡す
//   onPermission(card, phase): void                                 … 承認待ちの開始・決着（phase: 'open' | 'settled'）
//   onCompacted(sessionId): Promise<void>                           … bot の会話の圧縮が終わった → snapshotDue = true・delivered = []
export function createDispatcher({ channels, bots, memory, host, emit = () => {}, now = Date.now } = {}) {
  return {
    channels, bots, memory, host, emit, now,
    async start() {},
    stop() {},
    async onPosted() {},
    async stopThread() { throw new Error('dispatch.stopThread is not implemented yet'); },
    async turnExtras() { return { botInstructions: null, notes: [] }; },
    onTurnEvent() {},
    async onTurnEnd() {},
    onPermission() {},
    async onCompacted() {},
  };
}
