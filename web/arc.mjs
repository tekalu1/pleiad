// 走っている印（docs/design-system.md §6）。形はここで作り、動きは CSS に任せる。
// display:none の祖先の中では描画されず、document.hidden の間はアニメーションを一時停止する。
import { svgEl } from "./dom.mjs";

const ARC = { r: 5, cx: 7, cy: 7 };
const pt = (deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return `${(ARC.cx + ARC.r * Math.cos(a)).toFixed(2)},${(ARC.cy + ARC.r * Math.sin(a)).toFixed(2)}`;
};
// 270° の道の先頭を dasharray で切り出す。reduced motion では道を丸ごと見せる。
const ARC_PATH = `M${pt(0)} A${ARC.r},${ARC.r} 0 1 1 ${pt(270)}`;

// 裏で待っている印。点は最大 3 個、半径 4.6 の軌道を回る。
const SAT = { r: 1.45, orbit: 4.6, max: 3 };
const orbit = (deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [(ARC.cx + SAT.orbit * Math.cos(a)).toFixed(2), (ARC.cy + SAT.orbit * Math.sin(a)).toFixed(2)];
};

if (document.addEventListener) {
  const pauseWhenHidden = () => document.documentElement.classList.toggle("page-hidden", document.hidden);
  document.addEventListener("visibilitychange", pauseWhenHidden);
  pauseWhenHidden();
}

/** 走っている印を 1 つ作る。title は「ターンが走っている」など。 */
export function runMark(title) {
  const span = document.createElement("span");
  span.className = "run";
  if (title) span.title = title;
  const svg = svgEl("svg", { viewBox: "0 0 14 14" });
  const path = svgEl("path", { d: ARC_PATH });
  svg.append(path);
  span.append(svg);
  return span;
}

/**
 * 裏で待っている印を 1 つ作る。n は裏で動いている本数（点は 3 個まで）。
 * title は「裏で 2 本が動いている」など。runMark と同じく、待っているときだけ DOM に置くこと
 */
export function satMark(n, title) {
  const count = Math.max(1, Math.min(SAT.max, Math.floor(Number(n)) || 1));
  const span = document.createElement("span");
  span.className = "run sat";
  if (title) span.title = title;
  const svg = svgEl("svg", { viewBox: "0 0 14 14" });
  for (let i = 0; i < count; i++) {
    const [cx, cy] = orbit(i * 360 / count);
    svg.append(svgEl("circle", { r: SAT.r, cx, cy }));
  }
  span.append(svg);
  return span;
}

// 終わったサブエージェント・Pleiad タスクの印（docs/design-system.md §2.2・§6.2）。動かない。
// 弧・衛星と同じ 14×14・線幅 1.6・端は丸・currentColor（CSS は .state-mark）。色で意味を足さない。
// 青い丸（完了・未確認。塗りの円・--ink-unread）とは形で見分ける: どれも塗らない線画で、円を含まない。
//   done: チェック。web/icons.mjs の checkIcon（24×24 の m5 12 4 4L19 6）を中心 (12,11) から 0.6 倍して (7,7) に置いたもの
//   fail: ✕。ツールカードの「✕ 失敗」と同じ語彙。弧の半径 5 に収まる 3.5〜10.5
//   stop: 短い横線。止めた・途中で終わった
// 動かないので「走っているときだけ DOM に置く」（§6）の対象ではない。
const STILL_PATHS = {
  done: "M2.8 7.6 5.2 10 11.2 4",
  fail: "M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5",
  stop: "M4 7h6",
};

/** 静止した状態の印を 1 つ作る。shape は done / fail / stop。label は読み上げと title に使う */
export function stillMark(shape, label) {
  const span = document.createElement("span");
  span.className = `state-mark ${shape}`;
  span.setAttribute("role", "img");
  if (label) { span.setAttribute("aria-label", label); span.title = label; }
  const svg = svgEl("svg", { viewBox: "0 0 14 14", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: STILL_PATHS[shape] ?? "" }));
  span.append(svg);
  return span;
}
