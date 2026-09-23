// 走っている印（docs/design-system.md §6）。点滅しない。回る。色は白。
//
// 先端 head と尾 tail の角度を毎フレーム決める。どちらも単調非減少。戻ることは無い。
//   head(t) = θ(t)。速度 θ' = ω·(1 + a1·sin(2πt/T1) + a2·sin(2πt/T2 + φ))。a1 + a2 < 1 なので θ' > 0
//   tail(t) = min(θ(t − τ), head − gmin)。尾は先端が τ 秒前に居た場所を追う。単調な関数の min は単調
//   弧の長さ = head − tail。gmin で下限を切り、上限は vmax·τ ≈ 220°（1 周を超えない）
// 値の理由: ω 180°/s = 1 周 2s。T1 2.4s / T2 1.7s の 2 つの揺らぎを重ねると同じ形が 20.4s に 1 度しか戻らない。
//           a1 .6 + a2 .3 で最遅 18°/s（ほぼ止まる）〜最速 342°/s。τ .65s で弧が 24°〜220° の間を呼吸する
//
// 実装: runMark() で作った path を控えておき、1 本の rAF ループでまとめて更新する（要素数に依らず 1 ループ）。
// document から外れた印は次のフレームで忘れ、残りが無ければループを止める。
// 印は「走っている」ときだけ DOM に置くこと（CSS で隠すだけだと回り続ける）。
// prefers-reduced-motion では静止した 3/4 周。
import { svgEl } from "./dom.mjs";

const ARC = { r: 5, cx: 7, cy: 7, omega: 180, a1: .6, T1: 2.4, a2: .3, T2: 1.7, phi: 1.1, tau: .65, gmin: 24 };
const TAU = 2 * Math.PI;

const theta = (t) => ARC.omega * (
  t
  - ARC.a1 * ARC.T1 / TAU * Math.cos(TAU * t / ARC.T1)
  - ARC.a2 * ARC.T2 / TAU * Math.cos(TAU * t / ARC.T2 + ARC.phi)
);
const pt = (deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return `${(ARC.cx + ARC.r * Math.cos(a)).toFixed(2)},${(ARC.cy + ARC.r * Math.sin(a)).toFixed(2)}`;
};
const arcPath = (tail, head) =>
  `M${pt(tail)} A${ARC.r},${ARC.r} 0 ${head - tail > 180 ? 1 : 0} 1 ${pt(head)}`;

const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const STILL = arcPath(0, 270);

// 裏で待っている印（衛星。docs/design-system.md §6）。main は返答を終え、subagent などが裏で動いているとき。
//   点を n 個（上限 3）、中心 (7,7) の周りの半径 4.6 の軌道に置く。
//   angle_i(t) = θ(t·0.5) + i·360/n + 14·sin(1.3t + 2.1i)
//   θ は弧と同じ関数。同じ揺らぎで回るので同じ族の印に見え、t·0.5 で半分の速さ（平均 1 周 4s）に落として
//   「急いでいない・待っている」を出す。14·sin(...) で点ごとに ±14° 前後し、間隔が詰まったり開いたりする。
//   位相 2.1i で点ごとにずらし、全部が揃って動く（剛体の回転に見える）のを避ける
// 値の理由: 半径 1.45 は直径 2.9 ≈ 弧の線幅 1.6 の 2 倍弱。14px の印の中で「点」と読める最小。
//           軌道 4.6 は弧の半径 5 より少し内側で、4.6 + 1.45 = 6.05 < 7 なので viewBox から出ない。
//           上限 3: 4 個以上だと 14px の円周では点がつながり、輪に見える
// prefers-reduced-motion では静止し、点は真上から等間隔に並ぶ。
const SAT = { r: 1.45, orbit: 4.6, rate: .5, wobble: 14, wf: 1.3, wp: 2.1, max: 3 };
const orbit = (deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [(ARC.cx + SAT.orbit * Math.cos(a)).toFixed(2), (ARC.cy + SAT.orbit * Math.sin(a)).toFixed(2)];
};

const paths = new Set();   // 生きている印の path
const sats = new Set();    // 生きている衛星の印の svg
let raf = 0;

function tick(now) {
  for (const p of paths) if (!p.isConnected) paths.delete(p);
  for (const s of sats) if (!s.isConnected) sats.delete(s);
  if (!paths.size && !sats.size) { raf = 0; return; }          // 走っているものが無ければ止まる
  const t = now / 1000;
  if (paths.size) {
    const head = theta(t);
    const tail = Math.min(theta(t - ARC.tau), head - ARC.gmin);
    const d = arcPath(tail, head);
    for (const p of paths) p.setAttribute("d", d);
  }
  if (sats.size) {
    const base = theta(t * SAT.rate);
    for (const svg of sats) {
      const dots = svg.children, n = dots.length;
      for (let i = 0; i < n; i++) {
        const [cx, cy] = orbit(base + i * 360 / n + SAT.wobble * Math.sin(SAT.wf * t + SAT.wp * i));
        dots[i].setAttribute("cx", cx);
        dots[i].setAttribute("cy", cy);
      }
    }
  }
  raf = requestAnimationFrame(tick);
}

/** 走っている印を 1 つ作る。title は「ターンが走っている」など。置いた時点で回り始める */
export function runMark(title) {
  const span = document.createElement("span");
  span.className = "run";
  if (title) span.title = title;
  const svg = svgEl("svg", { viewBox: "0 0 14 14" });
  const path = svgEl("path", { d: STILL });
  svg.append(path);
  span.append(svg);
  paths.add(path);
  if (!reduced && !raf) raf = requestAnimationFrame(tick);
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
  sats.add(svg);
  if (!reduced && !raf) raf = requestAnimationFrame(tick);
  return span;
}

// 終わったサブエージェント・Pleiad タスクの印（docs/design-system.md §2.2・§6.2）。動かない。
// 弧・衛星と同じ 14×14・線幅 1.6・端は丸・currentColor（CSS は .state-mark）。色で意味を足さない。
// 青い丸（完了・未確認。塗りの円・--ink-unread）とは形で見分ける: どれも塗らない線画で、円を含まない。
//   done: チェック。web/icons.mjs の checkIcon（24×24 の m5 12 4 4L19 6）を中心 (12,11) から 0.6 倍して (7,7) に置いたもの
//   fail: ✕。ツールカードの「✕ 失敗」と同じ語彙。弧の半径 5 に収まる 3.5〜10.5
//   stop: 短い横線。止めた・途中で終わった
// 動かないので「走っているときだけ DOM に置く」（§6）の対象ではない。rAF にも登録しない
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
