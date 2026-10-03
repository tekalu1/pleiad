// Claude の使用量を、会話の累計（transcript の cost-state）からターンの分へ直す（ADR 0052）。
// - normalize: 開始時点を引く（モデルの切り替え・負の差分・開始 0・開始が分からない）
// - cost-state の読み取り: 無い・壊れている・末尾近く・分岐・古い版
// - runTurn: resume する前に transcript を読み、result の累計から引く（SDK は身代わり。LLM は呼ばない）
// - 移行: 結び付け・同じ値の続き・曖昧・結び付かない・写し・冪等
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { ZERO_COST, readCostState, decideCostBase, costStatesIn, claudeUsageDelta, versionBefore } from '../../core/backends/claude-cost-state.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { createUsageStore } from '../../core/usage.mjs';
import { fixClaudeCumulative, migrateClaudeUsage, CLAUDE_COST_DELTA, USAGE_BACKUP } from '../../core/usage-migrations.mjs';
import { readUsage, writeUsage } from '../lib/data-store.mjs';

export const name = 'claude-usage-delta';
export const title = 'Claude の使用量: 開始時点の累計（cost-state）からの差分・既存の記録の移行';

const model = (inputTokens, outputTokens, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests: 0, costUSD: 0 });
const costState = (totalCostUSD, modelUsage, extra = {}) => ({ type: 'cost-state', sessionId: 's', totalCostUSD, totalAPIDuration: 1, modelUsage, ...extra });
const result = (total_cost_usd, modelUsage, extra = {}) => ({ type: 'result', subtype: 'success', num_turns: 1, session_id: 'sess-1', total_cost_usd, modelUsage, ...extra });
const usageOf = events => events.find(e => e.type === 'usage');
const line = row => JSON.stringify(row);

