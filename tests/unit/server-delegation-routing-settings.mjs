// 設定の保存と使用量の再取得は独立。偽の agy の使用量だけを遅らせ、実サービスは呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-routing-settings';
export const title = '委譲の設定保存は使用量を待たず、必要なときだけ裏で取り直す';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-routing-settings-'));
  await fs.writeFile(path.join(scratch, 'prefs.json'), JSON.stringify({ delegationRouting: { enabled: false } }));
  const server = await startServer({ dataDir: scratch, env: {
    AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"`,
    FAKE_AGY_EXTRA_MODELS: 'gemini-3.8-flash-high,gemini-3.8-pro-high',
    FAKE_AGY_USAGE_DELAY_MS: '1200', AGENT_HOST_ROUTING_USAGE: 'on',
  } });
  const c = await open({ port: server.port, token: server.token });
  const usageEvent = e => e.type === 'delegationRoutingChanged' && e.change === 'usage';
  try {
    const before = c.mark();
    const started = Date.now();
    const on = await c.cmd('setDelegationRouting', { settings: { enabled: true } });
    t.ok('ON の保存は使用量の取得完了を待たない', on.settings.enabled && Date.now() - started < 800 && !c.since(before).some(usageEvent));
    await c.waitFor(usageEvent, { from: before, ms: 10000 });
    const afterOn = c.mark();
    await c.cmd('setDelegationRouting', { settings: { judgeByKind: { trivial: 'none' } } });
    await sleep(250);
    t.ok('判定器だけの変更は使用量を取り直さない', !c.since(afterOn).some(usageEvent));

    const beforeCandidate = c.mark();
    const candidateStarted = Date.now();
    const changed = await c.cmd('setDelegationRouting', { settings: { tiers: { t1: ['antigravity:gemini-3.8-flash-high', 'antigravity:gemini-3.8-pro-high'] } } });
    t.ok('候補を増やした保存も使用量を待たない', changed.settings.tiers.t1.includes('antigravity:gemini-3.8-pro-high') && Date.now() - candidateStarted < 800);
    await c.waitFor(usageEvent, { from: beforeCandidate, ms: 10000 });
    const afterCandidate = c.mark();
    await c.cmd('setDelegationRouting', { settings: { avoidPercent: 79 } });
    await c.cmd('setDelegationRouting', { settings: { tiers: { t1: ['antigravity:gemini-3.8-flash-high'] } } });
    await sleep(250);
    t.ok('使用量の方針の変更と候補の削除は取り直さない', !c.since(afterCandidate).some(usageEvent));
  } finally {
    c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true });
  }
}
