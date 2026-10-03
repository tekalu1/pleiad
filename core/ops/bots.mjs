// bot の定義（S2。ADR 0096）の操作（`bots.*`）。操作の一覧の正本（docs/design.md「操作の一覧」）。
// 持ち主のパッケージが defineOp を足す。id・危険度・口・引数と返りの形の契約は docs/channels.md「操作」。
// handler は `ctx.bots`（core/bots-host.mjs の BotHost.opsDeps）を呼ぶ。直のツール（mcp: 'direct'）は足さない（tests/unit/ops-surface.mjs の T4）。
export const botOps = [];
