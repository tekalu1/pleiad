// tests/run.mjs の「何を・どの順で・どう分けて走らせるか」。副作用は無い（ファイルを読むだけ）ので、tests/unit/runner-contract.mjs が直に確かめる。
//
//   - 引数の解釈（--jobs / --shard / --timings / --weights / --list / --json と、suite 名の絞り込み）。値を取る引数の値は suite 名にならない
//   - 登録の検査（重複・読めない名前・ファイルが無い・tests/unit に有るのに登録していない）。落とすのは、走らない suite を黙って作らないため
//   - 時間の重み（tests/suite-weights.json）と、その重みでの決定的な分割（LPT）・worker に配る順
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class ArgError extends Error {}

export const MAX_JOBS = 32;
export const MAX_SHARDS = 256;

export const USAGE = `使い方: node tests/run.mjs [絞り込み…] [オプション]

  絞り込み           suite 名の部分一致（複数なら OR）。無ければ全部
  --jobs N, -j N     子プロセスの worker を N 本使う（1〜${MAX_JOBS}。既定 1 = 従来どおり同じプロセスで順に）
  --shard k/N        N 分割したうちの k 番目だけ走らせる（時間の重みで決定的に分ける。k は 1〜N）
  --timings <path>   suite ごとの時間・判定数・skip・worker を JSON で書く
  --weights <path>   時間の重みの JSON（既定 tests/suite-weights.json）
  --list [--json]    走らせずに、選ばれた suite と重みを出す
  --help, -h         これ`;

