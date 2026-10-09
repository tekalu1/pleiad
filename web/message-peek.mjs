// ホバーの無い端末（タッチ）で、発言を押すとその発言の時刻を数秒だけ出す（docs/design-system.md §2.3、ADR 0067）。
// 時刻は触れている・焦点がある間だけ見える（style.css の .m:hover / .m.peek）。押した先がリンク・ボタン・コード・字の選択のときは何もしない。
export const PEEK_MS = 4000;
const SKIP = "a, button, summary, input, textarea, select, [contenteditable], .code-block, .table-wrap";

/** 押した先が、時刻を出す押し方か。root はこの押し方を見る入れ物（会話の列） */
export function peekTarget(target, { hasSelection = false } = {}) {
  if (hasSelection || !target?.closest || target.closest(SKIP)) return null;
  const m = target.closest(".m");
  return m?.querySelector(":scope > .who .when") ? m : null;
}

export function setupMessagePeek(root, { ms = PEEK_MS, hoverless = () => matchMedia("(hover:none)").matches } = {}) {
  const timers = new WeakMap();
  root.addEventListener("click", (e) => {
    if (!hoverless()) return;
    const m = peekTarget(e.target, { hasSelection: Boolean(getSelection()?.toString()) });
    if (!m) return;
    clearTimeout(timers.get(m));
    m.classList.add("peek");
    timers.set(m, setTimeout(() => m.classList.remove("peek"), ms));
  });
}
