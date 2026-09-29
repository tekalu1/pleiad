// 模型の分岐。web/branch-view.mjs（makeBranchRow・grow・promote・layoutBranchSpine）と
// web/client.mjs の forkFrom → changeBranch の流れを、寸法・時間・加減速まで同じに写す（docs/design-system.md §7）。
// アプリと違うのは、札が押せないこと（舞台は aria-hidden）と、スクロール・フォーカスを動かさないことだけ。

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BRANCH = { X: 20, SPLIT: 16, Y: 96, HEIGHT: 176, STEP: 104 };
const EASING = 'cubic-bezier(.22,.72,.18,1)';
// 筋の節（.msg::before）の中心の y。styles.css の top: 11px + 半径 3.5
const NODE_Y = 14.5;

function curve(a, b) {
  const h = (b.y - a.y) * .48;
  return `M${a.x},${a.y} C${a.x},${a.y + h} ${b.x},${b.y - h} ${b.x},${b.y}`;
}
function ease(t) {
  if (t <= 0 || t >= 1) return t;
  const at = (u, a, b) => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u * u * b + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const u = (lo + hi) / 2; if (at(u, .22, .18) < t) lo = u; else hi = u; }
  return at((lo + hi) / 2, .72, 1);
}
// animateBranch と同じ。場面を離れたら（alive() が偽）その場で止め、false を返す
function animate(ms, alive, frame) {
  const duration = reduce ? 0 : ms, start = performance.now();
  return new Promise((resolve) => {
    const tick = (now) => {
      if (!alive()) return resolve(false);
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      frame(ease(t), t);
      if (t < 1) requestAnimationFrame(tick); else resolve(true);
    };
    requestAnimationFrame(tick);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// 他の枠は動かさず、選んだノードと前のメインだけが入れ替わる
function branchOrder(ids, selected, previous = []) {
  const order = previous.filter((id) => ids.includes(id));
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const at = order.indexOf(selected);
  if (at > 0) [order[0], order[at]] = [order[at], order[0]];
  return order;
}

// makeBranchRow の写し。row はグループの入れ物（.fork）で、中身を作り直す
function makeBranchRow(row, entries, selected, previous) {
  row.replaceChildren();
  row.locked = false;
  delete row.dataset.phase;
  const track = el('div', 'branch-track'), svg = svgEl('svg', { class: 'branch-edges' });
  track.append(svg); row.append(track);
  const order = branchOrder(entries.map((e) => e.id), selected, previous?.order);
  const nodes = entries.map((entry) => {
    const tip = el('div', 'branch-tip' + (entry.id === selected ? ' is-cur' : ''));
    tip.dataset.session = entry.id;
    const ring = svgEl('svg', { class: 'branch-ring', viewBox: '0 0 16 16' });
    ring.append(svgEl('circle', { cx: 8, cy: 8, r: 5 }));
    tip.append(ring, el('span', 'branch-name', entry.name), el('span', 'branch-note', entry.id === selected ? entry.current : entry.note));
    track.append(tip);
    return { ...entry, tip, x: 0, growth: null };
  });
  for (const id of order) track.append(nodes.find((n) => n.id === id).tip);
  const step = () => Math.min(BRANCH.STEP, Math.max(64, (row.clientWidth - 48) / Math.max(1, nodes.length - 1)));
  const target = (n) => BRANCH.X + order.indexOf(n.id) * step();
  function draw() {
    const gap = step();
    const width = Math.max(row.clientWidth, 48 + (nodes.length - 1) * gap);
    // 札の幅は並びの間隔に合わせる（最大 92px = 間隔 104 − 12）。詰まっていれば 64px
    row.style.setProperty('--tip-w', `${gap >= 76 ? gap - 12 : 64}px`);
    track.style.width = `${width}px`;
    svg.setAttribute('width', String(width));
    svg.replaceChildren();
    for (const n of nodes) {
      n.tip.style.left = `${n.x}px`;
      const p = svgEl('path', { d: curve({ x: BRANCH.X, y: BRANCH.SPLIT }, { x: n.x, y: BRANCH.Y }), class: n.id === selected || n.growth != null ? 'active' : '' });
      if (n.growth != null) {
        p.setAttribute('pathLength', '1');
        p.style.strokeDasharray = '1';
        p.style.strokeDashoffset = String(1 - n.growth);
      }
      svg.append(p);
    }
    const n = nodes.find((n) => n.id === selected);
    if (n) svg.append(svgEl('path', { class: 'active branch-lower', d: curve({ x: n.x, y: BRANCH.Y }, { x: BRANCH.X, y: BRANCH.HEIGHT }) }));
  }
  row.layout = () => { if (!row.locked) for (const n of nodes) n.x = target(n); draw(); };
  row.snapshot = () => ({ order, positions: Object.fromEntries(nodes.map((n) => [n.id, n.x])) });
  row.promote = async (snapshot, alive) => {
    row.locked = true; row.dataset.phase = 'switching';
    for (const n of nodes) n.x = snapshot?.positions[n.id] ?? target(n);
    draw();
    const done = await animate(560, alive, (e) => {
      for (const n of nodes) { const from = snapshot?.positions[n.id] ?? target(n); n.x = from + (target(n) - from) * e; }
      draw();
    });
    if (!done) return false;
    row.dataset.phase = 'idle'; row.locked = false; row.layout();
    return true;
  };
  row.grow = async (id, alive) => {
    const n = nodes.find((n) => n.id === id);
    row.locked = true; row.dataset.phase = 'growing';
    n.growth = 0; n.tip.classList.add('growing', 'emerging'); n.tip.style.setProperty('--reveal', '0');
    draw();
    const done = await animate(780, alive, (e, t) => {
      n.growth = e;
      n.tip.style.setProperty('--reveal', String(ease(Math.max(0, (t - .65) / .35))));
      draw();
    });
    if (!done) return false;
    // 移り先の履歴を用意する間も、伸び終えた線は青のまま
    n.growth = 1; n.tip.classList.remove('growing');
    row.dataset.phase = 'grown'; draw();
    return true;
  };
  row.layout();
  return row;
}

/**
 * 分岐の場面の部品。fork は会話（.log-inner）の中のグループの入れ物で、直前が分岐元の返答、直後が枝の先の発言。
 * swap(toFork) は枝の先の発言の中身を入れ替える（文言は main.js が持つ）。
 * show(after) は動く前（分岐なし）か動き終えた形を即座に置き、play(alive) は作成 → 切り替えを 1 回動かす。
 */
export function mountBranch(fork, { swap }) {
  const thread = fork.parentElement;
  const source = fork.previousElementSibling;
  const later = () => fork.nextElementSibling;
  // 文言は index.html の <template> に置く（書体の字を削るとき index.html から拾うため）
  const parts = fork.querySelector('template');
  const text = Object.fromEntries([...parts.content.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n.textContent]));
  parts.remove();
  // 分岐元の会話（source）と、作る枝（fork）。note は選ばれていないときの札の 2 行目
  const SOURCE = { id: 'source', name: text.source, current: text.current, note: text.sourceNote };
  const FORK = { id: 'fork', name: text.fork, current: text.current, note: text.forkNote };

  // 会話の筋。グループの上下で区切り、動くノードの裏に直線を残さない
  const spine = svgEl('svg', { class: 'spine' });
  thread.prepend(spine);
  let geometry = '';
  function layoutSpine() {
    const rows = fork.hidden ? [] : [fork];
    let end = thread.offsetHeight;
    for (const m of thread.children) if (m.classList.contains('msg') && m.offsetHeight > 0) end = m.offsetTop + NODE_Y;
    const key = [...rows.map((r) => `${r.offsetTop}:${r.clientWidth}`), end].join('|');
    if (key === geometry) return;
    geometry = key;
    for (const r of rows) r.layout();
    const paths = [];
    let y = 0;
    const segment = (to) => { if (to > y) paths.push(svgEl('path', { d: curve({ x: BRANCH.X, y }, { x: BRANCH.X, y: to }) })); };
    for (const r of rows) { segment(r.offsetTop + BRANCH.SPLIT); y = r.offsetTop + BRANCH.HEIGHT; }
    segment(Math.max(y, end));
    spine.replaceChildren(...paths);
  }
  new ResizeObserver(layoutSpine).observe(thread);

  // 分岐元の返答の「⑂ ここから分岐」（.m.ai > .message-actions）
  const actions = el('div', 'fk-actions');
  const button = el('span', 'fk-btn', text.action);
  actions.append(button);
  source.append(actions);

  let fade = null;
  function place(entries, selected, previous) {
    fork.hidden = false;
    thread.classList.add('is-branched');
    return makeBranchRow(fork, entries, selected, previous);
  }
  function show(after) {
    fade?.cancel(); fade = null;
    actions.classList.remove('is-shown'); button.classList.remove('is-hover');
    if (after) place([FORK, SOURCE], FORK.id);
    else { fork.hidden = true; fork.replaceChildren(); thread.classList.remove('is-branched'); }
    swap(after);
    layoutSpine();
  }
  async function play(alive) {
    // 返答に触れると操作が出て、押す
    await wait(1300); if (!alive()) return false;
    actions.classList.add('is-shown');
    await wait(500); if (!alive()) return false;
    button.classList.add('is-hover');
    await wait(400); if (!alive()) return false;
    // 子の会話ができたら、元の会話を選んだまま線を伸ばし、後半で先端のノードを出す（780ms）
    let row = place([SOURCE, FORK], SOURCE.id);
    layoutSpine();
    if (!await row.grow(FORK.id, alive)) return false;
    await new Promise((r) => requestAnimationFrame(r)); if (!alive()) return false;
    // 切り替え: 共通の本文は残し、分かれ目より後を移り先に替えて 420ms でフェード。ノードは 560ms で入れ替わる
    const snapshot = row.snapshot();
    swap(true);
    row = place([FORK, SOURCE], FORK.id, snapshot);
    fade = later()?.animate([{ opacity: .15 }, { opacity: 1 }], { duration: reduce ? 0 : 420, easing: EASING }) ?? null;
    layoutSpine();
    if (!await row.promote(snapshot, alive)) return false;
    // 指が離れる
    await wait(500); if (!alive()) return false;
    button.classList.remove('is-hover'); actions.classList.remove('is-shown');
    return true;
  }
  return { show, play, layout: layoutSpine };
}
