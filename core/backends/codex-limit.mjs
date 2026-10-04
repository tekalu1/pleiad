export function codexLimitError(error) {
  const message = String(error?.message ?? error?.type ?? error ?? '');
  return /(?:usage|rate|request) limit|quota|too many requests/i.test(message);
}

const squash = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * そのモデルに効く Codex の枠。主の枠（limitId が codex か無し）と、名前がそのモデルに当たる追加のバケット
 * （GPT-5-Codex-Spark など。モデルが分からなければ主の枠だけ）。別のバケットが 100% でも、主の枠を使う会話には関係ない
 */
export function codexBucket(windows, model) {
  const wanted = squash(model);
  return (Array.isArray(windows) ? windows : []).filter(w => {
    if (!w?.limitId || w.limitId === 'codex') return true;
    const name = squash(w.limitName || w.limitId);
    return Boolean(wanted && name && wanted.includes(name));
  });
}

/**
 * Codex の上限の解除時刻。そのモデルに効く枠のうち、使い切った（100%）枠の最も遅く解ける時刻を使う
 * （週の枠も尽きているのに 5 時間枠の解除で再開しても、また上限になる）。
 * 100% の枠が無い（どれが原因か分からない）ときは、一番早く解ける枠。どちらも無ければ null
 */
export function codexResetOf(windows, now = Date.now(), model = '') {
  const future = codexBucket(windows, model).map(w => ({ w, at: Date.parse(w?.resetsAt) })).filter(x => Number.isFinite(x.at) && x.at > now);
  const used = future.filter(x => x.w.usedPercent >= 100);
  const pick = (used.length ? used : future).sort((a, b) => (used.length ? b.at - a.at : a.at - b.at))[0];
  return pick ? { resetsAt: pick.at, window: pick.w.label ?? null } : null;
}
