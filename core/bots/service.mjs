// bot の定義の保存と操作（S2 が埋める）。core/ops/bots.mjs の handler は `ctx.bots` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の Bot。bot の会話を作る部分は core/bots/sessions.mjs（S2。createBotSession・botInstructions）。
// P0 は工場の名前と返りの形だけ（振る舞いは空）。
//
// createBotService({ dataDir, channels, emit, now }) → BotService
//   dataDir … <data>（bots.json はここ）
//   channels … ChannelService（bot を作ると DM のチャンネルを作る）
//   emit    … botsChanged を出す
//
// BotService（author は types.mjs の Author）:
//   start(): Promise<void>・stop(): void
//   list(): Promise<Bot[]>・get({ botId }): Promise<Bot|null>
//   byName(name): Promise<Bot|null>               … @ の解析（core/channels/mentions.mjs）が使う。名前はチャンネルを通して一意（NFKC・大小を区別しない）
//   create({ name, icon, persona, backend, model?, effort? }, author): Promise<Bot>
//   update({ botId, name?, icon?, persona?, backend?, model?, effort?, folders?, sendToOthers?, sendTargets? }, author): Promise<Bot>   … フォルダー・送る先を広げる向きは ops が guarded にする（riskOf）
//   setMode({ botId, mode }, author): Promise<Bot>                 … 承認モード。human-only の操作から（Antigravity は 'yolo' だけ）
//   remove({ botId }, author): Promise<void>
//   usage({ botId }): Promise<{ weekTokens: number, cacheRatio: number|null }>   … usage.json の記録を sessionId で引く
export function createBotService({ dataDir, channels, emit = () => {}, now = Date.now } = {}) {
  const notYet = (name) => async () => { throw new Error(`bots.${name} is not implemented yet`); };
  return {
    dataDir, channels, emit, now,
    async start() {},
    stop() {},
    async list() { return []; },
    async get() { return null; },
    async byName() { return null; },
    create: notYet('create'), update: notYet('update'), setMode: notYet('setMode'), remove: notYet('remove'),
    async usage() { return { weekTokens: 0, cacheRatio: null }; },
  };
}
