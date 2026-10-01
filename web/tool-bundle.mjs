// ツール呼び出しの「まとまり」（docs/design-system.md §4.5「ツール呼び出し」、ADR 0061・0067）。
//
// 本文（と委譲）で区切られたツールの連続を 1 つのまとまりにする。閉じると見出し 1 行（「≡ ツール実行 N」。右端は失敗のときの「✕ 失敗 N」と、走っている間の経過だけ）。
// 走っている間は「見出し + 1 つ前（薄い行）+ 最新の行」の 3 行で、新しいツールが始まるたびに入れ替わる。
// 薄い行を押す・↑ で 1 件ずつ、最新を下端に固定したまま上へ伸びて遡れる。見出しを押すと全部を開く ⇄ 閉じる。
// 失敗・変更したファイル・承認待ちは、まとまりの中に入れる（失敗は見出しの右端の「✕ 失敗 N」で分かる）。委譲だけは呼び出し側がまとまりの外に置く。
// 動きは §8 の値（240ms・120ms）。prefers-reduced-motion では動かさない。
//
// コンピューターの操作（ply_computer）の連続は kind: "computer" の塊（docs/design-system.md「コンピューターの操作」、ADR 0073）。
// 走っている間は同じ 3 行 + 右に「止める」。終わったら失敗・止めた行・最後に撮った画面・最後の行を最大 3 行見せ、残りは「ほか N 件」。
// 1 件だけでも見出しを出す（「止める」の置き場）。
import { el, svgEl, chevron } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { runMark } from "./arc.mjs";
import { pickRows, computerSummary, reasonShort } from "./computer-use.mjs";

const DUR = 240, FAST = 120, STAG = 30, EASE = "cubic-bezier(.2,.7,.2,1)";
const MAX_STAG = 8;

// ---------------------------------------------------------------- 数え方（DOM に触れない。単体テストの対象）

// i18n-dynamic: timeline.tool.label.*
const VERB_ORDER = ["read", "grep", "find", "fetch", "webSearch", "edit", "write", "run"];

/**
 * ツールの並びから、まとまりの見出しに出す数を作る。
 * @param {{verb:string, err?:boolean, running?:boolean, change?:{path:string,add:number,del:number}|null}[]} items
 * @returns {{count:number, mix:[string,number][], errors:number, files:{path:string,name:string,add:number,del:number}[]}}
 *   mix は動詞ごとの件数（多い順、同数なら読む・検索…実行の順）。errors は走り終えて失敗したもの。
 *   files は変更したファイル（同じファイルへの変更は 1 つにまとめる。失敗した変更・走っている変更は数えない）
 */
export function bundleStats(items) {
  const count = new Map();
  for (const it of items) count.set(it.verb, (count.get(it.verb) ?? 0) + 1);
  const order = VERB_ORDER.map((k) => t(`timeline.tool.label.${k}`));
  const rank = (v) => { const i = order.indexOf(v); return i < 0 ? order.length : i; };
  const mix = [...count].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]));
  const files = new Map();
  for (const it of items) {
    if (!it.change || it.running || it.err) continue;
    // Codex の fileChange は変更したパスの一覧（paths）だけを持つ。量は最初のパスにだけ載せる
    const paths = it.change.paths?.length ? it.change.paths : [it.change.path];
    paths.forEach((key, i) => {
      const f = files.get(key) ?? { path: key, name: String(key).replace(/\\/g, "/").split("/").pop(), add: 0, del: 0 };
      if (i === 0) { f.add += it.change.add; f.del += it.change.del; }
      files.set(key, f);
    });
  }
  return { count: items.length, mix, errors: items.filter((it) => it.err && !it.running).length, files: [...files.values()] };
}

/**
 * 1 つの発言のツール呼び出しを、まとまりと委譲に分ける。委譲はまとまりの外に 1 件ずつ出し、まとまりはそこで切れる。
 * @template T
 * @param {T[]} calls
 * @param {(call:T)=>boolean} isBoundary 委譲のツールか
 * @param {(call:T)=>string} [groupOf] まとまりの種類（"computer" など）。続いていても種類が替わればそこで切れる
 * @returns {({type:"bundle", kind:string, calls:T[]}|{type:"delegate", call:T})[]}
 */
