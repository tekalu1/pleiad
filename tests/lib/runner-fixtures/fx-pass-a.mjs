export const name = "fx-pass-a";
export const title = "ランナーの試験用: 通る suite（短い）";
export default async function (t) {
  await new Promise((r) => setTimeout(r, 50));
  t.ok("通る 1", true, "詳細 a1");
  t.ok("通る 2", true);
}
