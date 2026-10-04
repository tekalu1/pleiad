export const name = "fx-kill";
export const title = "ランナーの試験用: プロセスが殺される（--jobs 2 以上でだけ登録する）";
export default async function (t) {
  t.ok("殺される前", true);
  process.kill(process.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 5000));
}
