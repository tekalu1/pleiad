import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHostShell } from "../../../core/host-shell.mjs";
export const name = "fx-shell";
export const title = "ランナーの試験用: 実際のホストのシェル（core/host-shell.mjs。POSIX は detached）で孫を起こしたまま、worker が途中で死ぬ";
export default async function (t) {
  const here = path.dirname(fileURLToPath(import.meta.url)).replaceAll("\\", "/");
  const file = path.join(process.env.RUNNER_FIXTURE_OUT, "child-fx-shell.json");
  runHostShell({ command: `node "${here}/fx-shell-child.mjs"`, cwd: here, timeoutMs: 120_000 }).catch(() => {});
  const end = Date.now() + 15_000;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  t.ok("シェルの孫が起きた", fs.existsSync(file));
  process.exit(9);
}
