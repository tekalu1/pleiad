// グループ（状態）の改名・削除。
//
// 状態は事前定義しないので「グループ」は実体を持たず、付いているセッションの集合でしかない。
// だから改名も削除も、付いている側が正しく書き換わるかでしか確かめられない。
//
// 検証には既存のセッションを借りる。**状態が付いていないもの**を優先して借り、
// 終わったら状態を外す。こうすると後片付けが「元に戻す」ではなく「消す」で済み、
// 途中で落ちても手元の状態を壊しにくい。

export const name = "groups";
export const title = "状態グループの改名と削除";

const TMP = "検証用グループ";
const TMP2 = "検証用グループ2";   // 全角括弧は SDK 側で半角に正規化されるので使わない

export default async function (t, ctx) {
  const c = await ctx.open();
  const borrowed = [];
  try {
    const list0 = await c.cmd("listSessions");
    if (!list0.length) return t.skip("~/.claude にセッションが1件も無い");

    // 状態なしを優先。足りなければ状態つきも借りて、最後に元へ戻す
    const free = list0.filter((s) => !s.status).slice(0, 3);
    const rest = list0.filter((s) => s.status).slice(0, 3 - free.length);
    for (const s of [...free, ...rest]) borrowed.push({ id: s.id, was: s.status ?? null });
    if (!borrowed.length) return t.skip("借りられるセッションが無い");
    t.note(`${borrowed.length} 件を借りる（うち状態つき ${rest.length} 件）`);

    for (const b of borrowed) await c.cmd("setStatus", { sessionId: b.id, status: TMP, reason: "検証" });
    let list = await c.cmd("listSessions");
    t.ok("グループを作れる", list.filter((s) => s.status === TMP).length === borrowed.length,
         `${list.filter((s) => s.status === TMP).length} 件`);

    const r1 = await c.cmd("renameStatus", { from: TMP, to: TMP2 });
    list = await c.cmd("listSessions");
    t.ok("グループ名を変えると全員に反映される",
         list.filter((s) => s.status === TMP2).length === borrowed.length &&
         list.filter((s) => s.status === TMP).length === 0,
         `moved=${r1.moved}`);

    // 削除（= 状態なしへ）
    const r2 = await c.cmd("renameStatus", { from: TMP2, to: "" });
    list = await c.cmd("listSessions");
    t.ok("グループを消すと状態が外れる", list.filter((s) => s.status === TMP2).length === 0, `moved=${r2.moved}`);
    t.ok("セッション自体は消えない", borrowed.every((b) => list.some((s) => s.id === b.id)),
         `${borrowed.length} 件とも残っている`);

    const one = await c.cmd("loadSession", { sessionId: borrowed[0].id }).catch(() => null);
    t.ok("loadSession は壊れない", Boolean(one), `${one?.messages?.length ?? 0} メッセージ`);

    await c.cmd("renameStatus", { from: "", to: "x" }).then(
      () => t.ok("改名元が空なら断る", false, "通ってしまった"),
      (e) => t.ok("改名元が空なら断る", true, e.message),
    );
  } finally {
    // 借りたものは必ず返す。途中で落ちてもここは通る
    for (const b of borrowed) {
      await c.cmd("setStatus", { sessionId: b.id, status: b.was, reason: "検証の後片付け" }).catch(() => {});
    }
    const back = borrowed.length ? await c.cmd("listSessions").catch(() => []) : [];
    if (back.length) {
      t.ok("借りたセッションを元に戻せた",
           borrowed.every((b) => (back.find((s) => s.id === b.id)?.status ?? null) === b.was));
    }
    c.close();
  }
}
