export const DEFAULT_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  minTokens: 150_000,
  delegatedHeadroom: 100_000,
  claude: { enabled: true, delayMinutes: 50 },
  codex: { enabled: false, delayMinutes: 25 },
});

// Claude Code の自動圧縮の閾値は min(floor(有効窓 × pct/100), 有効窓 − 13000)、有効窓 = 窓 − min(最大出力, 20000)。
// 環境変数 CLAUDE_CODE_AUTO_COMPACT_WINDOW（10 万〜100 万）を窓に使うと、閾値は W − 33000 になる（実測。docs/design.md「自動圧縮」）
export const AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const AUTO_COMPACT_WINDOW_MARGIN = 33_000;
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
/** 委譲の子の閾値の下限。窓の下限 10 万 − 余白 3.3 万 = 6.7 万を切り上げた値（これ未満だと窓が 10 万に丸まり、閾値が 6.7 万より下がらない） */
export const DELEGATED_TOKENS_MIN = 70_000;
/**
 * delegatedHeadroom の下限（0 = オフを除く）。圧縮した直後の文脈は固定の部分 + 要約で 1〜2 万多い（実測 2026-10-08: 固定 7.1 万 → 直後 8〜9 万）。
 * 空きがそれより小さいと、圧縮した直後にまた圧縮する
 */
export const DELEGATED_HEADROOM_MIN = 30_000;
export const DELEGATED_HEADROOM_MAX = 1_000_000;
/** 固定の部分（最初のリクエストの文脈）をまだ 1 度も測っていないときの見積もり（実測 2026-10-08: 7.1 万〜7.2 万） */
export const DEFAULT_CONTEXT_BASE = 70_000;

// 知らない項目は読まずに落とす。前の版の delegatedTokens（委譲の子の固定の閾値。ADR 0163）が prefs に残っていても、
// 読むときは無視し、次に保存するときに消える（ADR 0166）
export function normalizeCompactionSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid auto compaction settings');
  const defaults = DEFAULT_COMPACTION_SETTINGS;
  const result = {
    enabled: input.enabled ?? defaults.enabled,
    minTokens: input.minTokens ?? defaults.minTokens,
    delegatedHeadroom: input.delegatedHeadroom ?? defaults.delegatedHeadroom,
  };
  if (typeof result.enabled !== 'boolean' || !Number.isInteger(result.minTokens) || result.minTokens < 1_000 || result.minTokens > 10_000_000)
    throw new Error('Invalid auto compaction settings');
  const headroom = result.delegatedHeadroom;
  if (!Number.isInteger(headroom) || (headroom !== 0 && headroom < DELEGATED_HEADROOM_MIN) || headroom > DELEGATED_HEADROOM_MAX)
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
 * 閾値 threshold の委譲の子の Claude の CLI に渡す CLAUDE_CODE_AUTO_COMPACT_WINDOW の値（文字列）。付けないときは null。
 * 閾値が無い（0 以下）、または利用者が process.env に同名を置いている（そちらを優先）なら付けない。
 * 閾値は 70000 以上に上げ、窓は 10 万〜100 万に丸める
 */
export function delegatedCompactWindow(threshold, env = process.env) {
  if (!Number.isInteger(threshold) || threshold <= 0) return null;
  if (env?.[AUTO_COMPACT_WINDOW_ENV] != null && String(env[AUTO_COMPACT_WINDOW_ENV]).trim() !== '') return null;
  const tokens = Math.max(threshold, DELEGATED_TOKENS_MIN);
  return String(Math.min(Math.max(tokens + AUTO_COMPACT_WINDOW_MARGIN, AUTO_COMPACT_WINDOW_MIN), AUTO_COMPACT_WINDOW_MAX));
}

/** 固定の部分として使ってよい値（最初のリクエストの文脈のトークン数） */
export const validContextBase = (tokens) => Number.isInteger(tokens) && tokens > 0 && tokens < AUTO_COMPACT_WINDOW_MAX;

/**
 * 委譲の子のこのターンの自動圧縮（ADR 0166）。閾値 = 固定の部分 + 空き（delegatedHeadroom）。
 * base は { tokens, source }。source は own（その子自身の値）・same（同じ作業場所・同じモデルの直近）・recent（直近）・default（測った値が無い）。
 * 空きが 0（オフ）か、利用者の環境変数があれば null。threshold は CLI が実際に使う値（窓 − 33000。下限・上限で丸めた後）
 */
export function delegatedCompactPlan(settings, base, env = process.env) {
  const headroom = settings?.delegatedHeadroom;
  if (!Number.isInteger(headroom) || headroom <= 0) return null;
  const known = validContextBase(base?.tokens);
  const tokens = known ? base.tokens : DEFAULT_CONTEXT_BASE;
  const window = delegatedCompactWindow(tokens + headroom, env);
  if (!window) return null;
  return { threshold: Number(window) - AUTO_COMPACT_WINDOW_MARGIN, base: tokens, source: known ? base.source ?? 'recent' : 'default', headroom, window };
}
