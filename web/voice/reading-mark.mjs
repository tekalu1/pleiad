// いま話している場所の印（通話モード。docs/design-system.md「通話モード」案 1 伸びる下線）。
//
// 返事の文字は通話していないときと同じ出方・同じ字の色のまま、話している文の下に --fill-primary の 2px の下線が、再生位置から文字単位で補間してなめらかに伸びる
// （requestAnimationFrame。行をまたいで次の行で続く）。DOM は作り直さない: 返事の本文は触らず、本文の外（スクロールする列の中）に重ねた層へ線を置き、
// 線の幅（transform: scaleX）だけを更新する。文の位置は、ホストが送ってきた文（記法を外した読み上げの文）を、返事の本文の文字から探して決める
// （記法を外した文字の並びが同じなので、句読点・空白・大小を除いた文字で突き合わせる。見つからない文・コードの言い添えは印を出さない）。
// 読み終えた文の線は静かに消える。止める・割り込み・スピーカーのミュートでも、止まった位置で静かに消える。
// 話している場所が画面の外へ出たら onOffscreen('below' | 'above')（自動では追いかけない。reveal() でなめらかにスクロール）。
// 動きを減らす設定では、線は伸ばさず文の下に静止して出す（文の強調）。

const IGNORED = /[\s、。，．,.!?！？「」『』（）()・…~〜ー\-‐‑–—―"'“”‘’:：;；]/u;
const EXCLUDED = 'pre, script, style, .vc-underlay, .vc-live, .vc-hint, [aria-hidden="true"]';
const LOCATE_RETRY_MS = 150;
const LOCATE_GIVE_UP_MS = 4000;
const CHARS_PER_SEC = 6.5;      // 音が出そろうまでの見積もり（日本語の読み上げの速さ）

/** scope の中の文字を、突き合わせ用に正規化して並べる。chars[i] が元のどの文字（node, offset）か */
function indexText(scope) {
  const nodes = [], offs = [];
  let text = '';
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !n.parentElement.closest(EXCLUDED) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = n.data;
    for (let i = 0; i < data.length; i++) {
      for (const c of data[i].normalize('NFKC').toLowerCase()) {
        if (IGNORED.test(c)) continue;
        text += c; nodes.push(n); offs.push(i);
      }
    }
  }
  return { text, nodes, offs };
}

export const normalizeSentence = (s) => [...String(s).normalize('NFKC').toLowerCase()].filter((c) => !IGNORED.test(c)).join('');

/** 行ごとの矩形にまとめる（同じ行の矩形は 1 つに） */
function lineRects(range) {
  const lines = [];
  for (const r of range.getClientRects()) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const line = lines.find((l) => Math.abs(l.bottom - r.bottom) < 4);
    if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); line.bottom = Math.max(line.bottom, r.bottom); }
    else lines.push({ left: r.left, right: r.right, bottom: r.bottom });
  }
  return lines.sort((a, b) => a.bottom - b.bottom || a.left - b.left);
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host  スクロールする列（線の層を中に置く。position: relative にする）
 * @param {() => Element|null} o.scope  返事の本文が入っている範囲（探す範囲）
 * @param {() => boolean} o.reduced  動きを減らす設定か
 * @param {(dir: 'below'|'above'|null) => void} [o.onOffscreen]
 */
