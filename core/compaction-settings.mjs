export const DEFAULT_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  minTokens: 150_000,
  delegatedTokens: 150_000,
  claude: { enabled: true, delayMinutes: 50 },
  codex: { enabled: false, delayMinutes: 25 },
});

// Claude Code の自動圧縮の閾値は min(floor(有効窓 × pct/100), 有効窓 − 13000)、有効窓 = 窓 − min(最大出力, 20000)。
// 環境変数 CLAUDE_CODE_AUTO_COMPACT_WINDOW（10 万〜100 万）を窓に使うと、閾値は W − 33000 になる（実測。docs/design.md「自動圧縮」）
export const AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const AUTO_COMPACT_WINDOW_MARGIN = 33_000;
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
/** delegatedTokens の下限（0 = オフを除く）。窓の下限 10 万 − 余白 3.3 万 = 6.7 万を切り上げた値（これ未満だと窓が 10 万に丸まり、閾値が 6.7 万より下がらない） */
export const DELEGATED_TOKENS_MIN = 70_000;

export function normalizeCompactionSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid auto compaction settings');
  const defaults = DEFAULT_COMPACTION_SETTINGS;
  const result = {
    enabled: input.enabled ?? defaults.enabled,
    minTokens: input.minTokens ?? defaults.minTokens,
    delegatedTokens: input.delegatedTokens ?? defaults.delegatedTokens,
  };
  if (typeof result.enabled !== 'boolean' || !Number.isInteger(result.minTokens) || result.minTokens < 1_000 || result.minTokens > 10_000_000)
    throw new Error('Invalid auto compaction settings');
  if (!Number.isInteger(result.delegatedTokens) || (result.delegatedTokens !== 0 && result.delegatedTokens < DELEGATED_TOKENS_MIN) || result.delegatedTokens > 10_000_000)
    throw new Error('Invalid auto compaction settings');
  for (const id of ['claude', 'codex']) {
    const row = input[id] ?? {};
    result[id] = { enabled: row.enabled ?? defaults[id].enabled, delayMinutes: row.delayMinutes ?? defaults[id].delayMinutes };
    if (typeof result[id].enabled !== 'boolean' || !Number.isInteger(result[id].delayMinutes) || result[id].delayMinutes < 1 || result[id].delayMinutes > 10080)
      throw new Error('Invalid auto compaction settings');
  }
  return result;
}

/**
 * 委譲の子の Claude の CLI に渡す CLAUDE_CODE_AUTO_COMPACT_WINDOW の値（文字列）。付けないときは null。
 * delegatedTokens が 0（オフ）、または利用者が process.env に同名を置いている（そちらを優先）なら付けない。
 */
export function delegatedCompactWindow(settings, env = process.env) {
  const tokens = settings?.delegatedTokens;
  if (!Number.isInteger(tokens) || tokens <= 0) return null;
  if (env?.[AUTO_COMPACT_WINDOW_ENV] != null && String(env[AUTO_COMPACT_WINDOW_ENV]).trim() !== '') return null;
  return String(Math.min(Math.max(tokens + AUTO_COMPACT_WINDOW_MARGIN, AUTO_COMPACT_WINDOW_MIN), AUTO_COMPACT_WINDOW_MAX));
}
