// 絵文字ピッカー部品。
// 状態のアイコン選択（web/side.mjs）、チャンネルのリアクション（W2）、bot のアイコン（W4）などで共有する。
// 外部依存なし。絵文字の一覧（web/emoji.mjs）は初回起動の空き時間に先読みする。

import { isComposingKey } from "./keyboard.mjs";
import { el, icon } from "./dom.mjs";
import { runMark } from "./arc.mjs";
import { t } from "./i18n.mjs";

const RECENT_KEY = "agent-host-emoji-recent";
const RECENT_MAX = 16;
// 既定のアイコン。フォルダ（他のアイコンと同じ線幅 1.6・丸端）
const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";

// 絵文字の一覧（1363 件）は重いので、起動後の空き時間に先読みし、押した瞬間は面と弧を先に出す
let emojiMod = null;
const loadEmoji = () => (emojiMod ??= import("./emoji.mjs"));

/** 絵文字のカテゴリの名前。辞書に無い id は emoji.mjs の名前のまま */
// i18n-dynamic: sidebar.emoji.category.
const CATEGORY_IDS = ["smileys", "nature", "food", "activity", "travel", "objects", "symbols", "flags"];
const categoryLabel = (c) => (CATEGORY_IDS.includes(c.id) ? t(`sidebar.emoji.category.${c.id}`) : c.label);

(globalThis.requestIdleCallback ?? ((f) => setTimeout(f, 1500)))(() => { loadEmoji().catch(() => {}); });
const sections = new Map(); // カテゴリ id -> 一度作った格子。2 回目以降は使い回す

