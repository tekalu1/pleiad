// 翻訳漏れの lint（tests/lint-i18n.mjs）。直書きの日本語が基準より増えていない・減ったら基準を下げている・
// 辞書のキー・複数形・差し込みが全言語で揃う・未訳が無い・使うキーが有り使わないキーが無いことを見る。
// lint 自身の自己診断も一緒に回す（lint が壊れて何も検出しなくなった、を見逃さないため）。
import { lintRepo, selftest } from "../lint-i18n.mjs";

export const name = "i18n-lint";
export const title = "翻訳漏れが無い（直書きの日本語が基準より増えていない・辞書が揃っている）";

export default function (t) {
  const lines = [];
  t.ok("lint の自己診断が通る", selftest((l) => lines.push(l)) === 0, lines.filter((l) => l.startsWith("FAIL")).join(" / "));

  const { problems, total } = lintRepo();
  const byRule = {};
  for (const p of problems) byRule[p.rule] = (byRule[p.rule] ?? 0) + 1;
  for (const p of problems.slice(0, 30)) {
    t.note(`${p.file}${p.line ? ":" + p.line : ""}  [${p.rule}]  ${p.message}`);
    for (const w of (p.where ?? []).slice(0, 10)) t.note(`    ${w}`);
  }
  if (problems.length > 30) t.note(`…あと ${problems.length - 30} 件（node tests/lint-i18n.mjs で全部）`);
  t.ok("翻訳漏れの問題が 0 件", problems.length === 0,
       problems.length ? Object.entries(byRule).map(([r, n]) => `${r}: ${n}`).join(", ") : `直書きの日本語は基準どおり ${total} 件`);
}
