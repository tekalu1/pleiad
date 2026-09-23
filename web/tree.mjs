// ==================== ツリー（docs/design-system.md §9「コンテキスト探索」） ====================
// データ → DOM・開閉・選択・キーボード・絞り込みだけを持つ汎用の部品。行の意味は知らない。
// 行の中身（アイコン・右端の一語・件数）は render(node, row) で呼び出し側が描く。
//
//   node: { id, name, children?, open?, data }。children が無ければ葉。data は部品が触らない
//   DOM:  <div role=tree tabindex=0><ul><li role=none><div role=treeitem aria-level aria-expanded aria-selected>
//
// フォーカスは tree 1 つだけ（roving tabindex は持たない）。行が何百あっても tab 1 回で抜けられる。
// 今いる行は aria-activedescendant で支援技術に伝え、見た目は選択と同じ白い面で示す。
import { el, svgEl } from "./dom.mjs";

let seq = 0;

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
 *          render?:(node:any, row:HTMLElement)=>void, onSelect?:(node:any)=>void, onOpen?:(node:any, open:boolean)=>void}} opts
 */
export function createTree(root, { nodes = [], open = [], empty = "一致なし", render, onSelect, onOpen } = {}) {
  const prefix = `tree${++seq}`;
  const opened = new Set(open);                       // 開いている節の id。呼び出し側が state() で持ち出せる
  const parents = new Map(), rows = new Map(), byId = new Map();
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
  // 絞り込み中は祖先を全部開く。元の開閉は opened に残したままにして、解除で戻す
  const expanded = (n) => Boolean(n.children?.length) && (filter ? true : opened.has(n.id));

  function toggle(n) {
    if (!n.children?.length) return;
    const next = !opened.has(n.id);
    if (next) opened.add(n.id); else opened.delete(n.id);
    redraw();
    onOpen?.(n, next);
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
      if (n.children?.length) row.setAttribute("aria-expanded", String(expanded(n)));
      if (n === selected) row.classList.add("sel");
      if (filter?.hit.has(n)) row.classList.add("hit");
      const chev = chevron();
      if (!n.children?.length) chev.classList.add("none");   // 葉でも場所は空けて字下げを揃える
      chev.onclick = (e) => { e.stopPropagation(); toggle(n); };
      row.append(chev);
      if (render) render(n, row); else row.append(el("span", "nm", n.name));
      row.onclick = () => select(n);                   // 単押しは選択だけ。開閉は chevron かダブルクリック
      row.ondblclick = () => toggle(n);
      li.append(row);
      rows.set(n, row);
      if (n.children?.length && expanded(n)) li.append(build(n.children, level + 1));
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

  function select(target, notify = true) {
    const n = typeof target === "string" ? byId.get(target) : target;
    if (!n) return null;
    selected = n;
    for (const [node, row] of rows) {
      row.classList.toggle("sel", node === n);
      row.setAttribute("aria-selected", String(node === n));
    }
    const row = rows.get(n);
    root.setAttribute("aria-activedescendant", row?.id ?? "");
    row?.scrollIntoView({ block: "nearest" });
    if (notify) onSelect?.(n);
    return n;
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

  root.addEventListener("keydown", (e) => {
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
      else if (!selected.children?.length) return;
      else if (!expanded(selected)) toggle(selected);
      else select(selected.children.find((c) => rows.has(c)) ?? selected);
    } else if (key === "ArrowLeft") {
      if (!selected) return;
      else if (selected.children?.length && expanded(selected)) toggle(selected);
      else if (parents.get(selected)) select(parents.get(selected));
      else return;
    } else if (key === "Enter") {
      if (!selected) return;
      onSelect?.(selected);                            // 同じ行をもう一度送る（プレビューを戻す）
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
    select, reveal, redraw, setNodes,
    filter: applyFilter,
    node: (id) => byId.get(id) ?? null,
    selected: () => selected,
    focus: () => root.focus(),
    /** 開いている節の id。localStorage などに持てる。消えた節は落とす */
    state: () => [...opened].filter((id) => byId.has(id)),
  };
}
