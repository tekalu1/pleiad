import { nativeSettings } from '../procway-config.mjs';
import { readProfile } from '../auth/procway-token-store.mjs';
import { whamQuota } from '../usage.mjs';

export async function readProcwayUsage({ cwd } = {}, { settings = nativeSettings, profile = readProfile, fetchImpl = fetch } = {}) {
  const native = await settings(cwd);
  const cliBackends = [...new Set(Object.values(native.settings.providers ?? {})
    .filter(p => p.type === 'cli-agent' && ['codex', 'claude'].includes(p.command))
    .map(p => p.command === 'codex' ? 'Codex' : 'Claude Code'))];
  const cliNote = cliBackends.length
    ? `${cliBackends.join('・')} CLI 接続のサブスク枠は実行先のアカウントに属します。同じログイン設定なら上の各エージェント欄で確認できます。`
    : '';
  const providers = Object.values(native.settings.providers ?? {}).filter(p => p.type === 'openai-codex');
  const ids = [...new Set(providers.map(p => p.authProfile || 'codex'))];
  // Pleiad's built-in ChatGPT login uses the codex profile even before a native
  // provider entry has been added. API/CLI connections have no universal quota API.
  if (!ids.includes('codex')) ids.push('codex');
  const accounts = [];
  for (const id of ids) {
    const p = await profile(id);
    if (!p || p.provider !== 'openai-codex' || p.mode !== 'oauth') continue;
    const c = p.credentials;
    if (!c?.access || !c.accountId || !(c.expires > Date.now())) {
      accounts.push({ label: `ChatGPT (${id})`, windows: [], message: '認証の有効期限が切れています。procway code で接続を更新してから再取得してください。' });
      continue;
    }
    // Fixed official origin, no redirects. Never return credentials or raw errors.
    const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${c.access}`, 'ChatGPT-Account-Id': c.accountId, 'User-Agent': 'codex-cli' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('ChatGPT の使用量を取得できません');
    accounts.push({ label: `ChatGPT (${id})`, ...whamQuota(await response.json()) });
  }
  return { windows: [], accounts, message: cliNote + (accounts.length
    ? 'ChatGPT アカウント全体の枠です。同じアカウントを使う Codex と共有され、合算できません。API・CLI 接続の残量は各接続先で確認してください。'
    : 'API 接続の残量は各接続先で確認してください。procway 専用の ChatGPT ログインがある場合は、その枠もここに表示します。') };
}
