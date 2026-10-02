// 脇の会話検索の、DOM に触らない部分（docs/design-system.md §4.1「検索」）。
// 照合の規則は core/session-search.mjs と同じ（空白区切りは AND・"…" は 1 語で畳まない・ほかは NFKC と小文字の部分一致・場所はフォルダー名）。
// 題・状態・場所の一致は、サーバーの結果が届く前にここで即座に出し、本文まで探した結果が届いたら置き換える。
import { isComposingKey } from "./keyboard.mjs";

export const fold = (s) => String(s ?? "").normalize("NFKC").toLowerCase();

const MAX_TERMS = 12;

/** 検索語を解く。core の parseQuery と同じ（語が多すぎるときは先頭の 12 語だけ。サーバーに任せる前の見た目用） */
export function parseTerms(query) {
  const s = String(query ?? "");
  const terms = [];
  const seen = new Set();
  const push = (raw, exact) => {
    if (!raw) return;
    const needle = exact ? raw : fold(raw);
    if (!needle) return;
    const key = `${exact ? "e" : "f"}\0${needle}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ raw, exact, needle });
  };
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '"') {
      const close = s.indexOf('"', i + 1);
      const end = close < 0 ? s.length : close;
      push(s.slice(i + 1, end), true);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '"') j++;
    push(s.slice(i, j), false);
    i = j;
  }
  return terms.slice(0, MAX_TERMS);
}

/** 作業ディレクトリのフォルダー名 */
export function placeName(cwd) {
  if (typeof cwd !== "string") return "";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

const includes = (term, original, folded) => (term.exact ? original.includes(term.needle) : folded.includes(term.needle));

/** 重なる・接する範囲を 1 つにして手前から並べる */
function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** 元の文字の中の一致の範囲（畳むと長さが変わる文字があっても、元の位置で返す） */
export function findRanges(text, terms) {
  const original = String(text ?? "");
  if (!original || !terms.length) return [];
  const ranges = [];
  const chunks = [];
  let folded = "";
  for (const m of original.matchAll(/[\s\S][\p{M}ﾞﾟ]*/gu)) {
    const f = fold(m[0]);
    chunks.push({ o0: m.index, o1: m.index + m[0].length, f1: folded.length + f.length });
    folded += f;
  }
  const locate = (p) => {
    let lo = 0, hi = chunks.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (chunks[mid].f1 > p) hi = mid; else lo = mid + 1; }
    return chunks[lo];
  };
  for (const term of terms) {
    const hay = term.exact ? original : folded;
    for (let at = hay.indexOf(term.needle); at >= 0; at = hay.indexOf(term.needle, at + term.needle.length)) {
      const end = at + term.needle.length;
      ranges.push(term.exact ? [at, end] : [locate(at).o0, locate(Math.max(at, end - 1)).o1]);
    }
  }
  return mergeRanges(ranges);
}

/**
 * 題・状態・場所だけで照合する（本文は見ない）。全部の語がこの 3 つのどこかに当たれば結果を返す。
 * @returns {{ titleTerms: number, allInTitle: boolean, matched: string[] } | null}
 */
export function matchLocal(session, terms) {
  const fields = { title: String(session.title ?? ""), status: String(session.status ?? ""), place: placeName(session.cwd) };
  const foldedFields = { title: fold(fields.title), status: fold(fields.status), place: fold(fields.place) };
  let titleTerms = 0, seen = 0;
  const matched = new Set();
  terms.forEach((term, i) => {
    for (const key of ["title", "status", "place"]) {
      if (!includes(term, fields[key], foldedFields[key])) continue;
      seen |= 1 << i;
      matched.add(key);
      if (key === "title") titleTerms++;
    }
  });
  if (seen !== (1 << terms.length) - 1) return null;
  return { titleTerms, allInTitle: titleTerms === terms.length, matched: [...matched] };
}

const DAY_MS = 86_400_000;

/** 手元の結果の並び。サーバーの関連度から本文の項を除いたもの（題に当たった語・全部が題に揃う・新しさの減点は 3 まで） */
export function localOrder(rows, sort, now = Date.now()) {
  const recent = (a, b) => (b.session.lastModified ?? 0) - (a.session.lastModified ?? 0);
  if (sort === "recent") return [...rows].sort(recent);
  const score = (r) => r.titleTerms * 4 + (r.allInTitle ? 2 : 0) - Math.min(3, Math.max(0, now - (r.session.lastModified ?? now)) / DAY_MS / 30);
  return [...rows].sort((a, b) => score(b) - score(a) || recent(a, b));
}

/** 期間の絞り込み（日数）から since（epoch ms）。0 は絞らない、1 は今日（ローカルの 0 時から） */
export function periodSince(days, now = Date.now()) {
  if (!days) return null;
  if (days === 1) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return now - days * DAY_MS;
}

/** 最近の検索。同じ語は先頭へ寄せ、n 件まで */
export function pushRecentSearch(list, query, max = 5) {
  const q = String(query ?? "").trim();
  if (!q) return list;
  return [q, ...list.filter((x) => x !== q)].slice(0, max);
}

const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** 検索欄へ移る近道か（Ctrl+Shift+F、macOS は ⌘⇧F）。IME の変換中は奪わない。Ctrl+F は会話の中の検索のまま */
export function isSearchShortcut(event, mac = isMac()) {
  if (!event || event.defaultPrevented || isComposingKey(event) || event.altKey || !event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return String(event.key ?? "").toLowerCase() === "f";
}
export const searchShortcutLabel = (mac = isMac()) => (mac ? "⌘⇧F" : "Ctrl+Shift+F");
/** aria-keyshortcuts の値 */
export const searchShortcutAria = (mac = isMac()) => (mac ? "Meta+Shift+F" : "Control+Shift+F");