export function createReadingMark({ host, scope, reduced = () => false, onOffscreen = () => {} }) {
  const layer = document.createElement('div');
  layer.className = 'vc-underlay';
  layer.setAttribute('aria-hidden', 'true');
  host.classList.add('vc-host');
  host.append(layer);

  const segs = new Map();      // id -> { id, text, norm, skip, first }
  let cur = null;              // いま線を引いている文 { id, lines: [{ el, left, width, top }], total, estStart, range, tries, startedAt, bestP }
  let cursor = -1;             // 前の文の終わり（正規化した並びの位置）。同じ返事の続きの文は、ここより後ろから探す
  let dirty = false, frames = 0, lastDir = null, lastLocate = 0;
  const offscreenSegs = new Set();

  const hostRect = () => host.getBoundingClientRect();

  function drop(line, fade = true) {
    if (!line) return;
    if (!fade || reduced()) { line.el.remove(); return; }
    line.el.style.opacity = '0';
    setTimeout(() => line.el.remove(), 520);
  }
  function clearCurrent(fade) {
    if (!cur) return;
    for (const l of cur.lines) drop(l, fade);
    cur = null;
    if (lastDir !== null) { lastDir = null; onOffscreen(null); }
  }

  /** 文を探して線の位置を決める。見つからなければ false */
  function locate(seg) {
    const root = scope();
    if (!root || !seg.norm) return false;
    const { text, nodes, offs } = indexText(root);
    // 返事の最初の文は、いちばん後ろの出現（直前の発言・前の返事に同じ字が出ていても、いまの返事を指す）。続きの文は前の文より後ろから
    const at = seg.first || cursor < 0 ? text.lastIndexOf(seg.norm) : text.indexOf(seg.norm, cursor);
    const found = at >= 0 ? at : (seg.first ? -1 : text.lastIndexOf(seg.norm));
    if (found < 0) return false;
    const range = document.createRange();
    range.setStart(nodes[found], offs[found]);
    range.setEnd(nodes[found + seg.norm.length - 1], offs[found + seg.norm.length - 1] + 1);
    cursor = found + seg.norm.length;
    return range;
  }

  /** 範囲の行ごとの線を（なければ作って）位置を合わせる。幅の合計を返す */
  function layout(c) {
    const hr = hostRect();
    const rects = lineRects(c.range);
    while (c.lines.length > rects.length) c.lines.pop().el.remove();
    let total = 0;
    rects.forEach((r, i) => {
      let line = c.lines[i];
      if (!line) {
        const el = document.createElement('i');
        el.className = 'vc-ul';
        layer.append(el);
        line = c.lines[i] = { el, left: 0, width: 0 };
      }
      line.left = r.left - hr.left + host.scrollLeft;
      line.width = r.right - r.left;
      line.top = r.bottom - hr.top + host.scrollTop;
      line.el.style.left = `${line.left}px`;
      line.el.style.top = `${line.top}px`;
      line.el.style.width = `${line.width}px`;
      total += line.width;
    });
    c.total = total;
  }

  function paint(c, p) {
    let rest = p * c.total;
    for (const line of c.lines) {
      const f = reduced() ? 1 : Math.min(1, Math.max(0, rest / (line.width || 1)));
      line.el.style.transform = `scaleX(${f.toFixed(4)})`;
      rest -= line.width;
    }
  }

  const mo = new MutationObserver(() => { dirty = true; });
  const watch = () => { const root = scope(); if (root) mo.observe(root, { childList: true, subtree: true, characterData: true }); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { dirty = true; }) : null;
  ro?.observe(host);
  addEventListener('resize', () => { dirty = true; });
  watch();

  function beginSegment(seg, t) {
    clearCurrent(true);
    cur = { id: seg.id, seg, lines: [], total: 0, range: null, startedAt: t, bestP: 0 };
    tryLocate(t);
  }
  function tryLocate(t) {
    if (!cur || cur.range || !cur.seg.norm || cur.seg.skip) return;
    const range = locate(cur.seg);
    lastLocate = t;
    if (range) { cur.range = range; layout(cur); dirty = false; }
  }

  return {
    /** ホストが送ってきた文（読む前に、画面の文字から位置を探せるよう控える） */
    seg(info) { segs.set(info.id, { id: info.id, text: info.text, norm: info.skip ? '' : normalizeSentence(info.text), skip: Boolean(info.skip), first: Boolean(info.first) }); },
    /** 再生位置（engine.position()）に合わせて毎フレーム呼ぶ。t は performance.now() */
    frame(pos, t) {
      frames++;
      if (pos && (!cur || cur.id !== pos.id)) { const seg = segs.get(pos.id); if (seg) beginSegment(seg, t); else clearCurrent(true); }
      else if (!pos && cur && !cur.range) { /* 次の文までの間。探し直しは続ける */ }
      if (!cur) return;
      if (!cur.range && !cur.seg.skip && t - lastLocate >= LOCATE_RETRY_MS && t - cur.startedAt < LOCATE_GIVE_UP_MS) tryLocate(t);
      if (cur.range && dirty && t - lastLocate >= 200) { dirty = false; lastLocate = t; layout(cur); }
      if (!cur.range || !pos) return;
      const total = pos.total ?? Math.max(pos.elapsed + 0.4, cur.seg.text.length / CHARS_PER_SEC);
      const p = Math.min(pos.total ? 1 : 0.96, pos.elapsed / total);
      cur.bestP = Math.max(cur.bestP, p);
      paint(cur, cur.bestP);
      if (frames % 6 === 0) {
        const y = cur.lines[0]?.top ?? 0;
        const view = y - host.scrollTop;
        const dir = view > host.clientHeight - 24 ? 'below' : view < 24 ? 'above' : null;
        if (dir !== lastDir) { lastDir = dir; onOffscreen(dir); }
      }
    },
    /** 文を読み終えた（鳴り終わった）。線は伸び切って静かに消える */
    finish(id) {
      if (!cur || cur.id !== id) return;
      if (cur.range) paint(cur, 1);
      clearCurrent(true);
    },
    /** 止める・割り込み・スピーカーのミュート・通話の終わり。止まった位置で静かに消える */
    stop() { clearCurrent(true); segs.clear(); cursor = -1; },
    /** 話している場所へ（なめらかにスクロール） */
    reveal() {
      const y = cur?.lines[0]?.top;
      if (y === undefined) return;
      host.scrollTo({ top: Math.max(0, y - host.clientHeight / 3), behavior: reduced() ? 'auto' : 'smooth' });
    },
    /** 新しいターンの前に、探す位置の基準を捨てる */
    resetCursor() { cursor = -1; },
    destroy() { mo.disconnect(); ro?.disconnect(); layer.remove(); },
  };
}
