// tests/run.mjs の実行部。計画（tests/lib/runner-plan.mjs）に従って suite を走らせ、結果を集めて終了コードを返す。
//
//   --jobs 1（既定）  従来どおり、このプロセスで suite を登録の順に 1 本ずつ。
//   --jobs N > 1      子プロセスの worker（tests/lib/run-worker.mjs）を N 本。重い suite から順に、空いた worker へ 1 本ずつ渡す。
//                     worker は suite 1 本ごとに終わるまで次を受けない（同じプロセスの中で suite を並行させない）。
//                     出力は suite ごとにまとめて、終わった順に出す（行が混ざらない）。
//
// どちらでも: 登録した suite はちょうど 1 回ずつ走り、走らなかったもの・二重に走ったもの・worker が途中で死んだものは失敗にする。
// worktree の見張り（テストの後に本体の git に分けた作業場所が増えていない）は suite ごとに worker の中で見て、全体の前後でも親が見る。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Suite, runCase, summarize, pick } from "./harness.mjs";
import { snapshotPleiadWorktrees, leakedWorktrees } from "./worktree-guard.mjs";
import { installDomStub } from "./dom-stub.mjs";
import { reapOwned } from "./process-reap.mjs";
import { ArgError, USAGE, parseArgs, loadRegistry, loadWeights, weightOf, isWeighted, heaviestFirst, assignShards, planHash } from "./runner-plan.mjs";

const WORKER_PATH = fileURLToPath(new URL("./run-worker.mjs", import.meta.url));
const WORKER_EXIT_GRACE_MS = 30_000;

const clip = (text, n = 300) => { const s = String(text ?? ""); return s.length > n ? `${s.slice(0, n)}…` : s; };
const firstLine = (e) => String(e?.stack ?? e ?? "").split("\n")[0];

// ---------------------------------------------------------------------------------------------------------------------
// suite を 1 本走らせる（同じプロセスの順次実行と、worker の中の両方が使う）

/**
 * 各 suite の後に、本体の git の分けた作業場所が増えていないかを見る。後始末はしない（並行する別の作業のものかもしれない。理由は tests/lib/worktree-guard.mjs）。
 * parallel のときは、ほかの worker の suite の間に増えたものかもしれないことを、詳細に添える。
 */
export function createGuardedRunner({ root, parallel = false }) {
  let seen = null;
  return {
    async prime() { seen = await snapshotPleiadWorktrees(root); },
    async run(mod, expectedName) {
      const suite = await runCase(mod);
      if (expectedName && mod.name !== expectedName) suite.ok("登録した名前と export const name が一致する", false, `登録 ${expectedName} / 実際 ${mod.name}`);
      const now = await snapshotPleiadWorktrees(root);
      const leaked = leakedWorktrees(seen, now);
      if (leaked.length) suite.ok("テストの後に本体の git の分けた作業場所が増えていない", false, leaked.join(", ") + (parallel ? "（並列実行中: 同時に走っている別の worker の suite のものかもしれない。単独で流して確かめる）" : ""));
      seen = now ?? seen;
      return suite;
    },
  };
}

/** worker から親へ渡す形 */
export const serializeSuite = (s) => ({ name: s.name, title: s.title, results: s.results, error: s.error == null ? null : String(s.error?.stack ?? s.error), skipped: s.skipped, ms: s.ms ?? 0 });

/** 親で Suite に戻す */
export function reviveSuite(d) {
  const s = new Suite(d.name, d.title);
  s.results = d.results ?? [];
  s.error = d.error ?? null;
  s.skipped = d.skipped ?? null;
  s.ms = d.ms ?? 0;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// 同じプロセスで順に（従来）

async function runInProcess({ entries, root }) {
  installDomStub();
  const loaded = [];
  // 全部を読み込んでから走らせる（従来と同じ。読み込みの失敗は、その suite だけの失敗にする）
  for (const entry of entries) {
    try { loaded.push({ entry, mod: await import(pathToFileURL(entry.abs).href) }); }
    catch (error) { loaded.push({ entry, error }); }
  }
  const guard = createGuardedRunner({ root });
  await guard.prime();
  const out = [];
  const t0 = Date.now();
  for (const { entry, mod, error } of loaded) {
    const startMs = Date.now() - t0;
    let suite;
    if (error) {
      suite = new Suite(entry.name, entry.title ?? entry.name);
      console.log(`\n── ${suite.name}  ${suite.title}`);
      suite.error = error;
      console.log(`  NG  読み込みで例外 — ${error?.stack ?? error}`);
      suite.ms = 0;
    } else {
      suite = await guard.run(mod, entry.name);
    }
    out.push({ entry, suite, worker: null, startMs, endMs: Date.now() - t0 });
  }
  return { records: out, workers: [], problems: [], reaped: 0, reapErrors: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// 子プロセスの worker

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    else { try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); } }
  } catch { /* もう居ない */ }
}

