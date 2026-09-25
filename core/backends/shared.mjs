// バックエンドが共通で使う小さな定数と道具。SDK にもネットワークにも依存しない。

// ツールの結果は数百 KB になることがある。表示に要るのは行数・件数・成否と先頭だけなので
// （web/render.mjs の applyToolResult は全文を出さない）、**履歴に残す時点で**切っておく。
// ライブのイベントは切らない（v1 が生の SDK メッセージを素通ししていたのと同じ見た目にする）。
export const MAX_RESULT_CHARS = 2000;

/** capabilities の既定。バックエンドは持てるものだけ true にする。 */
export const NO_CAPABILITIES = {
  title: false,
  tag: false,
  fork: false,
  subagents: false,
  liveModel: false,
  liveMode: false,
  hostTools: false,
  // ply_agents（委譲の橋）を受け取れるか。受け取れる会話にだけ Pleiad が委譲の指示を入れる（core/added-context.mjs）
  plyAgents: false,
  alwaysAllow: false,
  login: false,
};
