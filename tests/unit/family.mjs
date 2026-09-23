// 脇の一覧で fork した会話をグループにまとめる（web/family.mjs）。ブラウザは要らない。
//
// core/lineage.mjs との違いは「見えている行だけで組む」こと。絞り込みで親が消えても
// 枝が迷子にならず、近い祖先に付く。見た目は tests/unit/design-lint.mjs の担当。
import { familiesOf } from "../../web/family.mjs";

export const name = "family";
export const title = "一覧の行をグループ（根と子孫）にまとめる";

const row = (id, parent) => ({ id, parent: parent ? { sessionId: parent, atMessage: null } : null });
const shape = (fams) => fams.map((f) => `${f.root.id}[${f.kin.map((k) => k.id).join(" ")}]`).join(" ");

export default function (t) {
  //   root ─ a ─ a1
  //        └ b
  //   solo（枝なし）
  const rows = [row("root"), row("a", "root"), row("b", "root"), row("a1", "a"), row("solo")];
  const fams = familiesOf(rows);
  t.ok("根ごとにひとつの器", shape(fams) === "root[a b a1] solo[]", shape(fams));
  t.ok("枝の枝も同じ器に平らに入る", fams[0].kin.map((k) => k.id).includes("a1"));
  t.ok("枝は器の中にしか出ない（根としては出ない）", fams.length === 2, shape(fams));
  t.ok("根は kin に入らない", !fams[0].kin.some((k) => k.id === "root"));
  t.ok("枝なしの会話は kin が空（器にしない目印）", fams[1].kin.length === 0);

  // 入力の順をそのまま保つ。並べ替えは呼び出し側（放置が先、あとは新しい順）の仕事
  const order = familiesOf([row("solo"), row("root"), row("b", "root"), row("a", "root")]);
  t.ok("根は見えた順", shape(order) === "solo[] root[b a]", shape(order));

  // ---- 絞り込みで親が消えたとき ----
  const all = rows;
  const noParent = familiesOf([row("a", "root"), row("a1", "a")], all);
  t.ok("親が見えなければ、見えている一番上が根になる", shape(noParent) === "a[a1]", shape(noParent));
  const onlyLeaf = familiesOf([row("a1", "a")], all);
  t.ok("祖先が一人も見えなければ自分が根", shape(onlyLeaf) === "a1[]", shape(onlyLeaf));
  const skip = familiesOf([row("root"), row("a1", "a")], all);
  t.ok("間の親が消えていれば近い祖先に付く", shape(skip) === "root[a1]", shape(skip));

  // ---- 状態と「外した印」。グループは持ち物ではなく、この 2 つと親子で決まる ----
  const st = (id, parent, status, ungrouped = false) => ({ ...row(id, parent), status, ungrouped });
  const mixed = [st("R", null, "進行中"), st("a", "R", "進行中"), st("b", "R", "レビュー待ち")];
  t.ok("状態が違う枝は入らず、自分が根になる", shape(familiesOf(mixed)) === "R[a] b[]", shape(familiesOf(mixed)));

  // R(進行中) ─ b(レビュー待ち) ─ b1(進行中)。間が違う状態でも、その先は根に付く
  const skipStatus = [...mixed, st("b1", "b", "進行中")];
  t.ok("間の枝の状態が違っても、その先の子孫は根に付く", shape(familiesOf(skipStatus)) === "R[a b1] b[]", shape(familiesOf(skipStatus)));

  const detached = [st("R", null, "進行中"), st("a", "R", "進行中", true), st("c", "R", "進行中")];
  t.ok("外した枝は入らない", shape(familiesOf(detached)) === "R[c] a[]", shape(familiesOf(detached)));

  const off = [st("R", null, "進行中", true), st("a", "R", "進行中"), st("a1", "a", "進行中")];
  t.ok("根を外すと、その下だけでまとまる（解除は全員に印を付ける）", shape(familiesOf(off)) === "R[] a[a1]", shape(familiesOf(off)));
  const allOff = off.map((r) => ({ ...r, ungrouped: true }));
  t.ok("全員に印が付いていれば、器はひとつもできない", shape(familiesOf(allOff)) === "R[] a[] a1[]", shape(familiesOf(allOff)));

  // 状態が揃えば、印を消すだけで戻る（「戻すときは状態を根に合わせる」の裏返し）
  const back = detached.map((r) => (r.id === "a" ? { ...r, ungrouped: false } : r));
  t.ok("印を消すと戻る", shape(familiesOf(back)) === "R[a c]", shape(familiesOf(back)));

  // ---- 壊れた親。行を落とさないこと ----
  const orphan = familiesOf([row("x", "gone")]);
  t.ok("一覧に無い親なら自分が根", shape(orphan) === "x[]", shape(orphan));
  const self = familiesOf([row("s", "s")]);
  t.ok("自己参照は根として扱う", shape(self) === "s[]", shape(self));
  const loop = familiesOf([row("p", "q"), row("q", "p")]);
  t.ok("循環でも行が消えない", loop.flatMap((f) => [f.root.id, ...f.kin.map((k) => k.id)]).sort().join() === "p,q", shape(loop));
  const deep = [];
  for (let i = 0; i < 300; i++) deep.push(row(`n${i}`, i ? `n${i - 1}` : null));
  const long = familiesOf(deep);
  t.ok("長い連鎖でも全部ひとつの器に入る", long.length === 1 && long[0].kin.length === 299, String(long.length));
}
