// Native boundaries are the history source. Sidecar records add details and cover missing boundaries.
export function mergeCompactionHistory(nativeEntries = [], savedEntries = []) {
  const unused = new Set(savedEntries);
  const near = (a, b) => Number.isFinite(a.at) && Number.isFinite(b.at)
    && Math.abs(a.at - b.at) <= 2 * 60_000;
  const score = (native, saved) => {
    if (saved.phase !== 'complete') return -1;
    if (native.nativeId && saved.nativeId && native.nativeId !== saved.nativeId) return -1;
    if (native.nativeId && saved.nativeId === native.nativeId) return 3;
    if (native.turnId && saved.turnId) return native.turnId === saved.turnId ? 2 : -1;
    return near(native, saved) ? 1 : -1;
  };
  const merged = nativeEntries.map(native => {
    let match = null, best = -1, distance = Infinity;
    for (const saved of unused) {
      const candidate = score(native, saved);
      const candidateDistance = Math.abs(Number(native.at) - Number(saved.at)) || 0;
      if (candidate > best || (candidate === best && candidate >= 0 && candidateDistance < distance)) {
        best = candidate; distance = candidateDistance; match = saved;
      }
    }
    if (!match || best < 0) return native;
    unused.delete(match);
    return { ...native, ...match, id: native.id, nativeId: native.nativeId, at: native.at, phase: native.phase };
  });
  return [...merged, ...unused].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}

/**
 * 圧縮の要約の発言（core/system-messages.mjs の kind: 'compactSummary'）を区切りに入れる（ADR 0052）。
 * 区切りの uuid が分かれば（transcript の印）それに、分からなければ区切りの直後（前後 2 分）の要約とみなす。
 * 合う区切りが無い（CLI の自動圧縮を保存分で読んだなど）ときは、要約から自動の区切りを作る。
 * 区切りが既に要約を持っていれば（Pleiad の PostCompact で受け取った分）、そちらを残す。
 */
export function attachCompactSummaries(summaries = [], compactions = []) {
  const list = compactions.map(entry => ({ ...entry }));
  const claimed = new Set();
  for (const m of summaries) {
    if (m?.kind !== 'compactSummary' || !m.summary) continue;
    const at = Date.parse(m.at ?? '');
    let target = m.boundary ? list.find(entry => entry.nativeId === m.boundary) : null;
    if (!target && Number.isFinite(at)) {
      target = list.filter(entry => entry.phase === 'complete' && !claimed.has(entry) && Number.isFinite(entry.at)
        && Math.abs(at - entry.at) <= 2 * 60_000)
        .sort((a, b) => Math.abs(at - a.at) - Math.abs(at - b.at))[0] ?? null;
    }
    if (target) { claimed.add(target); target.summary ??= m.summary; continue; }
    const entry = { id: `summary:${m.uuid ?? at}`, phase: 'complete', trigger: 'auto', at: Number.isFinite(at) ? at : 0, summary: m.summary };
    claimed.add(entry);
    list.push(entry);
  }
  return list.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}