export function splitToolCalls(calls, isBoundary, groupOf = () => "tools") {
  const out = [];
  for (const call of calls) {
    if (isBoundary(call)) { out.push({ type: "delegate", call }); continue; }
    const last = out.at(-1), kind = groupOf(call);
    if (last?.type === "bundle" && last.kind === kind) last.calls.push(call);
    else out.push({ type: "bundle", kind, calls: [call] });
  }
  return out;
}

/** 見出しの経過。1:11 */
export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---------------------------------------------------------------- 動き

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const animate = (node, frames, opts) => { if (!reducedMotion() && typeof node?.animate === "function") node.animate(frames, { easing: EASE, ...opts }); };

const scrollerOf = (node) => {
  for (let n = node?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
};

/**
 * 位置を保つ: 基準の要素の画面上の位置を、動きの間ずっと保つ。fn で中の行を開閉しても、読んでいる位置が跳ねない
 * （走っている間は最新の行、閉じた後は見出しが基準）
 */
function anchored(anchor, fn) {
  const sc = anchor?.isConnected ? scrollerOf(anchor) : null;
  if (!sc) { fn(); return; }
  const t0 = anchor.getBoundingClientRect().top;
  fn();
  const end = performance.now() + (reducedMotion() ? 0 : DUR + MAX_STAG * STAG + 60);
  const tick = () => {
    const dt = anchor.getBoundingClientRect().top - t0;
    if (Math.abs(dt) > .5) sc.scrollTop += dt;
    if (performance.now() < end && anchor.isConnected) requestAnimationFrame(tick);
  };
  tick();
}

// ---------------------------------------------------------------- 走っている印と経過

const ticking = new Set();   // 経過を刻む要素（行の右端 .tc-res と、走っているまとまりの見出し）
let timer = 0;
const secs = (ms) => `${Math.max(0, Math.floor(ms / 1000))}s`;
function tickAll() {
  const now = Date.now();
  for (const n of ticking) {
    if (!n.isConnected || !n.paint) { ticking.delete(n); continue; }   // 切り離された・結果が届いて印を外した要素は刻まない
    n.paint(now);
  }
  if (!ticking.size) { clearInterval(timer); timer = 0; }
}
function keepTicking(node) {
  ticking.add(node);
  if (!timer) timer = setInterval(tickAll, 1000);
}

/**
 * 承認を待っているツールの行: 行そのものは隠れ、最新の行の場所が承認カードになる（web/client.mjs の rowApprovalCard）。
 * 右端の弧は外す（走っていない）。経過の刻みも止める
 */
export function markWaiting(card) {
  card.classList.remove("tc-running");
  card.classList.add("tc-waiting");
  const res = card.querySelector(".tc-res");
  if (!res) return;
  ticking.delete(res);
  res.paint = null;
  res.replaceChildren();
}

/** 入れ替わりで出てくる側の不透明度 0 → 1（240ms）。動きを減らす設定では何もしない */
export function fadeIn(node) {
  animate(node, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR });
}

/**
 * 行 ⇄ 承認カードの入れ替え。host（.in）の高さを、入れ替える前の高さから後の高さへ 240ms で動かす。
 * 位置は最新の行を基準に保つので、上の本文は動かない。動きを減らす設定では動かさずに入れ替える
 */
export function swapHeight(host, mutate) {
  if (!host || reducedMotion() || typeof host.animate !== "function") { mutate(); return; }
  const before = host.getBoundingClientRect().height;
  mutate();
  const after = host.getBoundingClientRect().height;
  if (Math.abs(after - before) < 1) return;
  const prev = host.style.overflow;
  host.style.overflow = "hidden";
  const anim = host.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: DUR, easing: EASE });
  anim.onfinish = anim.oncancel = () => { host.style.overflow = prev; };
}

