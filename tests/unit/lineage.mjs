// 系譜（core/lineage.mjs）。一覧の行だけから根と家族を集める。
//
// parent は sidecar にもバックエンド（codex の forkedFromId）にもあるが、
// ここに渡るのは両方を合わせた一覧の行なので、どちらで分けたかは区別しない。
import { familyOf } from "../../core/lineage.mjs";

export const name = "lineage";
export const title = "系譜が一覧の行から根と家族を集める";

const row = (id, parent) => ({ id, parent: parent ? { sessionId: parent, atMessage: null } : null });

export default async function (t) {
  //   root ─ a ─ a1
  //        └ b
  //   other（別の家族）
  const rows = [row("root"), row("a", "root"), row("b", "root"), row("a1", "a"), row("other"), row("x", "other")];

  const fromLeaf = familyOf(rows, "a1");
  t.ok("葉から引いても根に着く", fromLeaf.rootId === "root", fromLeaf.rootId);
  t.ok("家族が全部入る", [...fromLeaf.ids].sort().join(",") === "a,a1,b,root", fromLeaf.ids.join(","));
  t.ok("別の家族は入らない", !fromLeaf.ids.includes("other") && !fromLeaf.ids.includes("x"));
  t.ok("根から引いても同じ家族", familyOf(rows, "root").ids.join(",") === fromLeaf.ids.join(","));
  t.ok("幅優先で、根の次に子", fromLeaf.ids[0] === "root" && fromLeaf.ids.indexOf("a1") > fromLeaf.ids.indexOf("b"));

  // バックエンドがネイティブに持つ親（codex の forkedFromId）も一覧の行では同じ parent。
  // sidecar に無くても辿れる
  const native = [row("t1"), { id: "t2", parent: { sessionId: "t1", atMessage: null } }];
  t.ok("ネイティブな親でも家族になる", familyOf(native, "t2").ids.join(",") === "t1,t2");

  // 壊れた parent。止まること、落ちないこと
  const loop = [row("p", "q"), row("q", "p")];
  const l = familyOf(loop, "p");
  t.ok("循環でも止まる", l.ids.length === 2, l.ids.join(","));
  const self = [row("s", "s")];
  t.ok("自己参照は根として扱う", familyOf(self, "s").rootId === "s" && familyOf(self, "s").ids.length === 1);
  t.ok("親が一覧に無ければ自分が根", familyOf([row("orphan", "gone")], "orphan").rootId === "orphan");
  t.ok("一覧に無い起点でも自分だけの家族", familyOf(rows, "unknown").ids.join(",") === "unknown");
}
