// ルーティン（P2 の R1。ADR 0097。sessions.send は P3 の X1 が core/ops/sessions.mjs に足す）の操作（`routines.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// 持ち主のパッケージが defineOp を足す。id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。
// handler は `ctx.routines`（core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。
export const routineOps = [];