const isOurTempData = (dir) => {
  if (!dir) return false;
  const abs = path.resolve(dir);
  return path.dirname(abs).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() && path.basename(abs).startsWith("pleiad-test-data-");
};

function removeWorkerData(dir) {
  if (!isOurTempData(dir)) return;
  // Windows は終わったばかりのプロセスの掴みが残ることがあるので、少し粘る。消せなくても残るだけ
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 残るだけ */ }
}

async function runPool({ entries, jobs, root, weights, parentDataDir }) {
  const queue = heaviestFirst(entries, weights);
  const t0 = Date.now();
  const records = [];
  const completions = new Map();
  const problems = [];
  const workers = [];
  const env = { ...process.env };
  // 親の置き場は渡さない。worker は自分で一時ディレクトリを作る（tests/lib/test-env.mjs）
  delete env.AGENT_HOST_DATA;

  let alive = 0;
  let reaped = 0;
  const reapErrors = [];
  let nextId = 1;
  let startFailures = 0;
  let settled = false;
  let resolveAll;
  const allDone = new Promise((r) => { resolveAll = r; });

  const record = (entry, suite, w, startMs, extra = {}) => {
    completions.set(entry.name, (completions.get(entry.name) ?? 0) + 1);
    records.push({ entry, suite, worker: w?.id ?? null, startMs, endMs: Date.now() - t0, ...extra });
  };
  const emit = (text) => { process.stdout.write(text.endsWith("\n") ? text : text + "\n"); };

  const finishIfDone = () => {
    if (settled || alive > 0) return;
    // 誰も居ない。残っているものは走れなかった
    for (const entry of queue.splice(0)) {
      const s = new Suite(entry.name, entry.title ?? entry.name);
      console.log(`\n── ${s.name}  ${s.title}`);
      s.ok("worker が起動できず、走らなかった", false, "worker が続けて起動に失敗した");
      record(entry, s, null, Date.now() - t0, { status: "missing" });
    }
    settled = true;
    resolveAll();
  };

  /** ws の worker が起こした子孫（suite が起こしたサーバーなど）のうち残っているものだけを止める。範囲は worker の pid から鎖で辿れるものだけ（tests/lib/process-reap.mjs） */
  const reapRoots = (ws) => {
    const r = reapOwned(ws.map((w) => ({ pid: w.pid, spawnedAt: w.spawnedAt })));
    reaped += r.killed;
    if (r.error && !reapErrors.includes(r.error)) reapErrors.push(r.error);
  };

  const dispatch = (w) => {
    if (w.exiting || w.closed || !w.ready || w.busy) return;
    const entry = queue.shift();
    if (!entry) {
      w.exiting = true;
      try { w.child.send({ type: "exit" }); } catch { /* 死んだ。close で拾う */ }
      w.killTimer = setTimeout(() => killTree(w.pid), WORKER_EXIT_GRACE_MS);   // 終わらない worker は木ごと止める。残りは exit で回収
      return;
    }
    w.busy = { entry, startedAt: Date.now(), out: [] };
    try { w.child.send({ type: "run", name: entry.name, file: entry.abs }); }
    catch { /* 死んだ。close で拾う（busy の suite は失敗にする） */ }
  };

  const spawnWorker = () => {
    const id = nextId++;
    const spawnedAt = Date.now();
    // POSIX は worker を自分のプロセスグループにする（死んだ後もグループへの kill で、残った子孫だけを止められる）
    const child = fork(WORKER_PATH, [parentDataDir ?? ""], {
      env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true, detached: process.platform !== "win32",
    });
    const w = { id, child, pid: child.pid, spawnedAt, ready: false, busy: null, dataDir: null, tail: [], done: 0, busyMs: 0, exit: null, closed: false, exiting: false, fatal: null, killTimer: null };
    workers.push(w);
    alive++;

    const lines = (stream) => {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        rest += chunk;
        const parts = rest.split(/\r?\n/);
        rest = parts.pop();
        for (const line of parts) { w.tail.push(line); if (w.tail.length > 40) w.tail.shift(); emit(`[w${id}] ${line}`); }
      });
      stream.on("end", () => { if (rest) { w.tail.push(rest); emit(`[w${id}] ${rest}`); } });
    };
    lines(child.stdout);
    lines(child.stderr);
    // worker が死んでも、孫が worker の stdout を掴んだままだと close が来ない。終わりの検知は exit で行い、出力の取りこぼしは少しだけ待つ
    const pipesClosed = Promise.all([child.stdout, child.stderr].map((st) => new Promise((r) => { st.once("close", r); st.once("error", r); })));

    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") { w.ready = true; w.dataDir = msg.dataDir ?? null; startFailures = 0; dispatch(w); }
      else if (msg.type === "out") { w.busy?.out.push(String(msg.text)); }
      else if (msg.type === "fatal") { w.fatal = String(msg.message); }
      else if (msg.type === "result") {
        const b = w.busy;
        // 頼んだ suite の結果だけを受ける。結果の中の name は module の export なので、登録と違っていても（そのこと自体が失敗として入っている）頼んだ側で数える
        if (!b || b.entry.name !== msg.requested) {
          problems.push(`worker ${id}: 頼んでいない suite の結果が来た: ${msg.requested}（実行中: ${b?.entry.name ?? "なし"}）`);
          if (b) killTree(w.pid);   // 取り違えたまま続けない。exit で、実行中だった suite が失敗になる
          return;
        }
        w.busy = null;
        w.done++;
        w.busyMs += Date.now() - b.startedAt;
        emit(b.out.join(""));
        record(b.entry, reviveSuite(msg.suite), w, b.startedAt - t0);
        dispatch(w);
      }
    });
    child.on("error", (e) => { w.fatal = `${w.fatal ?? ""}${e?.message ?? e}`; });
    child.on("exit", async (code, signal) => {
      clearTimeout(w.killTimer);
      w.closed = true;
      w.exit = { code, signal };
      const expected = w.exiting && code === 0;
      const abnormal = !expected || !!w.busy;
      // 予定外の終わり（suite の途中・終わりの合図なし・終了コード非 0）は、worker が起こした子孫を今すぐ止める。ほかの worker は動いたまま
      if (abnormal) reapRoots([w]);
      await Promise.race([pipesClosed, new Promise((r) => setTimeout(r, 300))]);
      child.stdout.destroy();
      child.stderr.destroy();
      alive--;
      if (abnormal) removeWorkerData(w.dataDir);   // 正常な終わりの置き場は、最後に子孫を止めてから消す
      if (w.busy) {
        const b = w.busy;
        w.busy = null;
        w.busyMs += Date.now() - b.startedAt;
        emit(b.out.join(""));
        const s = new Suite(b.entry.name, b.entry.title ?? b.entry.name);
        s.ms = Date.now() - b.startedAt;
        const last = [...b.out.join("").split(/\r?\n/), ...w.tail].filter((l) => l.trim()).slice(-12);
        s.ok("worker が最後まで走り切る", false, `worker ${id} が suite の途中で終了した（exit ${code}${signal ? ` / signal ${signal}` : ""}）${w.fatal ? ` ${w.fatal}` : ""}\n          直近の出力:\n          ${last.join("\n          ") || "（なし）"}`);
        record(b.entry, s, w, b.startedAt - t0, { status: "crash" });
      } else if (!expected) {
        problems.push(`worker ${id} が予定外に終了した（exit ${code}${signal ? ` / signal ${signal}` : ""}）${w.fatal ? ` ${w.fatal}` : ""}${w.tail.length ? `\n      ${w.tail.slice(-10).join("\n      ")}` : ""}`);
        if (!w.ready) startFailures++;
      }
      if (queue.length && alive < jobs && startFailures < 3) spawnWorker();
      finishIfDone();
    });
    return w;
  };

  const killAll = () => { for (const w of workers) if (!w.closed) killTree(w.pid); };
  const onSignal = (sig) => { killAll(); reapRoots(workers); process.exit(sig === "SIGINT" ? 130 : 143); };
  const onExit = () => { killAll(); reapRoots(workers); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);

  try {
    for (let i = 0; i < jobs; i++) spawnWorker();
    await allDone;
  } finally {
    killAll();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
  }

  // 全員の終わった後、suite が残した子孫（正常に終わった worker の分も）を止めてから、worker の置き場を消す（掴まれていると消せない）
  reapRoots(workers);
  for (const w of workers) removeWorkerData(w.dataDir);

  for (const [name, n] of completions) if (n > 1) problems.push(`${name} が ${n} 回走った`);
  return { records, workers, problems, wallMs: Date.now() - t0, reaped, reapErrors };
}

