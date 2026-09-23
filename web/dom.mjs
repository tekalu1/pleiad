// web/ 共通の小さな下請け。要素を作る定型と相対時刻の整形。
// タイトル・状態名・パスはモデル由来なので、文字は必ず textContent で入れる（innerHTML は使わない）。

import { fmt } from "./i18n.mjs";

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
 * 「〜経過」「〜待っている」のように後ろへ語を続けるときはこちら。書き方は画面の言語に従う（web/i18n.mjs の fmt）
 */
export const elapsed = (when) => fmt.elapsed(when);

/** 相対時刻。「たった今」「3分前」。一覧の行と候補の補足に */
export const relTime = (when) => fmt.relative(when);

/** 「…」の絵（行・見出しの操作。右クリックのメニューと同じ中身を開くボタンに置く） */
export function dotsIcon() {
  const svg = svgEl("svg", { class: "i", viewBox: "0 0 24 24", "aria-hidden": "true" });
  for (const cx of [5, 12, 19]) svg.append(svgEl("circle", { cx, cy: 12, r: 1.2 }));
  return svg;
}

/**
 * 右クリックのメニューと同じ中身を開く「…」のボタン（docs/remote.md §8.4。タッチでは右クリックもドラッグも届かない）。
 * open(x, y) はボタンの左下を渡す。行の上の押下（選択・開閉・ドラッグ）には伝えない
 */
export function moreButton(cls, label, open) {
  const b = el("button", `btn btn-icon more-btn ${cls}`);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-haspopup", "menu");
  b.draggable = false;
  b.append(dotsIcon());
  b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); const r = b.getBoundingClientRect(); open(r.left, r.bottom + 4); };
  b.onpointerdown = (e) => e.stopPropagation();
  b.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); };
  return b;
}

/**
 * UUID v4。crypto.randomUUID は secure context でしか使えない（WKWebView の 127.0.0.1・ブラウザー版の LAN の http。
 * docs/remote.md §8.3）。無ければ crypto.getRandomValues で同じ形を作る
 */
export function randomId(c = globalThis.crypto) {
  if (typeof c?.randomUUID === "function") {
    try { return c.randomUUID(); } catch { /* secure context でないと投げる実装がある */ }
  }
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
