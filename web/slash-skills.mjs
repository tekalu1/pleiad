import { isComposingKey } from "./keyboard.mjs";
import { el } from "./dom.mjs";
// カーソル位置の「/名前」だけを補完する（前後の文章・他のスキルは保持）。
//
// 日本語の文中は空白なしでも使える。URL・パスの内部では出さない。
// 候補は core の探索（コンテキスト画面と同じ結果）から来る。ここでは絞り込みと描画だけを行う。
//
// 確定は Enter / Tab / クリック。`/名前 ` まで入り、続けて引数を打てる。
// Ctrl+Enter は候補が開いていても送信のまま（keydown が false を返す）。

/** 入力欄の値から打ち込まれた名前を取り出す。候補を出す条件を満たさなければ null */
export function parseQuery(value, caret, end) {
  return skillToken(value, caret, end)?.query ?? null;
}

export function skillToken(value, caret = String(value ?? "").length, end = caret) {
  const text = String(value ?? "");
  if (caret !== end || caret < 0 || caret > text.length) return null;
  const start = text.lastIndexOf("/", caret - 1);
  if (start < 0 || start >= caret) return null;
  if (start && !/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（(「『、。，,]/u.test(text[start - 1])) return null;
  const query = text.slice(start + 1, caret);
  if (!/^[\p{L}\p{N}_.:-]*$/u.test(query)) return null;
  const tail = /^[\p{L}\p{N}_.:-]*/u.exec(text.slice(caret))[0];
  const finish = caret + tail.length;
  if (text[finish] === "/" || text[finish] === "\\") return null;
  return { query, start, end: finish };
}

/** 一致した文字の範囲（青くする場所）。無ければ空 */
export function matchRange(text, q) {
  const needle = String(q ?? "").toLowerCase();
  if (!needle) return [];
  const at = String(text ?? "").toLowerCase().indexOf(needle);
  return at < 0 ? [] : [at, at + needle.length];
}

/**
 * 名前と説明の部分一致。名前の前方一致 → 名前の部分一致 → 説明だけの一致、の順。
 * 同じ順位の中は元の並び（core が名前順で返す）を保つ。
 */
