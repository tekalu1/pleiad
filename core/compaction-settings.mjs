export const DEFAULT_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  minTokens: 150_000,
  claude: { enabled: true, delayMinutes: 50 },
  codex: { enabled: false, delayMinutes: 25 },
});

export function normalizeCompactionSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid auto compaction settings');
  const defaults = DEFAULT_COMPACTION_SETTINGS;
  const result = {
    enabled: input.enabled ?? defaults.enabled,
    minTokens: input.minTokens ?? defaults.minTokens,
  };
  if (typeof result.enabled !== 'boolean' || !Number.isInteger(result.minTokens) || result.minTokens < 1_000 || result.minTokens > 10_000_000)
    throw new Error('Invalid auto compaction settings');
  for (const id of ['claude', 'codex']) {
    const row = input[id] ?? {};
    result[id] = { enabled: row.enabled ?? defaults[id].enabled, delayMinutes: row.delayMinutes ?? defaults[id].delayMinutes };
    if (typeof result[id].enabled !== 'boolean' || !Number.isInteger(result[id].delayMinutes) || result[id].delayMinutes < 1 || result[id].delayMinutes > 10080)
      throw new Error('Invalid auto compaction settings');
  }
  return result;
}
