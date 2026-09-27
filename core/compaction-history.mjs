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
