// Claude の使用量の累計（transcript の cost-state 行）を読み、ターンの分へ直す。
//
// CLI 2.1.280 以降は、query（CLI のプロセス）の終わりに `{ type: "cost-state", totalCostUSD, modelUsage, … }` を
// transcript へ書き、resume のたびにその最後の行を読み戻す。そのため resume した query の result の
// `total_cost_usd` / `modelUsage` は会話を作ったときからの累計になる。Pleiad はターンごとに resume するので、
// ターンを始める前に最後の cost-state を「開始時点の累計」として読み、result の累計から引く（docs/design.md「使用量」、
// ADR 0052）。cost-state は文書に無い CLI の内部の形なので、読めないときは数えすぎるより null にする。
//
// SDK を import しない（claude-normalize.mjs と移行（core/usage-migrations.mjs）から使う）。
import fs from 'node:fs/promises';

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
/** 新しい会話・分岐した会話・cost-state を書かない版の会話の開始時点（CLI も 0 から数える） */
export const ZERO_COST = Object.freeze({ totalCostUSD: 0, modelUsage: Object.freeze({}) });
/** cost-state を書き始めた CLI の版。これより前の transcript に cost-state が無いのは正常 */
export const COST_STATE_SINCE_VERSION = '2.1.280';

/** result（total_cost_usd / modelUsage）と cost-state（totalCostUSD / modelUsage）を同じ形に均す。形が違えば null */
function costOf(totalCostUSD, modelUsage) {
  if (totalCostUSD != null && !(finite(totalCostUSD) && totalCostUSD >= 0)) return null;
  if (modelUsage == null) modelUsage = {};
  if (typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const models = {};
  for (const [model, u] of Object.entries(modelUsage)) {
    if (!u || typeof u !== 'object' || !finite(u.inputTokens) || !finite(u.outputTokens)
      || !TOKEN_KEYS.every(k => u[k] === undefined || (finite(u[k]) && u[k] >= 0))) return null;
    models[model] = Object.fromEntries(TOKEN_KEYS.map(k => [k, u[k] ?? 0]));
  }
  return { totalCostUSD: totalCostUSD ?? null, modelUsage: models };
}

/** transcript の 1 行（parse 済み）を cost-state として読む。cost-state でない・形が違うときは null */
export function costStateOf(row) {
  if (row?.type !== 'cost-state' || row.totalCostUSD == null) return null;
  return costOf(row.totalCostUSD, row.modelUsage);
}

/** SDK の result の累計。modelUsage も費用も無ければ null */
export function resultCost(m) {
  const hasModels = m?.modelUsage && typeof m.modelUsage === 'object' && Object.keys(m.modelUsage).length > 0;
  if (!hasModels && !finite(m?.total_cost_usd)) return null;
  // 形の違うモデルの項目が混じっても費用は読めるようにする（トークンは null）
  return costOf(finite(m.total_cost_usd) ? m.total_cost_usd : null, m.modelUsage)
    ?? { totalCostUSD: finite(m.total_cost_usd) ? m.total_cost_usd : null, modelUsage: null };
}

/** 累計を記録の 4 つの数値にする（入力はキャッシュを含む。docs/design.md「使用量」） */
export function usageTotals(cost) {
  const models = cost?.modelUsage ? Object.values(cost.modelUsage) : null;
  const sum = key => models.reduce((n, u) => n + u[key], 0);
  return {
    inputTokens: models?.length ? sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens') : null,
    outputTokens: models?.length ? sum('outputTokens') : null,
    cachedTokens: models?.length ? sum('cacheReadInputTokens') : null,
    costUsd: finite(cost?.totalCostUSD) ? cost.totalCostUSD : null,
  };
}

// 費用は小数の引き算なので、1e-9 未満の揺れは丸める（-1e-12 を「戻った」と見なさない）
const costDiff = (end, start) => {
  const d = Math.round((end - start) * 1e9) / 1e9;
  return d < 0 ? null : d;
};

/**
 * 累計 end から開始時点 start を引いた、そのターンの分。
 * モデルごとに引いてから合計する（途中でモデルを切り替えても正しい）。差分が負になった項目（累計が戻った・
 * 読んだ開始時点が CLI の読んだものと違う）は null にする（画面は「一部」と出す）。start が null（開始時点が分からない）なら全部 null
 */
export function claudeUsageDelta(end, start) {
  const none = { inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null };
  if (!end || !start) return none;
  const costUsd = finite(end.totalCostUSD) && finite(start.totalCostUSD) ? costDiff(end.totalCostUSD, start.totalCostUSD) : null;
  if (!end.modelUsage || !Object.keys(end.modelUsage).length) return { ...none, costUsd };
  const diff = Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])), bad = new Set();
  const models = new Set([...Object.keys(end.modelUsage), ...Object.keys(start.modelUsage ?? {})]);
  for (const model of models) {
    const e = end.modelUsage[model], s = start.modelUsage?.[model];
    for (const k of TOKEN_KEYS) {
      const d = (e?.[k] ?? 0) - (s?.[k] ?? 0);
      if (d < 0) bad.add(k); else diff[k] += d;
    }
  }
  const input = ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
  return {
    inputTokens: input.some(k => bad.has(k)) ? null : diff.inputTokens + diff.cacheReadInputTokens + diff.cacheCreationInputTokens,
    outputTokens: bad.has('outputTokens') ? null : diff.outputTokens,
    cachedTokens: bad.has('cacheReadInputTokens') ? null : diff.cacheReadInputTokens,
    costUsd,
  };
}