const loadRecent = () => {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const pushRecent = (e) => {
  const next = [e, ...loadRecent().filter((x) => x !== e)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 保存できなくても動く */
  }
};

let activePicker = null;

/** 開いている絵文字ピッカーを閉じる */
export function closeEmojiPicker() {
  if (activePicker) {
    activePicker.close();
  }
}

function getPickerElement() {
  let p = document.getElementById("iconPop");
  if (!p) {
    p = document.createElement("div");
    p.id = "iconPop";
    p.className = "pop emoji-picker-pop";
    p.hidden = true;
    document.body.append(p);
  }
  return p;
}

function placePicker(p, anchor, within) {
  if (within) {
    p.style.position = "absolute";
    const r = anchor.getBoundingClientRect();
    const side = within.getBoundingClientRect();
    p.style.left = `${Math.max(4, Math.min(r.left - side.left, side.width - 316))}px`;
    p.style.top = `${r.bottom - side.top + 4}px`;
  } else {
    p.style.position = "fixed";
    p.style.zIndex = "50";
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const popW = Math.min(312, vw - 16);
    p.style.width = `${popW}px`;
    const left = Math.max(8, Math.min(r.left, vw - popW - 8));
    let top = r.bottom + 4;
    if (top + 360 > vh && r.top - 4 - 360 >= 0) {
      top = Math.max(8, r.top - 4 - 360);
    }
    p.style.left = `${Math.round(left)}px`;
    p.style.top = `${Math.round(top)}px`;
  }
}

/**
 * どこからでも呼べる絵文字ピッカーを開く。
 *
 * @param {object} options
 * @param {HTMLElement} options.anchor 基準となる要素
 * @param {HTMLElement} [options.within] 配置の枠となる要素（例: #sidebar）。無ければ画面全体で位置決め
 * @param {(emoji: string) => void} options.onPick 絵文字が選ばれたときのコールバック
 * @param {(() => void)|null} [options.onReset] 既定に戻すボタンを押したときのコールバック（省略時はボタンなし）
 * @param {string} [options.current] 現在選ばれている絵文字（格子で .on を付ける）
 * @param {string} [options.title] 見出しの文言（省略時は見出しなし）
 * @param {string} [options.resetLabel] リセットボタンのラベル（既定: t("sidebar.emoji.reset")）
 * @param {string} [options.resetHint] リセットボタンの補足（既定: t("sidebar.emoji.folder")）
 * @param {string} [options.resetIcon] リセットボタンのアイコン path（既定: FOLDER）
 */
export async function openEmojiPicker({
  anchor,
  within,
  onPick,
  onReset,
  current = "",
  title,
  resetLabel,
  resetHint,
  resetIcon = FOLDER,
}) {
  if (!anchor) return;
  closeEmojiPicker();

  const p = getPickerElement();
  const container = within ?? document.body;
  if (p.parentElement !== container) {
    container.append(p);
  }

  p.hidden = false;
  placePicker(p, anchor, within);

  const cur = current ?? "";
  let isClosed = false;

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    p.hidden = true;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (activePicker === self) {
      activePicker = null;
    }
  };

  const choose = (e) => {
    close();
    pushRecent(e);
    onPick?.(e);
  };

  const self = { close, pop: p, anchor };
  activePicker = self;

  const onPointerDown = (e) => {
    if (p.contains(e.target) || anchor?.contains(e.target)) return;
    close();
  };

  const onKeyDown = (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);

  // 押した瞬間に面を出す。一覧の読み込みを待つ間は弧
  if (title) p.replaceChildren(el("div", "head", title));
  else p.replaceChildren();

  const q = document.createElement("input");
  q.className = "field";
  q.placeholder = t("sidebar.emoji.placeholder");
  q.setAttribute("aria-label", t("sidebar.emoji.search"));
  p.append(q);

  const tabs = el("div", "etabs");
  const body = el("div", "ebody");
  const wait = el("div", "empty ewait");
  wait.append(runMark(t("sidebar.emoji.loadingMark")), el("span", null, t("sidebar.emoji.loading")));
  body.append(wait);
  p.append(tabs, body);

  if (onReset) {
    const reset = el("button", "li");
    reset.type = "button";
    reset.append(
      icon(resetIcon),
      el("span", "lbl", resetLabel ?? t("sidebar.emoji.reset")),
      el("span", "hint", resetHint ?? t("sidebar.emoji.folder"))
    );
    reset.onclick = () => {
      close();
      onReset();
    };
    p.append(reset);
  }
  setTimeout(() => q.focus(), 0);

  const opened = (p.dataset.seq = String(Number(p.dataset.seq ?? 0) + 1));
  let mod;
  try {
    mod = await loadEmoji();
  } catch {
    wait.textContent = t("sidebar.emoji.loadFailed");
    return;
  }
  if (p.hidden || p.dataset.seq !== opened || isClosed) return; // 待っている間に閉じた・別のを開いた

  const { CATEGORIES, EMOJI_RE } = mod;

  /** 格子。触れると薄い丸、押すと確定。押した先は body で受ける（格子は使い回すので、ここでは結ばない） */
  const grid = (items) => {
    const g = el("div", "egrid");
    for (const [e, en, ja] of items) {
      const b = el("button", null, e);
      b.type = "button";
      b.dataset.e = e;
      b.title = `${ja} ${en}`.trim();
      g.append(b);
    }
    return g;
  };

  const section = (id, label, items) => {
    const s = el("div", "esec");
    s.dataset.cat = id;
    s.append(el("div", "head", label), grid(items));
    return s;
  };

  // カテゴリの格子は一度作ったら使い回す（1363 個のボタンを毎回作らない）
  const cached = (c) => {
    if (!sections.has(c.id)) sections.set(c.id, section(c.id, categoryLabel(c), c.items));
    return sections.get(c.id);
  };

  body.onclick = (e) => {
    const b = e.target.closest(".egrid button");
    if (b) choose(b.dataset.e);
  };

  const markCurrent = () => {
    for (const b of body.querySelectorAll(".egrid button.on")) b.classList.remove("on");
    if (cur) for (const b of body.querySelectorAll(`.egrid button[data-e="${CSS.escape(cur)}"]`)) b.classList.add("on");
  };

  for (const c of CATEGORIES) {
    const tab = el("button", "etab", c.icon);
    tab.type = "button";
    tab.title = categoryLabel(c);
    tab.onclick = () => {
      q.value = "";
      renderAll();
      body.querySelector(`.esec[data-cat="${c.id}"]`)?.scrollIntoView({ block: "start" });
    };
    tabs.append(tab);
  }

  const renderAll = () => {
    body.replaceChildren();
    const recent = loadRecent();
    if (recent.length) {
      const all = new Map(CATEGORIES.flatMap((c) => c.items).map((it) => [it[0], it]));
      body.append(section("recent", t("sidebar.emoji.recent"), recent.map((e) => all.get(e) ?? [e, "", ""])));
    }
    for (const c of CATEGORIES) body.append(cached(c));
    markCurrent();
  };

  const renderSearch = (text) => {
    body.replaceChildren();
    const typed = text.trim();
    // 貼り付けた絵文字はそのまま候補の先頭に。一覧に無いものでも選べる
    const pasted = [...new Set([...typed.matchAll(EMOJI_RE)].map((m) => m[0]))];
    const words = typed.replace(EMOJI_RE, " ").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length
      ? CATEGORIES.flatMap((c) => c.items).filter(([e, en, ja]) => {
          const hay = `${en} ${ja}`.toLowerCase();
          return words.every((w) => hay.includes(w)) && !pasted.includes(e);
        })
      : [];
    const items = [...pasted.map((e) => [e, "", ""]), ...hits];
    body.append(items.length ? section("search", t("sidebar.emoji.hits", { count: items.length }), items) : el("div", "empty", t("sidebar.noMatch")));
    markCurrent();
  };

  q.oninput = () => (q.value.trim() ? renderSearch(q.value) : renderAll());
  q.onkeydown = (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    // Enter は先頭の候補で確定
    if (e.key === "Enter") {
      e.preventDefault();
      body.querySelector(".egrid button")?.click();
    }
  };

  if (q.value.trim()) renderSearch(q.value);
  else renderAll(); // 待っている間に打ち始めていたらその結果から
}
