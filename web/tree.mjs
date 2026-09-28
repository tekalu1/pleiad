// ==================== ツリー（docs/design-system.md §9「コンテキスト探索」） ====================
// データ → DOM・開閉・選択・キーボード・絞り込みだけを持つ汎用の部品。行の意味は知らない。
// 行の中身（アイコン・右端の一語・件数）は render(node, row) で呼び出し側が描く。
//
//   node: { id, name, children?, open?, lazy?, more?, data }。children が無ければ葉。data は部品が触らない
//   lazy: true は「まだ読んでいないフォルダー」（空の [] とは別）。開くと onLoad(node) で読み、その間は「読み込み中…」の行、
//   失敗すると失敗の行を出す。more（数）があれば子の後ろに「さらに表示」の行を出し、押すと onMore(node) で続きを読む。
//   onLoad・onMore は { children, more?, ... } を返し、部品はそれを node に書き込む（children は全体を差し替える）
//   DOM:  <div role=tree tabindex=0><ul><li role=none><div role=treeitem aria-level aria-expanded aria-selected>
//
// フォーカスは tree 1 つだけ（roving tabindex は持たない）。行が何百あっても tab 1 回で抜けられる。
// 今いる行は aria-activedescendant で支援技術に伝え、見た目は選択と同じ白い面で示す。
import { el, svgEl } from "./dom.mjs";
import { t } from "./i18n.mjs";

let seq = 0;

/**
 * 横に送る量（scrollLeft）を決める純粋な関数。座標はすべてツリーの中身の左端から。
 * start は行の頭（アイコン）の左、end は名前の右、reserve は名前の右に空けたい幅（右端に留まる ⋯ の分）、width は欄の見える幅。
 * 名前が欄に収まるなら 0。収まらなければ名前の終わりが見える最小の量（頭も見えるならそのまま、見えなくても名前の終わりを優先）。
 * すでに名前の終わりと頭が見えていれば今の scroll のまま。force なら見えていても合わせ直す
 */
export function scrollLeftFor({ scroll = 0, width, start, end, reserve = 0, force = false }) {
  const need = Math.ceil(end + reserve - width);      // 名前の終わりが見える最小の量
  if (!force && scroll >= Math.max(0, need) && scroll <= Math.max(start, need, 0)) return scroll;
  return Math.max(0, need);
}

/** 10px の chevron。閉じているとき右向き、開くと 90° 回る（回転は CSS） */
function chevron() {
  const svg = svgEl("svg", { viewBox: "0 0 10 10", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: "M3.5 1.5 7 5l-3.5 3.5" }));
  const span = el("span", "chev");
  span.append(svg);
  return span;
}

/**
 * ツリーを 1 つ作る。
 * @param {HTMLElement} root 置き場所。role と tabindex はここで付ける
 * @param {{nodes?:Array, open?:string[], empty?:string,
 *          render?:(node:any, row:HTMLElement)=>void, onSelect?:(node:any)=>void, onOpen?:(node:any, open:boolean)=>void,
 *          onContext?:(node:any, x:number, y:number, row:HTMLElement)=>void,
 *          onLoad?:(node:any)=>Promise<any>, onMore?:(node:any)=>Promise<any>,
 *          loading?:string, failed?:string, moreLabel?:(node:any)=>string, scrollX?:boolean}} opts
 *   onContext は行のメニュー。右クリック・ContextMenu キー・Shift+F10 で呼ぶ（行は選ぶが onSelect は呼ばない）
 *   failed は読めなかった行の文言（無ければ投げられたエラーの文）。moreLabel は「さらに表示」の行の文言
 *   scrollX は名前を省略せず横にスクロールする使い手（呼び出し側の CSS で行を伸ばす）。選んだ・送った行の名前が見える
 *   よう横位置も合わせ（scrollLeftFor）、すべて畳むと左端へ戻す。無ければ横には触らない
 */
