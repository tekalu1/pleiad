// tests/run.mjs --retry-failed の部品: 何を流し直すか・流し直した結果の書き方・GitHub Actions への出し方。
//
// 流し直すのは「判定が落ちた / 例外で中断した」suite だけ（1 回だけ・新しい worker で）。
// 流し直さない（失敗のまま）: ランナーの整合の失敗（worker の異常終了・起動できず走らなかった・登録した名前と export の不一致・worktree の漏れ）。
// 理由と範囲は docs/adr/0162-ci-retry-failed-suites.md。
import fs from "node:fs";

/** 走らせ直さない失敗の判定名（ランナー自身が足す整合の検査。suite の中身の揺れではない） */
const INTEGRITY_LABELS = ["登録した名前と export const name が一致する", "worktree が増えていない"];

const oneLine = (text, n = 200) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const firstLine = (e) => String(e?.stack ?? e ?? "").split("\n")[0];

/** 1 回目の記録 { entry, suite, status? } が、流し直す対象か */
export function isRetryable(record) {
  if (record.status === "crash" || record.status === "missing") return false;
  const s = record.suite;
  if (!(s.error != null || s.failures.length > 0)) return false;
  return !s.failures.some((f) => INTEGRITY_LABELS.some((l) => String(f.label).includes(l)));
}

/** 落ちた suite の一行の説明（最初に落ちた判定。判定が無く例外なら例外の 1 行目） */
export function describeFailure(suite) {
  const f = suite.failures[0];
  if (f) {
    const more = suite.failures.length > 1 ? `（ほか ${suite.failures.length - 1} 判定）` : "";
    return `${f.label}${f.detail ? ` — ${oneLine(f.detail)}` : ""}${more}`;
  }
  return `例外 — ${oneLine(firstLine(suite.error))}`;
}

/** 流し直した 1 本の記録。timings の suites[].retried にそのまま入る */
export function buildRetryEntry({ name, first, second }) {
  const passed = !second.failed;
  return {
    name,
    outcome: passed ? "passed" : "failed",
    first: { failedJudgements: first.failures.length, error: first.error == null ? null : oneLine(firstLine(first.error)), description: describeFailure(first), ms: first.ms ?? 0 },
    second: passed ? null : { failedJudgements: second.failures.length, error: second.error == null ? null : oneLine(firstLine(second.error)), description: describeFailure(second), ms: second.ms ?? 0 },
  };
}

/** 端末に出す、流し直しのまとめ（流し直しが無ければ空） */
export function retryLines(retried) {
  if (!retried.length) return [];
  const passed = retried.filter((r) => r.outcome === "passed");
  const failed = retried.filter((r) => r.outcome === "failed");
  const lines = [];
  if (passed.length) {
    lines.push(`  流し直しで通った suite（1 回目は落ちた。緑として扱う）: ${passed.length} 本`);
    for (const r of passed) lines.push(`    - ${r.name} — 1 回目: ${r.first.description}`);
  }
  if (failed.length) {
    lines.push(`  流し直しでも落ちた suite: ${failed.length} 本`);
    for (const r of failed) lines.push(`    - ${r.name} — 1 回目: ${r.first.description} / 2 回目: ${r.second.description}`);
  }
  return lines;
}

// GitHub Actions のワークフローコマンドの文字の escape（actions/toolkit の command.ts と同じ）
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const MAX_ANNOTATIONS = 10;

/**
 * GitHub Actions の警告の注釈（::warning）と、ジョブのまとめ（GITHUB_STEP_SUMMARY）に、流し直しを残す。
 * Actions の外（GITHUB_ACTIONS が true でない）では何もしない。まとめのファイルが書けなくても失敗にしない（注釈と端末の出力は残る）。
 */
export function reportRetriesToCi(retried, { env = process.env, write = (s) => process.stdout.write(s), append = fs.appendFileSync, platform = process.platform, node = process.version } = {}) {
  if (!retried.length || env.GITHUB_ACTIONS !== "true") return { annotations: 0, summary: false };
  const where = `${platform} / node ${node}`;
  const passed = retried.filter((r) => r.outcome === "passed");
  const failed = retried.filter((r) => r.outcome === "failed");

  let annotations = 0;
  const title = escapeProperty(`テストを流し直した (${where})`);
  for (const r of passed.slice(0, MAX_ANNOTATIONS)) {
    write(`::warning title=${title}::${escapeData(`${r.name}: 1 回目に落ちたが、流し直しで通った。緑として扱っている。1 回目: ${r.first.description}`)}\n`);
    annotations++;
  }
  if (passed.length > MAX_ANNOTATIONS) {
    write(`::warning title=${title}::${escapeData(`ほか ${passed.length - MAX_ANNOTATIONS} 本も流し直しで通った（ジョブのまとめに全部ある）`)}\n`);
    annotations++;
  }

  let summary = false;
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) {
    const md = [`### テストを流し直した（${where}）`, ""];
    if (passed.length) {
      md.push(`1 回目に落ちた suite だけを 1 回流し直し、通ったもの（**緑として扱っている**）: ${passed.length} 本`, "", "| suite | 1 回目に落ちた判定 |", "|---|---|");
      for (const r of passed) md.push(`| ${cell(r.name)} | ${cell(r.first.description)} |`);
      md.push("");
    }
    if (failed.length) {
      md.push(`流し直しでも落ちたもの（**赤**）: ${failed.length} 本`, "", "| suite | 1 回目 | 2 回目 |", "|---|---|---|");
      for (const r of failed) md.push(`| ${cell(r.name)} | ${cell(r.first.description)} | ${cell(r.second.description)} |`);
      md.push("");
    }
    try { append(file, `${md.join("\n")}\n`); summary = true; } catch { /* まとめが書けなくても、注釈と端末の出力は残る */ }
  }
  return { annotations, summary };
}
