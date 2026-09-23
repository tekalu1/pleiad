// デザインの lint。「薄い地 + 同系の濃い文字」の札・枠線・片側の線を機械的に落とす。
//
// 規則と閾値の理由は docs/design-system.md §5。ここは web/ の CSS と index.html を
// --strict 相当で検査し、1 件でも違反があれば落とす。lint 自身の自己診断も一緒に回す
// （lint が壊れて何も検出しなくなった、を見逃さないため）。
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lint, selftest, readFiles } from "../lint-design.mjs";

export const name = "design-lint";
export const title = "web/ の CSS がデザインの規則を守っている";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = (f) => path.join(ROOT, "web", f);

// トークンを先頭に置く。定義は渡した全ファイルから集めるので順序は判定に効かないが、
// 違反の並びが「トークン → 各 CSS → index.html」になって読みやすい
const FILES = ["tokens.css", "style.css", "tools.css", "tree.css", "context.css", "manage-panel.css", "updates.css", "usage.css", "file-preview.css", "index.html"].map(WEB);

export default function (t) {
  const lines = [];
  t.ok("lint の自己診断が通る", selftest((l) => lines.push(l)) === 0, lines.filter((l) => l.startsWith("FAIL")).join(" / "));

  // 名前を変えたり分けたりしたときに、無いファイルを黙って検査済みにしない
  const missing = FILES.filter((f) => !existsSync(f));
  t.ok("検査対象のファイルが全部ある", missing.length === 0, missing.map((f) => path.relative(ROOT, f)).join(", "));
  if (missing.length) return;

  const V = lint(readFiles(FILES), { strict: true });
  const byRule = {};
  for (const v of V) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  for (const v of V.slice(0, 30)) t.note(`${path.relative(ROOT, v.file)}:${v.line}  [${v.rule}]  ${v.message}`);
  if (V.length > 30) t.note(`…あと ${V.length - 30} 件`);
  t.ok("--strict で違反が 0 件", V.length === 0,
       V.length ? Object.entries(byRule).map(([r, n]) => `${r}: ${n}`).join(", ") : "なし");
}
