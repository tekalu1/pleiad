export const name = "fx-fail";
export const title = "ランナーの試験用: 落ちる判定が混ざる";
export default async function (t) {
  t.ok("通る", true);
  t.ok("落ちる判定", false, "詳細 FAIL-DETAIL-1\n二行目");
}
