import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexQuota, whamQuota, claudeQuota, usageWindow, createQuotaCache, createUsageStore, createCodexMeter } from '../../core/usage.mjs';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { quotaText } from '../../web/usage.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
export const name = 'usage';
export const title = '使用枠・残量・欠損・重複通知・記録の永続化';
export default async function(t) {
  assert.equal(usageWindow('5h', null, null, 300).remainingPercent, null);
  assert.equal(usageWindow('5h', 0, null, 300).remainingPercent, 100);
  assert.equal(usageWindow('5h', 110, null, 300).remainingPercent, 0);
  assert.equal(usageWindow('5h', '20', 'bad', 300).usedPercent, null);
  const quota = codexQuota({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 60, windowDurationMins: 10080 } },
    spark: { limitName: 'Spark', primary: { usedPercent: 0, windowDurationMins: 15 } },
  } });
  assert.equal(quota.windows.length, 3);
  assert.equal(quota.windows[0].remainingPercent, 80);
  assert.equal(quota.windows[0].resetsAt, new Date(1800000000000).toISOString());
  assert.equal(quota.windows[2].minutes, 15);
  assert.equal(codexQuota({}).windows.length, 0);
  assert.equal(whamQuota({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1800000000 } } }).windows[0].remainingPercent, 60);
  assert.equal(claudeQuota({ subscription_type: 'max', rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 30 }, model_scoped: [{ display_name: 'Fable', utilization: 97 }] } }).windows[2].remainingPercent, 3);
  assert.match(quotaText(usageWindow('5h', 20, '2020-01-01', 300)), /更新待ち/);
  t.ok('欠損を0とせず、複数枠・秒の時刻・モデル別枠を表示する', true);

  const meter = createCodexMeter();
  const usage = (total, last) => ({ total: { inputTokens: total, outputTokens: total, cachedInputTokens: 0 }, last: { inputTokens: last, outputTokens: last, cachedInputTokens: 0 } });
  assert.equal(meter(usage(110, 10)).inputTokens, 10);
  assert.equal(meter(usage(110, 10)).inputTokens, 10);
  assert.equal(meter(usage(150, 40)).inputTokens, 50);
  assert.equal(meter(usage(20, 20)).inputTokens, 70);
  const events = normalizeSdkMessage({ type: 'result', subtype: 'success', total_cost_usd: .25,
    modelUsage: { main: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 30, cacheCreationInputTokens: 20 }, subagent: { inputTokens: 2, outputTokens: 3 } } });
  assert.equal(events.find(e => e.type === 'usage').inputTokens, 62);
  assert.equal(events.find(e => e.type === 'usage').outputTokens, 8);
  t.ok('Codex累積値の過去分・重複を除外し、Claudeはモデル集計を使う', true);

  let now = 100000, calls = 0;
  const cache = createQuotaCache({ now: () => now });
  const fetcher = async () => { calls++; return { windows: [] }; };
  await Promise.all([cache('codex', fetcher), cache('codex', fetcher)]);
  await cache('codex', fetcher); assert.equal(calls, 1);
  now += 61000; await cache('codex', fetcher); assert.equal(calls, 2);
  cache.clear(); await cache('codex', fetcher); assert.equal(calls, 3);
  const failed = await cache('bad', () => { throw new Error('Bearer secret'); });
  assert.equal(failed.checkedAt, null); assert.ok(!JSON.stringify(failed).includes('secret'));
  t.ok('同時取得を共有し、キャッシュ期限と認証変更を反映する', true);


  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-usage-'));
  let server, client;
  try {
    let at = Date.now(); const store = createUsageStore(dir, { now: () => at });
    await Promise.all([store.record({ id: 'a', backend: 'codex', inputTokens: 12 }), store.record({ id: 'b', backend: 'claude', costUsd: .5 })]);
    await store.record({ id: 'a', backend: 'codex', inputTokens: 99 });
    const restored = createUsageStore(dir, { now: () => at });
    assert.equal((await restored.summary('codex')).fiveHour.inputTokens.value, 12);
    assert.equal((await restored.summary('codex')).fiveHour.costUsd.value, null);
    at += 6 * 3600000;
    assert.equal((await restored.summary('codex')).fiveHour.turns, 0);
    assert.equal((await restored.summary('codex')).sevenDay.turns, 1);
    server = await startServer({ dataDir: path.join(dir, 'server'), env: { AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: `node "${path.resolve('tests/lib/fake-codex.mjs')}"` } });
    client = await open({ port: server.port, token: server.token, autoAllow: true });
    await assert.rejects(client.cmd('providerUsage', { backend: 'invalid' }));
    await client.runTurn({ backend: 'codex', prompt: 'hello', cwd: dir }, { ms: 15000 });
    const result = await client.cmd('providerUsage', { backend: 'codex' });
    assert.equal(result.local.fiveHour.inputTokens.value, 10);
    assert.equal(result.local.fiveHour.outputTokens.value, 5);
    assert.equal(result.local.fiveHour.costUsd.value, null);
    t.ok('再起動・期間境界・エージェント別集計とWebSocket経路を検証', true);
  } finally { client?.close(); await server?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}
