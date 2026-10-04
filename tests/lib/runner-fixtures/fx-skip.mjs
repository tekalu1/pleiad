export const name = "fx-skip";
export const title = "ランナーの試験用: とばす";
export default async function (t) {
  t.skip("前提が無い（試験用）");
}
