// 既定の引き継ぎ。一度選んだ承認モードが、次に新しく始めるときの既定になること。
// （画面の取り違えが起きないかどうかは LLM を要らないので tests/unit/stream-routing.mjs へ）
import path from "node:path";
import fs from "node:fs/promises";

export const name = "prefs";
export const title = "選んだ既定が次の新規セッションに引き継がれる";

export default async function (t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  let before = null;
  try {
    before = await c.cmd("prefs");
    await c.cmd("setPref", { key: "mode", value: "auto" });
    t.ok("既定を保存できる", (await c.cmd("prefs")).mode === "auto");

    await c.cmd("setPref", { key: "mode", value: "でたらめ" }).then(
      () => t.ok("知らないモードは既定にできない", false, "通ってしまった"),
      (e) => t.ok("知らないモードは既定にできない", true, e.message),
    );

    // mode を指定せずに新規セッションを走らせ、auto が使われるか（＝承認を聞かれない）
    const out = path.join(ctx.work, "pref-out.md");
    await fs.rm(out, { force: true });
    const turn = await c.runTurn({
      prompt: `Write ツールで ${out} に "x" と1行書いて。説明不要。`,
      sessionId: null, cwd: ctx.work,
    });
    t.ok("mode 未指定の新規セッションが既定(auto)で動く", turn.permissions.length === 0,
         `承認要求 ${turn.permissions.length} 件`);
    t.ok("実際に書けている", await fs.access(out).then(() => true, () => false));

    const list = await c.cmd("listSessions");
    const me = list.find((s) => s.id === turn.sessionId);
    t.ok("セッションにも auto が記録される", me?.mode === "auto", me?.mode ?? "(なし)");
  } finally {
    // 既定は必ず戻す
    if (before) await c.cmd("setPref", { key: "mode", value: before.mode ?? "default" }).catch(() => {});
    c.close();
  }
}
