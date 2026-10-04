// fx-shell.mjs が core/host-shell.mjs 経由（POSIX は detached のシェル）で起こす、長生きの孫。自分の pid を書いて居座る。
import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(path.join(process.env.RUNNER_FIXTURE_OUT, "child-fx-shell.json"), JSON.stringify({ child: process.pid }));
setInterval(() => {}, 1000);