/** 走っているツールの行: 右端に §6 の弧と経過秒。結果が来たら applyToolResult が外す */
export function markRunning(card, since = Date.now()) {
  card.classList.remove("tc-waiting");
  card.classList.add("tc-running");
  const res = card.querySelector(".tc-res");
  if (!res) return;
  const sec = el("span", "tc-elapsed", "0s");
  res.replaceChildren(runMark(t("timeline.bundle.running")), sec);
  res.paint = (now) => { sec.textContent = secs(now - since); };
  keepTicking(res);
}

// ---------------------------------------------------------------- まとまり

const stackIcon = () => {
  const svg = svgEl("svg", { class: "stk", viewBox: "0 0 12 12", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: "M2.5 9.5h7M3.5 6.5h5M4.5 3.5h3" }));
  return svg;
};

/** コンピューターの操作の見出しの絵（モニター） */
const monitorIcon = () => {
  const svg = svgEl("svg", { class: "stk", viewBox: "0 0 16 16", "aria-hidden": "true" });
  svg.append(svgEl("rect", { x: 1.5, y: 2.5, width: 13, height: 9, rx: 2 }), svgEl("path", { d: "M6 14h4M8 11.5V14" }));
  return svg;
};

/** 行（.tc）から見出しの数え方に要る情報を読む */
function itemOf(card) {
  return {
    card,
    failed: card.classList.contains("tc-error"),
    stopped: card.classList.contains("tc-stopped"),
    reason: card.dataset?.stopReason || null,
    shot: Boolean(card.querySelector(".tc-shot, .tc-shot-gone")),
    verb: card.dataset.verb ?? card.querySelector(".tc-label")?.textContent ?? "",
    main: card.querySelector(".tc-main")?.textContent ?? "",
    err: card.classList.contains("tc-error"),
    running: card.classList.contains("tc-running"),
    change: card.toolChange ?? null,
  };
}

export class Bundle {
  /**
   * @param {{live?:boolean, kind?:"tools"|"computer", onStop?:(bundle:Bundle)=>void}} [o]
   *   live: 走っているまとまり（最新の行 + 薄い行）。false は履歴（全部が中の行で、閉じて始まる）。
   *   kind: "computer" はコンピューターの操作の塊。onStop はその「止める」（走っている間だけ）
   */
  constructor({ live = false, kind = "tools", onStop = null } = {}) {
    this.kind = kind;
    this.computer = kind === "computer";
    this.onStop = onStop;
    this.cards = [];
    this.k = 0;              // 見出しから遡って開いている中の行の数
    this.expanded = false;   // 全部を開いているか
    this.live = live;
    this.cur = null;         // 最新の行（live のとき）
    this.t0 = Date.now();

    this.el = el("div", `bundle${live ? " live" : ""}${this.computer ? " cu" : ""}`);
    this.el.bundle = this;
    this.head = el("button", "rhead");
    this.head.type = "button";
    this.head.setAttribute("aria-expanded", "false");
    // 「≡ ツール実行 12」。数は見出しの語の後ろに弱い字で置くだけ（丸いバッジにしない）。畳んでいる間は .verb 全体を沈める（tools.css）
    this.nEl = el("span", "n");
    const verb = el("span", "verb");
    this.mixEl = el("span", "mix", this.computer ? t("timeline.computer.bundle.running") : t("timeline.bundle.title"));
    verb.append(this.computer ? monitorIcon() : stackIcon(), this.mixEl, this.nEl);
    this.xmEl = el("span", "xm");
    this.elEl = el("span", "el");
    const res = el("span", "res");
    res.append(this.xmEl, this.elEl);
    this.head.append(verb, res, chevron());
    this.hist = el("div", "hist");
    this.hist.setAttribute("role", "list");
    this.latest = el("div", "latest");
    this.el.append(this.head, this.hist, this.latest);
    if (this.computer) {
      // 終わった塊の「ほか N 件」（押すと全部を開く）。走っている間は出さない
      this.moreEl = el("button", "more");
      this.moreEl.type = "button";
      this.moreEl.hidden = true;
      this.moreEl.onclick = () => { this.expanded = true; this.relayout(); };
      this.el.append(this.moreEl);
      if (live) {
        // 見出しの右（ボタンの中にボタンは置けないので、重ねて置く。間は .cu.live の見出しが空けてある）
        this.stopEl = el("button", "btn btn-quiet rstop", t("timeline.computer.bundle.stop"));
        this.stopEl.type = "button";
        this.stopEl.title = t("timeline.computer.bundle.stopTitle");
        this.stopEl.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.onStop?.(this); };
        this.el.append(this.stopEl);
      }
    }

