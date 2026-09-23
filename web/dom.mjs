// web/ 共通の小さな下請け。要素を作る定型と相対時刻の整形。
// タイトル・状態名・パスはモデル由来なので、文字は必ず textContent で入れる（innerHTML は使わない）。

export const SVG_NS = "http://www.w3.org/2000/svg";

/** テキストだけの要素 */
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

/** SVG の要素。attrs は setAttribute でそのまま置く */
export function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
}

/** 16px の線画アイコン（svg.i）。d は 24×24 の path */
export function icon(d) {
  const svg = svgEl("svg", { class: "i", viewBox: "0 0 24 24" });
  svg.append(svgEl("path", { d }));
  return svg;
}

/**
 * 経過した幅。「3分」「5時間」「2日」。ms でも ISO でも受ける。
 * 「〜経過」「〜待っている」のように後ろへ語を続けるときはこちら
 */
export function elapsed(when) {
  const t = typeof when === "number" ? when : when ? Date.parse(when) : NaN;
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.round(sec / 60)}分`;
  if (sec < 86400) return `${Math.round(sec / 3600)}時間`;
  return `${Math.round(sec / 86400)}日`;
}

/** 相対時刻。「たった今」「3分前」。一覧の行と候補の補足に */
export function relTime(when) {
  const e = elapsed(when);
  return !e ? "" : e.endsWith("秒") ? "たった今" : `${e}前`;
}
