// モデル選択。指定したモデルが実際にそのターンで使われるか
// （session イベントに乗る「実際に解決されたモデル」で確かめる）。

export const name = "model";
export const title = "モデル選択";

export default async function (t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    const models = await c.cmd("models");
    t.ok("models が返る", Object.keys(models).length >= 3,
         Object.keys(models).map((k) => k || "(既定)").join(", "));

    await c.cmd("setModel", { sessionId: "x", model: "gpt-4" }).then(
      () => t.ok("知らないモデルを断る", false, "通ってしまった"),
      (e) => t.ok("知らないモデルを断る", true, e.message),
    );

    let last = null;
    for (const want of ["haiku", "sonnet"]) {
      last = await c.runTurn({
        prompt: "Reply with exactly: OK",
        sessionId: null, cwd: ctx.work, model: want, mode: "default",
      });
      t.ok(`model=${want} が実際に使われる`, String(last.initModel).includes(want),
           `解決されたモデル=${last.initModel}`);
    }

    if (last?.sessionId) {
      await c.cmd("setModel", { sessionId: last.sessionId, model: "opus" });
      const list = await c.cmd("listSessions");
      const me = list.find((s) => s.id === last.sessionId);
      t.ok("モデルがセッションに覚えられる", me?.model === "opus", me?.model ?? "(なし)");
    } else {
      t.ok("モデルがセッションに覚えられる", false, "sessionId が取れなかった");
    }
  } finally {
    c.close();
  }
}