export function filterSkills(skills, q) {
  const needle = String(q ?? "").toLowerCase();
  const rank = (s) => {
    const name = String(s.name ?? "").toLowerCase();
    if (!needle) return 0;
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    return 2;
  };
  return (skills ?? [])
    .filter((s) => !needle
      || String(s.name ?? "").toLowerCase().includes(needle)
      || String(s.description ?? "").toLowerCase().includes(needle))
    .map((s, i) => ({ s, rank: rank(s), i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.s);
}

/**
 * @param {object} o
 * @param {HTMLTextAreaElement} o.input 入力欄
 * @param {HTMLElement} o.list 候補の ul（.clist）
 * @param {HTMLElement} [o.hint] 引数の書き方を出す場所
 * @param {(cwd:string) => Promise<Array<object>>} o.load 候補を取りに行く（cwd は今の作業ディレクトリ）
 * @param {() => string} [o.cwd] 今の作業ディレクトリ
 * @param {() => number} [o.now] 取得した時刻の測り方（テストのためだけに差し替えられる）
 */
export function setupSlashSkills({ input, list, hint, load, cwd = () => "", now = () => Date.now() }) {
  // 同じ作業ディレクトリなら使い回す。ただし古くなったら取り直す（編集中に足したスキルを拾う）
  const FRESH_MS = 60_000;
  let skills = [], skillsKey = null, skillsAt = 0, loadingKey = null;
  let items = [], active = 0, chosen = null;
  const token = () => skillToken(input.value, input.selectionStart, input.selectionEnd);
  const query = () => token()?.query ?? null;

  const isOpen = () => !list.hidden;
  const cwdKey = () => String(cwd() ?? "").trim();

  const close = () => {
    if (!isOpen()) return;
    list.hidden = true;
    list.replaceChildren();
    items = [];
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  const parts = (text, q) => {
    const [a, b] = matchRange(text, q);
    if (!a && !b) return [el("span", null, text)];
    return [el("span", null, text.slice(0, a)), el("b", null, text.slice(a, b)), el("span", null, text.slice(b))];
  };

  const paint = (q) => {
    list.replaceChildren();
    const head = el("li", "head");
    head.append(el("span", null, "スキル"), el("span", "n", String(items.length)));
    list.append(head);
    if (!items.length) list.append(el("li", "none", "一致するスキルがありません"));
    for (const extra of list.children) if (!extra.classList.contains("it") && extra !== head) extra.setAttribute("role", "presentation");
    items.forEach((s, i) => {
      const li = el("li", "it" + (i === active ? " on" : ""));
      li.id = `slash-option-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      const name = el("span", "name");
      name.append(el("span", null, "/"), ...parts(s.name, q));
      if (s.hint) name.append(el("span", "args", s.hint));
      li.append(name, el("span", "from", s.from ?? ""));
      li.append(el("span", "desc", s.description ?? ""));
      // click だと blur が先に走る。mousedown で取る（combo と同じ）
      li.onmousedown = (e) => { e.preventDefault(); commit(i); };
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
    if (items.length) input.setAttribute("aria-activedescendant", `slash-option-${active}`);
    list.children[active + 1]?.scrollIntoView?.({ block: "nearest" });
  };

  const render = (q) => {
    items = filterSkills(skills, q);
    if (active >= items.length) active = 0;
    paint(q);
  };

  /** 候補を取りに行く。同じ作業ディレクトリの新しい結果があれば使う */
  async function ensure(key) {
    if (loadingKey === key) return;
    if (skillsKey === key && now() - skillsAt < FRESH_MS) return;
    loadingKey = key;
    items = [];
    input.removeAttribute("aria-activedescendant");
    list.hidden = false;
    list.replaceChildren(el("li", "head"), el("li", "none", "読み込み中…"));
    input.setAttribute("aria-expanded", "true");
    try {
      const got = await load(key);
      if (loadingKey !== key) return;
      skillsKey = key;
      skillsAt = now();
      skills = Array.isArray(got) ? got : [];
    } catch {
      if (loadingKey !== key) return;
      skillsKey = key;
      skillsAt = now();
      skills = [];
      list.replaceChildren(el("li", "none", "スキル一覧を取得できませんでした"));
      input.setAttribute("aria-expanded", "true");
      return;
    } finally {
      if (loadingKey === key) loadingKey = null;
    }
    const q = query();
    if (q === null) return close();
    if (!isOpen()) return;
    active = 0;
    render(q);
  }

  const commit = (i) => {
    const s = items[i];
    const at = token();
    if (!s || !at) return close();
    const suffix = input.value.slice(at.end);
    const insertion = `/${s.name}` + (/^\s/.test(suffix) ? "" : " ");
    input.value = input.value.slice(0, at.start) + insertion + suffix;
    const caret = at.start + insertion.length + (/^\s/.test(suffix) ? 1 : 0);
    chosen = { value: input.value };
    if (hint) hint.textContent = s.hint ? `引数  ${s.hint}` : "";
    close();
    input.focus?.();
    input.setSelectionRange?.(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** 入力が変わったら候補の出し入れと、選んだ直後の引数ヒントの後始末 */
  const sync = () => {
    const q = query();
    if (q === null) return close();
    const key = cwdKey();
    if (skillsKey !== key || now() - skillsAt >= FRESH_MS) return ensure(key);
    active = 0;
    render(q);
  };

  input.addEventListener("input", () => {
    if (chosen && chosen.value !== input.value) {
      chosen = null;
      if (hint) hint.textContent = "";
    }
    sync();
  });
  input.addEventListener("focus", sync);
  input.addEventListener("click", sync);
  input.addEventListener("keyup", e => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) sync();
  });
  input.addEventListener("blur", () => { setTimeout(close, 120); });

  /** 候補が開いている間のキーを取る。取ったら true（呼び出し側は以降を処理しない） */
  const keydown = (e) => {
    if (isComposingKey(e)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;   // Ctrl+Enter は送信のまま
    if (!isOpen()) return false;
    const q = query();
    if (q === null) { close(); return false; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return true;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      render(q);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (!items.length) return false;
      e.preventDefault();
      commit(active);
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); close(); return true; }
    return false;
  };

  return { keydown, close, isOpen };
}
