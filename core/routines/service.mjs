// ルーティン（P2 の R1 が埋める）。core/ops/routines.mjs の handler は `ctx.routines` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の Routine。式・スケジュール・取りこぼし・イベントのトリガは core/routines/{cron,schedule,runner,events}.mjs（R1）。
// P0 は工場の名前と返りの形だけ（振る舞いは空）。
//
// createRoutineService({ dataDir, channels, bots, dispatch, host, emit, now }) → RoutineService
//   emit … routinesChanged を出す
//
// RoutineService（author は types.mjs の Author）:
//   start(): Promise<void>                                          … 有効なルーティンの予約・起動時の取りこぼし（最新の 1 回だけ）
//   stop(): void
//   list(): Promise<(Routine & { nextAt: number|null })[]>・get({ routineId }): Promise<Routine|null>
//   create(input, author) / update({ routineId, ...patch }, author) / pause / resume / remove({ routineId }, author): Promise<Routine>
//   run({ routineId, dryRun? }, author): Promise<{ postId: string|null, runId: string }>
//   rotateSecret({ routineId }): Promise<{ secret: string }>        … P3。1 度だけ表示
//   onPermission(card, phase): void                                 … 承認待ちの期限（approvalTimeoutMin）・イベントのトリガ「あなた待ち」
//   onSessionDone(sessionId, outcome): void                         … イベントのトリガ「完了・失敗」。bot・ルーティン・学習の会話から来たものは対象にしない
export function createRoutineService({ dataDir, channels, bots, dispatch, host, emit = () => {}, now = Date.now } = {}) {
  const notYet = (name) => async () => { throw new Error(`routines.${name} is not implemented yet`); };
  return {
    dataDir, channels, bots, dispatch, host, emit, now,
    async start() {},
    stop() {},
    async list() { return []; },
    async get() { return null; },
    create: notYet('create'), update: notYet('update'), pause: notYet('pause'), resume: notYet('resume'), remove: notYet('remove'),
    run: notYet('run'), rotateSecret: notYet('rotateSecret'),
    onPermission() {},
    onSessionDone() {},
  };
}
