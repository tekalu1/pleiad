// 会話の地図（docs/design-system.md「会話の移動」B、ADR 0063）。#log の右端の細いレール。
// 各ターン（利用者の発言）を点で置き、位置は本文の実際の高さに比例させる。今見えている範囲は淡い面。
// 区別する形は ◆ 承認待ち・⋮ 圧縮の境目・⑂ 分岐・◉ 可視化だけ（失敗は出さない）。
// 位置は web/conversation-nav-view.mjs が持つ測定結果を使い、ここでは測らない（強制レイアウトを起こさない）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { appendPieces } from './conversation-nav.mjs';

const GLYPH = { pending: '◆', compact: '⋮', branch: '⑂', visual: '◉' };
/** 点の高さ（当たり判定）の半分。端で切れないよう、点の中心はこの分だけ内側に寄せる */
const HALF = 8;
/** レールの上下の余白。CSS の top / bottom と同じ */
const PAD_TOP = 14, PAD_BOTTOM = 16;   // 点の位置は rail の上端から測る（rail 自身が上下の余白の内側）

/**
 * 各ターンに付ける区別の形を、筋の並びから 1 度の走査で決める（優先は 承認待ち > 圧縮 > 分岐 > 可視化）。
 * 圧縮の境目・分岐・可視化・承認は利用者の発言の後ろに並ぶので、直前の発言のターンに数える
 * @returns {string[]} ターンごとの種類（''・pending・compact・branch・visual）
 */
export function turnKinds(thread, turns) {
  const kinds = turns.map(() => '');
  const owner = new Map();
  let index = -1;
  const rows = new Map(turns.map((turn, i) => [turn.row, i]));
  for (const child of thread.children) {
    if (rows.has(child)) index = rows.get(child);
    owner.set(child, index);
  }
  const RANK = ['', 'visual', 'branch', 'compact', 'pending'];
  const mark = (node, kind) => {
    let child = node;
    while (child && child.parentElement !== thread) child = child.parentElement;
    const i = child ? owner.get(child) : undefined;
    if (i === undefined || i < 0) return;
    if (RANK.indexOf(kind) > RANK.indexOf(kinds[i])) kinds[i] = kind;
  };
  for (const node of thread.querySelectorAll('.visualize-expand')) mark(node, 'visual');
  for (const node of thread.querySelectorAll(':scope > .branch-row')) mark(node, 'branch');
  for (const node of thread.querySelectorAll(':scope > .mw.compaction-boundary')) mark(node, 'compact');
  for (const node of thread.querySelectorAll(':scope > .mw.card:not(.done)')) mark(node, 'pending');
  return kinds;
}

/**
 * @param {{ frame:HTMLElement, log:HTMLElement, thread:HTMLElement, nav:object, narrow:MediaQueryList }} o
 */
