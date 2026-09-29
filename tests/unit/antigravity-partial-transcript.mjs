// antigravity の控えは、ターンの終わりを待たずに途中から書く（core/backends/antigravity.mjs の runTurn）。
// 途中の書き込み・失敗／中断／途中で落ちたターンで残ること・uuid が変わらず二重にならないこと・
// forget した控えを作り直さないこと・書き込みが 1 本ずつであることを、偽の agy（tests/lib/fake-agy.mjs）で見る。
// バックエンドを読み込むと置き場の掃除が走るので、置き場を分けた別プロセス（tests/lib/agy-partial-worker.mjs）で回す
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "../lib/server.mjs";

export const name = "antigravity-partial-transcript";
export const title = "antigravity の控えをターンの途中から書き、失敗・中断でも残す";

export default async function (t) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, "tests/lib/agy-partial-worker.mjs")], { timeout: 120_000 });
  let checks = [];
  try { checks = JSON.parse(stdout); } catch { t.ok("worker の結果が読める", false, stdout.slice(0, 500)); return; }
  t.ok("worker の判定が揃う", checks.length >= 15, `${checks.length} 件`);
  for (const c of checks) t.ok(c.label, c.pass, c.detail);
}
