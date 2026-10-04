import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const name = "fx-hang";
export const title = "ランナーの試験用: 子プロセスを起こして長く待つ（親のランナーが外から止められたとき、worker と孫が残らない）";
export default async function (t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(process.env.RUNNER_FIXTURE_OUT, `child-${name}.json`), JSON.stringify({ worker: process.pid, child: child.pid }));
  await new Promise((r) => setTimeout(r, 120_000));
  t.ok("ここへは来ない", false);
}
