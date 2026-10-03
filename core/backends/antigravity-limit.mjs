// Antigravity の使用量の上限のエラーを見分ける（ADR 0119）。agy は上限を普通の失敗（`result.status` が SUCCESS 以外・`result.error` に英語の文）で返す。
// 例（2026-10-04 の実物）: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h14m6s."
// これを Claude・Codex と同じ turnResult の limited（解除の時刻つき）にそろえる（core/backends/antigravity.mjs の turnResultFor）。
//
//   antigravityLimit(text, now) → { resetsAt: number|null } | null   … 上限の文でなければ null。解除の時刻は「Resets in 4h14m6s」から（無ければ null）

const LIMIT_RX = /\bquota (?:reached|exceeded|exhausted)\b|\bresource[_ ]exhausted\b|\brate limit(?:ed| reached| exceeded)?\b|\busage limit\b/i;
const RESETS_RX = /\bresets? in\s+((?:\d+\s*[dhms]\s*)+)/i;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

export function antigravityLimit(text, now = Date.now()) {
  const s = String(text ?? '');
  if (!LIMIT_RX.test(s)) return null;
  const span = s.match(RESETS_RX)?.[1];
  if (!span) return { resetsAt: null };
  let ms = 0;
  for (const [, n, unit] of span.matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(n) * UNIT_MS[unit.toLowerCase()];
  return { resetsAt: ms > 0 ? now + ms : null };
}
