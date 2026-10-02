// 入力欄の上の帯の右端にある、バックグラウンドの入口（docs/design-system.md「入力欄の上の帯」「バックグラウンドの入口」）。
// 動いているものを種類ごとのアイコンで見せる（エージェントのロゴ・ターミナル）。2 本以上は右下に数、4 種類以上は「+N」、
// 承認待ちを含む種類は先頭へ寄せて ◆。弧は左に 1 つ。終わったものだけなら「✓ N」。
// 出入り・数の変化は差分だけを描き替える（動かすのは新しい種類・数・チップ自体だけ）
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { backendLogo } from './side.mjs';
import { TERMINAL_PATHS } from './icons.mjs';
import { backgroundSummary } from './background-model.mjs';

/** 出入りの長さ（ms）。style.css の --dur と同じ */
const OUT_MS = 240;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// i18n-dynamic: activity.bgKind.
const kindName = (kind) => t(`activity.bgKind.${kind}`);

function kindLogo(kind) {
  const mark = el('span', `bgc-logo bgc-${kind}`);
  if (kind === 'term') {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    for (const d of TERMINAL_PATHS) svg.append(svgEl('path', { d }));
    mark.append(svg);
  } else if (kind === 'compat') {
    mark.textContent = '◇';
  } else {
    // 名前はボタンの aria-label・title にまとめて持つ。ロゴ単独の名前・ツールチップは付けない
    const logo = backendLogo(kind, '');
    logo.removeAttribute('title');
    logo.setAttribute('aria-hidden', 'true');
    for (const node of logo.querySelectorAll('[aria-label],[alt]')) { node.removeAttribute('aria-label'); node.removeAttribute('role'); if (node.tagName === 'IMG') node.alt = ''; }
    mark.append(logo);
  }
  return mark;
}

function waitMark() {
  const svg = svgEl('svg', { viewBox: '0 0 10 10', class: 'bgc-wait', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M5 .8 9.2 5 5 9.2.8 5z' }));
  return svg;
}

function checkMark() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'm5 12 4 4L19 6' }));
  return svg;
}

/** 読み上げ名とツールチップ。「バックグラウンド: Claude 2・Codex 1（1 本が承認待ち）。一覧を開く」。「+N」で隠れた種類も全部入れる */
export function backgroundName(summary) {
  if (!summary.live) return t('activity.bgEndedSpoken', { n: summary.ended });
  const parts = summary.groups.map((g) => g.waiting
    ? t('activity.bgItemWaiting', { name: kindName(g.kind), n: g.n, w: g.waiting })
    : t('activity.bgItem', { name: kindName(g.kind), n: g.n }));
  return t('activity.bgSpoken', { items: parts.join(t('activity.bgJoin')) });
}

/**
 * @param {HTMLButtonElement} button 入口のボタン（#workEntryButton）。中身はここが持つ
 * @returns {{ update:(items:object[])=>void }}
 */
export function createBackgroundChip(button) {
  const runSlot = el('span', 'bgc-run');
  const slots = el('span', 'bgc-slots');
  button.append(runSlot, slots);
  const byKind = new Map();
  let more = null, shown = false, running = false, sessionKey = null;

  // 動きが済んだらクラスを外す（残すと、並べ替えで要素を動かしたときに動きがもう一度走る）
  const animate = (node, cls) => {
    if (reduced.matches) return;
    node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
    node.addEventListener('animationend', (event) => { if (event.target === node) node.classList.remove(cls); }, { once: true });
  };

  /** key が替わったら（別の会話）出入りの動きは付けずに描く */
  function update(items, key = null) {
    const summary = backgroundSummary(items);
    const visible = summary.live > 0 || summary.ended > 0;
    const fresh = key !== sessionKey;
    sessionKey = key;
    if (!visible) { shown = false; return; }
    if (!shown && !fresh) animate(button, 'enter');
    shown = true;
    const name = backgroundName(summary);
    button.setAttribute('aria-label', name);
    button.title = name;
    button.classList.toggle('ended', !summary.live);
    const quiet = fresh;   // 会話を開いたときに出入りを動かさない

    // 走っている弧は 1 つだけ（走っている間だけ DOM に置く。web/arc.mjs）
    if (summary.live && !running) { runSlot.replaceChildren(runMark()); running = true; }
    else if (!summary.live && running) { runSlot.replaceChildren(); running = false; }

    if (!summary.live) {
      for (const node of byKind.values()) node.remove();
      byKind.clear(); more?.remove(); more = null;
      const done = el('span', 'bgc-done');
      done.append(checkMark(), String(summary.ended));
      slots.replaceChildren(done);
      return;
    }
    slots.querySelector('.bgc-done')?.remove();

    const keep = new Set(summary.visible.map((g) => g.kind));
    for (const [kind, node] of byKind) {
      if (keep.has(kind)) continue;
      byKind.delete(kind);
      if (!quiet && !reduced.matches) { node.classList.add('out'); setTimeout(() => node.remove(), OUT_MS); } else node.remove();
    }
    let previous = null;
    for (const g of summary.visible) {
      let node = byKind.get(g.kind);
      if (!node) {
        node = el('span', 'bgc-slot');
        node.dataset.kind = g.kind;
        node.append(kindLogo(g.kind));
        byKind.set(g.kind, node);
        if (!quiet) animate(node, 'in');
      }
      let count = node.querySelector('.bgc-n');
      if (g.n >= 2) {
        if (!count) { count = el('span', 'bgc-n'); node.append(count); }
        if (count.textContent !== String(g.n)) { count.textContent = String(g.n); if (!quiet) animate(count, 'bump'); }
      } else count?.remove();
      const mark = node.querySelector('.bgc-wait');
      if (g.waiting && !mark) node.append(waitMark());
      else if (!g.waiting && mark) mark.remove();
      // 並びを合わせる（消えかけの種類は動かさない）
      const want = previous ? previous.nextElementSibling : slots.firstElementChild;
      let target = want;
      while (target?.classList.contains('out')) target = target.nextElementSibling;
      if (target !== node) slots.insertBefore(node, want);
      previous = node;
    }
    if (summary.hidden) {
      if (!more) { more = el('span', 'bgc-more'); if (!quiet) animate(more, 'in'); }
      const text = `+${summary.hidden}`;
      if (more.textContent !== text) { more.textContent = text; if (!quiet && more.isConnected) animate(more, 'bump'); }
      if (slots.lastElementChild !== more) slots.append(more);
    } else if (more) { more.remove(); more = null; }
  }
  return { update };
}
