export const name = "fx-heavy";
export const title = "ランナーの試験用: 重い suite（待つ）";
export default async function (t) {
  await new Promise((r) => setTimeout(r, 700));
  t.ok("待ち終わった", true);
}
