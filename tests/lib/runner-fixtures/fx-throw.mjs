export const name = "fx-throw";
export const title = "ランナーの試験用: 例外で中断する";
export default async function (t) {
  t.ok("例外の前", true);
  throw new Error("FX-THROW-BOOM");
}
