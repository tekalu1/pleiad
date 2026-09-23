import assert from 'node:assert/strict';
export const name = 'usage';
export const title = '実アカウントの使用枠（推論を実行しない）';
export default async function(t, ctx) {
  const client = await ctx.open();
  try {
    for (const backend of ['codex', 'claude']) {
      const result = await client.cmd('providerUsage', { backend });
      assert.equal(result.backend, backend);
      assert.ok(result.quota.checkedAt, `${backend}: 使用枠取得に失敗`);
      assert.ok(Array.isArray(result.quota.windows));
      assert.ok(result.quota.windows.length, `${backend}: サブスクの枠を取得できません`);
      assert.ok(!/access_token|refresh_token|Bearer/.test(JSON.stringify(result)));
      t.ok(`${backend}: 使用量を取得し、資格情報を返さない`, true);
    }
  } finally { client.close(); }
}
