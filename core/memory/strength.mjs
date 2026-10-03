// 記憶の強さ（ADR 0118）。人の記憶に寄せて、強さ ＝ 重み（印象 1〜3）× 新しさ（半減期で薄れる）。
// 強さは保存しない（読むたびに今の時刻から計算する）。保存するのは行のメタの種類 k・重み w・状態 st だけ（store.mjs）。
//   種類 … stop（やめたこと）・promise（約束）・decision（決めたこと）・share（分担）・pref（好み・直し）・note（その他）。無い行は「種類なし」
//   重み … 1〜3。行に w が無ければ、人が書いた行は 3、それ以外は種類の既定（種類なしは 2）
//   半減期 … 人が書いた・直した行（by.kind === 'human'）と、やめたこと・まだの約束は薄れない。済んだ約束は 7 日
// 薄れた記憶（強さが FADED_BELOW 未満）は消さない。核の写し（tail.mjs の pickCore）に入れないだけで、memory.search・関係する記憶では出る。
// 後で足す（段 ③）: 思い出した時刻（recalledAt）を新しさの起点にする。今は呼び出し側が渡さない。
const DAY = 86_400_000;

export const MEMORY_KINDS = Object.freeze(['stop', 'promise', 'decision', 'share', 'pref', 'note']);
export const MEMORY_STATUSES = Object.freeze(['open', 'done']);
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 3;
/** 種類が無い・AI の行の重みの既定 */
export const WEIGHT_DEFAULT = 2;
/** これより弱い記憶は核の写しに入れない */
export const FADED_BELOW = 0.5;

// order は核の写しに並べる順（やめたこと → 約束 → 決めたこと → 分担 → 好み → その他 → 種類なし）
const KIND = {
  stop: { weight: 3, halfLifeDays: Infinity, order: 0 },
  promise: { weight: 3, halfLifeDays: Infinity, order: 1 },
  decision: { weight: 3, halfLifeDays: 180, order: 2 },
  share: { weight: 2, halfLifeDays: 60, order: 3 },
  pref: { weight: 2, halfLifeDays: 60, order: 4 },
  note: { weight: 1, halfLifeDays: 30, order: 5 },
};
const UNKNOWN = { weight: WEIGHT_DEFAULT, halfLifeDays: 60, order: 6 };
const PROMISE_DONE_DAYS = 7;

export const isMemoryKind = (kind) => MEMORY_KINDS.includes(kind);
export const isMemoryStatus = (status) => MEMORY_STATUSES.includes(status);
export const isWeight = (weight) => Number.isInteger(weight) && weight >= WEIGHT_MIN && weight <= WEIGHT_MAX;

const isHumanLine = (entry) => entry?.by?.kind === 'human';
const kindInfo = (entry) => KIND[entry?.kind] ?? UNKNOWN;

/** 行の重み（行の w、無ければ人の行は 3・ほかは種類の既定） */
export function weightOf(entry) {
  if (isWeight(entry?.weight)) return entry.weight;
  return isHumanLine(entry) ? WEIGHT_MAX : kindInfo(entry).weight;
}

/** 半減期（日）。Infinity は薄れない */
export function halfLifeOf(entry) {
  if (isHumanLine(entry)) return Infinity;
  if (entry?.kind === 'promise' && entry.status === 'done') return PROMISE_DONE_DAYS;
  return kindInfo(entry).halfLifeDays;
}

/** 核の写しに並べる順（種類ごと） */
export const kindOrder = (entry) => kindInfo(entry).order;

/**
 * 強さ ＝ 重み × 0.5^(経過日数 / 半減期)。経過は最後に書いた・直した時刻（recalledAt を渡せばそれと新しい方）から。
 * now は ms。未来の時刻の行は経過 0 とみなす
 */
export function strengthOf(entry, now = Date.now(), { recalledAt = 0 } = {}) {
  const weight = weightOf(entry);
  const halfLife = halfLifeOf(entry);
  if (!Number.isFinite(halfLife)) return weight;
  const since = Math.max(Number(entry?.updatedAt) || 0, Number(entry?.at) || 0, Number(recalledAt) || 0);
  const days = Math.max(0, now - since) / DAY;
  return weight * 0.5 ** (days / halfLife);
}

export const isFaded = (entry, now = Date.now(), opts) => strengthOf(entry, now, opts) < FADED_BELOW;
