// テストランナー（tests/run.mjs・tests/lib/runner*.mjs・run-worker.mjs）の契約:
//   - 引数: --jobs / --shard / --timings の値は suite 名にならない。不正な引数・重複・範囲外は何も走らせずに 2 で終わる
//   - 登録: 重複（ファイル・名前）・読めない名前・ファイルが無い・tests/unit にあるのに登録していないものは、走る前に落ちる。実際の export const name との不一致も落ちる
//   - 分割: --shard は決定的で、全 suite がちょうど 1 つの shard に入る（重みの無い新しい suite も）。重い suite が 1 つの shard に偏らない
//   - 実行: --jobs 1（同じプロセス）と --jobs 2（子プロセス）で、同じ suite が同じ結果になる。失敗の詳細・skip・例外・判定数が残る
//   - 異常系: worker が途中で死ぬ・例外・読み込めない・名前の不一致は、他の suite を巻き込まず、その suite を失敗にして全体の終了コードを 1 にする
//   - 隔離: worker は親の AGENT_HOST_DATA を使わず、worker ごとの一時ディレクトリを作って消す。実行元の制御用の環境変数（PLEIAD_CONTROL_* など）はテストに届かない。子プロセスは残らない
// 実際の tests/run.mjs は --list（走らせない）で見る。走らせるのは tests/lib/runner-fixtures/ の小さな試験用 suite（入口は tests/lib/runner-fixture-entry.mjs）。
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../lib/server.mjs";
import { ownedDescendants, reapOwned, killTagged, WORKER_TAG_ENV } from "../lib/process-reap.mjs";
import { ArgError, parseArgs, extractSuiteName, loadRegistry, loadWeights, assignShards, heaviestFirst, weightOf } from "../lib/runner-plan.mjs";

export const name = "runner-contract";
export const title = "テストランナー: 引数・登録・分割・worker・異常系・環境の隔離（--jobs / --shard）";

const RUN = path.join(ROOT, "tests", "run.mjs");
const ENTRY = path.join(ROOT, "tests", "lib", "runner-fixture-entry.mjs");