export function createTree(root, { nodes = [], open = [], empty = t("common.noMatch"), render, onSelect, onOpen, onContext,
  onLoad, onMore, loading = t("pending.loading"), failed = "", moreLabel = (n) => String(n.more), scrollX = false } = {}) {
  const prefix = `tree${++seq}`;
  const opened = new Set(open);                       // 開いている節の id。呼び出し側が state() で持ち出せる。setNodes でも消さない
  const parents = new Map(), rows = new Map(), byId = new Map();
  const pending = new Set(), failures = new Map();    // 読んでいる最中・読めなかった節の id（中身の読み込みと「さらに表示」）
  let list = [], filter = null, selected = null, typed = "", typedAt = 0, counter = 0;

  root.setAttribute("role", "tree");
  if (!root.hasAttribute("tabindex")) root.tabIndex = 0;

  function index(items, parent) {
    for (const n of items) {
      parents.set(n, parent);
      byId.set(n.id, n);
      if (n.open) opened.add(n.id);                   // 初期状態。以後は opened だけを見る
      if (n.children?.length) index(n.children, n);
    }
  }
  /** 開ける節か。まだ読んでいない（lazy）フォルダーも含む */
  const branch = (n) => Boolean(n.lazy || n.children?.length);
  // 絞り込み中は祖先を全部開く。元の開閉は opened に残したままにして、解除で戻す
  const expanded = (n) => branch(n) && (filter ? true : opened.has(n.id));

  function toggle(n) {
    if (!branch(n)) return;
    const next = !opened.has(n.id);
    if (next) opened.add(n.id); else opened.delete(n.id);
    if (next) failures.delete(n.id);                  // 閉じて開き直すと、読めなかった節をもう一度読む
    redraw();
    onOpen?.(n, next);
  }

  /**
   * 中身（lazy の節）か続き（more）を読む。読んでいる間に setNodes で差し替わったら、同じ id の今の節がまだ読んでいない
   * ときだけそこへ書き込む（中身を持った節を、前の節から読んだ結果で上書きしない）
   */
  async function fetchInto(n, loader) {
    if (!loader || pending.has(n.id)) return;
    pending.add(n.id);
    failures.delete(n.id);
    redraw();
    try {
      const result = await loader(n);
      const live = byId.get(n.id) ?? n;
      if (live !== n && !live.lazy) return;
      Object.assign(live, result ?? {}, { lazy: false });
      live.children ??= [];
      index(live.children, live);
    } catch (error) {
      failures.set(n.id, error?.message || failed);
    } finally {
      pending.delete(n.id);
      redraw();
    }
  }
  const load = (n) => fetchInto(n, onLoad);
  const loadMore = (n) => fetchInto(n, onMore);

  /** 部品が足す行（読み込み中・失敗）。選べず、キーボードでも止まらない */
  function note(text, level, className) {
    const li = el("li");
    li.setAttribute("role", "none");
    const row = el("div", `tree-row tree-note ${className}`);
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(level));
    row.setAttribute("aria-disabled", "true");
    const chev = chevron();
    chev.classList.add("none");
    row.append(chev, el("span", "nm", text));
    li.append(row);
    return li;
  }

  function build(items, level) {
    const ul = el("ul");
    ul.setAttribute("role", "group");
    for (const n of items) {
      if (filter && !filter.keep.has(n)) continue;
      const li = el("li");
      li.setAttribute("role", "none");
      const row = el("div", "tree-row");
      row.id = `${prefix}-${counter++}`;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(level));
      row.setAttribute("aria-selected", String(n === selected));
      if (branch(n)) row.setAttribute("aria-expanded", String(expanded(n)));
      if (n === selected) row.classList.add("sel");
      if (filter?.hit.has(n)) row.classList.add("hit");
      const chev = chevron();
      if (!branch(n)) chev.classList.add("none");   // 葉でも場所は空けて字下げを揃える
      chev.onclick = (e) => { e.stopPropagation(); toggle(n); };
      row.append(chev);
      if (render) render(n, row); else row.append(el("span", "nm", n.name));
      row.onclick = () => select(n);                   // 単押しは選択だけ。開閉は chevron かダブルクリック
      row.ondblclick = () => toggle(n);
      if (onContext) row.oncontextmenu = (e) => {
        e.preventDefault();
        select(n, false);
        onContext(n, e.clientX, e.clientY, row);
      };
      li.append(row);
      rows.set(n, row);
      if (expanded(n)) li.append(inner(n, level + 1));
      ul.append(li);
    }
    return ul;
  }

  /** 開いた節の中身。まだ読んでいなければ読み始め、読み込み中・失敗・「さらに表示」の行を足す */
  function inner(n, level) {
    if (n.lazy && !pending.has(n.id) && !failures.has(n.id)) queueMicrotask(() => load(n));
    const ul = build(n.lazy ? [] : n.children ?? [], level);
    if (filter) return ul;
    if (pending.has(n.id)) ul.append(note(loading, level, "tree-pending"));
    else if (failures.has(n.id)) {
      const reason = failures.get(n.id);
      const li = note(failed || reason, level, "tree-failed");
      if (reason && reason !== failed) li.firstChild.title = reason;
      ul.append(li);
    }
    if (!n.lazy && n.more > 0 && !pending.has(n.id)) {
      // 「さらに表示」はキーボードでも辿れる行。選んでも onSelect は呼ばず、押す・Enter で続きを読む
      const action = { id: `${n.id}\0more`, name: moreLabel(n), action: () => loadMore(n) };
      const li = el("li");
      li.setAttribute("role", "none");
      const row = el("div", "tree-row tree-action");
      row.id = `${prefix}-${counter++}`;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(level));
      row.setAttribute("aria-selected", "false");
      const chev = chevron();
      chev.classList.add("none");
      row.append(chev, el("span", "nm", action.name));
      row.onclick = () => action.action();
      li.append(row);
      rows.set(action, row);
      parents.set(action, n);
      ul.append(li);
    }
    return ul;
  }

  function redraw() {
    rows.clear();
    counter = 0;
    root.replaceChildren(build(list, 1));
    if (filter && !rows.size) root.append(el("div", "tree-empty", empty));
    root.setAttribute("aria-activedescendant", rows.get(selected)?.id ?? "");
  }

  /**
   * 行を選ぶ。見つからない id・null は選択を外す（前の行が選ばれたまま残らない）。
   * scroll: false なら送らない（呼び出し側が scrollToRow で余白を取って送るとき）
   */
  function select(target, notify = true, { scroll = true } = {}) {
    const n = (typeof target === "string" ? byId.get(target) : target) ?? null;
    selected = n;
    for (const [node, row] of rows) {
      row.classList.toggle("sel", node === n);
      row.setAttribute("aria-selected", String(node === n));
    }
    const row = n ? rows.get(n) : null;
    root.setAttribute("aria-activedescendant", row?.id ?? "");
    if (scroll && row) {
      const left = root.scrollLeft;
      row.scrollIntoView({ block: "nearest" });
      if (scrollX) alignX(row, left);                  // scrollIntoView の横の送り（行の幅いっぱい）は使わない
    }
    if (notify && n && !n.action) onSelect?.(n);
    return n;
  }

  /**
   * その行をツリーの中で縦に送る。上下に 3 行分（欄の 1/3 まで）の余白を残し、すでに余白の内にあれば動かさない。
   * 外にあれば上の余白の位置へ送る。force なら余白の内でも上の余白の位置へ送る（利用者が頼んだとき）。
   * ツリーの外（ページ）はスクロールしない
   */
  function scrollToRow(target, { margins = 3, force = false } = {}) {
    const n = typeof target === "string" ? byId.get(target) : target;
    const row = n ? rows.get(n) : null;
    if (!row?.getBoundingClientRect || !root.getBoundingClientRect) return;
    const box = root.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (!box.height) return;                            // 畳まれていて見えない。開いたときに呼び直す
    const margin = Math.min((r.height || 28) * margins, box.height / 3);
    const top = r.top - box.top, bottom = box.bottom - r.bottom;
    if (force || top < margin || bottom < margin) root.scrollTop += top - margin;
    if (scrollX) alignX(row, root.scrollLeft, force);
  }

  /**
   * scrollX の使い手で、行の名前が見える横位置へ送る（scrollLeftFor）。left は合わせる前の scrollLeft（動かさないときはここへ戻す）。
   * 頭は chevron の次（アイコンか名前）、終わりは ⋯ の前の最後の部品（名前・「経路のみ」の札）。
   * ⋯ は右端に留まるので、その幅と行の右の余白を名前の右に空ける
   */
  function alignX(row, left, force = false) {
    const box = root.getBoundingClientRect?.();
    if (!box?.width || !root.clientWidth) return;
    const parts = [...row.children].filter((c) => !c.classList.contains("chev") && !c.classList.contains("tree-more"));
    if (!parts.length) return;
    const more = row.querySelector(".tree-more");
    const style = globalThis.getComputedStyle?.(row), rootStyle = globalThis.getComputedStyle?.(root);
    // ⋯ は欄の余白の内側に留まる（sticky）ので、欄の右の余白も足す
    const gap = parseFloat(style?.columnGap) || 0, pad = (parseFloat(style?.paddingRight) || 0) + (parseFloat(rootStyle?.paddingRight) || 0);
    const origin = box.left + (root.clientLeft || 0) - (root.scrollLeft || 0);   // 中身の左端（今の位置で測る。scrollIntoView が動かしていても）
    const x = (c, side) => c.getBoundingClientRect()[side] - origin;
    root.scrollLeft = scrollLeftFor({
      scroll: left, width: root.clientWidth, force,
      start: x(parts[0], "left"), end: x(parts[parts.length - 1], "right"),
      reserve: pad + (more ? gap + more.getBoundingClientRect().width : 0),
    });
  }

  /** すべて畳む。一番上の節（根）だけ開いたまま残し、根の直下が並ぶ */
  function collapseAll() {
    opened.clear();
    for (const n of list) if (branch(n)) opened.add(n.id);
    redraw();
    if (scrollX) root.scrollLeft = 0;
  }

  /** その行が見えるところまで祖先を開く。選択はしない */
  function reveal(target) {
    const n = typeof target === "string" ? byId.get(target) : target;
    if (!n) return null;
    for (let p = parents.get(n); p; p = parents.get(p)) opened.add(p.id);
    redraw();
    return n;
  }

  // 一致した行と、その祖先だけを残す。一致行に .hit。子から親へ畳み上げる
  function applyFilter(pred) {
    if (!pred) { filter = null; redraw(); return; }
    const keep = new Set(), hit = new Set();
    (function walk(items) {
      let any = false;
      for (const n of items) {
        const kids = n.children?.length ? walk(n.children) : false;
        const here = Boolean(pred(n));
        if (here) hit.add(n);
        if (here || kids) { keep.add(n); any = true; }
      }
      return any;
    })(list);
    filter = { keep, hit };
    redraw();
  }

  /** キーボードからのメニュー。今いる行の左下に開く */
  function contextFromKeyboard() {
    const row = rows.get(selected);
    if (!onContext || !row) return false;
    const r = row.getBoundingClientRect();
    onContext(selected, r.left + 24, r.bottom, row);
    return true;
  }

  root.addEventListener("keydown", (e) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (contextFromKeyboard()) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const order = [...rows.keys()];
    if (!order.length) return;
    const at = order.indexOf(selected);
    const key = e.key;
    if (key === "ArrowDown") select(order[Math.min(order.length - 1, at + 1)] ?? order[0]);
    else if (key === "ArrowUp") select(order[Math.max(0, at - 1)] ?? order[0]);
    else if (key === "Home") select(order[0]);
    else if (key === "End") select(order[order.length - 1]);
    else if (key === "ArrowRight") {
      if (!selected) select(order[0]);
      else if (!branch(selected)) return;
      else if (!expanded(selected)) toggle(selected);
      else select(selected.children?.find((c) => rows.has(c)) ?? selected);
    } else if (key === "ArrowLeft") {
      if (!selected) return;
      else if (branch(selected) && expanded(selected)) toggle(selected);
      else if (parents.get(selected)) select(parents.get(selected));
      else return;
    } else if (key === "Enter") {
      if (!selected) return;
      if (selected.action) selected.action();          // 「さらに表示」の行
      else onSelect?.(selected);                       // 同じ行をもう一度送る（プレビューを戻す）
    } else if (key.length === 1 && /\S/.test(key)) {
      // 打った文字で始まる次の行へ。続けて打つと語で絞る
      const now = Date.now();
      typed = now - typedAt < 800 ? typed + key : key;
      typedAt = now;
      const from = at + 1;
      const found = [...order.slice(from), ...order.slice(0, from)]
        .find((n) => String(n.name ?? "").toLowerCase().startsWith(typed.toLowerCase()));
      if (!found) return;
      select(found);
    } else return;
    e.preventDefault();
  });

  function setNodes(next) {
    list = next ?? [];
    parents.clear();
    byId.clear();
    index(list, null);
    selected = selected ? byId.get(selected.id) ?? null : null;   // 差し替えても id が同じなら選択を保つ
    redraw();
  }

  setNodes(nodes);
  return {
    select, reveal, redraw, setNodes, scrollToRow, collapseAll,
    filter: applyFilter,
    node: (id) => byId.get(id) ?? null,
    selected: () => selected,
    focus: () => root.focus(),
    /** 開いている節の id。localStorage などに持てる。消えた節は落とす */
    state: () => [...opened].filter((id) => byId.has(id)),
  };
}
