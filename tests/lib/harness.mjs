// テストの共通土台。テストランナーは入れない（依存を増やさない・素の Node で動く）。
//
// 各テストファイルは次の形を守る:
//   export const name  = "短い名前";      // CLI から絞り込むときのキー
//   export const title = "何を確かめるか";
//   export default async function (t, ctx) { t.ok("...", 条件, "補足"); }
//
// テスト側は t.ok を呼ぶだけでよい。数え上げ・失敗の一覧・終了コードはここが持つ。

export class Suite {
  constructor(name, title) {
    this.name = name;
    this.title = title ?? name;
    this.results = [];
    this.error = null;
    this.skipped = null;
  }

  /** 判定を1件記録する。pass が偽なら detail が失敗の手がかりとして残る。 */
  ok(label, pass, detail = "") {
    const r = { label, pass: Boolean(pass), detail: String(detail ?? "") };
    this.results.push(r);
    console.log(`  ${r.pass ? "OK" : "NG"}  ${label}${r.detail ? "  — " + r.detail : ""}`);
    return r.pass;
  }

  /** 判定ではない補足。落ちたときの手がかりに使う。 */
  note(text) {
    console.log(`      ${text}`);
  }

  /** 前提が揃わないので測れない、と申告する。失敗にはしないが黙ってもいない。 */
  skip(why) {
    this.skipped = why;
    console.log(`  --  とばす — ${why}`);
  }

  get passed() { return this.results.filter((r) => r.pass).length; }
  get failures() { return this.results.filter((r) => !r.pass); }
  get failed() { return this.failures.length > 0 || this.error != null; }
}

/** テストを1本走らせる。中で例外が出ても他は止めない。 */
export async function runCase(mod, ctx) {
  const t = new Suite(mod.name, mod.title);
  console.log(`\n── ${t.name}  ${t.title}`);
  const t0 = Date.now();
  try {
    await mod.default(t, ctx);
  } catch (err) {
    t.error = err;
    console.log(`  NG  例外で中断 — ${err?.stack ?? err}`);
  }
  t.ms = Date.now() - t0;
  return t;
}

/**
 * 全体の結果を出して終了コードを返す。
 * 「何が落ちたか」が末尾だけ見れば分かることを優先する。
 */
export function summarize(suites) {
  const total = suites.reduce((n, s) => n + s.results.length, 0);
  const passed = suites.reduce((n, s) => n + s.passed, 0);
  const broken = suites.filter((s) => s.failed);
  const skipped = suites.filter((s) => s.skipped);

  console.log("\n" + "─".repeat(64));
  for (const s of skipped) console.log(`  とばした  ${s.name} — ${s.skipped}`);

  if (broken.length === 0) {
    console.log(`  全て通過  ${passed} / ${total} 判定 / ${suites.length} 本`);
    return 0;
  }

  console.log(`  失敗  ${total - passed} / ${total} 判定（${broken.length} / ${suites.length} 本）`);
  for (const s of broken) {
    console.log(`\n  [${s.name}] ${s.title}`);
    for (const f of s.failures) console.log(`    NG  ${f.label}${f.detail ? "  — " + f.detail : ""}`);
    if (s.error) console.log(`    例外  ${String(s.error?.stack ?? s.error).split("\n").slice(0, 6).join("\n          ")}`);
  }
  return 1;
}

/** CLI 引数でテストを絞り込む。引数が無ければ全部。部分一致で拾う。 */
export function pick(mods, argv) {
  const want = argv.filter((a) => !a.startsWith("-"));
  if (!want.length) return mods;
  const hit = mods.filter((m) => want.some((w) => m.name.includes(w)));
  if (!hit.length) {
    console.log(`該当するテストが無い: ${want.join(", ")}`);
    console.log(`あるのは: ${mods.map((m) => m.name).join(", ")}`);
  }
  return hit;
}
