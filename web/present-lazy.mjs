// 提示（Visualize の HTML・画像）の本文を、見える近くに来てから取る（ADR 0182）。
// loadSession は大きい本文（lazy の印）を運ばない。画面は印のままカードの枠だけを描き、枠がスクロールの面に近づいたら
// GET /present-body から本文を取る（記録は追記だけで本文は変わらないので、サーバーは長く覚えさせる。2 回目からは HTTP の覚えから出る）。
// 印を持つ提示は { …, lazy: { i: 提示の通し番号, content?: 長さ, dataUri?: 長さ, sessionId } }（sessionId は描く側が足す）。
// 持っている提示（state.presents）は書き換えない。取った本文は、描いたカードの中だけで使う

/** 本文を取る URL。field は "content"（HTML・文字）か "dataUri"（画像。<img src> が直に読める） */
export function presentBodyUrl(ev, field) {
  const query = new URLSearchParams({ sessionId: ev.lazy.sessionId, i: String(ev.lazy.i), field });
  if (ev.at) query.set("at", ev.at);
  return `/present-body?${query}`;
}

/** 本文が印のまま（取りに行く必要がある）か */
export const isLazy = (ev, field) => Boolean(ev?.lazy && ev.lazy[field] !== undefined && ev.lazy.sessionId);

const KEEP = 6;
const bodies = new Map();

/** 本文（文字）を取る。同じ提示を続けて頼まれたら 1 度だけ取る。直近の KEEP 件だけ覚える */
export function fetchPresentBody(ev, field = "content") {
  const url = presentBodyUrl(ev, field);
  let hit = bodies.get(url);
  if (hit) { bodies.delete(url); bodies.set(url, hit); return hit; }
  hit = fetch(url, { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new Error(String(res.status));
    return res.text();
  });
  hit.catch(() => { if (bodies.get(url) === hit) bodies.delete(url); });
  bodies.set(url, hit);
  while (bodies.size > KEEP) bodies.delete(bodies.keys().next().value);
  return hit;
}

let observer = null;
const waiting = new WeakMap();

/**
 * node がスクロールの面（#log）の margin 分まで近づいたら、1 度だけ run を呼ぶ。見える前に取り始めて、見えたときには出来上がっているようにする。
 * IntersectionObserver が無い環境（試験の簡易 DOM）は、すぐ呼ぶ
 */
export function whenNear(node, run, { margin = 800 } = {}) {
  if (typeof IntersectionObserver === "undefined" || typeof document === "undefined") { run(); return; }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const fn = waiting.get(entry.target);
      waiting.delete(entry.target);
      fn?.();
    }
  }, { root: document.getElementById("log"), rootMargin: `${margin}px 0px` });
  waiting.set(node, run);
  observer.observe(node);
}
