// 長押しで右クリックのメニューを開く（docs/remote.md §8.4）。
// iOS の WebView は長押しで contextmenu を出さない。Android（Chromium）は出すので、先に届いた方だけを通す。
// 指を置いたまま delay だけ動かなければ、置いた位置で contextmenu を起こす。受け手（行・見出し・ファイル）が
// preventDefault したときだけ「長押しで開いた」とみなし、指を離したあとの click と、あとから来る OS の contextmenu を捨てる。
// 受け手の無い場所（本文の文字など）では何もしない（文字の選択は OS のまま）。「…」のボタンは対象にしない。

const SKIP = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .more-btn';

/**
 * @param {object} [o]
 * @param {Document} [o.doc]
 * @param {number} [o.delay] 長押しとみなす時間（ms）
 * @param {number} [o.slop]  動いてもよい距離（px）。越えたらスクロールとみなしてやめる
 */
export function setupLongPress({ doc = globalThis.document, delay = 500, slop = 10 } = {}) {
  if (!doc?.addEventListener) return null;
  let timer = null, start = null, opened = false, nativeSeen = false, reset = null;
  const cancel = () => { clearTimeout(timer); timer = null; };

  doc.addEventListener('pointerdown', (e) => {
    cancel();
    clearTimeout(reset);
    opened = false;
    nativeSeen = false;
    if (e.pointerType !== 'touch' || e.isPrimary === false) return;
    const target = e.target;
    if (!target?.closest || target.closest(SKIP)) return;
    start = { x: e.clientX, y: e.clientY, target };
    timer = setTimeout(() => {
      timer = null;
      if (nativeSeen || !target.isConnected) return;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: start.x, clientY: start.y, button: 2, buttons: 2 });
      target.dispatchEvent(ev);
      opened = ev.defaultPrevented;
    }, delay);
  }, true);

  doc.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) cancel();
  }, true);
  // 指を離した・スクロールが始まった（pointercancel）。開いたあとの click を捨て終えたら印を外す
  const up = () => { cancel(); if (opened) { clearTimeout(reset); reset = setTimeout(() => { opened = false; }, 600); } };
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', up, true);

  doc.addEventListener('contextmenu', (e) => {
    if (!e.isTrusted) return;             // 自分で起こしたもの
    if (opened) { e.preventDefault(); e.stopImmediatePropagation(); return; }   // もう開いた。OS の分は捨てる
    if (timer) { nativeSeen = true; cancel(); }   // OS が先に出した（Android）。こちらは起こさない
  }, true);
  // OS の長押しで受け手がメニューを開いたときも、指を離したあとの click（開いたメニューの上に落ちる）を捨てる
  doc.addEventListener('contextmenu', (e) => {
    if (e.isTrusted && nativeSeen && e.defaultPrevented) opened = true;
  });

  doc.addEventListener('click', (e) => {
    if (!opened) return;
    opened = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  return { cancel };
}
