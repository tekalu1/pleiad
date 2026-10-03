// bot の記憶（S3 が埋める。夜の整理は P3 の core/memory/learn.mjs）。core/ops/memory.mjs の handler は `ctx.memory` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の MemoryEntry、置き場は <data>/memory/（types.mjs の冒頭）。
// P0 は工場の名前と返りの形だけ（振る舞いは空）。
//
// createMemoryService({ dataDir, emit, now }) → MemoryService
//   emit … memoryChanged を出す
//
// MemoryService（author は types.mjs の Author）:
//   start(): Promise<void>・stop(): void
//   list({ layer }): Promise<MemoryEntry[]>                       … layer は 'user' か botId
//   search({ query, layer?, limit }): Promise<MemoryEntry[]>      … 各 150 トークンまで
//   write({ layer, text, why?, sources }, author): Promise<MemoryEntry>   … 出どころの検査（MEMORY_SOURCE・MEMORY_REJECTED）はここ
//   edit({ id, text }, author): Promise<MemoryEntry>・forget({ id }, author): Promise<void>・unforget({ id }, author): Promise<MemoryEntry>
//       … 人も AI も使える（edit は write、forget は guarded）。誰がしたかは log.jsonl の by に残す
//   rev(): number                                                 … log.jsonl の最後の rev
//   turnContext({ bot, session, incomingText, now }): Promise<{ notes: string[], memRev: number, delivered: string[] }>
//       … ターンの末尾の包み（核の写し <pleiad-memory-core> は session.snapshotDue のときだけ、末尾 <pleiad-turn-context> は毎ターン）。
//         notes は core/channels/types.mjs の memoryCoreEnvelope・turnContextEnvelope で包んだ文の並び。dispatch.turnExtras がこれを返す
export function createMemoryService({ dataDir, emit = () => {}, now = Date.now } = {}) {
  const notYet = (name) => async () => { throw new Error(`memory.${name} is not implemented yet`); };
  return {
    dataDir, emit, now,
    async start() {},
    stop() {},
    async list() { return []; },
    async search() { return []; },
    write: notYet('write'), edit: notYet('edit'), forget: notYet('forget'), unforget: notYet('unforget'),
    rev() { return 0; },
    async turnContext() { return { notes: [], memRev: 0, delivered: [] }; },
  };
}
