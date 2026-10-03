// ルーティン（P2 の R1。ADR 0111。sessions.send は core/ops/conversations.mjs（ADR 0104）。bot の検査は P3 の X1 が足す。ADR 0113）の操作（`routines.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// 持ち主のパッケージが defineOp を足す。id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。
// handler は `ctx.routines`（core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。
export const routineOps = [];
