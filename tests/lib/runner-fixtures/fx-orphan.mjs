import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
export const name = "fx-orphan";
export const title = "ランナーの試験用: 長生きの子プロセスを 3 本起こしたまま、worker が途中で死ぬ（孫の回収。worker の出力を掴んだままのもの・detached のものを含む）";
export default async function (t) {
  const sleeper = ["-e", "setInterval(() => {}, 1000)"];
  const plain = spawn(process.execPath, sleeper, { stdio: "ignore" });
  // worker の stdout/stderr を掴んだまま居座る孫（掴んでいると、親から見た worker の close が来ない）
  const holder = spawn(process.execPath, sleeper, { stdio: ["ignore", "inherit", "inherit"] });
  // detached の孫（実際のサーバーが detached で起こす子に当たる。Windows は親子の鎖で辿れる。POSIX はグループを抜けるので回収の範囲外）
  const detached = spawn(process.execPath, sleeper, { stdio: "ignore", detached: true });
  detached.unref();
  fs.writeFileSync(path.join(process.env.RUNNER_FIXTURE_OUT, `child-${name}.json`), JSON.stringify({ worker: process.pid, plain: plain.pid, holder: holder.pid, detached: detached.pid }));
  t.ok("子を起こした", !!plain.pid && !!holder.pid && !!detached.pid);
  process.exit(9);
}
