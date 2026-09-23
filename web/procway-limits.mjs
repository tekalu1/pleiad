// Shared validation; null means preserve the provider's existing behavior.
export function validateLimits(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('容量設定が不正です');
  const out = {};
  for (const key of ['context', 'output', 'threshold', 'keep', 'recent', 'chars']) {
    const n = value[key];
    if (n == null || n === '') { out[key] = null; continue; }
    if (!Number.isSafeInteger(n) || n < 1 || n > 100_000_000) throw new Error('容量・保持件数は 1〜100,000,000 の整数で指定してください');
    out[key] = n;
  }
  for (const key of ['compact', 'condense']) {
    if (value[key] != null && typeof value[key] !== 'boolean') throw new Error('容量設定のオン・オフが不正です');
    out[key] = value[key] ?? null;
  }
  if (out.context && !out.output) throw new Error('コンテキスト長を指定するときは、出力に予約するトークン数も指定してください');
  if (out.context && out.output >= out.context) throw new Error('最大出力は最大コンテキスト長より小さくしてください');
  if (out.compact === true && !out.threshold) throw new Error('自動要約の開始トークン数を指定してください');
  if (out.compact && out.context && out.threshold >= out.context - out.output) throw new Error('要約開始は出力予約を差し引いた入力予算より小さくしてください');
  return out;
}
