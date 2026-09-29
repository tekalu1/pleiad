import { mountBranch } from './branch.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ヒーローの星図。WebGL が無ければ焼いた一枚
(async () => {
  const canvas = $('.sky');
  if (!document.createElement('canvas').getContext('webgl2')) {
    const img = new Image();
    img.className = 'sky-still';
    img.alt = '';
    img.src = 'assets/sky.webp';
    canvas.replaceWith(img);
    return;
  }
  try {
    const { initSky } = await import('./hero.js');
    initSky({
      canvas,
      labelsEl: $('.sky-labels'),
      avoid: $('.hero-copy'),
      labels: [
        { title: 'DB の移行手順', status: '承認待ち', logo: 'assets/openai.svg', kind: 'wait' },
        { title: 'ログインの不具合を直す', status: '実行中', logo: 'assets/claude.svg', kind: 'run' },
        { title: 'README の英訳', status: '完了', logo: 'assets/antigravity.svg', kind: 'done' },
        { title: 'E2E を安定させる', status: '実行中', logo: 'assets/openai.svg', kind: 'run' },
      ],
    });
  } catch (e) {
    console.warn(e);
  }
})();

// 走っている印（docs/design-system.md §6 と同じ式。先端も尾も戻らない）
const arcs = new Set();
let arcLoop = 0;
const ARC = { w: Math.PI, a1: 0.6, T1: 2.4, a2: 0.3, T2: 1.7, phi: 1.1, tau: 0.65, gmin: (24 * Math.PI) / 180 };
const theta = (t) => ARC.w * (t - (ARC.a1 * ARC.T1 / (2 * Math.PI)) * Math.cos((2 * Math.PI * t) / ARC.T1) - (ARC.a2 * ARC.T2 / (2 * Math.PI)) * Math.cos((2 * Math.PI * t) / ARC.T2 + ARC.phi));
function setArc(el, tail, head) {
  const r = 5, c = 7;
  const x0 = c + r * Math.cos(tail), y0 = c + r * Math.sin(tail);
  const x1 = c + r * Math.cos(head), y1 = c + r * Math.sin(head);
  el.querySelector('path').setAttribute('d', `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${head - tail > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
}
function drawArcs(now) {
  const t = now / 1000;
  const head = theta(t);
  const tail = Math.min(theta(t - ARC.tau), head - ARC.gmin);
  arcs.forEach((el) => (el.isConnected ? setArc(el, tail, head) : arcs.delete(el)));
  arcLoop = arcs.size ? requestAnimationFrame(drawArcs) : 0;
}
function trackArcs(root = document) {
  $$('.arc', root).forEach((el) => arcs.add(el));
  if (reduce) arcs.forEach((el) => setArc(el, 0, Math.PI * 1.5));
  else if (!arcLoop) arcLoop = requestAnimationFrame(drawArcs);
}

// ナビ: 面はヒーローを過ぎたら
const nav = $('.nav');
// ダウンロードの大きなボタン（ヒーローと終わり）が見えている間は、ナビに同じボタンを重ねない
const ctaSeen = new Map();
const ctaIo = new IntersectionObserver((entries) => {
  entries.forEach((e) => ctaSeen.set(e.target, e.isIntersecting));
  nav.classList.toggle('show-dl', ![...ctaSeen.values()].some(Boolean));
});
$$('.hero .cta, .end .cta').forEach((el) => ctaIo.observe(el));

// 出現
$$('.tile-copy, .v-deleg, .phone, .end > *').forEach((el) => el.setAttribute('data-reveal', ''));
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in');
    io.unobserve(e.target);
    e.target.dispatchEvent(new CustomEvent('enter'));
  });
}, { threshold: 0.3 });
$$('[data-reveal]').forEach((el) => io.observe(el));

// ひとつの画面 --------------------------------------------------------------
const screen = $('.screen');
const prologue = $('.prologue');
const lines = $$('.leave-line', prologue);
// 取り消し線は行の順に、句ごとに続けて引く
const chunks = lines.map((el) => $$('.nw', el));
const cam = $('.stage-cam');
const app = $('.app');
const steps = $$('.step');
const APP_H = 680, MAIN_X = 268;
const APP_W = { wide: 1080, narrow: 688 };
// 各場面の枠。辺は面の境目（x）か要素のすき間（y）にだけ置き、切れる辺はぼかす。
// top: 上端をそこに揃える / bottomOf: その要素の下に揃える / bottomAbove: その要素の上に揃える（その要素は入れない）
// 場面: 0 選ばない / 1 見る / 2 思い出す / 3 分岐
const S_AGENT = 0, S_SEE = 1, S_ROWS = 2, S_FORK = 3;
const SHOTS = {
  wide: [
    { full: true },
    { x0: MAIN_X, bottomAbove: '.composer' },
    { x0: 0, x1: 560, top: 0, bottomOf: '.rows:last-of-type' },
    { x0: MAIN_X, bottomAbove: '.composer' },
  ],
  narrow: [
    { x0: MAIN_X, bottom: true },
    { x0: MAIN_X, bottomAbove: '.composer' },
    { x0: 0, x1: MAIN_X, top: 0, bottomOf: '.rows' },
    { x0: MAIN_X, bottomAbove: '.composer' },
  ],
};

const rows = Object.fromEntries($$('.row').map((r) => [r.dataset.row, r]));
const MARK = {
  run: () => '<svg class="arc" viewBox="0 0 14 14"><path/></svg>',
  wait: () => '<i class="dia"></i><span class="wait">承認待ち</span>',
  done: () => '<i class="dot"></i>',
  stale: () => '<span class="stale">◌ 9日</span>',
  idle: () => '',
};
function setRow(key, s, flash) {
  const row = rows[key];
  if (row.dataset.s === s) return;
  row.dataset.s = s;
  const mk = $('.mk', row);
  mk.innerHTML = MARK[s]();
  trackArcs(mk);
  if (flash) {
    row.classList.add('is-flash');
    setTimeout(() => row.classList.remove('is-flash'), 900);
  }
}
const ROWS_START = { login: 'run', sales: 'run', db: 'wait', readme: 'done', e2e: 'idle', pay: 'stale' };
const ROWS_SCRIPT = [['db', 'run'], ['sales', 'done'], ['login', 'wait']];
function setRows(after) {
  const want = { ...ROWS_START };
  if (after) ROWS_SCRIPT.forEach(([k, s]) => (want[k] = s));
  Object.entries(want).forEach(([k, s]) => setRow(k, s));
}

// 分岐（branch.js）。分かれ目の後の発言は、元の会話と作った枝で替わる
const late = $('.is-late .bubble');
const LATE = ['9月の内訳も出して', '列に前年比を足して'];
const branch = mountBranch($('.fork'), { swap: (toFork) => { late.textContent = LATE[toFork ? 1 : 0]; } });

// 入力欄のエージェント
const agentChip = $('.chip-agent');
const AGENTS = { claude: ['assets/claude.svg', 'Claude Code'], codex: ['assets/openai.svg', 'Codex'] };
const salesLogo = $('img', rows.sales);
async function setAgent(name, animate) {
  if (agentChip.dataset.agent === name) return;
  agentChip.dataset.agent = name;
  if (animate) { agentChip.classList.add('is-swap'); await wait(200); }
  $('.ag-logo', agentChip).src = AGENTS[name][0];
  $('.ag-name', agentChip).textContent = AGENTS[name][1];
  salesLogo.src = AGENTS[name][0];
  agentChip.classList.remove('is-swap');
}

// n 番目の場面の、動く前（done=false）か動き終えた（done=true）形
const past = (n, done, s) => n > s || (n === s && done);
function applyState(n, done) {
  const handed = past(n, done, S_AGENT);
  app.dataset.step = n;
  app.classList.toggle('has-hand', handed);
  app.classList.toggle('has-ask', handed);
  app.classList.toggle('has-reply', handed);
  app.classList.toggle('is-seen', past(n, done, S_SEE));
  app.classList.toggle('is-drawn', past(n, done, S_SEE));
  app.classList.toggle('has-fork', n >= S_FORK);
  app.classList.remove('is-picking');
  setRows(past(n, done, S_ROWS));
  const toB = past(n, done, S_FORK);
  branch.show(toB);
  app.classList.toggle('has-run', toB);
  setAgent(handed ? 'codex' : 'claude', false);
  trackArcs(app);
}

let step = -1, gen = 0;
const stepDone = [false, false, false, false];

// 枠の基準にする要素（脇の行・最初の返答・入力欄）は場面の動きで位置が変わらないので、その場で測る
let mode = 'wide';
function measure() {
  mode = cam.clientWidth < 700 ? 'narrow' : 'wide';
  app.classList.toggle('is-narrow', mode === 'narrow');
}
function shotFor(n) {
  const f = SHOTS[mode][n];
  if (f.full) return f;
  const a = app.getBoundingClientRect();
  const k = a.width / APP_W[mode];
  const box = (sel) => { const r = $(sel, app).getBoundingClientRect(); return { top: (r.top - a.top) / k, bottom: (r.bottom - a.top) / k }; };
  const y1 = f.bottomOf ? box(f.bottomOf).bottom + 20 : f.bottomAbove ? box(f.bottomAbove).top - 4 : APP_H;
  return { x0: f.x0, x1: f.x1 ?? APP_W[mode], top: f.top, y1 };
}
function placeCamera() {
  const cw = cam.clientWidth, ch = cam.clientHeight;
  if (!cw) return;
  const W = APP_W[mode];
  const f = shotFor(Math.max(step, 0));
  let s, tx, ty;
  if (f.full) {
    s = Math.min(cw / W, ch / APP_H);
    tx = (cw - W * s) / 2;
    ty = (ch - APP_H * s) / 2;
  } else {
    s = cw / (f.x1 - f.x0);
    if (f.top != null) s = Math.min(s, ch / (f.y1 - f.top));
    tx = -f.x0 * s;
    ty = f.top != null ? -f.top * s : clamp(ch - f.y1 * s, ch - APP_H * s, 0);
  }
  app.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
  // 切れた辺だけぼかす。脇で切れる下端は脇の色で
  cam.classList.toggle('cut-top', ty < -0.5);
  cam.classList.toggle('cut-right', tx + W * s > cw + 0.5);
  cam.classList.toggle('cut-bottom', ty + APP_H * s > ch + 0.5);
  cam.classList.toggle('cut-side', !f.full && f.x1 <= MAIN_X);
}

// 場面の動き。1 度やったら、戻って来ても動き終えた形で見せる
async function playStep(n) {
  const g = ++gen;
  const alive = () => g === gen;
  if (reduce || stepDone[n]) { stepDone[n] = true; applyState(n, true); return; }
  applyState(n, false);
  if (n === S_AGENT) {
    await wait(700);
    if (!alive()) return;
    app.classList.add('is-picking');
    await wait(450);
    if (!alive()) return;
    await setAgent('codex', true);
    await wait(300);
    app.classList.remove('is-picking');
    app.classList.add('has-hand');
    await wait(700);
    if (!alive()) return;
    app.classList.add('has-ask');
    await wait(800);
    if (!alive()) return;
    app.classList.add('has-reply');
    trackArcs(app);
  }
  if (n === S_SEE) {
    await wait(900);
    if (!alive()) return;
    app.classList.add('is-seen', 'is-drawn');
  }
  if (n === S_ROWS) {
    await wait(700);
    for (const [k, s] of ROWS_SCRIPT) {
      if (!alive()) return;
      setRow(k, s, true);
      await wait(1200);
    }
  }
  if (n === S_FORK) {
    if (!(await branch.play(alive))) return;
    app.classList.add('has-run');
    trackArcs(app);
  }
  if (alive()) stepDone[n] = true;
}

function onScreen() {
  const r = screen.getBoundingClientRect();
  const vh = innerHeight;
  const narrow = innerWidth <= 960;
  const P = vh * (narrow ? 1.3 : 1.5);
  const S = vh * (narrow ? 0.7 : 0.8);
  const y = -r.top;
  // 前置き: 読み進めた分だけ濃くなり、言い切ったら舞台に替わる
  const p = y / P;
  // 読み終えたら、行の順に句ごとに線を引いて消し、結びの一文を出す
  let j = 0;
  lines.forEach((el, i) => {
    el.style.setProperty('--t', clamp((p - 0.04 - i * 0.14) / 0.1).toFixed(3));
    let s = 0;
    chunks[i].forEach((c) => { s = clamp((p - 0.44 - j++ * 0.022) / 0.03); c.style.setProperty('--s', s.toFixed(3)); });
    el.style.setProperty('--x', s.toFixed(3));
  });
  prologue.style.setProperty('--e', clamp((p - 0.57) / 0.05).toFixed(3));
  // 前置きが消えきってから舞台が入る。どちらもスクロール量で動かし、重ならない
  prologue.style.setProperty('--out', clamp((p - 0.8) / 0.08).toFixed(3));
  const come = clamp((p - 0.9) / 0.08);
  screen.style.setProperty('--in', come.toFixed(3));
  screen.classList.toggle('in', come > 0.6);
  const n = clamp(Math.floor((y - P) / S), 0, 3);
  if (n === step) return;
  step = n;
  steps.forEach((el, i) => el.classList.toggle('is-on', i === step));
  playStep(step);
  placeCamera();
}

measure();
new ResizeObserver(() => { measure(); placeCamera(); }).observe(cam);
// 書体が入ると高さが変わるので測り直す
document.fonts.ready.then(() => { measure(); placeCamera(); });

// スクロールは 1 フレームに 1 回だけ読む
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    nav.classList.toggle('is-scrolled', scrollY > 24);
    onScreen();
  });
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();

// 任せる: 使用量が満ちてから決まる
const deleg = $('.v-deleg');
deleg.addEventListener('enter', async () => {
  await wait(reduce ? 0 : 1400);
  deleg.classList.add('is-decided');
});

// 外から: 見えたらしばらく待って、一度だけ許可する
const phone = $('.phone');
trackArcs(phone);
const approve = () => {
  phone.classList.add('is-approved');
  $('.ph-q span', phone).textContent = '許可した';
};
if (reduce) { approve(); phone.classList.add('is-next'); }
else {
  new IntersectionObserver(async ([e], obs) => {
    if (!e.isIntersecting) return;
    obs.disconnect();
    await wait(3200);
    phone.classList.add('is-press');
    await wait(180);
    phone.classList.remove('is-press');
    approve();
    await wait(2600);
    phone.classList.add('is-next');
    // 会話と同じく、新しいカードが見えるところまで流す
    const scr = $('.ph-screen', phone), th = $('.ph-thread', phone), nx = $('.ph-next', phone);
    const over = nx.getBoundingClientRect().bottom - scr.getBoundingClientRect().bottom + 20;
    if (over > 0) th.style.transform = `translateY(${-over}px)`;
  }, { threshold: 0.5 }).observe(phone);
}
