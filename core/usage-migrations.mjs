// usage.json の移行（一度だけ）。
//
// claude-cost-delta: 同梱の CLI が 2.1.280 になった 2026-09-22 16:39Z から、Claude の記録には会話全体の累計が入っていた
// （resume のたびに CLI が transcript の cost-state を読み戻すため。core/backends/claude-cost-state.mjs）。
// 記録の値と transcript の cost-state（totalCostUSD と modelUsage の合計）が完全に一致するものを会話に結び付け、
// その cost-state の 1 つ前（CLI がそのターンの開始時に読み戻した値）からの差分に置き換える。
// 候補の会話が 2 つ以上あるもの・結び付かないものは触らない。書き直す前の usage.json は usage.v1-backup.json に写す
// （ADR 0052）。済んだ移行は usage.json の migrations に残し、二度は直さない。
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { usageTotals, claudeUsageDelta, costStatesIn, ZERO_COST } from './backends/claude-cost-state.mjs';

export const CLAUDE_COST_DELTA = 'claude-cost-delta';
// SDK 経由の transcript に cost-state が最初に書かれた時刻（CLI 2.1.280）。これより前の記録はターンの分で正しい
export const CLAUDE_CUMULATIVE_SINCE = Date.parse('2026-09-22T16:39:00Z');
export const USAGE_BACKUP = 'usage.v1-backup.json';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const keyOf = t => `${t.costUsd.toFixed(6)}/${t.inputTokens}/${t.outputTokens}`;
const affected = (r, since) => r?.backend === 'claude' && finite(r.at) && r.at >= since && !r.nativeSessionId;
const linkable = r => finite(r.costUsd) && r.costUsd > 0 && finite(r.inputTokens) && finite(r.outputTokens);

/**
 * 記録を直す（純粋な関数）。sessions は 会話のネイティブ id -> その transcript の cost-state（書かれた順）。
 * 同じ会話で同じ値の cost-state が続く（API を呼ばなかったターン）ときは、記録の時刻順に前から割り当てる
 */
export function fixClaudeCumulative(records, sessions, { since = CLAUDE_CUMULATIVE_SINCE } = {}) {
  const index = new Map();   // 値 -> [{ sid, idx }]
  for (const [sid, states] of sessions) states.forEach((state, idx) => {
    const totals = usageTotals(state);
    if (totals.costUsd == null || totals.inputTokens == null) return;
    const key = keyOf(totals);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ sid, idx });
  });
  const next = records.slice();
  const used = new Map();    // sid -> 最後に割り当てた cost-state の番号
  let fixed = 0, unlinked = 0, ambiguous = 0;
  const order = records.map((r, i) => i).filter(i => affected(records[i], since)).sort((a, b) => records[a].at - records[b].at || a - b);
  for (const i of order) {
    const r = records[i];
    const candidates = linkable(r) ? index.get(keyOf(r)) ?? [] : [];
    const sids = new Set(candidates.map(c => c.sid));
    if (sids.size > 1) { ambiguous++; continue; }
    const [sid] = sids;
    const hit = candidates.find(c => c.idx > (used.get(sid) ?? -1));
    if (!hit) { unlinked++; continue; }
    used.set(sid, hit.idx);
    const states = sessions.get(sid), end = states[hit.idx], start = hit.idx > 0 ? states[hit.idx - 1] : ZERO_COST;
    next[i] = { ...r, ...claudeUsageDelta(end, start), nativeSessionId: sid, cumulativeStart: usageTotals(start), cumulativeEnd: usageTotals(end) };
    fixed++;
  }
  return { records: next, fixed, unlinked, ambiguous };
}

/**
 * projects の下の transcript（<projects>/<何か>/<sessionId>.jsonl）から cost-state を集める。
 * since より前に最後に書かれたファイルは、対象の記録の cost-state を含まないので読まない
 */
export async function readClaudeCostStates(projects, { since = CLAUDE_CUMULATIVE_SINCE } = {}) {
  const sessions = new Map();
  let broken = 0;
  const dirs = await fs.readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const files = await fs.readdir(path.join(projects, dir.name), { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const full = path.join(projects, dir.name, file.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs < since) continue;
      const text = await fs.readFile(full, 'utf8').catch(() => null);
      if (!text?.includes('"cost-state"')) continue;
      const found = costStatesIn(text);
      broken += found.broken;
      const sid = file.name.slice(0, -'.jsonl'.length);
      if (found.states.length > (sessions.get(sid)?.length ?? 0)) sessions.set(sid, found.states);
    }
  }
  return { sessions, broken };
}

/**
 * 起動時の移行。usage.json が無い・済んでいるときは null（transcript を読まない）。
 * 直した結果 { fixed, unlinked, ambiguous, broken } を返す。store は createUsageStore（書き込みを直列にする）
 */
export async function migrateClaudeUsage({ store, projects, since = CLAUDE_CUMULATIVE_SINCE }) {
  let current;
  try { current = JSON.parse(await fs.readFile(store.file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (current?.migrations?.includes(CLAUDE_COST_DELTA)) return null;
  const needed = Array.isArray(current?.records) && current.records.some(r => affected(r, since));
  const { sessions, broken } = needed ? await readClaudeCostStates(projects, { since }) : { sessions: new Map(), broken: 0 };
  return store.update(async data => {
    if (data.migrations?.includes(CLAUDE_COST_DELTA)) return null;
    // 書き直す前の写し。前回の移行が途中で止まって写しが既にあるなら、古い（元の）方を残す
    await fs.copyFile(store.file, path.join(path.dirname(store.file), USAGE_BACKUP), constants.COPYFILE_EXCL)
      .catch(e => { if (e.code !== 'EEXIST') throw e; });
    const { records, ...result } = fixClaudeCumulative(data.records, sessions, { since });
    return { data: { ...data, migrations: [...(data.migrations ?? []), CLAUDE_COST_DELTA], records }, result: { ...result, broken } };
  });
}
