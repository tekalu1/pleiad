// 長い本文の畳み（docs/design-system.md「長い発言の畳み」、ADR 0067）。自分の発言の吹き出しと、委譲の「依頼」が同じ部品を使う。
//
// 畳んだ間は、畳む側（rest）の頭だけを覗かせて面の色へ溶かし（.fold-fade）、シェブロンはそのフェードの上に重ねる（字は出さない）。
// 開くと rest が伸び（240ms）、シェブロンは吹き出しの下端に移って上向きになる。閉じた側の高さは CSS（.fold-rest の max-height）が持つので、
// ここで測るのは開閉の間だけ。畳んだ部分は inert。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';

let seq = 0;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const scrollerOf = (node) => {
  for (let n = node?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return null;
};

function chevronDown() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M6 9l6 6 6-6' }));
  return svg;
}

/**
 * 畳みを付ける。
 * @param {HTMLElement} host 入れ物（吹き出し）。.fold が付き、シェブロンの行が入る
 * @param {HTMLElement} rest 畳む側。閉じている間は頭だけが覗く
 * @param {{ measure?: boolean, labels?: { open: string, close: string } }} opts
 *   measure: 畳まなくても収まるときは手がかりを出さない（見えるようになった後に測る）。
 *   labels: ボタンの名前（aria-label・title）。開く前の名前と、開いた後の名前
 * @returns {{ open(animate?: boolean): void, close(): void, toggle(): void, isOpen(): boolean }}
 */
export function mountFold(host, rest, { measure = false, labels = { open: t('chat.message.showMore'), close: t('chat.message.showLess') } } = {}) {
  host.classList.add('fold');
  rest.classList.add('fold-rest');
  rest.id ||= `fold-${++seq}`;
  rest.inert = true;
  const fade = el('div', 'fold-fade');
  fade.setAttribute('aria-hidden', 'true');
  host.append(fade);
  const row = el('div', 'fold-row');
  const button = el('button', 'fold-btn');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', rest.id);
  button.append(chevronDown());
  row.append(button);
  host.append(row);

  let opened = false, done = null;
  const label = () => {
    const name = opened ? labels.close : labels.open;
    button.setAttribute('aria-label', name);
    button.title = name;
  };
  label();

  // 畳む間、シェブロンの画面上の位置を保つ（下端から畳んで読んでいた場所が飛ばないように。ツールのまとまりと同じ）
  const hold = (ms) => {
    const sc = scrollerOf(button);
    if (!sc || reduced()) return;
    const y0 = button.getBoundingClientRect().top, until = performance.now() + ms;
    const step = () => {
      if (!button.isConnected) return;
      const d = button.getBoundingClientRect().top - y0;
      if (Math.abs(d) >= 1) sc.scrollTop += d;
      if (performance.now() < until) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const settle = () => { done = null; if (opened) rest.style.maxHeight = 'none'; };
  const apply = (want, animate) => {
    if (want === opened) return;
    opened = want;
    if (done) { rest.removeEventListener('transitionend', done); done = null; }
    const still = !animate || reduced();
    host.classList.toggle('expanded', opened);
    button.setAttribute('aria-expanded', String(opened));
    label();
    if (opened) {
      rest.inert = false;
      if (still) { rest.style.maxHeight = 'none'; return; }
      rest.style.maxHeight = `${rest.scrollHeight}px`;
      done = (e) => { if (e.propertyName === 'max-height') { rest.removeEventListener('transitionend', done); settle(); } };
      rest.addEventListener('transitionend', done);
    } else {
      rest.inert = true;
      if (still) { rest.style.maxHeight = ''; return; }
      rest.style.maxHeight = `${rest.scrollHeight}px`;
      void rest.offsetHeight;   // 今の高さから閉じた高さへ動かすための基準
      hold(300);
      rest.style.maxHeight = '';
    }
  };
  const control = {
    open: (animate = true) => apply(true, animate),
    close: () => apply(false, true),
    toggle: () => apply(!opened, true),
    isOpen: () => opened,
  };
  button.onclick = control.toggle;
  fade.onclick = control.toggle;
  host.fold = control;

  if (measure && typeof ResizeObserver === 'function') {
    // 見えるようになってから測る（閉じたカードの中では高さが取れない）。畳まなくても収まるなら手がかりを出さない
    const fits = () => {
      if (opened || !rest.isConnected || !rest.clientHeight) return;
      const needed = rest.scrollHeight > rest.clientHeight + 1;
      host.classList.toggle('fold-fit', !needed);
      rest.inert = needed;
    };
    new ResizeObserver(fits).observe(rest);
  }
  return control;
}

/** 畳まれた部分の中の要素を見せる（会話の中の検索・目次で一致したとき）。動かさずに開く */
export function revealFold(node) {
  const rest = node?.closest?.('.fold-rest');
  const host = rest?.closest('.fold');
  if (!host?.fold || host.fold.isOpen()) return false;
  host.fold.open(false);
  return true;
}