/**
 * transcript の本文から cost-state を順に拾う（移行で使う）。本文の大半は parse しない。
 * 発言の中に「cost-state」と書かれていても、行の type が cost-state でなければ拾わない。
 * broken は type が cost-state なのに形が違った行の数
 */
export function costStatesIn(text) {
  const states = [];
  let broken = 0, i = 0;
  while ((i = text.indexOf('"cost-state"', i)) !== -1) {
    const start = text.lastIndexOf('\n', i) + 1, end = text.indexOf('\n', i);
    const line = text.slice(start, end < 0 ? undefined : end);
    i = end < 0 ? text.length : end;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'cost-state') continue;
    const state = costStateOf(row);
    if (state) states.push(state); else broken++;
  }
  return { states, broken };
}

const versionParts = v => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v.split(/[.-]/).slice(0, 3).map(Number) : null;
/** a が b より前の版か。版が読めなければ null */
export function versionBefore(a, b) {
  const x = versionParts(a), y = versionParts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/**
 * transcript の末尾から最後の cost-state を探す（CLI が resume で読み戻すのと同じ値）。
 * 返り値 { state, cost, version, sawAssistant, forked }
 * - state: found（cost に累計）/ none（cost-state が無い）/ broken（最後の cost-state の形が違う）
 * - none のとき、最後の assistant 行の version と forkedFrom（SDK の forkSession が写した行）を返す。
 *   開始時点を 0 としてよいか（CLI も 0 から数えるか）を呼び出し側が決める（decideCostBase）
 */
export async function readCostState(file, { chunkBytes = 256 * 1024 } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let pos = size, carry = Buffer.alloc(0), version = null, sawAssistant = false, forked = false;
    const look = line => {
      if (!line) return null;
      if (line.includes('"cost-state"')) {
        let row; try { row = JSON.parse(line); } catch { row = null; }
        if (row?.type === 'cost-state') {
          const cost = costStateOf(row);
          return cost ? { state: 'found', cost } : { state: 'broken', cost: null, version: typeof row.version === 'string' ? row.version : version };
        }
      }
      // 最後の assistant 行だけ見る（版と、分岐で写された行か）。本文の行は大きいので parse は 1 回だけ
      if (!sawAssistant && line.includes('"assistant"')) {
        let row; try { row = JSON.parse(line); } catch { row = null; }
        if (row?.type === 'assistant') {
          sawAssistant = true;
          version = typeof row.version === 'string' ? row.version : null;
          forked = Boolean(row.forkedFrom);
        }
      }
      return null;
    };
    while (pos > 0) {
      const size = Math.min(chunkBytes, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, pos);
      const joined = Buffer.concat([buf, carry]);
      // 行の区切りはバイトで探す（UTF-8 の途中で切らない）
      let end = joined.length;
      for (let i = joined.length - 1; i >= 0; i--) {
        if (joined[i] !== 0x0a) continue;
        const hit = look(joined.subarray(i + 1, end).toString('utf8').trim());
        if (hit) return { version, sawAssistant, forked, ...hit };
        end = i;
      }
      carry = joined.subarray(0, end);
    }
    const hit = look(carry.toString('utf8').trim());
    if (hit) return { version, sawAssistant, forked, ...hit };
    return { state: 'none', cost: null, version, sawAssistant, forked };
  } finally { await handle.close(); }
}

/**
 * readCostState の結果から、ターン開始時点の累計を決める。null は「分からない」（記録を null にする）。
 * mismatch は非公開形式の不一致として残す種類（core/backend-shape-diagnostics.mjs）
 * - 過去の発言が無い・分岐で写した会話・cost-state を書かない版の会話: CLI も 0 から数えるので 0
 * - cost-state を書く版なのに見つからない: 読めなかったのに再開した。数えすぎを防ぐため null
 */
export function decideCostBase(read) {
  if (read.state === 'found') return { cost: read.cost };
  if (read.state === 'broken') return { cost: null, mismatch: 'cost-state-shape' };
  if (!read.sawAssistant || read.forked) return { cost: ZERO_COST };
  if (versionBefore(read.version, COST_STATE_SINCE_VERSION) === true) return { cost: ZERO_COST };
  return { cost: null, mismatch: 'cost-state-missing' };
}
