export function codexLimitError(error) {
  const message = String(error?.message ?? error?.type ?? error ?? '');
  return /(?:usage|rate|request) limit|quota|too many requests/i.test(message);
}

/**
 * Codex の上限の解除時刻。使い切った（100%）枠のうち、最も遅く解ける時刻を使う
 * （週の枠も尽きているのに 5 時間枠の解除で再開しても、また上限になる）。
 * 100% の枠が無い（どれが原因か分からない）ときは、一番早く解ける枠。どちらも無ければ null
 */
export function codexResetOf(windows, now = Date.now()) {
  const future = (windows ?? []).map(w => ({ w, at: Date.parse(w?.resetsAt) })).filter(x => Number.isFinite(x.at) && x.at > now);
  const used = future.filter(x => x.w.usedPercent >= 100);
  const pick = (used.length ? used : future).sort((a, b) => (used.length ? b.at - a.at : a.at - b.at))[0];
  return pick ? { resetsAt: pick.at, window: pick.w.label ?? null } : null;
}