    this.head.onclick = () => this.toggleAll();
    this.el.addEventListener("keydown", (e) => {
      // ↑↓・Esc で遡るのは、見出しか薄い行にフォーカスがあるときだけ（承認のボタンや開いた行の中では、会話のスクロールを奪わない）
      if (!e.target.closest?.(".rhead, .hi.ghost") || e.target.closest?.(".tc-details-body") || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowUp") { e.preventDefault(); this.step(1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.step(-1); }
      else if (e.key === "Escape" && (this.expanded || this.k > 0)) { e.preventDefault(); this.collapse(); }
    });
    // 薄い行を押す: 行を開くのではなく遡る
    this.hist.addEventListener("click", (e) => {
      const g = e.target.closest?.(".hi.ghost");
      if (!g || e.target.closest?.("button, a")) return;
      e.preventDefault(); e.stopPropagation(); this.step(3);
    }, true);
    this.hist.addEventListener("keydown", (e) => {
      const g = e.target.closest?.(".hi.ghost");
      if (g && g === e.target && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); this.step(3); }
    });

    if (live) {
      this.head.paint = () => { this.elEl.textContent = clock((Date.now() - this.t0) / 1000); };
      keepTicking(this.head);
    }
  }

  get items() { return this.cards.map(itemOf); }
  /** 中の行（最新以外） */
  get inner() { return this.cards.filter((c) => c !== this.cur); }

  wrap(card) {
    const w = el("div", "hi");
    w.setAttribute("role", "listitem");
    const inner = el("div", "in");
    inner.append(card);
    w.append(inner);
    card.hiWrap = w;
    return w;
  }

  /** 履歴: 全部を中の行として閉じて置く（コンピューターの操作の塊は、見せる行だけ開けて置く） */
  addAll(cards) {
    for (const c of cards) { this.cards.push(c); const w = this.wrap(c); w.classList.add("hid"); w.setAttribute("inert", ""); this.hist.append(w); }
    if (this.computer) this.layout(); else this.paint();
  }

  /** 「止める」を押した後: 止め終えるまで押せなくする（止まれば塊が閉じて外れる）。失敗したら押し直せるように戻す */
  setStopping(on) {
    if (!this.stopEl) return;
    this.stopEl.disabled = on;
    this.stopEl.textContent = on ? t("timeline.computer.bundle.stopping") : t("timeline.computer.bundle.stop");
    // 字が長くなる（止めています…）ので、見出しが空ける幅を測り直す
    this.el.style.setProperty("--stop-w", `${this.stopEl.offsetWidth ?? 48}px`);
  }

  /** 新しいツールが始まる。今の最新は 1 つ前（薄い行）へ下がり、その前の薄い行は畳まれる */
  add(card) {
    const prev = this.cur;
    this.cards.push(card);
    this.cur = card;
    if (prev) {
      const w = this.wrap(prev);
      this.hist.append(w);
      animate(w, [{ opacity: 1 }, { opacity: .42 }], { duration: DUR });
    }
    const nw = this.wrap(card);
    this.latest.replaceChildren(nw);
    if (!reducedMotion()) {
      // 畳まれる行と同じフレームで伸び始める（同時に進むので、まとまりの高さはほぼ変わらない）
      nw.classList.add("hid");
      void nw.offsetHeight;
      nw.classList.remove("hid");
      animate(card, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: DUR });
    }
    this.layout({ countAnimation: true });
  }

  /** 本文が来た・委譲が始まった・ターンが終わった: 見出し 1 行に閉じる。最新の行は中の行へ移る */
  close() {
    if (!this.live) return;
    this.live = false;
    this.el.classList.remove("live");
    this.stopEl?.remove();
    this.stopEl = null;
    ticking.delete(this.head);
    const card = this.cur;
    this.cur = null;
    // 1 件だけなら見出しは要らない。行のまま置く（コンピューターの操作は 1 件でも見出しを残す）
    if (this.cards.length === 1 && card && this.el.isConnected && !this.computer) { this.el.replaceWith(card); return; }
    const settle = () => {
      if (card) { const w = this.wrap(card); w.classList.add("hid"); w.setAttribute("inert", ""); this.hist.append(w); }
      this.latest.replaceChildren();
      this.k = 0;
      this.layout();
    };
    const w = card?.hiWrap;
    if (!w || reducedMotion()) { settle(); return; }
    // 最新の行を上へ畳んでから、中の行へ移す（移したときに一瞬出ないよう、移す先は高さ 0）
    w.style.transition = `grid-template-rows ${DUR}ms ${EASE}, opacity ${DUR}ms ${EASE}`;
    w.classList.add("hid");
    for (const g of this.hist.querySelectorAll(".hi.ghost")) g.classList.replace("ghost", "hid");
    setTimeout(settle, DUR);
  }

  /** 最新でない行が見えなければ困る（承認を待っている）ときに、全部を開いてその行を見せる */
  reveal(card) {
    if (card === this.cur || !this.cards.includes(card)) return;
    this.expanded = true;
    this.relayout();
  }

  /** 全部を閉じる（Esc） */
  collapse() {
    this.expanded = false;
    this.k = 0;
    this.relayout();
  }

  /** d > 0 で d 件遡る、d < 0 で戻る */
  step(d) {
    const n = this.inner.length;
    if (this.expanded && d > 0) return;
    if (d < 0 && this.expanded) { this.expanded = false; this.k = Math.max(0, n - 1); }
    this.k = Math.max(0, Math.min(n, this.k + d));
    if (this.k >= n && n) this.expanded = true;
    this.relayout();
  }

  /** 見出しを押す: 全部を開く ⇄ 閉じる */
  toggleAll() {
    const n = this.inner.length;
    this.expanded = !this.expanded && !(this.k >= n && this.k > 0);
    if (!this.expanded) this.k = 0;
    this.relayout();
  }

  /** 開いている範囲（読むだけの筋を作り直すときに控える。web/view-state.mjs） */
  viewState() {
    return { expanded: this.expanded, k: this.k };
  }

  /** 控えた範囲へ動かさずに戻す。作り直した直後（画面に置く前）に呼ぶので、開く動きは出ない */
  restoreView({ expanded, k }) {
    this.expanded = expanded;
    this.k = Math.max(0, Math.min(k, this.inner.length));
    this.layout();
  }

  relayout() {
    anchored(this.live && this.cur ? this.latest : this.head, () => this.layout({ stagger: true }));
  }

  /** 中の行の出入りを決め直し、見出しを書き直す */
  layout({ stagger = false, countAnimation = false } = {}) {
    const inner = this.inner, n = inner.length;
    // 終わったコンピューターの操作の塊は、閉じていても失敗・止めた行・最後の画面・最後の行を見せる
    const pick = this.computer && !this.live ? pickRows(this.items) : null;
    inner.forEach((card, i) => {
      const fromEnd = n - 1 - i;
      // 承認を待っている行は、まとまりの操作（閉じる・新しいツール）で薄い行や隠れた行に落とさない
      const shown = this.expanded || fromEnd < this.k || card.classList.contains("tc-waiting") || Boolean(pick?.has(i));
      const ghost = !shown && this.live && !!this.cur && fromEnd === this.k;
      const w = card.hiWrap;
      if (!w) return;
      const was = w.classList.contains("hid") ? "hid" : w.classList.contains("ghost") ? "ghost" : "shown";
      const now = shown ? "shown" : ghost ? "ghost" : "hid";
      // 最新に近い行から少しずつ遅らせて出す（上へ向かって順に伸びる）
      w.style.transitionDelay = stagger && now === "shown" && was !== "shown" && !reducedMotion()
        ? `${Math.min(fromEnd - Math.max(0, this.k - 3), MAX_STAG) * STAG}ms` : "";
      w.classList.toggle("hid", now === "hid");
      w.classList.toggle("ghost", now === "ghost");
      if (now === "hid") w.setAttribute("inert", ""); else w.removeAttribute("inert");
      // 薄い行は「押すと遡る」1 つの部品。中のリンクや開閉に Tab で入れない
      const inner = w.firstChild;
      if (inner) { if (now === "ghost") inner.setAttribute("inert", ""); else inner.removeAttribute("inert"); }
      if (now === "ghost") {
        w.tabIndex = 0;
        const it = itemOf(card);
        w.setAttribute("aria-label", t("timeline.bundle.ghost", { verb: it.verb, target: it.main }));
      } else { w.removeAttribute("tabindex"); w.removeAttribute("aria-label"); }
    });
    this.head.setAttribute("aria-expanded", String(this.expanded || (this.k > 0 && this.k >= n)));
    if (this.moreEl) {
      const rest = pick ? n - pick.size : 0, open = this.expanded || this.k >= n;
      this.moreEl.hidden = !(rest > 0 && !open);
      this.moreEl.textContent = rest > 0 ? t("timeline.computer.bundle.more", { count: rest, n: rest }) : "";
    }
    this.laying = true;
    try { this.paint(countAnimation); } finally { this.laying = false; }
  }

  /** 見出し。「ツール実行 N」・失敗の数（右端）・走っている間の経過。結果が届いたら呼び直す */
  paint(countAnimation = false) {
    // 終わった塊に遅れて結果が届いたとき（見せる行が替わりうる）は、行の出入りから決め直す
    if (this.computer && !this.live && !this.laying) return this.layout();
    const items = this.items;
    const st = bundleStats(items);
    this.el.dataset.n = String(st.count);   // 1 件の間は見出しを出さない（tools.css）
    const nText = st.count > 99 ? "99+" : String(st.count);
    if (this.nEl.textContent !== nText) {
      this.nEl.textContent = nText;
      if (countAnimation) animate(this.nEl, [{ opacity: 0, transform: "translateY(-40%)" }, { opacity: 1, transform: "none" }], { duration: FAST });
    }
    this.nEl.title = t("timeline.bundle.count", { count: st.count, n: st.count });   // 100 以上の「99+」の実数
    if (this.computer) {
      // 失敗は ✕ の数、止めたもの（Esc・止める・ロック・禁止・拒否）は失敗に数えず、最後の理由を短い字で
      const sum = computerSummary(items);
      this.mixEl.textContent = this.live ? t("timeline.computer.bundle.running") : t("timeline.computer.bundle.done");
      this.xmEl.textContent = [st.errors ? t("timeline.bundle.failed", { count: st.errors, n: st.errors }) : "", sum.stopped ? reasonShort(sum.stopped) : ""].filter(Boolean).join(" · ");
      this.head.classList.toggle("xm-err", st.errors > 0);
      // Esc・「止める」で止まったら、もう止めるものは無い
      if (this.stopEl) this.stopEl.hidden = items.some((x) => x.stopped && (x.reason === "escape" || x.reason === "stop"));
    } else this.xmEl.textContent = st.errors ? t("timeline.bundle.failed", { count: st.errors, n: st.errors }) : "";
    this.elEl.textContent = this.live ? clock((Date.now() - this.t0) / 1000) : "";   // 終わったまとまりに経過は出さない
    const open = this.head.getAttribute("aria-expanded") === "true";
    this.head.setAttribute("aria-label",
      (this.computer ? t("timeline.computer.bundle.label", { count: st.count, n: st.count }) : t("timeline.bundle.label", { count: st.count, n: st.count }))
      + (st.errors ? t("timeline.bundle.labelFailed", { count: st.errors, n: st.errors }) : "")
      + (open ? t("timeline.bundle.labelClose") : t("timeline.bundle.labelOpen")));
  }
}

/** ツールの行（.tc）から、それが入っているまとまりを引く。結果が届いたら見出しの数を直すのに使う */
export function bundleOf(card) {
  return card?.closest?.(".bundle")?.bundle ?? null;
}
