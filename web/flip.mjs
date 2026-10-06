// 並べ替えた行を、前にあった位置から今の位置へ滑らせる（FLIP。docs/design-system.md「脇」）。
// 行の素性は data-session（会話の id・スレッドの "thread:<チャンネル>:<根>"）で見分けるので、並べ方を切り替えて
// 行の要素が作り直されても、同じ会話・スレッドなら滑る。見えていない行は控えない（数百行でも重くしない）。
// 動きを減らす設定では何もしない（すぐ切り替わる）。長さと加減速は --dur・--ease-out（web/tokens.css）。

const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** 見えている行の位置を控える。返すのは 素性 → 上端の位置（px） */
export function captureRows(root) {
  if (reduced()) return null;
  const box = root.getBoundingClientRect();
  const out = new Map();
  for (const n of root.querySelectorAll('[data-session]')) {
    const r = n.getBoundingClientRect();
    if (r.height === 0 || r.bottom < box.top || r.top > box.bottom) continue;
    out.set(n.dataset.session, r.top);
  }
  return out;
}

/** 控えた位置から今の位置へ滑らせる。新しく現れた行は薄い所から出す */
export function playRows(root, from) {
  if (!from || reduced()) return;
  const css = getComputedStyle(root);
  const dur = css.getPropertyValue('--dur').trim() || '240ms';
  const ease = css.getPropertyValue('--ease-out').trim() || 'ease-out';
  const box = root.getBoundingClientRect();
  const moved = [];
  for (const n of root.querySelectorAll('[data-session]')) {
    const r = n.getBoundingClientRect();
    if (r.height === 0 || r.bottom < box.top || r.top > box.bottom) continue;
    const before = from.get(n.dataset.session);
    n.style.transition = 'none';
    if (before === undefined) n.style.opacity = '0';
    else if (Math.abs(before - r.top) >= 1) n.style.transform = `translateY(${before - r.top}px)`;
    else continue;
    moved.push(n);
  }
  if (!moved.length) return;
  // 1 コマ置いてから戻す（置いた transform を描かせてから、遷移で 0 へ）
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const n of moved) {
      n.style.transition = `transform ${dur} ${ease}, opacity ${dur} ${ease}`;
      n.style.transform = '';
      n.style.opacity = '';
      n.addEventListener('transitionend', () => { n.style.transition = ''; }, { once: true });
    }
  }));
}