const spawnNode = (args, env = {}) => new Promise((resolve) => {
  const e = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  execFile(process.execPath, args, { cwd: ROOT, env: e, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 99) : 0, stdout, stderr });
  });
});
/** 試験用の入口（登録は fixtures の suite）を走らせる。AGENT_HOST_DATA は引き継がない（入口が自分で作る） */
const fixtureRun = (files, args, env = {}) => spawnNode([ENTRY, ...args], { AGENT_HOST_DATA: undefined, RUNNER_FIXTURE_FILES: JSON.stringify(files), ...env });
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const waitFor = async (fn, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
const readJsonIf = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

export default async function (t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pleiad-runner-contract-"));
  // ほかのプロセス（ユーザーの別の作業の代わり）。ランナーが回収するのは worker の子孫だけなので、これは最後まで生きている
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const stray = [];   // 試験用の suite が起こして、回収されなかったものがあれば、終わりにこの試験が止める（自分が起こした試験用のものだけ）
  try {
    // ---- 引数 ------------------------------------------------------------------------------------------------------
    {
      const a = parseArgs(["markdown", "--jobs", "2", "--shard", "1/3", "--timings", "out.json", "tree"]);
      t.ok("値を取る引数の値は suite 名にならない（--jobs 2・--shard 1/3・--timings out.json）", same(a.names, ["markdown", "tree"]) && a.jobs === 2 && same(a.shard, { index: 1, total: 3 }) && a.timings === "out.json", JSON.stringify(a));
    }
    {
      const a = parseArgs(["--jobs=3", "--shard=2/2", "x"]);
      t.ok("--jobs=N・--shard=k/N の形", a.jobs === 3 && same(a.shard, { index: 2, total: 2 }) && same(a.names, ["x"]), JSON.stringify(a));
      t.ok("-jN・-j N の形", parseArgs(["-j4"]).jobs === 4 && parseArgs(["-j", "5"]).jobs === 5);
      t.ok("既定は --jobs 1・shard なし・絞り込みなし", same(parseArgs([]), { names: [], jobs: 1, shard: null, timings: null, weights: null, list: false, json: false, help: false }));
      t.ok("-- の後ろは全部 suite 名（npm test -- … の形）", same(parseArgs(["--", "--jobs", "2"]).names, ["--jobs", "2"]));
      const bad = [
        [["--jobs"], "値が無い"], [["--jobs", "--shard", "1/2"], "値が無い（次が別のオプション）"], [["--jobs", "0"], "0"], [["--jobs", "-3"], "負"], [["--jobs", "abc"], "整数でない"],
        [["--jobs", "1.5"], "小数"], [["--jobs", "999"], "上限超え"], [["--jobs", "2", "--jobs", "3"], "重複"], [["--shard", "3/2"], "k > N"], [["--shard", "0/2"], "k = 0"],
        [["--shard", "1"], "k/N の形でない"], [["--shard", "a/b"], "数字でない"], [["--shard", "1/9999"], "N が大きすぎる"], [["--bogus"], "知らないオプション"],
        [["--list=1"], "値を取らない旗に値"], [["--json"], "--json だけ"], [["--timings"], "値が無い"], [["--timings", "a", "--timings", "b"], "重複"],
      ];
      for (const [argv, why] of bad) t.ok(`不正な引数は ArgError: ${argv.join(" ")}（${why}）`, throws(() => parseArgs(argv)) instanceof ArgError);
    }

    // ---- 登録の検査 ---------------------------------------------------------------------------------------------------
    {
      t.ok("extractSuiteName: 通常の形・コメントの中は静的には見分けない（実行時に export と突き合わせる）", extractSuiteName('export const name = "a-b";') === "a-b" && extractSuiteName("export const name = 'x'") === "x" && extractSuiteName("export const name = foo;") === null);
      const base = path.join(tmp, "reg");
      const unit = path.join(base, "unit");
      fs.mkdirSync(unit, { recursive: true });
      const put = (f, body) => fs.writeFileSync(path.join(unit, f), body);
      put("a.mjs", 'export const name = "alpha";\nexport default async () => {};\n');
      put("b.mjs", 'export const name = "beta";\nexport default async () => {};\n');
      put("dup.mjs", 'export const name = "alpha";\nexport default async () => {};\n');
      put("noname.mjs", "export default async () => {};\n");
      put("dash.mjs", 'export const name = "-x";\n');
      put("unlisted.mjs", 'export const name = "unlisted";\n');
      const probs = (files, o = {}) => loadRegistry({ baseDir: base, files, ...o }).problems;
      t.ok("正しい登録は問題なし・登録の順を保つ", probs(["./unit/a.mjs", "./unit/b.mjs"]).length === 0 && same(loadRegistry({ baseDir: base, files: ["./unit/b.mjs", "./unit/a.mjs"] }).entries.map((e) => e.name), ["beta", "alpha"]));
      t.ok("同じファイルを 2 回登録するとエラー", probs(["./unit/a.mjs", "./unit/a.mjs"]).some((p) => p.includes("2 回登録")));
      t.ok("名前の重複（別のファイルで同じ name）はエラー", probs(["./unit/a.mjs", "./unit/dup.mjs"]).some((p) => p.includes("名前が重複")));
      t.ok("export const name が読めなければエラー", probs(["./unit/noname.mjs"]).some((p) => p.includes("export const name")));
      t.ok("名前が - で始まるとエラー（絞り込みの引数と区別できない）", probs(["./unit/dash.mjs"]).some((p) => p.includes("- で始まる")));
      t.ok("ファイルが無ければエラー", probs(["./unit/none.mjs"]).some((p) => p.includes("読めない")));
      t.ok("登録の形が不正（絶対パス・.. ・拡張子違い）はエラー", probs(["/abs/a.mjs", "./unit/../a.mjs", "./unit/a.js", "unit/a.mjs"]).length === 4);
      t.ok("登録が空ならエラー", probs([]).length > 0);
      const missing = probs(["./unit/a.mjs", "./unit/b.mjs"], { unitDir: unit });
      t.ok("tests/unit にあるのに登録していないファイルはエラー（登録漏れ）", missing.some((p) => p.includes("登録漏れ") && p.includes("unlisted.mjs")) && missing.some((p) => p.includes("dup.mjs")), missing.join(" / "));
    }

    // ---- 時間の重みと分割 ----------------------------------------------------------------------------------------------
    {
      const wfile = path.join(tmp, "w.json");
      fs.writeFileSync(wfile, JSON.stringify({ schema: 1, defaultMs: 100, suites: { heavy1: 900, heavy2: 800, heavy3: 700, m1: 300, m2: 200 } }));
      const w = loadWeights(wfile);
      const entries = ["heavy1", "heavy2", "heavy3", "m1", "m2", "fresh1", "fresh2", "l1", "l2", "l3"].map((n, order) => ({ name: n, order, file: `./${n}.mjs` }));
      t.ok("重みの無い suite は defaultMs で数える", weightOf(w, "fresh1") === 100 && weightOf(w, "heavy1") === 900);
      const bins = assignShards(entries, w, 3);
      const flat = bins.flatMap((b) => b.entries.map((e) => e.name));
      t.ok("全 suite がちょうど 1 つの shard に入る（重みの無い新しい suite も）", flat.length === entries.length && new Set(flat).size === entries.length && entries.every((e) => flat.includes(e.name)), flat.join(","));
      t.ok("重い 3 本は別々の shard（偏らない）", new Set(["heavy1", "heavy2", "heavy3"].map((n) => bins.findIndex((b) => b.entries.some((e) => e.name === n)))).size === 3);
      t.ok("同じ入力なら同じ分け方（決定的）。登録の並びを入れ替えても同じ", same(assignShards([...entries].reverse().map((e, i) => ({ ...e, order: i })), w, 3).map((b) => b.entries.map((e) => e.name).sort()), bins.map((b) => b.entries.map((e) => e.name).sort())));
      t.ok("各 shard の中は登録の順", bins.every((b) => b.entries.every((e, i, arr) => i === 0 || arr[i - 1].order < e.order)));
      const sums = bins.map((b) => b.sumMs);
      const total = sums.reduce((a, b) => a + b, 0);
      t.ok("最大の shard は 理想値 + 最大の 1 本 以下（LPT の上限）", Math.max(...sums) <= total / 3 + 900, JSON.stringify(sums));
      t.ok("shard を 1 つにすると全部・並びは登録の順", same(assignShards(entries, w, 1)[0].entries.map((e) => e.name), entries.map((e) => e.name)));
      t.ok("worker へ配る順は重い順（同じ重みは名前順）", heaviestFirst(entries, w).map((e) => e.name).join() === "heavy1,heavy2,heavy3,m1,m2,fresh1,fresh2,l1,l2,l3");
      for (const [doc, why] of [[{ schema: 2, defaultMs: 1, suites: {} }, "schema"], [{ schema: 1, defaultMs: 0, suites: {} }, "defaultMs"], [{ schema: 1, defaultMs: 1, suites: { a: -1 } }, "負の重み"], [{ schema: 1, defaultMs: 1 }, "suites なし"]]) {
        const f = path.join(tmp, "bad-w.json");
        fs.writeFileSync(f, JSON.stringify(doc));
        t.ok(`不正な重みの JSON は ArgError（${why}）`, throws(() => loadWeights(f)) instanceof ArgError);
      }
      fs.writeFileSync(path.join(tmp, "broken.json"), "{ not json");
      t.ok("壊れた重みの JSON・無いファイルも ArgError（黙って均等に戻さない）", throws(() => loadWeights(path.join(tmp, "broken.json"))) instanceof ArgError && throws(() => loadWeights(path.join(tmp, "nope.json"))) instanceof ArgError);
    }

    // ---- 本物の tests/run.mjs（--list。suite は走らせない）-----------------------------------------------------------
    {
      const list = async (args) => {
        const r = await spawnNode([RUN, "--list", "--json", ...args], { AGENT_HOST_DATA: undefined });
        let doc = null;
        try { doc = JSON.parse(r.stdout); } catch { /* 下で落とす */ }
        return { ...r, doc };
      };
      const all = await list([]);
      const onDisk = fs.readdirSync(path.join(ROOT, "tests", "unit")).filter((f) => f.endsWith(".mjs"));
      t.ok("実際の登録: 終了コード 0・tests/unit の *.mjs と同じ本数（登録漏れなし）", all.code === 0 && all.doc?.registered === onDisk.length && all.doc?.selected === onDisk.length, `${all.doc?.registered} / ${onDisk.length} ${all.stderr.slice(0, 200)}`);
      const names = (all.doc?.suites ?? []).map((s) => s.name);
      t.ok("実際の登録: 名前は一意・自分（runner-contract）を含む", new Set(names).size === names.length && names.includes(name));
      const shards = await Promise.all([1, 2, 3].map((k) => list(["--shard", `${k}/3`])));
      const parts = shards.map((s) => (s.doc?.suites ?? []).map((x) => x.name));
      const union = parts.flat();
      t.ok("実際の登録: --shard 1/3・2/3・3/3 の和は全 suite をちょうど 1 回ずつ（重なり・漏れなし）", shards.every((s) => s.code === 0) && union.length === names.length && new Set(union).size === names.length && names.every((n) => union.includes(n)), parts.map((p) => p.length).join("+"));
      t.ok("実際の登録: shard の分け方の指紋（分割数を含む）が全 shard で同じ（別々のジョブが同じ計画を見る）", new Set(shards.map((s) => s.doc?.planHash)).size === 1 && !!shards[0].doc?.planHash && shards[0].doc.planHash !== all.doc?.planHash);
      const sums = shards.map((s) => s.doc?.sumWeightMs);
      const totalW = sums.reduce((a, b) => a + b, 0);
      const maxW = Math.max(...(all.doc?.suites ?? []).map((s) => s.weightMs));
      t.ok("実際の登録: 最大の shard は 理想値 + 最重の 1 本 以下（重い suite が偏らない）", Math.max(...sums) <= totalW / 3 + maxW, `${sums.join(" / ")}（最重 ${maxW}）`);
      const second = await list(["--shard", "1/3"]);
      t.ok("実際の登録: 同じ引数なら同じ shard（決定的）", same(second.doc?.suites?.map((s) => s.name), parts[0]));
      // 値が suite 名と取り違えられない: 名前に "1" を含む suite（i18n など）が混ざらない
      const filtered = await list(["--jobs", "1", "--shard", "1/3", "markdown-xss"]);
      const only = await list(["markdown-xss"]);
      t.ok("実際の登録: `--jobs 1 --shard 1/3 markdown-xss` の選択は markdown-xss だけ（1・1/3 が絞り込みに入らない）", same(only.doc?.suites?.map((s) => s.name), ["markdown-xss"]) && same(filtered.doc?.suites?.map((s) => s.name), ["markdown-xss"]), JSON.stringify(filtered.doc?.suites?.map((s) => s.name)));
      const bad = await Promise.all([["--jobs", "0"], ["--shard", "4/3"], ["--bogus"], ["--jobs", "2", "--jobs", "2"]].map((a) => spawnNode([RUN, "--list", ...a], { AGENT_HOST_DATA: undefined })));
      t.ok("実際の run.mjs: 不正な引数は 2 で終わり、suite 名の一覧も出さない", bad.every((r) => r.code === 2 && !r.stdout.includes("\t")), bad.map((r) => r.code).join());
      const none = await spawnNode([RUN, "--list", "no-such-suite-zzz"], { AGENT_HOST_DATA: undefined });
      t.ok("該当する suite が無いと 1（従来どおり）", none.code === 1 && none.stdout.includes("該当するテストが無い"));
      const emptyShard = await spawnNode([RUN, "--list", "markdown-xss", "--shard", "2/3"], { AGENT_HOST_DATA: undefined });
      t.ok("選んだ suite より shard が多くて空の shard は 2（黙って 0 本で成功しない）", emptyShard.code === 2, `${emptyShard.code} ${emptyShard.stderr.slice(0, 120)}`);
    }

    // ---- 試験用の suite を、--jobs 1 / --jobs 2 / --shard で走らせる ------------------------------------------------------
    const GOOD = ["./fx-pass-a.mjs", "./fx-fail.mjs", "./fx-skip.mjs", "./fx-probe.mjs", "./fx-heavy.mjs", "./fx-pass-b.mjs"];
    const probeDir = path.join(tmp, "probe1");
    const probeDir2 = path.join(tmp, "probe2");
    fs.mkdirSync(probeDir);
    fs.mkdirSync(probeDir2);
    const ambient = { PLEIAD_CONTROL_TOKEN: "ambient-secret-token", PLEIAD_CONTROL_URL: "http://127.0.0.1:1", AGENT_HOST_PORT: "1" };
    const j1 = await fixtureRun(GOOD, ["--timings", path.join(tmp, "j1.json")], { RUNNER_FIXTURE_OUT: probeDir, ...ambient });
    const userData = fs.mkdtempSync(path.join(tmp, "user-data-"));
    const j2 = await fixtureRun(GOOD, ["--jobs", "2", "--timings", path.join(tmp, "j2.json")], { RUNNER_FIXTURE_OUT: probeDir2, ...ambient, AGENT_HOST_DATA: userData });
    const T1 = read(path.join(tmp, "j1.json"));
    const T2 = read(path.join(tmp, "j2.json"));
    const view = (T) => T.suites.map((s) => [s.name, s.status, s.judgements, s.passed, s.failed, s.skipped]);
    t.ok("--jobs 1 と --jobs 2 は同じ suite を同じ結果にする（登録の順・状態・判定数・skip）", same(view(T1), view(T2)) && T1.suites.length === GOOD.length, JSON.stringify(view(T2)));
    t.ok("どちらも失敗する suite があるので終了コード 1・末尾に失敗の詳細（判定名・詳細・suite 名）が残る", j1.code === 1 && j2.code === 1 && [j1, j2].every((r) => r.stdout.includes("[fx-fail]") && r.stdout.includes("落ちる判定") && r.stdout.includes("FAIL-DETAIL-1")), `${j1.code} ${j2.code}`);
    t.ok("skip は理由つきで機械可読（timings）にも、末尾の一覧にも出る", T2.suites.find((s) => s.name === "fx-skip")?.skipped === "前提が無い（試験用）" && j2.stdout.includes("とばした  fx-skip") && T1.totals.skippedSuites === 1);
    t.ok("判定数の合計・通った数が合う（6 判定 + …）", T1.totals.judgements === T2.totals.judgements && T2.totals.passed === T2.totals.judgements - T2.totals.failedJudgements && T2.totals.failedJudgements === 1, JSON.stringify(T2.totals));
    t.ok("--jobs 2 は worker 2 本・全 suite を 1 回ずつ・各 worker の一時の置き場は消えている", T2.workers.length >= 2 && T2.workers.reduce((n, w) => n + w.suites, 0) === GOOD.length && T2.workers.every((w) => w.exit?.code === 0 && w.dataDirRemoved === true) && T2.problems.length === 0, JSON.stringify(T2.workers));
    const heavy = T2.suites.find((s) => s.name === "fx-heavy");
    t.ok("重い suite から先に配る（最初に配られる）", T2.suites.every((s) => heavy.startMs <= s.startMs), JSON.stringify(T2.suites.map((s) => [s.name, s.startMs])));
    t.ok("timings: 重み・重みの有無・時間・worker・開始終了が入る", T2.suites.every((s) => typeof s.ms === "number" && typeof s.weightMs === "number" && typeof s.weighted === "boolean" && s.worker >= 1 && s.endMs >= s.startMs) && T1.suites.every((s) => s.worker === null) && T2.args.jobs === 2 && T2.registered === GOOD.length);

    const p1 = fs.readdirSync(probeDir).map((f) => read(path.join(probeDir, f)));
    const p2 = fs.readdirSync(probeDir2).map((f) => read(path.join(probeDir2, f)));
    t.ok("--jobs 1: 同じプロセスの中・実行元の制御用の環境変数はテストに届かない（PLEIAD_CONTROL_*）", p1.length === 1 && p1[0].inWorker === false && p1[0].controlToken === null && p1[0].controlUrl === null && j1.stdout.includes("実行元の制御用の環境変数を外した"), JSON.stringify(p1));
    t.ok("--jobs 2: worker（子プロセス）の中・制御用の環境変数は届かない・言語は ja・本物の置き場を守る設定が入っている", p2.length === 1 && p2[0].inWorker === true && p2[0].controlToken === null && p2[0].controlUrl === null && p2[0].locale === "ja" && String(p2[0].guard).includes(".agent-host"), JSON.stringify(p2));
    t.ok("--jobs 2: worker の置き場は親が渡した AGENT_HOST_DATA ではなく、worker 専用の一時ディレクトリ（終わると消える）", !!p2[0]?.data && path.resolve(p2[0].data) !== path.resolve(userData) && path.basename(p2[0].data).startsWith("pleiad-test-data-") && p2[0].dataExists === true && !fs.existsSync(p2[0].data), p2[0]?.data);
    t.ok("--jobs 2: 親が渡した AGENT_HOST_DATA（利用者の置き場の代わり）には何も書かれない・消されない", fs.existsSync(userData) && fs.readdirSync(userData).length === 0);
    t.ok("--jobs 1 の置き場も一時ディレクトリで、終わると消える", !!p1[0]?.data && path.basename(p1[0].data).startsWith("pleiad-test-data-") && !fs.existsSync(p1[0].data) && p1[0].data !== p2[0]?.data);

    const probeDir3 = path.join(tmp, "probe3");
    fs.mkdirSync(probeDir3);
    const sh1 = await fixtureRun(GOOD, ["--shard", "1/2", "--timings", path.join(tmp, "s1.json")], { RUNNER_FIXTURE_OUT: probeDir3 });
    const sh2 = await fixtureRun(GOOD, ["--shard", "2/2", "--timings", path.join(tmp, "s2.json")], { RUNNER_FIXTURE_OUT: probeDir3 });
    const S1 = read(path.join(tmp, "s1.json"));
    const S2 = read(path.join(tmp, "s2.json"));
    const sn = [...S1.suites, ...S2.suites].map((s) => s.name);
    t.ok("--shard 1/2 と 2/2 を走らせた和は、全 suite をちょうど 1 回ずつ・同じ結果（--jobs 1 と一致）", sn.length === GOOD.length && new Set(sn).size === GOOD.length && same([...S1.suites, ...S2.suites].map((s) => [s.name, s.status, s.judgements]).sort(), T1.suites.map((s) => [s.name, s.status, s.judgements]).sort()) && sh1.stdout.includes("shard 1/2") && sh2.stdout.includes("shard 2/2"));
    t.ok("fx-heavy（重い）は fx-pass-a と別の shard", S1.suites.some((s) => s.name === "fx-heavy") !== S1.suites.some((s) => s.name === "fx-pass-a") && S1.planHash === S2.planHash && S1.planHash !== T1.planHash);

    // ---- 絞り込みと worker の本数 -----------------------------------------------------------------------------------------
    {
      const f = await fixtureRun(GOOD, ["--jobs", "3", "--shard", "1/1", "pass", "--timings", path.join(tmp, "f.json")]);
      const F = read(path.join(tmp, "f.json"));
      t.ok("絞り込み（pass）・--jobs 3・--shard 1/1 の組み合わせ: 選ばれた 2 本だけ走り、worker は本数に合わせて 2 本まで", same(F.suites.map((s) => s.name), ["fx-pass-a", "fx-pass-b"]) && f.code === 0 && F.workers.filter((w) => w.suites > 0).length <= 2 && f.stdout.includes("減らした"), `${f.code} ${JSON.stringify(F.suites.map((s) => s.name))}`);
      t.ok("全部通ると終了コード 0・timings の ok が true", F.ok === true && F.totals.failedSuites === 0);
    }

    // ---- 異常系 -----------------------------------------------------------------------------------------------------------
    {
      const C = ["./fx-pass-a.mjs", "./fx-exit.mjs", "./fx-kill.mjs", "./fx-throw.mjs", "./fx-mismatch.mjs", "./fx-nodefault.mjs", "./fx-pass-b.mjs"];
      const c = await fixtureRun(C, ["--jobs", "2", "--timings", path.join(tmp, "c.json")]);
      const CT = read(path.join(tmp, "c.json"));
      const st = Object.fromEntries(CT.suites.map((s) => [s.name, s.status]));
      t.ok("worker が途中で死んでも（exit・kill）、その suite だけが crash の失敗になり、ほかは最後まで走る", c.code === 1 && st["fx-exit"] === "crash" && st["fx-kill"] === "crash" && st["fx-pass-a"] === "pass" && st["fx-pass-b"] === "pass", JSON.stringify(st));
      t.ok("suite の例外・読み込めない・default が関数でない・登録と実際の name の不一致は、その suite の失敗（error / fail）", st["fx-throw"] === "error" && st["fx-nodefault"] === "error" && Object.values(st).includes("fail") && c.stdout.includes("FX-THROW-BOOM") && c.stdout.includes("登録した名前と export const name が一致する"), JSON.stringify(st));
      t.ok("死んだ worker の失敗には、終了コードと直近の出力（遺言）が残る", c.stdout.includes("exit 7") && c.stdout.includes("FX-EXIT-LAST-WORDS") && c.stdout.includes("worker が最後まで走り切る"));
      t.ok("登録した 7 本が欠けも重複もなく 1 回ずつ記録される・実行の整合の問題は無い（worker の死は suite の失敗として数える）", CT.suites.length === C.length && new Set(CT.suites.map((s) => s.name)).size === C.length && CT.problems.length === 0, JSON.stringify(CT.problems));
      t.ok("死んだ worker の置き場も後始末される・生きている worker は残らない", CT.workers.length >= 3 && CT.workers.every((w) => w.dataDirRemoved === true && w.pid > 0 && !alive(w.pid)), JSON.stringify(CT.workers.map((w) => [w.id, w.pid, w.dataDirRemoved])));
      t.ok("全体の終了コードは 1・timings の ok は false", CT.ok === false);

      const D = ["./fx-pass-a.mjs", "./fx-throw.mjs", "./fx-mismatch.mjs", "./fx-nodefault.mjs"];
      const d = await fixtureRun(D, ["--timings", path.join(tmp, "d.json")]);
      const DT = read(path.join(tmp, "d.json"));
      const ds = Object.fromEntries(DT.suites.map((s) => [s.name, s.status]));
      t.ok("--jobs 1 でも、例外・default が関数でない・name の不一致は失敗になり、残りは走る", d.code === 1 && ds["fx-pass-a"] === "pass" && ds["fx-throw"] === "error" && ds["fx-nodefault"] === "error" && Object.values(ds).includes("fail"), JSON.stringify(ds));
    }

    // ---- 回収の判定（合成データ。pid の使い回し・止める直前の再確認・読めないときの扱い）-----------------------------------------------
    {
      const T0 = 1_000_000;   // worker を起こした時刻
      const tbl = (rows) => new Map(rows.map(([pid, ppid, created]) => [pid, { ppid, created }]));
      const root = { pid: 100, spawnedAt: T0, endedAt: T0 + 5000 };
      const names = (m) => [...m.keys()].sort((a, b) => a - b);
      t.ok("生きている worker の子孫（孫まで）を集める。root 自身・自分・無関係なプロセスは入れない", same(names(ownedDescendants(tbl([[100, 1, T0 + 10], [200, 100, T0 + 100], [300, 200, T0 + 200], [400, 1, T0 + 50], [500, 400, T0 + 60], [999, 100, T0 + 300]]), [{ pid: 100, spawnedAt: T0 }], 999)), [200, 300]));
      t.ok("root の pid が別のプロセスに使い回されている（生まれた時刻が、起こした時刻と違う）なら、その新しい子孫も辿らない", ownedDescendants(tbl([[100, 1, T0 + 3_600_000], [200, 100, T0 + 3_600_500], [300, 200, T0 + 3_600_900]]), [root]).size === 0);
      t.ok("root が死んでいて、その pid の子が root の死より後に生まれていたら（使い回された pid の子）辿らない。死ぬ前に生まれた子（本物の孫）は辿る", same(names(ownedDescendants(tbl([[200, 100, T0 + 1000], [201, 100, T0 + 3_600_000], [300, 201, T0 + 3_600_100]]), [root])), [200]));
      // 起こした時刻 1000 → worker の死 2000 → 同じ pid の新しいプロセスが 2500（許容幅の 15 秒の中）に生まれ、その子が 3000 に生まれた
      const reusedSoon = ownedDescendants(tbl([[100, 1, 2500], [200, 100, 3000]]), [{ pid: 100, spawnedAt: 1000, endedAt: 2000 }], 999, 10_000);
      t.ok("worker の死（endedAt 2000）より後に同じ pid で生まれた新しいプロセス（2500。起こした時刻 1000 から 15 秒の許容幅の中）とその新しい子（3000）は、絶対に対象にしない", reusedSoon.size === 0);
      t.ok("死んだ worker が（ハンドルが残って）表にまだ載っているときは、本物として子孫を辿る（生まれた時刻が死より前）", ownedDescendants(tbl([[100, 1, 1100], [200, 100, 1500]]), [{ pid: 100, spawnedAt: 1000, endedAt: 2000 }], 999, 10_000).has(200));
      t.ok("worker が知らせた bornAt があれば、それと 3 秒以内の作成時刻だけを本物とする（15 秒の許容幅の中でも、bornAt から離れていれば辿らない）", ownedDescendants(tbl([[100, 1, 1000 + 10_000], [200, 100, 1000 + 10_500]]), [{ pid: 100, spawnedAt: 1000, bornAt: 1100 }], 999).size === 0 && ownedDescendants(tbl([[100, 1, 1500], [200, 100, 1800]]), [{ pid: 100, spawnedAt: 1000, bornAt: 1100 }], 999).has(200));
      t.ok("作成時刻が表に無い（0）root は、本物かを確かめられないので辿らない（対象にしない）", ownedDescendants(tbl([[100, 1, 0], [200, 100, 5000]]), [{ pid: 100, spawnedAt: 1000 }], 999).size === 0);
      t.ok("子が親より先に生まれていたら（親の pid が使い回された）辿らない", ownedDescendants(tbl([[100, 1, T0 + 10], [200, 100, T0 + 100], [300, 200, T0 - 600_000]]), [{ pid: 100, spawnedAt: T0 }]).has(300) === false);
      t.ok("root の生まれた時刻が許容幅の中なら生きている root として辿る", ownedDescendants(tbl([[100, 1, T0 + 500], [200, 100, T0 + 900]]), [{ pid: 100, spawnedAt: T0 }]).has(200));
      const kills = [];
      const kill = (pid, sig) => { kills.push([pid, sig]); };
      const live = tbl([[200, 100, T0 + 1000], [300, 200, T0 + 1100], [700, 1, T0 + 1200]]);
      const r1 = reapOwned([root], { platform: "win32", list: () => live, kill });
      t.ok("Windows: 鎖で辿れる子孫だけを止める（無関係な 700 は止めない）", r1.killed === 2 && same(kills.map((k) => k[0]).sort(), [200, 300]) && !r1.error, JSON.stringify({ r1, kills }));
      kills.length = 0;
      const r2 = reapOwned([root], { platform: "win32", list: () => null, kill });
      t.ok("Windows: プロセス表が読めないときは error を返し、何も止めない（注意だけで成功にしない）", !!r2.error && r2.killed === 0 && kills.length === 0);
      let calls = 0;
      const r3 = reapOwned([root], { platform: "win32", list: () => (++calls === 1 ? live : null), kill });
      t.ok("Windows: 止める直前の再読みができなければ error・何も止めない", !!r3.error && kills.length === 0);
      calls = 0;
      const r4 = reapOwned([root], { platform: "win32", list: () => (++calls === 1 ? live : tbl([[200, 100, T0 + 1000], [300, 4242, T0 + 1100]])), kill });
      t.ok("Windows: 読んでから止めるまでに別のプロセスへ変わったもの（親が違う）は止めない", same(kills.map((k) => k[0]), [200]) && r4.killed === 1, JSON.stringify(kills));
      calls = 0;
      kills.length = 0;
      reapOwned([root], { platform: "win32", list: () => (++calls === 1 ? live : tbl([[200, 100, T0 + 77_000], [300, 200, T0 + 1100]])), kill });
      t.ok("Windows: 生まれた時刻が変わっていたもの（pid の使い回し）は止めない", same(kills.map((k) => k[0]), [300]), JSON.stringify(kills));
      kills.length = 0;
      reapOwned([{ pid: 100, spawnedAt: T0 }], { platform: "win32", list: () => tbl([[100, 1, T0 + 10], [200, 100, T0 + 100]]), kill });
      t.ok("root が今も生きている場合も、子孫だけを止める（root は止めない。root は呼び出し側が止める）", same(kills.map((k) => k[0]), [200]));

      // Linux: 環境変数の印（/proc/<pid>/environ）。偽の /proc で
      const proc = path.join(tmp, "fakeproc");
      for (const [pid, env] of [[10, `A=1\0${WORKER_TAG_ENV}=run-w1\0B=2`], [11, `${WORKER_TAG_ENV}=run-w2\0`], [12, "A=1\0B=2"], [13, `${WORKER_TAG_ENV}=run-w1`], [14, `${WORKER_TAG_ENV}=run-w1x`], [15, `X${WORKER_TAG_ENV}=run-w1`]]) {
        fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
        fs.writeFileSync(path.join(proc, String(pid), "environ"), env);
      }
      fs.mkdirSync(path.join(proc, "notapid"));
      fs.mkdirSync(path.join(proc, "16"));   // environ が読めない
      kills.length = 0;
      const n = killTagged(["run-w1"], { procDir: proc, kill, selfPid: 13 });
      t.ok("印（worker ごとの一意の文字列）が完全一致するプロセスだけを止める（別の worker の印・印なし・前方一致・別の変数名・自分・読めないものは止めない）", n === 1 && same(kills, [[10, "SIGKILL"]]), JSON.stringify(kills));
      t.ok("印の一覧が空・/proc が無いときは何もしない", killTagged([], { procDir: proc, kill }) === 0 && killTagged(["x"], { procDir: path.join(tmp, "none"), kill }) === 0);
      kills.length = 0;
      const rp = reapOwned([{ pid: 4321, spawnedAt: T0, tag: "run-w2" }], { platform: "linux", kill });
      t.ok("POSIX: worker のグループへ kill（-pid）してから、印のあるものを探す（本物の /proc に印が無ければ、グループだけ）", kills.some((k) => k[0] === -4321 && k[1] === "SIGKILL") && rp.killed >= 1);
    }

    // ---- 孫のプロセスの回収（所有した worker の子孫だけ。ほかのプロセスには触れない）------------------------------------------------------
    {
      const outDir = path.join(tmp, "orphans");
      fs.mkdirSync(outDir);
      const r = await fixtureRun(["./fx-pass-a.mjs", "./fx-orphan.mjs", "./fx-leak.mjs", "./fx-pass-b.mjs"], ["--jobs", "2", "--timings", path.join(tmp, "o.json")], { RUNNER_FIXTURE_OUT: outDir });
      const O = read(path.join(tmp, "o.json"));
      const orphan = readJsonIf(path.join(outDir, "child-fx-orphan.json"));
      const leak = readJsonIf(path.join(outDir, "child-fx-leak.json"));
      const pids = [orphan?.plain, orphan?.holder, orphan?.detached, leak?.child].filter(Boolean);
      stray.push(...pids);
      // 止めるのは非同期（OS が片付けるまで少しかかる）ので、少し待って見る
      const gone = await waitFor(() => pids.every((p) => !alive(p)), 8000);
      const st = Object.fromEntries(O.suites.map((x) => [x.name, x.status]));
      t.ok("worker が途中で死んだ suite は crash の失敗・suite が子を残して普通に終わったものと、ほかは通る", r.code === 1 && st["fx-orphan"] === "crash" && st["fx-leak"] === "pass" && st["fx-pass-a"] === "pass" && st["fx-pass-b"] === "pass", JSON.stringify(st));
      t.ok("worker が起こした孫（worker の出力を掴んだまま居座る子・detached の子・普通の子・suite が残した子）は、ランナーが終わるまでに残らない（detached の子は、Windows は親子の鎖で・Linux は worker ごとの環境変数の印で見つける。印の読める /proc が無い macOS だけは、グループを抜けた子が範囲外）", pids.length === 4 && (gone || (process.platform === "darwin" && [orphan.plain, orphan.holder, leak.child].every((p) => !alive(p)))), JSON.stringify({ orphan, leak, aliveNow: pids.filter(alive) }));
      t.ok("worker（死んだもの・終わったもの）も残らない", O.workers.every((w) => !alive(w.pid)) && O.workers.every((w) => w.dataDirRemoved === true), JSON.stringify(O.workers.map((w) => [w.id, w.pid, w.dataDirRemoved])));
      t.ok("関係ないプロセス（ユーザーの別の作業の代わり）には触れない", alive(bystander.pid));
      t.ok("回収した本数が timings に残る（Windows は detached の子を鎖で辿って止める）", process.platform !== "win32" || O.reapedProcesses >= 1, JSON.stringify({ reaped: O.reapedProcesses, errors: O.reapErrors }));
      t.ok("終了コード 1（worker の死は失敗）", r.code === 1);

      // 実際の経路: core/host-shell.mjs（POSIX は detached のシェル。入力欄の `!` と同じ）で孫を起こしたまま worker が死ぬ
      const shellOut = path.join(tmp, "shell");
      fs.mkdirSync(shellOut);
      const rs = await fixtureRun(["./fx-pass-a.mjs", "./fx-shell.mjs"], ["--jobs", "2", "--timings", path.join(tmp, "sh.json")], { RUNNER_FIXTURE_OUT: shellOut });
      const SH = read(path.join(tmp, "sh.json"));
      const shellChild = readJsonIf(path.join(shellOut, "child-fx-shell.json"));
      if (shellChild) stray.push(shellChild.child);
      const shellGone = shellChild && process.platform !== "win32" ? await waitFor(() => !alive(shellChild.child), 8000) : null;
      // Windows の Git Bash（msys）は、孫を自分の子として起こした後、仲介のプロセスが worker の死と一緒に消えると親子の鎖が切れる（孫の親が存在しない pid になる）。
      // 鎖で辿れず、ほかの作業のプロセスと区別する印も無いので、この場合だけは回収を保証しない（止められるのは worker が生きている間の取り消し・正常な終わり）。ここでは残りものを最後に止める
      t.ok("ホストのシェル（core/host-shell.mjs）が起こした孫は、worker が途中で死んでも残らない（POSIX。Windows の Git Bash 経由は保証しない）", rs.code === 1 && SH.suites.find((x) => x.name === "fx-shell")?.status === "crash" && !!shellChild && (process.platform === "win32" || !!shellGone), JSON.stringify({ code: rs.code, shellChild, alive: shellChild && alive(shellChild.child), tail: rs.stdout.slice(-300) }));
      t.ok("そのときも関係ないプロセスには触れない", alive(bystander.pid));
    }
    {
      // 親のランナー（入口のプロセス）を外から止める: worker は自分と子孫（suite が起こしたもの）を残さない
      const outDir = path.join(tmp, "cancel");
      fs.mkdirSync(outDir);
      const env = { ...process.env, RUNNER_FIXTURE_FILES: JSON.stringify(["./fx-hang.mjs", "./fx-pass-a.mjs"]), RUNNER_FIXTURE_OUT: outDir };
      delete env.AGENT_HOST_DATA;
      const driver = spawn(process.execPath, [ENTRY, "--jobs", "2"], { cwd: ROOT, env, stdio: "ignore", windowsHide: true });
      const info = await waitFor(() => readJsonIf(path.join(outDir, "child-fx-hang.json")), 30_000);
      if (info) stray.push(info.child, info.worker);
      t.ok("取り消しの準備: suite が子を起こしてから待っている", !!info && alive(info.worker) && alive(info.child), JSON.stringify(info));
      driver.kill();
      const reaped = info ? await waitFor(() => !alive(info.worker) && !alive(info.child), 15_000) : null;
      t.ok("親のランナーが止められると、worker と、その suite が起こした孫が残らない", !!reaped, JSON.stringify({ info, workerAlive: info && alive(info.worker), childAlive: info && alive(info.child) }));
      t.ok("関係ないプロセスには触れない（取り消しのとき）", alive(bystander.pid));
    }

    if (process.platform === "win32") {
      // プロセス表（PowerShell）が読めない環境: 子孫が残っていないか確かめられないので、注意だけで成功にせず失敗にする
      const blind = await fixtureRun(["./fx-pass-a.mjs", "./fx-pass-b.mjs"], ["--jobs", "2"], { PATH: path.dirname(process.execPath), SystemRoot: "" });
      t.ok("Windows: プロセス表が読めないと、suite が全部通っても終了コード 1（回収を確かめられなかったことを失敗に数える）", blind.code === 1 && blind.stdout.includes("子孫のプロセスの回収を確かめられなかった"), `${blind.code} ${blind.stdout.slice(-300)}`);
    }

    // ---- 不正な引数・登録は、何も走らせない -------------------------------------------------------------------------------------
    {
      const rs = await Promise.all([
        fixtureRun(GOOD, ["--jobs", "0"]), fixtureRun(GOOD, ["--jobs", "2", "--shard", "5/2"]), fixtureRun(GOOD, ["--wat"]), fixtureRun(GOOD, ["--jobs", "2", "--jobs", "3"]),
        fixtureRun(["./fx-pass-a.mjs", "./fx-pass-a.mjs"], []), fixtureRun(["./fx-pass-a.mjs", "./fx-nope.mjs"], []), fixtureRun(["./fx-pass-a.mjs"], ["--shard", "2/3"]),
      ]);
      t.ok("不正な引数（0 本・k>N・不明・重複）は終了コード 2 で、suite を 1 本も走らせない", rs.slice(0, 4).every((r) => r.code === 2 && !r.stdout.includes("── fx-")), rs.slice(0, 4).map((r) => r.code).join());
      t.ok("登録の重複・ファイルが無いは終了コード 2 で、何も走らせない", rs[4].code === 2 && rs[5].code === 2 && !rs[4].stdout.includes("── fx-") && !rs[5].stdout.includes("── fx-") && rs[4].stderr.includes("2 回登録") && rs[5].stderr.includes("読めない"), `${rs[4].code} ${rs[5].code}`);
      t.ok("shard に割り当てる suite が無ければ終了コード 2（空の shard で成功にしない）", rs[6].code === 2 && !rs[6].stdout.includes("── fx-"), String(rs[6].code));
    }
  } finally {
    for (const pid of stray) { try { process.kill(pid, "SIGKILL"); } catch { /* もう居ない */ } }
    try { bystander.kill(); } catch { /* もう居ない */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
