export const name = "codex-title";
export const title = "Codex generates a title without a persistent conversation";
export const serverEnv = { AGENT_HOST_BACKENDS: "codex" };

export default async function (t, ctx) {
  const { backend } = await import("../../core/backends/codex.mjs");
  const { rpc } = await import("../../core/backends/codex-rpc.mjs");
  try {
    const text = await backend.suggestTitle({ transcript: "依頼: 新規セッションで前回選んだモデルと承認モードを保持する。応答: 設定の保存と復元を修正しました。" });
    t.ok("Short Japanese title returned", Boolean(text.trim()) && text.trim().length <= 60, text);
  } finally { rpc.stop(); }
  const c = await ctx.open();
  try {
    const { sessionId } = await c.cmd("newSession", { backend: "codex", cwd: ctx.work, mode: "readonly" });
    await c.runTurn({ sessionId, prompt: "タイトル動作確認です。ツールを使わず「確認しました」とだけ返してください。" }, { ms: 120_000 });
    const row = (await c.cmd("listSessions")).find(s => s.id === sessionId);
    t.ok("Preallocated Codex conversation gets its initial title", Boolean(row?.title) && row.title !== "新しいセッション" && row.title !== "(no title)", row?.title);
  } finally { c.close(); }
}
