import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutable } from '../cli-installation.mjs';
import { claudeQuota } from '../usage.mjs';
import { claudeEnv, redactToken, TOKEN_ENV } from '../claude-accounts.mjs';

/**
 * 使用量を読むプロセスの env。
 *   configDir あり … 登録したアカウントの使用量。そのアカウント専用の設定フォルダ（`claude auth login` 済み）を
 *                    CLAUDE_CONFIG_DIR にし、会話用のトークン（CLAUDE_CODE_OAUTH_TOKEN）は外す。
 *                    setup-token のトークンは scope が user:inference だけで使用量を読めない（2026-09-23 確認）ため。
 *   無し          … ログイン中のアカウント（今までどおり）
 */
export function usageEnv(base = process.env, { token, configDir } = {}) {
  if (!configDir) return claudeEnv(base, { token, extra: { CLAUDECODE: undefined } });
  const env = claudeEnv(base, { extra: { CLAUDECODE: undefined } });
  for (const key of Object.keys(env)) if ([TOKEN_ENV, 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// A control-only query: no prompt is yielded and no inference request is made.
// Keep stdin open until get_usage completes, then close the owned process.
export async function readClaudeUsage({ token, configDir } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const q = query({ prompt: (async function* () { await gate; })(), options: {
    pathToClaudeCodeExecutable: claudeExecutable(), persistSession: false,
    settingSources: ['user'], tools: [], mcpServers: {}, settings: { disableAllHooks: true },
    env: usageEnv(process.env, { token, configDir }),
  } });
  let timer;
  try {
    const result = await Promise.race([
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('使用量の取得が時間切れです')), 20_000); }),
    ]);
    return claudeQuota(result);
  } finally { clearTimeout(timer); release(); q.close(); }
}

export const NEEDS_USAGE_LOGIN = '使用量を表示するには、設定の「Claude のアカウント」で「使用量の表示を認可」を済ませてください。';

/**
 * 登録したアカウントがあるときの使用量。どのアカウントの値かが分かるよう、アカウントごとに見出しを付けて並べる
 * （web/usage.mjs の quota.accounts）。登録が無ければ今までどおりログイン中のアカウントの値だけを返す。
 *
 * accounts: [{ id, name, configDir, usageLogin }]（core/claude-accounts.mjs の usageTargets）。
 * 使用量の認可が済んでいないアカウントは読みに行かず、認可を促す（needsUsageLogin）。
 * 1 件が取れなくても他は出す。エラーメッセージからはトークンを伏せる。
 */
export async function readClaudeAccountsUsage({ accounts = [], loginLabel = 'ログイン中のアカウント', read = readClaudeUsage } = {}) {
  if (!accounts.length) return read({});
  const login = async () => {
    try { return { label: loginLabel, ...(await read({})) }; }
    catch (e) { return { label: loginLabel, windows: [], message: `取得できませんでした: ${redactToken(e?.message ?? e)}` }; }
  };
  const one = async a => {
    const base = { label: a.name, accountId: a.id ?? null };
    if (a.error) return { ...base, windows: [], message: a.error };
    if (!a.usageLogin || !a.configDir) return { ...base, windows: [], needsUsageLogin: true, message: NEEDS_USAGE_LOGIN };
    try { return { ...base, ...(await read({ configDir: a.configDir })) }; }
    catch (e) {
      const text = String(e?.message ?? e).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[トークン]');
      return { ...base, windows: [], reauth: true, message: `取得できませんでした: ${text}。続くときは「使用量の表示を認可」をやり直してください。` };
    }
  };
  const rows = await Promise.all([login(), ...accounts.map(one)]);
  return { windows: [], accounts: rows, message: null };
}