const intIn = (name, text, min, max) => {
  if (!/^\d+$/.test(text)) throw new ArgError(`${name} は整数: ${JSON.stringify(text)}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ArgError(`${name} は ${min}〜${max}: ${text}`);
  return n;
};

/** argv（node tests/run.mjs の後ろ）を解釈する。おかしければ ArgError */
export function parseArgs(argv) {
  const o = { names: [], jobs: 1, shard: null, timings: null, weights: null, list: false, json: false, help: false };
  const seen = new Set();
  const once = (key) => {
    if (seen.has(key)) throw new ArgError(`${key} が 2 回指定されている`);
    seen.add(key);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") { o.names.push(...argv.slice(i + 1).map(String)); break; }
    if (!a.startsWith("-") || a === "-") { o.names.push(a); continue; }

    let key = a;
    let val = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
    else if (/^-j\d+$/.test(a)) { key = "-j"; val = a.slice(2); }
    const need = () => {
      if (val !== null) return val;
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith("--")) throw new ArgError(`${key} に値が無い`);
      i++;
      return String(next);
    };
    const flag = () => { if (val !== null) throw new ArgError(`${key} は値を取らない`); };

    switch (key) {
      case "--jobs": case "-j": {
        once("--jobs");
        o.jobs = intIn("--jobs", need(), 1, MAX_JOBS);
        break;
      }
      case "--shard": {
        once("--shard");
        const text = need();
        const m = /^(\d+)\/(\d+)$/.exec(text);
        if (!m) throw new ArgError(`--shard は k/N の形（例 2/3）: ${JSON.stringify(text)}`);
        const total = intIn("--shard の N", m[2], 1, MAX_SHARDS);
        const index = intIn("--shard の k", m[1], 1, total);
        o.shard = { index, total };
        break;
      }
      case "--timings": { once(key); const p = need(); if (!p) throw new ArgError("--timings のパスが空"); o.timings = p; break; }
      case "--weights": { once(key); const p = need(); if (!p) throw new ArgError("--weights のパスが空"); o.weights = p; break; }
      case "--list": flag(); once(key); o.list = true; break;
      case "--json": flag(); once(key); o.json = true; break;
      case "--help": case "-h": flag(); o.help = true; break;
      default: throw new ArgError(`知らないオプション: ${a}`);
    }
  }
  if (o.json && !o.list) throw new ArgError("--json は --list と一緒に使う");
  return o;
}

/** テストファイルの `export const name = "…"` を、読み込まずに取る（読み込むと副作用が走るので、割り当ての前には読み込まない） */
export function extractSuiteName(source) {
  const m = /^export\s+const\s+name\s*=\s*(["'`])([^"'`\\\r\n$]+)\1\s*;?/m.exec(String(source));
  return m ? m[2] : null;
}

/** 失敗の表示に使う題（読めなければ null。名前で代える） */
export function extractSuiteTitle(source) {
  const m = /^export\s+const\s+title\s*=\s*(["'`])(.*)\1\s*;?\s*$/m.exec(String(source));
  return m ? m[2] : null;
}

/**
 * 登録した suite のファイル（baseDir からの相対 "./unit/x.mjs"）を検査して、{ entries, problems } を返す。
 * entries は登録の順。problems が空でなければ走らせない。
 * unitDir を渡すと、その直下の *.mjs が全部登録されているかも見る（登録漏れ。走らない suite を作らない）。
 */
export function loadRegistry({ baseDir, files, unitDir = null }) {
  const problems = [];
  const entries = [];
  const byFile = new Map();
  const byName = new Map();
  if (!Array.isArray(files) || !files.length) problems.push("登録した suite が 1 本も無い");
  for (const [order, raw] of (Array.isArray(files) ? files : []).entries()) {
    const file = String(raw);
    if (!/^\.\/[\w./-]+\.mjs$/.test(file) || file.split("/").includes("..")) {
      problems.push(`登録の形が不正: ${JSON.stringify(file)}（"./unit/x.mjs" の形）`);
      continue;
    }
    const abs = path.resolve(baseDir, file);
    const key = abs.toLowerCase();
    if (byFile.has(key)) { problems.push(`同じファイルを 2 回登録している: ${file}`); continue; }
    byFile.set(key, file);
    let source;
    try { source = fs.readFileSync(abs, "utf8"); } catch { problems.push(`登録したファイルが読めない: ${file}`); continue; }
    const name = extractSuiteName(source);
    if (!name) { problems.push(`${file}: \`export const name = "…"\` が読めない`); continue; }
    if (name.startsWith("-")) { problems.push(`${file}: 名前が - で始まる（絞り込みに使えない）: ${name}`); continue; }
    if (byName.has(name)) { problems.push(`名前が重複: ${name}（${byName.get(name).file} と ${file}）`); continue; }
    const entry = { file, abs, name, title: extractSuiteTitle(source), order };
    byName.set(name, entry);
    entries.push(entry);
  }
  if (unitDir) {
    let onDisk = [];
    try { onDisk = fs.readdirSync(unitDir).filter((f) => f.endsWith(".mjs")); } catch (e) { problems.push(`${unitDir} が読めない: ${e.message}`); }
    for (const f of onDisk.sort()) {
      if (!byFile.has(path.resolve(unitDir, f).toLowerCase())) problems.push(`登録漏れ: ${path.relative(baseDir, path.resolve(unitDir, f)).replaceAll("\\", "/")} が tests/run.mjs の一覧に無い`);
    }
  }
  return { entries, problems };
}

/** 時間の重みの JSON を読む。{ schema: 1, defaultMs, suites: { <name>: <ms> } }。読めなければ ArgError（黙って均等に戻さない） */
export function loadWeights(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new ArgError(`時間の重み ${file} が読めない: ${e.message}`); }
  if (!doc || typeof doc !== "object" || doc.schema !== 1) throw new ArgError(`時間の重み ${file}: schema が 1 でない`);
  const defaultMs = Number(doc.defaultMs);
  if (!Number.isFinite(defaultMs) || defaultMs <= 0) throw new ArgError(`時間の重み ${file}: defaultMs が正の数でない`);
  if (!doc.suites || typeof doc.suites !== "object" || Array.isArray(doc.suites)) throw new ArgError(`時間の重み ${file}: suites が無い`);
  const map = new Map();
  for (const [name, ms] of Object.entries(doc.suites)) {
    if (!Number.isFinite(ms) || ms <= 0) throw new ArgError(`時間の重み ${file}: ${name} が正の数でない`);
    map.set(name, ms);
  }
  return { map, defaultMs, file };
}

/** 重みの無い suite（新しく足したもの）は defaultMs で数える。落とさず、必ずどこかに入る */
export const weightOf = (weights, name) => weights.map.get(name) ?? weights.defaultMs;
export const isWeighted = (weights, name) => weights.map.has(name);

/** 重い順（同じ重みは名前順）。分割と worker への配り方が同じ並びを使う。ロケールに依らない比較 */
export function heaviestFirst(entries, weights) {
  return [...entries].sort((a, b) => weightOf(weights, b.name) - weightOf(weights, a.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * entries を total 個に分ける（LPT: 重い順に、今いちばん軽い箱へ）。決定的（同じ entries・重みなら、どこで呼んでも同じ）。
 * 各箱は登録の順に戻して返す。全員がちょうど 1 つの箱に入る。
 */
export function assignShards(entries, weights, total) {
  const bins = Array.from({ length: total }, () => ({ sum: 0, items: [] }));
  for (const e of heaviestFirst(entries, weights)) {
    let best = bins[0];
    for (const b of bins) if (b.sum < best.sum) best = b;
    best.items.push(e);
    best.sum += weightOf(weights, e.name);
  }
  return bins.map((b) => ({ sumMs: b.sum, entries: b.items.sort((x, y) => x.order - y.order) }));
}

/** 計画の指紋。shard を走らせる各ジョブが同じ分け方を見ているかを、timings の JSON で突き合わせる */
export function planHash(entries, weights, total) {
  const h = crypto.createHash("sha1");
  h.update(`${total}\n`);
  for (const e of [...entries].sort((a, b) => a.order - b.order)) h.update(`${e.name}:${weightOf(weights, e.name)}\n`);
  return h.digest("hex").slice(0, 12);
}
