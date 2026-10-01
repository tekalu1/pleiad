// オーバーレイの描画（desktop/computer-overlay.html）。ふつうの script として読む（file: ではモジュールを読めないため）。
// Node（tests/unit/computer-overlay.mjs）から require したときは、描く前の純粋な部品だけを返す。
// 動きの数値は ADR 0073。main（desktop/computer-overlay.cjs）が送る { op: show | pill | cursor | hide | stop } だけで動く。
(function () {
  const OVC = { enter: 480, exit: 600, escExit: 360, rmFade: 150, pillDelay: 120, pillHold: 1200, half: 2000, restDepth: 30, maxDepth: 36 };

  /** CSS の cubic-bezier と同じ曲線 */
  function bez(p1x, p1y, p2x, p2y) {
    const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx, cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
    const sx = t => ((ax * t + bx) * t + cx) * t, sy = t => ((ay * t + by) * t + cy) * t, dx = t => (3 * ax * t + 2 * bx) * t + cx;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; t -= e / d; }
      return sy(Math.min(1, Math.max(0, t)));
    };
  }
  const easeOrganic = bez(.65, 0, .25, 1);

  /** カーソルの移動時間: 280 + 0.35 × 距離(DIP) ms を 320〜900ms に丸める */
  const pathDuration = dist => Math.min(900, Math.max(320, 280 + dist * .35));

  /** 2 次ベジェの経路（距離の 15% だけ横へ膨らむ）の、進み具合 progress（0〜1。イージング前）での位置 */
  function pathPoint(x0, y0, x1, y1, progress) {
    const dx = x1 - x0, dy = y1 - y0, mx = x0 + dx / 2 - dy * .15, my = y0 + dy / 2 + dx * .15;
    const e = easeOrganic(progress), u = 1 - e;
    return { x: u * u * x0 + 2 * u * e * mx + e * e * x1, y: u * u * y0 + 2 * u * e * my + e * e * y1 };
  }

  const api = { OVC, bez, easeOrganic, pathDuration, pathPoint };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  // ---------------------------------------------------------------- 画面
  const $ = id => document.getElementById(id);
  const ov = $('ov'), glow = $('glow'), gi = $('gi'), pill = $('pill'), cur = $('cur'), ring = $('ring');
  const S = { vis: false, rm: false, x: null, y: null, moveToken: 0, enterT: 0, exitT: 0, pillT: 0, pressT: 0 };
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');

  const depth = () => parseFloat(getComputedStyle(gi).getPropertyValue('--d')) || 0;

  function setPill(p) {
    $('pWho').textContent = p.who || '';
    $('pTitle').textContent = p.title || '';
    $('pTitle').hidden = !p.title;
    const hint = $('pHint');
    hint.hidden = !p.hint;
    hint.textContent = '';
    const m = /^(Esc)(.*)$/s.exec(p.hint || '');
    if (m) { const b = document.createElement('b'); b.textContent = m[1]; hint.append(b, m[2]); } else hint.textContent = p.hint || '';
    $('pDot').hidden = !p.hint;
    $('pStop').textContent = p.stopped || '';
  }

  function show(message) {
    clearTimeout(S.exitT); clearTimeout(S.pillT); clearTimeout(S.enterT);
    S.rm = typeof message.rm === 'boolean' ? message.rm : reduceQuery.matches;
    if (message.pill) setPill(message.pill);
    S.vis = true; ov.classList.add('vis');
    if (S.rm) {
      gi.style.animation = 'none'; gi.style.transition = 'none'; gi.style.setProperty('--d', OVC.restDepth);
      glow.style.transition = `opacity ${OVC.rmFade}ms linear`; glow.style.opacity = 1;
    } else {
      // 消えかけから戻るときは、今の深さから入り直す
      const d0 = depth(); gi.style.animation = 'none'; gi.style.transition = 'none'; gi.style.setProperty('--d', d0); void gi.offsetWidth;
      gi.style.transition = `--d ${OVC.enter}ms cubic-bezier(.2,.7,.2,1)`; gi.style.setProperty('--d', OVC.maxDepth);
      glow.style.transition = `opacity ${OVC.enter}ms cubic-bezier(.2,.7,.2,1)`; glow.style.opacity = 1;
      S.enterT = setTimeout(() => { gi.style.transition = 'none'; gi.style.animation = `cuBreathe ${OVC.half}ms cubic-bezier(.37,0,.63,1) infinite alternate-reverse`; }, OVC.enter);
    }
    pill.classList.remove('stopped');
    pill.style.transitionDuration = S.rm ? `${OVC.rmFade}ms` : '';
    S.pillT = setTimeout(() => pill.classList.add('in'), S.rm ? 0 : OVC.pillDelay);
  }

  /** kind: now / idle = 縁を 600ms で引く。esc = 縁を 360ms で引き、ピルを「止めました」にして 1.2 秒残す */
  function hide(kind) {
    if (!S.vis) return;
    clearTimeout(S.enterT); clearTimeout(S.pillT); clearTimeout(S.exitT);
    S.vis = false;
    const ms = S.rm ? OVC.rmFade : (kind === 'esc' ? OVC.escExit : OVC.exit);
    const d0 = depth(); gi.style.animation = 'none'; gi.style.transition = 'none'; gi.style.setProperty('--d', d0); void gi.offsetWidth;
    if (!S.rm) { gi.style.transition = `--d ${ms}ms cubic-bezier(.65,0,.25,1)`; gi.style.setProperty('--d', 0); }
    glow.style.transition = `opacity ${ms}ms cubic-bezier(.65,0,.25,1)`; glow.style.opacity = 0;
    cur.classList.remove('in'); cur.classList.add('out');
    S.moveToken++;
    if (kind === 'esc') { pill.classList.add('stopped'); S.pillT = setTimeout(() => pill.classList.remove('in'), OVC.pillHold); }
    else pill.classList.remove('in');
    S.exitT = setTimeout(() => { ov.classList.remove('vis'); S.x = null; }, Math.max(kind === 'esc' ? OVC.pillHold + 300 : ms, 260));
  }

  const place = () => { cur.style.transform = `translate(${S.x}px,${S.y}px)`; };

  function moveCursor(x, y) {
    const token = ++S.moveToken;
    cur.classList.remove('out');
    if (S.x == null) { S.x = x; S.y = y; place(); requestAnimationFrame(() => cur.classList.add('in')); return; }
    cur.classList.add('in');
    const x0 = S.x, y0 = S.y, dur = S.rm ? 0 : pathDuration(Math.hypot(x - x0, y - y0));
    if (!dur) { S.x = x; S.y = y; place(); return; }
    const t0 = performance.now();
    const step = now => {
      if (token !== S.moveToken) return; // 新しい移動か、消えた
      const p = Math.min(1, (now - t0) / dur), pt = pathPoint(x0, y0, x, y, p);
      S.x = pt.x; S.y = pt.y; place();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function click() {
    ring.classList.remove('go'); void ring.offsetWidth; if (!S.rm) ring.classList.add('go');
    clearTimeout(S.pressT); cur.classList.add('press');
    S.pressT = setTimeout(() => cur.classList.remove('press'), 90);
  }

  window.plyOverlay.onMessage(message => {
    if (message.op === 'show') show(message);
    else if (message.op === 'pill') setPill(message.pill);
    else if (message.op === 'cursor') { moveCursor(message.x, message.y); if (message.pressed) click(); }
    else if (message.op === 'hide') hide(message.kind);
    else if (message.op === 'stop') { if (message.pill) setPill(message.pill); hide('esc'); }
  });
})();
