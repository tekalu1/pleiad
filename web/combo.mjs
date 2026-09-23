import { isComposingKey } from "./keyboard.mjs";
import { searchTerms, matchesTerms, moreText } from "./search-terms.mjs";
// 独自のプルダウン（combo）。人間が入力する箇所は同時に候補も出す（docs/design-system.md §2.4）。
//
// 標準の <select> / <datalist> は使わない。入力欄をフォーカスすると候補が浮き、
// 選んでも、そのまま打ち込んでもよい。↑↓ Enter Esc で操作できる。
//
// DOM:
//   <label class="combo [up] [mono] [fill] [right]"><input><ul class="clist" hidden></ul></label>
// 静的な入力欄（index.html）はこの形で書いて combo() に渡す。動的に作るなら createCombo()。
//
// 候補は options() が返す { value, label?, hint?, sub?, badge?, badgeTitle?, search?, title? } の配列。
// 表示は label（無ければ value）、確定時に渡すのは value。sub は 2 行目の補足、badge は字の横の小さな札
// （「1M」など。確定した値に札があれば入力欄の横にも出す）、search は絞り込みにだけ使う字（display_name など）。
// 絞り込みは大文字小文字を区別しない部分一致で、空白区切りの語は AND（web/search-terms.mjs）。
// limit を渡すと先頭の limit 件だけ描き、残りは「ほかに N 件。文字を入れて絞り込んでください」。
// 打ち込んだ文字が今の値の表示のままなら今の値、value → label の順に一致すればその候補、
// 一致しなければ free なら打ち込んだ文字そのもの、strict なら直前の値に戻す。
import { el } from "./dom.mjs";

/**
 * @param {HTMLElement} root  .combo の label
 * @param {object} o
 * @param {() => Array<{value:string,label?:string,hint?:string,sub?:string,badge?:string,search?:string[]}>} o.options 候補
 * @param {(value:string, opt:object|null) => void} [o.onCommit] 値が確定した（変わったときだけ）
 * @param {string} [o.head] 候補一覧の見出し
 * @param {boolean} [o.strict] 候補に無い値を受け付けない
 * @param {string} [o.value] 初期値
 * @param {number} [o.limit] 描く候補の上限（数百件の一覧向け）
 * @param {string} [o.emptyText] 打った字に当たる候補が無いときの一文（自由入力の案内など）
 */
export function combo(root, { options, onCommit, head, strict = false, value, limit = Infinity, emptyText } = {}) {
  root.classList.toggle("strict", strict);
  const input = root.querySelector("input");
  const list = root.querySelector(".clist");
  let badge = root.querySelector(".cbadge");
  let items = [];
  let active = -1;
  let current = value ?? "";           // 確定している value

  const shown = (o) => String(o.label ?? o.value);
  const optionOf = (v) => (options?.() ?? []).find((o) => o.value === v) ?? null;
  const labelOf = (v) => { const opt = optionOf(v); return opt ? shown(opt) : v; };

  const paint = () => {
    const opt = optionOf(current);
    input.value = opt ? shown(opt) : current;
    // 字と確定する値が違う（表示名を出している）ときは、値を title に
    if (opt && (opt.title || shown(opt) !== String(opt.value))) input.title = opt.title ?? String(opt.value);
    else input.removeAttribute("title");
    if (opt?.badge) {
      if (!badge) { badge = el("span", "cbadge"); root.append(badge); }
      badge.textContent = opt.badge;
      if (opt.badgeTitle) badge.title = opt.badgeTitle;
      badge.hidden = false;
    } else if (badge) badge.hidden = true;
  };

  const render = (typed) => {
    const all = options?.() ?? [];
    const q = typed.trim().toLowerCase();
    const exact = q && all.some((o) => shown(o).toLowerCase() === q || String(o.value).toLowerCase() === q);
    // 完全一致なら全部出す（既に選んでいる値で絞ると何も残らないため）
    const terms = q && !exact ? searchTerms(q) : [];
    const hit = terms.length ? all.filter((o) => matchesTerms(terms, [shown(o), o.value, ...(o.search ?? [])])) : all;
    items = Number.isFinite(limit) ? hit.slice(0, limit) : hit;
    list.replaceChildren();
    if (head) list.append(el("li", "head", head));
    items.forEach((o, i) => {
      const li = el("li", [i === active ? "on" : "", o.sub ? "two" : ""].filter(Boolean).join(" "));
      li.dataset.i = String(i);
      if (o.title) li.title = o.title;
      const lbl = el("span", "lbl");
      lbl.append(el("span", "txt", shown(o)));
      if (o.badge) { const b = el("span", "cbadge", o.badge); if (o.badgeTitle) b.title = o.badgeTitle; lbl.append(b); }
      if (o.sub) { const body = el("span", "body"); body.append(lbl, el("span", "sub", o.sub)); li.append(body); }
      else li.append(lbl);
      if (o.hint) li.append(el("span", "hint", o.hint));
      // click だと blur が先に走って閉じてしまう。mousedown で取る
      li.onmousedown = (e) => { e.preventDefault(); pick(i); };
      list.append(li);
    });
    const more = hit.length - items.length;
    const note = more > 0 ? moreText(more) : !items.length && q && emptyText ? emptyText : "";
    // 案内の行は選べない（mousedown で閉じないよう、フォーカスも移さない）
    if (note) { const li = el("li", "more", note); li.onmousedown = (e) => e.preventDefault(); list.append(li); }
    list.hidden = !items.length && !note;
  };

  const close = () => { list.hidden = true; active = -1; };

  const settle = (v, opt) => {
    if (v === current) { paint(); return; }
    current = v;
    paint();
    onCommit?.(v, opt ?? null);
  };

  /** 打ち込まれた文字を値に落とす。今の値の表示のままなら今の値、候補の value / label に一致すればそれ */
  const commitTyped = () => {
    const typed = input.value.trim();
    // 表示名が同じ候補が複数あっても（`x` と `x[1m]`）、触っていなければ今の値を変えない
    if (typed === String(labelOf(current)).trim() || typed === current) return paint();
    const all = options?.() ?? [];
    const low = typed.toLowerCase();
    const hit = all.find((o) => String(o.value) === typed)
      ?? all.find((o) => shown(o) === typed && !o.badge) ?? all.find((o) => shown(o) === typed)
      ?? all.find((o) => String(o.value).toLowerCase() === low)
      ?? all.find((o) => shown(o).toLowerCase() === low);
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
  input.addEventListener("input", () => {
    active = -1;
    // 打ち替えている間は、確定している値の札を隠す（打った字の札に見えるため）
    if (badge) badge.hidden = !optionOf(current)?.badge || input.value !== labelOf(current);
    render(input.value);
  });
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
