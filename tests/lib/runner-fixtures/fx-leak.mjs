import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const name = "fx-leak";
export const title = "ランナーの試験用: 長生きの子プロセスを起こしたまま、suite は普通に終わる（残りものの回収）";
export default async function (t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.unref();
  fs.writeFileSync(path.join(process.env.RUNNER_FIXTURE_OUT, `child-${name}.json`), JSON.stringify({ worker: process.pid, child: child.pid }));
  t.ok("子を起こした", !!child.pid);
}
