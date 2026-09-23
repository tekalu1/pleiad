// 候補の絞り込み（combo・入力欄のモデルの面・tests が読む。DOM に触らない）。
// 大文字小文字を区別しない部分一致。空白で区切った語はすべて当たるもの（AND）。語ごとに、どの字に当たってもよい。
// 数百件の一覧でも重くならないよう、描画するのは先頭の limit 件だけ（残りの件数を返し、画面は「ほかに N 件」を出す）。

/** 描画する件数の上限の既定 */
export const SHOW_LIMIT = 50;

/** 検索語を小文字の語の配列に（空白区切り） */
export const searchTerms = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

/** terms のすべての語が texts のどれかに含まれるか（語が無ければ true） */
export function matchesTerms(terms, texts) {
  if (!terms.length) return true;
  const hay = texts.filter((t) => t !== undefined && t !== null && t !== '').map((t) => String(t).toLowerCase());
  return terms.every((term) => hay.some((h) => h.includes(term)));
}

/**
 * 候補を検索語で絞り、先頭の limit 件だけ返す。
 * @param {Array} items
 * @param {string} query
 * @param {(item) => Array<string>} textsOf 当てる字
 * @param {number} [limit]
 * @returns {{ shown: Array, total: number, more: number }} more は描画しなかった件数
 */
export function filterLimited(items, query, textsOf, limit = SHOW_LIMIT) {
  const terms = searchTerms(query);
  const hit = terms.length ? items.filter((it) => matchesTerms(terms, textsOf(it))) : items;
  const shown = Number.isFinite(limit) ? hit.slice(0, limit) : hit;
  return { shown, total: hit.length, more: hit.length - shown.length };
}

/** 「ほかに N 件」の文言 */
export const moreText = (n) => `ほかに ${n} 件。文字を入れて絞り込んでください`;
