export const name = "fx-exit";
export const title = "ランナーの試験用: プロセスが勝手に終わる（worker の異常終了。--jobs 2 以上でだけ登録する）";
export default async function (t) {
  t.ok("終わる前", true);
  console.log("FX-EXIT-LAST-WORDS");
  process.exit(7);
}
