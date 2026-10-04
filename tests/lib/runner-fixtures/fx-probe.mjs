import fs from "node:fs";
import path from "node:path";
export const name = "fx-probe";
export const title = "ランナーの試験用: 走っているプロセスの環境を記録する";
export default async function (t) {
  const out = process.env.RUNNER_FIXTURE_OUT;
  const probe = {
    pid: process.pid,
    inWorker: typeof process.send === "function",
    data: process.env.AGENT_HOST_DATA ?? null,
    dataExists: !!process.env.AGENT_HOST_DATA && fs.existsSync(process.env.AGENT_HOST_DATA),
    controlToken: process.env.PLEIAD_CONTROL_TOKEN ?? null,
    controlUrl: process.env.PLEIAD_CONTROL_URL ?? null,
    guard: process.env.PLEIAD_TEST_GUARD_HOME ?? null,
    locale: process.env.AGENT_HOST_LOCALE ?? null,
  };
  if (out) fs.writeFileSync(path.join(out, `probe-${process.pid}.json`), JSON.stringify(probe));
  t.ok("記録した", !!out);
}