// ---------------------------------------------------------------------------------------------------------------------
// 機械可読の記録

function statusOf(suite, extra) {
  if (extra?.status) return extra.status;
  if (suite.error != null) return "error";
  if (suite.failures.length) return "fail";
  if (suite.skipped) return "skip";
  return "pass";
}

function buildTimings({ args, weights, selected, totalCount, records, workers, extraProblems, wallMs, plan }) {
  const suites = records.map((r) => {
    const s = r.suite;
    return {
      name: r.entry.name,
      file: r.entry.file,
      weightMs: weightOf(weights, r.entry.name),
      weighted: isWeighted(weights, r.entry.name),
      status: statusOf(s, r),
      ms: s.ms ?? 0,
      judgements: s.results.length,
      passed: s.passed,
      failed: s.failures.length,
      skipped: s.skipped ?? null,
      error: s.error == null ? null : firstLine(s.error),
      worker: r.worker,
      startMs: r.startMs,
      endMs: r.endMs,
    };
  }).sort((a, b) => selected.findIndex((e) => e.name === a.name) - selected.findIndex((e) => e.name === b.name));
  const sum = (f) => suites.reduce((n, s) => n + f(s), 0);
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    args: { jobs: args.jobs, shard: args.shard, filter: args.names },
    planHash: plan.hash,
    selected: selected.length,
    registered: totalCount,
    wallMs,
    sumSuiteMs: sum((s) => s.ms),
    totals: {
      suites: suites.length,
      judgements: sum((s) => s.judgements),
      passed: sum((s) => s.passed),
      failedJudgements: sum((s) => s.failed),
      failedSuites: suites.filter((s) => s.status !== "pass" && s.status !== "skip").length,
      skippedSuites: suites.filter((s) => s.skipped).length,
    },
    problems: extraProblems,
    workers: workers.map((w) => ({ id: w.id, pid: w.pid, suites: w.done, busyMs: w.busyMs, exit: w.exit, dataDirRemoved: w.dataDir ? !fs.existsSync(w.dataDir) : null })),
    suites,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * tests/run.mjs の本体。終了コードを返す（呼び出し側が process.exit する）。
 * 0 全部通った / 1 失敗・走らなかった・該当なし / 2 引数か登録が不正（何も走らせていない）
 */
export async function main({ suites: files, baseDir, unitDir = null, argv, root, weightsFile, testEnv }) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    console.error(`引数が不正: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }

  const { entries, problems } = loadRegistry({ baseDir, files, unitDir });
  if (problems.length) {
    console.error(`suite の登録が不正（何も走らせない）:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 2;
  }
  let weights;
  try { weights = loadWeights(args.weights ?? weightsFile); } catch (e) {
    if (!(e instanceof ArgError)) throw e;
    console.error(`引数が不正: ${e.message}`);
    return 2;
  }

  let selected = pick(entries, args.names);
  if (!selected.length) return 1;
  const filtered = selected.length !== entries.length;
  let shardSumMs = null;
  if (args.shard) {
    const bins = assignShards(selected, weights, args.shard.total);
    selected = bins[args.shard.index - 1].entries;
    shardSumMs = bins[args.shard.index - 1].sumMs;
    if (!selected.length) {
      console.error(`--shard ${args.shard.index}/${args.shard.total}: 割り当てる suite が無い（選んだ ${filtered ? "" : "全"}${entries.length} 本に対して分割が多すぎる）`);
      return 2;
    }
  }
  const jobs = Math.min(args.jobs, selected.length);
  const plan = { hash: planHash(filtered ? selected : entries, weights, args.shard?.total ?? 1) };

  if (args.list) {
    const rows = selected.map((e) => ({ name: e.name, file: e.file, weightMs: weightOf(weights, e.name), weighted: isWeighted(weights, e.name) }));
    if (args.json) console.log(JSON.stringify({ registered: entries.length, selected: rows.length, shard: args.shard, planHash: plan.hash, sumWeightMs: rows.reduce((n, r) => n + r.weightMs, 0), suites: rows }, null, 2));
    else for (const r of rows) console.log(`${r.name}\t${r.weightMs}${r.weighted ? "" : "\t(重み無し)"}\t${r.file}`);
    return 0;
  }

  if (testEnv.scrubbedEnv.length) console.log(`  実行元の制御用の環境変数を外した: ${testEnv.scrubbedEnv.join(", ")}`);
  if (args.jobs > 1 || args.shard) {
    const unweighted = selected.filter((e) => !isWeighted(weights, e.name)).length;
    console.log(`  ${args.shard ? `shard ${args.shard.index}/${args.shard.total}（重み ${(shardSumMs / 1000).toFixed(0)} 秒）` : "全体"}: ${selected.length} 本 / worker ${jobs} 本${jobs !== args.jobs ? `（--jobs ${args.jobs} は本数に合わせて減らした）` : ""}${unweighted ? ` / 重みの無い ${unweighted} 本は ${weights.defaultMs}ms で数えた` : ""}`);
    if (jobs > 1 && testEnv.testDataOwned === false) console.log("  AGENT_HOST_DATA は worker へ渡さない（worker ごとに一時ディレクトリを作る）");
  }

  const t0 = Date.now();
  // 全体の前後でも、本体の git の分けた作業場所を見る（suite ごとの見張りが拾えない取りこぼしと、worker が途中で死んだ場合の分）
  const before = await snapshotPleiadWorktrees(root);
  const ran = jobs > 1
    ? await runPool({ entries: selected, jobs, root, weights, parentDataDir: testEnv.testDataDir })
    : await runInProcess({ entries: selected, root });
  const after = await snapshotPleiadWorktrees(root);
  if (ran.reaped) console.log(`
  後始末: worker の子孫のプロセス ${ran.reaped} 本を止めた（suite が起こして残したもの・worker が途中で死んで残ったもの）`);
  for (const e of ran.reapErrors) console.log(`  注意: 子孫のプロセスの回収を確かめられなかった — ${e}`);

  const problemsRun = [...ran.problems];
  // 登録した suite がちょうど 1 回ずつ走ったか
  const got = new Map();
  for (const r of ran.records) got.set(r.entry.name, (got.get(r.entry.name) ?? 0) + 1);
  for (const e of selected) if (!got.has(e.name)) problemsRun.push(`走らなかった suite: ${e.name}`);
  for (const [name, n] of got) if (n !== 1) problemsRun.push(`${name} が ${n} 回走った`);

  const order = new Map(selected.map((e, i) => [e.name, i]));
  const records = [...ran.records].sort((a, b) => order.get(a.entry.name) - order.get(b.entry.name));
  const suiteList = records.map((r) => r.suite);

  const leaked = leakedWorktrees(before, after);
  if (leaked.length && !suiteList.some((s) => s.failures.some((f) => f.label.includes("分けた作業場所が増えていない")))) {
    const g = new Suite("ランナー: worktree の見張り", "全体の前後で本体の git の分けた作業場所が増えていない");
    console.log(`\n── ${g.name}  ${g.title}`);
    g.ok("全体の前後で本体の git の分けた作業場所が増えていない", false, leaked.join(", "));
    suiteList.push(g);
  }
  if (problemsRun.length) {
    const g = new Suite("ランナー: 実行の整合", "登録した suite がちょうど 1 回ずつ走り、worker が正常に終わる");
    console.log(`\n── ${g.name}  ${g.title}`);
    for (const p of problemsRun) g.ok("実行の整合", false, p);
    suiteList.push(g);
  }

  const code = summarize(suiteList);
  const wallMs = Date.now() - t0;
  const sumMs = suiteList.reduce((n, s) => n + (s.ms ?? 0), 0);
  console.log(jobs > 1 ? `  ${(wallMs / 1000).toFixed(1)} 秒（worker ${jobs} 本・suite の合計 ${(sumMs / 1000).toFixed(1)} 秒）` : `  ${(wallMs / 1000).toFixed(1)} 秒`);

  if (args.timings) {
    const doc = buildTimings({ args, weights, selected, totalCount: entries.length, records, workers: ran.workers, extraProblems: problemsRun, wallMs, plan });
    doc.ok = code === 0;
    doc.reapedProcesses = ran.reaped;
    doc.reapErrors = ran.reapErrors;
    try {
      fs.mkdirSync(path.dirname(path.resolve(args.timings)), { recursive: true });
      fs.writeFileSync(args.timings, `${JSON.stringify(doc, null, 2)}\n`);
      console.log(`  timings: ${args.timings}`);
    } catch (e) {
      console.log(`  NG  timings を書けない: ${args.timings} — ${e.message}`);
      return 1;
    }
  }
  return code;
}