export default async function (t) {
  // ---- normalize
  const base = { totalCostUSD: 1.5, modelUsage: { opus: model(100, 10, 1000, 50) } };
  const switched = normalizeSdkMessage(result(2.25, { opus: model(130, 15, 1500, 50), haiku: model(7, 3, 0, 20) }), { costBase: base });
  const u = usageOf(switched);
  t.ok('モデルごとに開始時点を引いてから合計する（途中で増えたモデルは 0 から）',
    u.inputTokens === 30 + 500 + 0 + 7 + 20 && u.outputTokens === 5 + 3 && u.cachedTokens === 500 && u.costUsd === 0.75, JSON.stringify(u));
  t.ok('会話のネイティブ id と開始・終了時点の累計を付ける',
    u.nativeSessionId === 'sess-1' && u.cumulativeStart.inputTokens === 1150 && u.cumulativeStart.costUsd === 1.5
      && u.cumulativeEnd.inputTokens === 1680 + 27 && u.cumulativeEnd.costUsd === 2.25, JSON.stringify(u));
  t.ok('turnResult.costUsd もこのターンの分', switched.find(e => e.type === 'turnResult').costUsd === 0.75);

  const back = usageOf(normalizeSdkMessage(result(1.4, { opus: model(120, 9, 1200, 50) }), { costBase: base }));
  t.ok('差分が負になった項目だけ null（累計が戻った）',
    back.outputTokens === null && back.costUsd === null && back.inputTokens === 20 + 200 && back.cachedTokens === 200, JSON.stringify(back));
  const dropped = usageOf(normalizeSdkMessage(result(2, { haiku: model(5, 5) }), { costBase: base }));
  t.ok('開始時点にあったモデルが消えたら、そのトークンは null', dropped.inputTokens === null && dropped.outputTokens === null && dropped.costUsd === 0.5);

  const fresh = usageOf(normalizeSdkMessage(result(0.25, { main: model(10, 5, 30, 20), sub: model(2, 3) })));
  t.ok('開始 0（新しい会話・既定）は累計そのまま', fresh.inputTokens === 62 && fresh.outputTokens === 8 && fresh.costUsd === 0.25 && fresh.cumulativeStart.costUsd === 0);
  const unknown = normalizeSdkMessage(result(9, { opus: model(1, 1) }), { costBase: null });
  t.ok('開始時点が分からなければ数値は全部 null（終了時点の累計は残す）',
    ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd'].every(k => usageOf(unknown)[k] === null) && usageOf(unknown).cumulativeStart === null
      && usageOf(unknown).cumulativeEnd.costUsd === 9 && unknown.find(e => e.type === 'turnResult').costUsd === null);
  const same = usageOf(normalizeSdkMessage(result(1.5, base.modelUsage), { costBase: base }));
  t.ok('API を呼ばなかったターン（失敗した圧縮など）は 0', same.inputTokens === 0 && same.outputTokens === 0 && same.costUsd === 0);
  const costOnly = usageOf(normalizeSdkMessage({ type: 'result', subtype: 'success', total_cost_usd: 3 }, { costBase: { totalCostUSD: 1, modelUsage: {} } }));
  t.ok('modelUsage が無ければ費用だけ', costOnly.costUsd === 2 && costOnly.inputTokens === null);
  t.ok('費用の小数の揺れを負と見なさない', claudeUsageDelta({ totalCostUSD: 0.30000000000000004, modelUsage: {} }, { totalCostUSD: 0.3, modelUsage: {} }).costUsd === 0);
  t.ok('usage の無い result は usage を出さない', !usageOf(normalizeSdkMessage({ type: 'result', subtype: 'success' })));

  // ---- cost-state の読み取り
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-cost-state-'));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  let restoreSdk = null;
  try {
    const write = async (name, rows) => { const file = path.join(dir, name); await fs.writeFile(file, rows.map(r => typeof r === 'string' ? r : line(r)).join('\n') + '\n'); return file; };
    const assistant = (version, extra = {}) => ({ type: 'assistant', version, message: { id: 'm', usage: { input_tokens: 1 }, content: [{ type: 'text', text: 'あいうえお'.repeat(50) }] }, ...extra });
    const user = text => ({ type: 'user', message: { content: text } });

    const empty = await readCostState(await write('empty.jsonl', [user('hi')]));
    t.ok('過去の発言も cost-state も無ければ 0', empty.state === 'none' && decideCostBase(empty).cost === ZERO_COST);

    const many = [user('cost-state を読む話（本文の中の語は拾わない）')];
    for (let i = 0; i < 40; i++) many.push(assistant('2.1.282'), costState(i, { opus: model(i, i) }));
    many.push(assistant('2.1.282'), user('"type":"cost-state" と本文に書いた'), assistant('2.1.282'));
    const near = await readCostState(await write('near.jsonl', many), { chunkBytes: 97 });
    t.ok('末尾から最後の cost-state を読む（小さな塊・多バイト文字をまたいでも）', near.state === 'found' && near.cost.totalCostUSD === 39 && near.cost.modelUsage.opus.inputTokens === 39, JSON.stringify(near));
    t.ok('ファイル全体からも同じ順で拾う（移行用）', costStatesIn(many.map(line).join('\n')).states.length === 40);

    const broken = await readCostState(await write('broken.jsonl', [assistant('2.1.282'), costState(1, { opus: model(1, 1) }), costState('x', { opus: { inputTokens: 'a' } }), assistant('2.1.282')]));
    t.ok('最後の cost-state の形が違えば分からない（形の不一致として残す）', broken.state === 'broken' && decideCostBase(broken).cost === null && decideCostBase(broken).mismatch === 'cost-state-shape');
    t.ok('壊れた cost-state は移行でも数える', costStatesIn([line(costState(1, { opus: model(1, 1) })), line(costState(2, 'x'))].join('\n')).broken === 1);

    const missing = await readCostState(await write('missing.jsonl', [user('a'), assistant('2.1.282')]));
    t.ok('cost-state を書く版なのに無い（読めなかったのに再開した）は分からない', decideCostBase(missing).cost === null && decideCostBase(missing).mismatch === 'cost-state-missing');
    const old = await readCostState(await write('old.jsonl', [user('a'), assistant('2.1.273')]));
    t.ok('cost-state を書かない版の会話は 0（CLI も 0 から数える）', decideCostBase(old).cost === ZERO_COST);
    const forked = await readCostState(await write('forked.jsonl', [user('a'), assistant('2.1.282', { forkedFrom: { sessionId: 'p', messageUuid: 'u' } })]));
    t.ok('分岐で写した会話（cost-state は写されない）は 0', decideCostBase(forked).cost === ZERO_COST);
    t.ok('版の比較', versionBefore('2.1.279', '2.1.280') === true && versionBefore('2.1.280', '2.1.280') === false && versionBefore('2.2.0', '2.1.280') === false && versionBefore(null, '2.1.280') === null);

    // ---- runTurn: resume する前に読み、result の累計から引く（圧縮・アカウント切替も同じ transcript の続き）
    process.env.CLAUDE_CONFIG_DIR = dir;
    await fs.mkdir(path.join(dir, 'projects', 'D--work'), { recursive: true });
    await fs.writeFile(path.join(dir, 'projects', 'not-a-dir.txt'), 'x');
    await fs.writeFile(path.join(dir, 'projects', 'D--work', 'sess-1.jsonl'),
      [user('a'), assistant('2.1.282'), costState(4, { opus: model(100, 10, 900) }), user('b')].map(line).join('\n') + '\n');
    const inbox = [];
    let options = null;
    restoreSdk = setClaudeSdkForTest({ executable: () => 'claude-fake', query: ({ prompt, options: o }) => {
      options = o;
      (async () => { for await (const _ of prompt) { /* 入力は読み捨てる */ } })();
      return { close() {}, interrupt: async () => ({}), async *[Symbol.asyncIterator]() { yield* inbox; } };
    } });
    const run = async (sessionId, messages) => {
      inbox.splice(0, inbox.length, ...messages);
      const events = [];
      await claude.runTurn({ prompt: 'x', sessionId, cwd: dir, mode: 'default', emit: e => events.push(e), askPermission: async () => ({ allow: true }), signal: new AbortController(), control: {}, hostSessionId: 'h' });
      return events;
    };
    const resumed = await run('sess-1', [
      result(5, { opus: model(110, 12, 1000) }, { subtype: 'success' }),
      result(6, { opus: model(120, 14, 1100) }),
    ]);
    const usages = resumed.filter(e => e.type === 'usage');
    t.ok('resume したターンは transcript の最後の cost-state から引く（1 つの query の result はどれも同じ開始時点から）',
      options?.resume === 'sess-1' && usages.length === 2 && usages[0].costUsd === 1 && usages[1].costUsd === 2 && usages[1].inputTokens === 20 + 200 && usages[1].outputTokens === 4,
      JSON.stringify(usages));
    t.ok('turnResult も開始時点からの費用', resumed.filter(e => e.type === 'turnResult').at(-1)?.costUsd === 2);
    const child = await run(null, [result(0.5, { haiku: model(3, 4) }, { session_id: 'new-1' })]);
    t.ok('新しい会話（子の会話を含む）は 0 から', usageOf(child).costUsd === 0.5 && usageOf(child).inputTokens === 3);
    const lost = await run('sess-missing', [result(7, { opus: model(1, 1) }, { session_id: 'sess-missing' })]);
    t.ok('transcript が見つからない会話は数値を null にする（数えすぎない）', usageOf(lost).costUsd === null && usageOf(lost).inputTokens === null);
  } finally {
    restoreSdk?.();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ---- 移行（純粋な関数）
  const since = Date.parse('2026-09-22T16:39:00Z');
  const cs = (cost, input, output, m = 'opus') => ({ totalCostUSD: cost, modelUsage: { [m]: model(input, output) } });
  const sessions = new Map([
    ['A', [cs(1, 100, 10), cs(3, 300, 30), cs(3, 300, 30), cs(4.5, 450, 40)]],
    ['B', [cs(2, 200, 20)]],
    ['C', [cs(2, 200, 20), cs(7, 700, 70)]],
  ]);
  const rec = (id, at, cost, input, output, extra = {}) => ({ id, backend: 'claude', at, inputTokens: input, outputTokens: output, cachedTokens: 0, costUsd: cost, ...extra });
  const records = [
    rec('old', since - 1000, 3, 300, 30),                  // 切り替え前（ターンの分で正しい）
    rec('a1', since + 1, 1, 100, 10),
    rec('a2', since + 2, 3, 300, 30),
    rec('a3', since + 3, 3, 300, 30),                        // 同じ値の続き（API を呼ばなかった）
    rec('a4', since + 4, 4.5, 450, 40),
    rec('amb', since + 5, 2, 200, 20),                       // B と C の両方に一致
    rec('c2', since + 6, 7, 700, 70),
    rec('none', since + 7, 9, 900, 90),                      // 一致する cost-state が無い
    rec('null', since + 8, null, null, null),
    { id: 'codex', backend: 'codex', at: since + 9, inputTokens: 5, outputTokens: 5, cachedTokens: 0, costUsd: null },
    rec('new', since + 10, 1, 100, 10, { nativeSessionId: 'A', cumulativeStart: null, cumulativeEnd: null }),   // 直した版が書いた記録
  ];
  const fixed = fixClaudeCumulative(records, sessions, { since });
  const by = id => fixed.records.find(r => r.id === id);
  t.ok('結び付いた記録は同じ会話の 1 つ前の cost-state からの差分になる',
    by('a1').costUsd === 1 && by('a2').costUsd === 2 && by('a2').inputTokens === 200 && by('a4').costUsd === 1.5 && by('a4').outputTokens === 10 && by('c2').costUsd === 5,
    JSON.stringify(fixed.records.map(r => [r.id, r.costUsd])));
  t.ok('同じ値が続いた記録は 0（前の記録と同じ cost-state を二度使わない）', by('a3').costUsd === 0 && by('a3').inputTokens === 0);
  t.ok('会話の id と元の累計を記録に残す', by('a2').nativeSessionId === 'A' && by('a2').cumulativeEnd.costUsd === 3 && by('a2').cumulativeStart.costUsd === 1);
  t.ok('候補が 2 つ以上・結び付かない・切り替え前・他のバックエンド・直した版の記録は触らない',
    ['amb', 'none', 'null', 'old', 'codex', 'new'].every(id => by(id) === records.find(r => r.id === id)) && fixed.fixed === 5 && fixed.ambiguous === 1 && fixed.unlinked === 2,
    JSON.stringify({ fixed: fixed.fixed, ambiguous: fixed.ambiguous, unlinked: fixed.unlinked }));

  // ---- 移行（起動時。写し・冪等）
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-usage-migrate-'));
  const others = [];
  try {
    const projects = path.join(data, 'projects');
    await fs.mkdir(path.join(projects, 'D--work'), { recursive: true });
    const transcript = [...sessions.get('A').map(s => costState(s.totalCostUSD, s.modelUsage))].map(line).join('\n');
    await fs.writeFile(path.join(projects, 'D--work', 'A.jsonl'), transcript + '\n');
    const store = createUsageStore(data);
    t.ok('記録が無ければ何もしない', await migrateClaudeUsage({ store, projects, since }) === null);
    const original = { version: 1, since: since - 5000, records: records.filter(r => ['old', 'a1', 'a2', 'a3', 'a4'].includes(r.id)) };
    writeUsage(data, original);
    const first = await migrateClaudeUsage({ store, projects, since });
    const after = readUsage(data);
    const backup = JSON.parse(await fs.readFile(path.join(data, USAGE_BACKUP), 'utf8'));
    t.ok('書き直す前の記録を写しに残し、直した件数を返す', first?.fixed === 4 && first.unlinked === 0 && JSON.stringify(backup.records) === JSON.stringify(original.records) && backup.since === original.since, JSON.stringify(first));
    t.ok('直した記録の合計は実際の分', after.records.filter(r => r.at >= since).reduce((n, r) => n + r.costUsd, 0) === 4.5 && after.migrations.includes(CLAUDE_COST_DELTA));
    const summaryStore = createUsageStore(data, { now: () => since + 3600_000 });
    others.push(summaryStore);
    const summary = await summaryStore.summary('claude');
    t.ok('画面の集計（summary）は直した値を足す', summary.sevenDay.costUsd.value === 3 + 4.5 && summary.sevenDay.inputTokens.value === 300 + 450, JSON.stringify(summary.sevenDay));
    await fs.writeFile(path.join(projects, 'D--work', 'A.jsonl'), transcript + '\n' + line(costState(99, { opus: model(1, 1) })) + '\n');
    t.ok('やり直しても二重に直さない（済みの印）', await migrateClaudeUsage({ store, projects, since }) === null
      && JSON.stringify(readUsage(data)) === JSON.stringify(after));
    await store.record({ id: 'later', backend: 'claude', inputTokens: 1, nativeSessionId: 'A', cumulativeStart: { inputTokens: 1 }, cumulativeEnd: { costUsd: 'x' } });
    const later = readUsage(data).records.at(-1);
    t.ok('記録は会話の id と累計（数値だけ）を残す', later.nativeSessionId === 'A' && later.cumulativeStart.inputTokens === 1 && later.cumulativeEnd.costUsd === null);

    const fresh = createUsageStore(path.join(data, 'fresh'));
    others.push(fresh);
    await fresh.record({ id: 'x', backend: 'claude', costUsd: 1 });
    t.ok('新しく作る記録は最初から移行済み', readUsage(path.join(data, 'fresh')).migrations.includes(CLAUDE_COST_DELTA)
      && await migrateClaudeUsage({ store: fresh, projects, since }) === null);
    others.push(store);
  } finally { for (const s of others) await s.close(); await fs.rm(data, { recursive: true, force: true }); }
}
