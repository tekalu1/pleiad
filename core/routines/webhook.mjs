// webhook の受け口 `POST /hooks/<hookId>`（P3 の H1 が埋める。ADR 0100）。core/server.mjs は認証の前でこれを呼ぶ（botHost.handleHttp）。
// P0 は工場の名前と返りの形だけ。どの要求も取らない（false を返す）ので、サーバーは今までどおり後ろの処理へ進む。
//
// createWebhookReceiver({ dataDir, routines, host, now }) → WebhookReceiver
//   handle(req, res): Promise<boolean>   … 自分の要求（/hooks/ で始まる）なら応答して true、そうでなければ何もせず false
export function createWebhookReceiver({ dataDir, routines, host, now = Date.now } = {}) {
  return {
    dataDir, routines, host, now,
    async handle() { return false; },
  };
}
