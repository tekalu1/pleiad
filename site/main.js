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
const cam = $('.stage-cam');
const app = $('.app');
const steps = $$('.step');
const APP_W = 1080, APP_H = 680, MAIN_X = 268;
// 照らす場所。寄るときはここを収める。x は揃える面の左端、top は見出しの帯から見せる
const FOCUS = {
  wide: [
    { sel: ['.msg.is-ai[data-zone="see"]', '.msg.is-user'], x: MAIN_X },
    { sel: ['.side-head', '.rows:last-of-type'], x: 0, top: true },
    { sel: ['.fork', '.is-late .bubble'], x: MAIN_X },
    { sel: ['.handoff', '.is-late2', '.composer'], x: MAIN_X },
  ],
  narrow: [
    { sel: ['.viz'], x: MAIN_X },
    { sel: ['.side-head', '.rows'], x: 0 },
    { sel: ['.fk-a-node', '.fk-b-node', '.is-late .bubble'], x: MAIN_X },
    { sel: ['.handoff span', '.is-late2 .spk img', '.chip-agent'], x: MAIN_X },
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

// 分岐: x=20 にいるのが今の会話
const nodeA = $('.fk-a-node'), nodeB = $('.fk-b-node');
const late = $('.is-late .bubble');
const LATE = ['9月の内訳も出して', '列に前年比を足して'];
function setBranch(toB) {
  nodeA.classList.toggle('is-cur', !toB);
  nodeA.classList.toggle('is-right', toB);
  nodeB.classList.toggle('is-cur', toB);
  nodeB.classList.toggle('is-right', !toB);
}

// 入力欄のエージェント
const agentChip = $('.chip-agent');
const AGENTS = { claude: ['assets/claude.svg', 'Claude Code'], codex: ['assets/openai.svg', 'Codex'] };
async function setAgent(name, animate) {
  if (agentChip.dataset.agent === name) return;
  agentChip.dataset.agent = name;
  if (animate) { agentChip.classList.add('is-swap'); await wait(200); }
  $('.ag-logo', agentChip).src = AGENTS[name][0];
  $('.ag-name', agentChip).textContent = AGENTS[name][1];
  agentChip.classList.remove('is-swap');
}

// n 番目の場面の、動く前（done=false）か動き終えた（done=true）形
function applyState(n, done) {
  const handed = n === 3 && done;
  app.dataset.step = n;
  app.classList.toggle('has-fork', n >= 2);
  app.classList.toggle('has-hand', handed);
  app.classList.remove('is-picking', 'is-moving');
  setRows(n === 1 && done);
  const toB = n === 2 && done;
  setBranch(toB);
  late.textContent = LATE[toB ? 1 : 0];
  late.style.opacity = 1;
  setAgent(handed ? 'codex' : 'claude', false);
  trackArcs(app);
}

let step = -1, gen = 0;
const stepDone = [false, false, false, false];

// 寄る先は、各場面の動き終えた形で測っておく（動いている途中で測らない）
let focusCache = null;
function measure() {
  const narrow = cam.clientWidth < 700;
  app.classList.toggle('is-narrow', narrow);
  app.classList.add('is-measuring');
  const saved = app.style.transform;
  app.style.transform = 'none';
  focusCache = FOCUS[narrow ? 'narrow' : 'wide'].map((f, n) => {
    applyState(n, true);
    const a = app.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    f.sel.forEach((sel) => {
      const r = $(sel, app).getBoundingClientRect();
      x0 = Math.min(x0, r.left - a.left); y0 = Math.min(y0, r.top - a.top);
      x1 = Math.max(x1, r.right - a.left); y1 = Math.max(y1, r.bottom - a.top);
    });
    const pad = 24;
    x0 = Math.min(x0, f.x);
    y0 = f.top ? 0 : y0 - pad;
    return { x: x0, y: y0, w: x1 + pad - x0, h: y1 + pad - y0, snap: f.x };
  });
  const cur = Math.max(step, 0);
  applyState(cur, stepDone[cur]);
  app.style.transform = saved;
  void app.offsetWidth;
  app.classList.remove('is-measuring');
}
function placeCamera() {
  const cw = cam.clientWidth, ch = cam.clientHeight;
  if (!cw || !focusCache) return;
  const base = Math.min(cw / APP_W, ch / APP_H);
  const narrow = cw < 700;
  const f = focusCache[Math.max(step, 0)];
  // 広い画面: 会話の面を枠いっぱいに（脇を半端に切らない）。脇の場面は全体
  const s = narrow ? clamp(Math.min(cw / f.w, ch / f.h), base, 1) : f.snap === MAIN_X ? cw / (APP_W - MAIN_X) : base;
  const tx = APP_W * s <= cw ? (cw - APP_W * s) / 2 : clamp(-f.x * s, cw - APP_W * s, 0);
  let ty = APP_H * s <= ch ? (ch - APP_H * s) / 2 : clamp(ch / 2 - (f.y + f.h / 2) * s, ch - APP_H * s, 0);
  // 見出しの帯（52px）を途中で切らない。全部見せるか、全部外す
  const band = 52 * s;
  if (!narrow && ty < 0 && ty > -band) ty = f.y + f.h <= ch / s ? 0 : -band;
  app.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
}

// 場面の動き。1 度やったら、戻って来ても動き終えた形で見せる
async function playStep(n) {
  const g = ++gen;
  const alive = () => g === gen;
  if (reduce || stepDone[n]) { stepDone[n] = true; applyState(n, true); return; }
  applyState(n, false);
  if (n === 1) {
    await wait(700);
    for (const [k, s] of ROWS_SCRIPT) {
      if (!alive()) return;
      setRow(k, s, true);
      await wait(1200);
    }
  }
  if (n === 2) {
    await wait(1500);
    if (!alive()) return;
    app.classList.add('is-moving');
    late.style.opacity = 0;
    await wait(130);
    setBranch(true);
    await wait(560);
    late.textContent = LATE[1];
    late.style.opacity = 1;
    app.classList.remove('is-moving');
    if (!alive()) return;
  }
  if (n === 3) {
    await wait(600);
    if (!alive()) return;
    app.classList.add('is-picking');
    await wait(450);
    if (!alive()) return;
    await setAgent('codex', true);
    await wait(300);
    app.classList.remove('is-picking');
    app.classList.add('has-hand');
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
  lines.forEach((el, i) => el.style.setProperty('--t', clamp((p - 0.04 - i * 0.14) / 0.1).toFixed(3)));
  screen.classList.toggle('is-said', p > 0.5);
  prologue.style.setProperty('--out', clamp((p - 0.8) / 0.14).toFixed(3));
  screen.classList.toggle('in', p > 0.9);
  if (p > 0.9) app.classList.add('is-drawn');
  const n = clamp(Math.floor((y - P) / S), 0, 3);
  if (n === step) return;
  step = n;
  steps.forEach((el, i) => el.classList.toggle('is-on', i === step));
  playStep(step);
  placeCamera();
}

measure();
new ResizeObserver(() => { measure(); placeCamera(); }).observe(cam);

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
if (reduce) approve();
else {
  new IntersectionObserver(async ([e], obs) => {
    if (!e.isIntersecting) return;
    obs.disconnect();
    await wait(3200);
    phone.classList.add('is-press');
    await wait(180);
    phone.classList.remove('is-press');
    approve();
  }, { threshold: 0.5 }).observe(phone);
}