export function createConversationRail({ frame, log, thread, nav, narrow }) {
  const rail = el('div', 'nav-rail');
  rail.hidden = true;
  rail.setAttribute('role', 'group');
  rail.setAttribute('aria-label', t('nav.rail.label'));
  const surface = el('div', 'nav-rail-surface');
  const range = el('div', 'nav-rail-range');
  const tip = el('div', 'nav-tip');
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  rail.append(surface, range, tip);
  frame.append(rail);

  /** @type {HTMLButtonElement[]} */
  let dots = [];
  let kinds = [], shown = false, height = 0, active = -1, dragging = false, dragFrom = 0, dragTurn = -1;
  let builtFor = null, timer = 0, tops = [], hovered = -1;

  const label = (turn, i) => {
    const info = nav.turnInfo(turn), kind = kinds[i];
    const text = info.plain.length > 60 ? `${info.plain.slice(0, 60)}…` : info.plain;
    // i18n-dynamic: nav.rail.kind.
    return [String(i + 1), info.at, text, kind ? t(`nav.rail.kind.${kind}`) : ''].filter(Boolean).join(' · ');
  };

  function build(turns) {
    for (const dot of dots) dot.remove();
    dots = turns.map((turn, i) => {
      const dot = el('button', 'nav-dot');
      dot.type = 'button';
      dot.tabIndex = -1;
      dot.addEventListener('focus', () => showTip(i));
      dot.addEventListener('blur', hideTip);
      // ポインターの操作は rail 全体で拾う（キャプチャの下では click が dot に届かない）。click はキーボード（detail 0）だけ
      dot.addEventListener('click', (event) => { if (event.detail === 0) nav.goTo(i); });
      dot.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowDown') next = Math.min(dots.length - 1, i + 1);
        else if (event.key === 'ArrowUp') next = Math.max(0, i - 1);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = dots.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        dots[i].tabIndex = -1;
        dots[next].tabIndex = 0;
        dots[next].focus();
      });
      rail.append(dot);
      return dot;
    });
    active = -1;
    hovered = -1;
  }

  /** 区別の形を取り直す。変わった点だけ書く（全部書くと、点の数だけ再計算が走る） */
  function paintKinds(turns) {
    const next = turnKinds(thread, turns);
    dots.forEach((dot, i) => {
      if (kinds[i] === next[i] && dot.firstChild) return;
      const kind = next[i];
      dot.className = `nav-dot${kind ? ` ${kind}` : ''}`;
      dot.replaceChildren(kind ? GLYPH[kind] : el('span', 'nav-dot-normal'));
      kinds[i] = kind;
      dot.setAttribute('aria-label', label(turns[i], i));
    });
    kinds.length = dots.length;
  }

  function place(turns) {
    const total = log.scrollHeight;
    const h = height;
    const before = tops;
    tops = turns.map((turn) => Math.max(HALF, Math.min(h - HALF, turn.top / total * h)));
    // transform で置く（top を書くと、点の数だけレイアウトが走る）。点の高さ 15px の半分を引いて中心を tops に合わせる。0.5px 以上動いた点だけ書く
    dots.forEach((dot, i) => { if (before[i] === undefined || Math.abs(before[i] - tops[i]) >= 0.5) dot.style.transform = `translateY(${(tops[i] - 7.5).toFixed(1)}px)`; });
  }
  /** レールの上の高さ y（レールの上端から）に一番近い点。近い点が無ければ -1。点は重なることがあるので、要素ではなく距離で選ぶ */
  function nearest(y) {
    let lo = 0, hi = tops.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid] < y) lo = mid + 1; else hi = mid; }
    let best = -1, gap = HALF + 2;
    for (const i of [lo - 1, lo]) if (i >= 0 && i < tops.length && Math.abs(tops[i] - y) < gap) { best = i; gap = Math.abs(tops[i] - y); }
    return best;
  }
  const railTop = () => rail.getBoundingClientRect().top;
  function hot(i) {
    if (i === hovered) return;
    dots[hovered]?.classList.remove('hot');
    hovered = i;
    if (i < 0) return hideTip();
    dots[i].classList.add('hot');
    showTip(i);
  }

  function flush() {
    timer = 0;
    if (!shown) return;
    const turns = nav.turns();
    if (builtFor !== turns) return;
    paintKinds(turns);
    place(turns);
  }

  function showTip(i) {
    if (dragging) return;
    const turn = nav.turns()[i];
    if (!turn) return;
    const info = nav.turnInfo(turn);
    const text = el('span', 'nav-tip-text');
    appendPieces(text, info.pieces);
    tip.replaceChildren(el('span', 'nav-tip-time', info.at), text);
    tip.hidden = false;
    const top = tops[i] - 22;
    tip.style.top = `${Math.max(0, Math.min(height - tip.offsetHeight, top))}px`;
  }
  function hideTip() { tip.hidden = true; }

  /** 会話欄の高さ・スクロールから、レールの出入り・範囲・いまの点を合わせる */
  function sync(remeasured) {
    const want = !narrow.matches && log.scrollHeight >= log.clientHeight * 2;
    if (want !== shown) { shown = want; rail.hidden = !want; frame.classList.toggle('has-rail', want); if (!want) hot(-1); remeasured = true; }
    if (!want) return;
    const turns = nav.turns();
    height = Math.max(0, log.clientHeight - PAD_TOP - PAD_BOTTOM);
    if (builtFor !== turns) { builtFor = turns; build(turns); tops = []; kinds = []; remeasured = true; }
    // 点の位置・区別する形は、測り直しが落ち着いてから（300ms）まとめて書く。最初の 1 回だけは待たずに置く。
    // 実寸の確定が続く間は測り直しが続くので、そのたびに点を置き直すと、点の数だけ再計算が走ってスクロールが重くなる
    if (remeasured) {
      clearTimeout(timer);
      if (!tops.length) flush(); else timer = setTimeout(flush, 300);
    }
    // 位置は transform（再レイアウトを起こさない）。高さはスクロールでは変わらないので、測り直したときだけ書く
    const total = log.scrollHeight;
    if (remeasured) range.style.height = `${Math.max(12, log.clientHeight / total * height)}px`;
    range.style.transform = `translateY(${log.scrollTop / total * height}px)`;
    const current = nav.currentIndex();
    if (current !== active) {
      if (dots[active]) { dots[active].removeAttribute('aria-current'); if (dots[active] !== document.activeElement) dots[active].tabIndex = -1; }
      active = current;
      if (dots[current]) { dots[current].setAttribute('aria-current', 'true'); if (!rail.contains(document.activeElement) || document.activeElement === dots[current]) dots[current].tabIndex = 0; }
    }
  }
  nav.onUpdate(sync);

  // ---- ポインター: 点を押すとその問いへ、空白のドラッグで連続移動、空白を押すとその位置へ
  const scrollAt = (clientY) => { log.scrollTop = (clientY - railTop()) / height * log.scrollHeight - log.clientHeight / 2; };
  rail.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragFrom = event.clientY;
    dragTurn = nearest(event.clientY - railTop());
    dragging = false;
    rail.setPointerCapture(event.pointerId);
  });
  rail.addEventListener('pointermove', (event) => {
    if (!rail.hasPointerCapture(event.pointerId)) { if (event.pointerType !== 'touch') hot(nearest(event.clientY - railTop())); return; }
    if (!dragging && Math.abs(event.clientY - dragFrom) > 4) { dragging = true; rail.classList.add('dragging'); hot(-1); }
    if (dragging) scrollAt(event.clientY);
  });
  const finish = (event, cancelled) => {
    if (!rail.hasPointerCapture(event.pointerId)) return;
    if (!dragging && !cancelled) { if (dragTurn >= 0) nav.goTo(dragTurn); else scrollAt(event.clientY); }
    rail.releasePointerCapture(event.pointerId);
    rail.classList.remove('dragging');
    dragging = false;
  };
  rail.addEventListener('pointerleave', () => hot(-1));
  rail.addEventListener('pointerup', (event) => finish(event, false));
  rail.addEventListener('pointercancel', (event) => finish(event, true));
  // レールの上のホイールは会話を動かす（レールは #log の外にあるので、そのままでは届かない）
  rail.addEventListener('wheel', (event) => { log.scrollTop += event.deltaY; }, { passive: true });
  narrow.addEventListener('change', () => nav.schedule());
  return { rail };
}
