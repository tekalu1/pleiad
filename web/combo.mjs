import { isComposingKey } from "./keyboard.mjs";
// 独自のプルダウン（combo）。人間が入力する箇所は同時に候補も出す（docs/design-system.md §2.4）。
//
// 標準の <select> / <datalist> は使わない。入力欄をフォーカスすると候補が浮き、
// 選んでも、そのまま打ち込んでもよい。↑↓ Enter Esc で操作できる。
//
// DOM:
//   <label class="combo [up] [mono] [fill] [right]"><input><ul class="clist" hidden></ul></label>
// 静的な入力欄（index.html）はこの形で書いて combo() に渡す。動的に作るなら createCombo()。
//
// 候補は options() が返す { value, label?, hint? } の配列。表示は label（無ければ value）、
// 確定時に渡すのは value。打ち込んだ文字が label か value に一致すればその候補、
// 一致しなければ free なら打ち込んだ文字そのもの、strict なら直前の値に戻す。
import { el } from "./dom.mjs";

/**
 * @param {HTMLElement} root  .combo の label
 * @param {object} o
 * @param {() => Array<{value:string,label?:string,hint?:string}>} o.options 候補
 * @param {(value:string, opt:object|null) => void} [o.onCommit] 値が確定した（変わったときだけ）
 * @param {string} [o.head] 候補一覧の見出し
 * @param {boolean} [o.strict] 候補に無い値を受け付けない（procway の接続先など）
 * @param {string} [o.value] 初期値
 */
export function combo(root, { options, onCommit, head, strict = false, value } = {}) {
  root.classList.toggle("strict", strict);
  const input = root.querySelector("input");
  const list = root.querySelector(".clist");
  let items = [];
  let active = -1;
  let current = value ?? "";           // 確定している value

  const labelOf = (v) => {
    const opt = (options?.() ?? []).find((o) => o.value === v);
    return opt ? (opt.label ?? opt.value) : v;
  };

  const paint = () => { input.value = labelOf(current); };

  const render = (typed) => {
    const all = options?.() ?? [];
    const q = typed.trim().toLowerCase();
    const shown = (o) => String(o.label ?? o.value);
    const exact = q && all.some((o) => shown(o).toLowerCase() === q || String(o.value).toLowerCase() === q);
    // 完全一致なら全部出す（既に選んでいる値で絞ると何も残らないため）
    items = q && !exact
      ? all.filter((o) => shown(o).toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q))
      : all;
    list.replaceChildren();
    if (head) list.append(el("li", "head", head));
    items.forEach((o, i) => {
      const li = el("li", i === active ? "on" : "");
      li.dataset.i = String(i);
      li.append(el("span", "lbl", shown(o)));
      if (o.hint) li.append(el("span", "hint", o.hint));
      // click だと blur が先に走って閉じてしまう。mousedown で取る
      li.onmousedown = (e) => { e.preventDefault(); pick(i); };
      list.append(li);
    });
    list.hidden = items.length === 0;
  };

  const close = () => { list.hidden = true; active = -1; };

  const settle = (v, opt) => {
    if (v === current) { paint(); return; }
    current = v;
    paint();
    onCommit?.(v, opt ?? null);
  };

  /** 打ち込まれた文字を値に落とす。候補の label / value に一致すればそれ */
  const commitTyped = () => {
    const typed = input.value.trim();
    const all = options?.() ?? [];
    const hit = all.find((o) => String(o.label ?? o.value) === typed || String(o.value) === typed)
      ?? all.find((o) => String(o.label ?? o.value).toLowerCase() === typed.toLowerCase());
    if (hit) return settle(hit.value, hit);
    if (strict) return paint();          // 候補に無い値は無効。元に戻す
    settle(typed, null);
  };

  const pick = (i) => {
    const o = items[i];
    close();
    if (o) settle(o.value, o); else commitTyped();
    input.blur();
  };

  const open = () => { if (input.readOnly) return; active = -1; render(""); };

  input.addEventListener("focus", open);
  input.addEventListener("click", () => { if (list.hidden) open(); });
  input.addEventListener("input", () => { active = -1; render(input.value); });
  // 候補は mousedown で確定する。blur も同期的に確定し、直後の送信に間に合わせる。
  input.addEventListener("blur", () => { close(); commitTyped(); });
  input.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { open(); return; }
      if (!items.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      render(input.value);
      list.querySelector(`li[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.hidden && active >= 0) pick(active);
      else { close(); commitTyped(); input.blur(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      paint();
      input.blur();
    }
  });

  paint();
  return {
    root,
    get value() { return current; },
    /** 外から値を差し替える（確定イベントは出さない） */
    set(v) {
      const editing = document.activeElement === input && input.value !== labelOf(current);
      current = v ?? "";
      if (!editing) paint();
    },
  };
}

/**
 * 骨組みごと作る。戻りの root を置きたい場所に append する。
 * @param {object} o combo() の引数に加えて
 * @param {string} [o.placeholder]
 * @param {string} [o.ariaLabel]
 * @param {string} [o.cls] .combo に足す class（up / mono / fill / right）
 */
export function createCombo({ placeholder, ariaLabel, cls, ...opts } = {}) {
  const root = el("label", "combo" + (cls ? ` ${cls}` : ""));
  const input = document.createElement("input");
  input.autocomplete = "off";
  if (placeholder) input.placeholder = placeholder;
  if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
  const list = el("ul", "clist");
  list.hidden = true;
  root.append(input, list);
  return combo(root, opts);
}
