// 実行中に承認モードを変えたら、その場から効くか。
// 1件目の承認に答えた直後に auto へ切り替え、2件目以降は聞かれずに進むことを見る。
import path from "node:path";
import fs from "node:fs/promises";

export const name = "livemode";
export const title = "実行中のモード切替が即時に効く";

export default async function (t, ctx) {
  const files = ["live-a.md", "live-b.md", "live-c.md"].map((f) => path.join(ctx.work, f));
  const perms = [];
  let sessionId = null;
  let switched = false;

  const c = await ctx.open({
    onEvent: async (ev, self) => {
      if (ev.type === "session") sessionId = ev.sessionId;
      if (ev.type !== "permission") return;
      perms.push(ev.toolName);
      t.note(`承認要求 ${perms.length} 件目: ${ev.toolName}`);
      await self.cmd("resolvePermission", { id: ev.id, allow: true }).catch(() => {});
      // 1件目に答えたところで auto へ切り替える。以降は聞かれないはず
      if (perms.length === 1 && sessionId && !switched) {
        switched = true;
        const r = await self.cmd("setMode", { sessionId, mode: "auto", reason: "実行中に切替" })
          .catch((err) => ({ err: err.message }));
        t.ok("実行中の切り替えが即時反映される（live=true）", r?.live === true, JSON.stringify(r));
      }
    },
  });

  try {
    for (const f of files) await fs.rm(f, { force: true });

    await c.runTurn({
      prompt:
        `Write ツールで次の3つを順に作って。説明は不要。\n` +
        files.map((f, i) => `${i + 1}. ${f} に "${"abc"[i]}"`).join("\n"),
      sessionId: null, cwd: ctx.work, mode: "default",
    });

    t.ok("最初は承認を聞かれる", perms.length >= 1, `${perms.length} 件`);
    t.ok("切り替え後は聞かれなくなる", perms.length === 1, `承認要求は計 ${perms.length} 件`);

    const made = [];
    for (const f of files) if (await fs.access(f).then(() => true, () => false)) made.push(path.basename(f));
    t.ok("3つとも作られた", made.length === 3, made.join(", ") || "1つも無い");

    const list = await c.cmd("listSessions");
    t.ok("モードがセッションに残る", list.find((s) => s.id === sessionId)?.mode === "auto",
         list.find((s) => s.id === sessionId)?.mode ?? "(なし)");
  } finally {
    c.close();
  }
}
