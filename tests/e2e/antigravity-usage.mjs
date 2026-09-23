import assert from 'node:assert/strict';
export const name = 'antigravity-usage';
export const title = '実アカウントの Antigravity 使用枠（推論なし）';
export const serverEnv = { AGENT_HOST_BACKENDS: 'antigravity' };
export default async function(t, ctx) {
  const client = await ctx.open();
  try {
    const result = await client.cmd('providerUsage', { backend: 'antigravity' });
    assert.ok(result.quota.checkedAt, '使用枠取得に失敗');
    assert.ok(result.quota.windows.length, result.quota.message);
    assert.ok(result.quota.windows.some(w => w.minutes === 300));
    assert.ok(result.quota.windows.some(w => w.minutes === 10080));
    assert.equal(result.local.fiveHour.turns, 0);
    assert.ok(!/access_token|refresh_token|Bearer/.test(JSON.stringify(result)));
    t.ok('実CLIから5時間・週次の枠を取得し、推論実績・資格情報を返さない', true);
  } finally { client.close(); }
}
