// 承認モード。default では聞かれ、auto では聞かれずに実行され、選んだモードが覚えられること。
import path from "node:path";
import fs from "node:fs/promises";

export const name = "mode";
export const title = "承認モードの切り替え";

export default async function (t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    const modes = await c.cmd("modes");
    t.ok("modes が返る", Object.keys(modes).length >= 3, Object.keys(modes).join(", "));
    t.ok("bypassPermissions は出さない", !("bypassPermissions" in modes));

    await c.cmd("setMode", { sessionId: "x", mode: "でたらめ" }).then(
      () => t.ok("知らないモードを断る", false, "通ってしまった"),
      (e) => t.ok("知らないモードを断る", true, e.message),
    );

    const write = (file, mode) =>
      c.runTurn({
        prompt: `Write ツールで ${path.join(ctx.work, file)} に "x" と1行書いて。説明不要。`,
        sessionId: null, cwd: ctx.work, mode,
      });

    const a = await write("mode-default.md", "default");
    t.ok("default では承認を聞かれる", a.permissions.length > 0,
         `permission ${a.permissions.length} 回 / tools: ${a.tools.join(",")}`);

    const b = await write("mode-auto.md", "auto");
    t.ok("auto では聞かれずに実行される", b.permissions.length === 0 && b.tools.includes("Write"),
         `permission ${b.permissions.length} 回 / tools: ${b.tools.join(",")}`);
    t.ok("auto でもファイルは作られる",
         await fs.access(path.join(ctx.work, "mode-auto.md")).then(() => true, () => false));

    if (b.sessionId) {
      await c.cmd("setMode", { sessionId: b.sessionId, mode: "acceptEdits" });
      const list = await c.cmd("listSessions");
      const me = list.find((s) => s.id === b.sessionId);
      t.ok("モードが一覧に出る", me?.mode === "acceptEdits", me?.mode ?? "(なし)");
    } else {
      t.ok("モードが一覧に出る", false, "sessionId が取れなかった");
    }
  } finally {
    c.close();
  }
}
