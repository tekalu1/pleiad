import fs from "node:fs";
import path from "node:path";
export const name = "fx-flaky";
export const title = "ランナーの試験用: 1 回目だけ落ちる（RUNNER_FIXTURE_OUT の flaky-attempts に 1 回ごとに 1 行足す）";
export default async function (t) {
  const file = path.join(process.env.RUNNER_FIXTURE_OUT, "flaky-attempts");
  fs.appendFileSync(file, "x\n");
  const attempt = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  t.ok("1 回目だけ落ちる判定", attempt > 1, `FLAKY-FIRST-ATTEMPT 試行 ${attempt} 回目`);
  t.ok("いつも通る判定", true);
}
