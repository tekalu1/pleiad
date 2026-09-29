const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ナビ: ヒーローを過ぎたら面を敷く
const nav = $('.nav');
const onNav = () => nav.classList.toggle('is-scrolled', scrollY > 24);
addEventListener('scroll', onNav, { passive: true });
onNav();

// ヒーローの星図
(async () => {
  try {
    if (!document.createElement('canvas').getContext('webgl2')) return;
    const { initSky } = await import('./hero.js');
    initSky({
      canvas: $('.sky'),
      labelsEl: $('.sky-labels'),
      labels: [
        { title: 'ログインの不具合を直す', status: '実行中', logo: 'assets/claude.svg' },
        { title: 'DB の移行手順', status: '承認待ち', logo: 'assets/openai.svg' },
        { title: 'README の英訳', status: '完了', logo: 'assets/antigravity.svg' },
        { title: 'E2E を安定させる', status: '実行中', logo: 'assets/openai.svg' },
      ],
    });
  } catch (e) {
    console.warn(e);
  }
})();

// 走っている印（アプリの docs/design-system.md §6 と同じ式。先端も尾も戻らない）
const arcs = new Set();
let arcLoop = 0;
const ARC = { w: Math.PI, a1: 0.6, T1: 2.4, a2: 0.3, T2: 1.7, phi: 1.1, tau: 0.65, gmin: (24 * Math.PI) / 180 };
function trackArcs(root = document) {
  $$('.arc', root).forEach((el) => arcs.add(el));
  if (!arcLoop && !reduce) arcLoop = requestAnimationFrame(drawArcs);
  if (reduce) arcs.forEach((el) => setArc(el, 0, Math.PI * 1.5));
}
const theta = (t) => ARC.w * (t - (ARC.a1 * ARC.T1 / (2 * Math.PI)) * Math.cos((2 * Math.PI * t) / ARC.T1) - (ARC.a2 * ARC.T2 / (2 * Math.PI)) * Math.cos((2 * Math.PI * t) / ARC.T2 + ARC.phi));
function setArc(el, tail, head) {
  const p = el.querySelector('path');
  const r = 5, c = 7;
  const x0 = c + r * Math.cos(tail), y0 = c + r * Math.sin(tail);
  const x1 = c + r * Math.cos(head), y1 = c + r * Math.sin(head);
  p.setAttribute('d', `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${head - tail > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);
}
function drawArcs(now) {
  const t = now / 1000;
  const head = theta(t);
  const tail = Math.min(theta(t - ARC.tau), head - ARC.gmin);
  arcs.forEach((el) => (el.isConnected ? setArc(el, tail, head) : arcs.delete(el)));
  arcLoop = arcs.size ? requestAnimationFrame(drawArcs) : 0;
}

// 離れる理由: スクロールで一行ずつ
const leave = $('.leave');
const lines = $$('.leave-line', leave);
const onLeave = () => {
  const r = leave.getBoundingClientRect();
  const p = -r.top / (r.height - innerHeight);
  lines.forEach((el, i) => el.classList.toggle('is-on', p > i * 0.2 + 0.02));
  leave.classList.toggle('is-done', p > 0.68);
};
addEventListener('scroll', onLeave, { passive: true });
onLeave();

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
const cam = $('.stage-cam');
const app = $('.app');
const steps = $$('.step');
const APP_W = 1080, APP_H = 680;
// 照らす場所。狭い画面ではここまで寄る
const FOCUS = [
  ['.viz'],
  ['.side'],
  ['.fork-svg', '.fk-b-node', '.is-late .bubble'],
  ['.handoff span', '.is-late2 .spk img', '.chip-agent'],
];
let step = -1;

new IntersectionObserver(([e]) => { if (e.isIntersecting) screen.classList.add('in'); }, { threshold: 0.05 }).observe(screen);

function focusRect(n) {
  const a = app.getBoundingClientRect();
  const k = a.width / APP_W;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  FOCUS[n].forEach((sel) => {
    const r = $(sel, app).getBoundingClientRect();
    if (!r.height) return;
    x0 = Math.min(x0, (r.left - a.left) / k); y0 = Math.min(y0, (r.top - a.top) / k);
    x1 = Math.max(x1, (r.right - a.left) / k); y1 = Math.max(y1, (r.bottom - a.top) / k);
  });
  const pad = 20;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
function placeCamera() {
  const cw = cam.clientWidth, ch = cam.clientHeight;
  const base = Math.min(cw / APP_W, ch / APP_H);
  const narrow = cw < 700;
  const f = narrow ? focusRect(Math.max(step, 0)) : { x: 0, y: 0, w: APP_W, h: APP_H };
  const s = narrow ? Math.min(Math.max(Math.min(cw / f.w, ch / f.h), base), 1) : base;
  const fit = (size, view, center) => (size * s <= view ? (view - size * s) / 2 : Math.min(0, Math.max(view - size * s, view / 2 - center * s)));
  const tx = fit(APP_W, cw, f.x + f.w / 2);
  const ty = fit(APP_H, ch, f.y + f.h / 2);
  app.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
}
new ResizeObserver(placeCamera).observe(cam);

// 脇の一覧の印
const MARK = {
  run: () => '<svg class="arc" viewBox="0 0 14 14"><path/></svg>',
  wait: () => '<i class="dia"></i><span class="wait">承認待ち</span>',
  done: () => '<i class="dot"></i>',
  stale: (el) => `<span class="stale">◌ ${el.dataset.days || '9日'}</span>`,
  idle: () => '',
};
function setRow(row, s, flash) {
  row.dataset.s = s;
  const mk = $('.mk', row);
  mk.innerHTML = MARK[s](row);
  trackArcs(mk);
  if (flash) {
    row.classList.add('is-flash');
    setTimeout(() => row.classList.remove('is-flash'), 900);
  }
}
const rows = Object.fromEntries($$('.row').map((r) => [r.dataset.row, r]));
const initial = { login: 'run', sales: 'run', db: 'wait', readme: 'done', e2e: 'idle', pay: 'stale' };
const resetRows = () => Object.entries(initial).forEach(([k, s]) => rows[k].dataset.s !== s && setRow(rows[k], s));
Object.entries(initial).forEach(([k, s]) => setRow(rows[k], s));
trackArcs(app);

// 分岐: 左（x=20）にいるのが今の会話
const nodeA = $('.fk-a-node'), nodeB = $('.fk-b-node');
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

let gen = 0;
async function playStep(n) {
  const g = ++gen;
  const alive = () => g === gen;
  app.classList.toggle('is-drawn', true);
  app.classList.toggle('has-fork', n >= 2);
  app.classList.toggle('has-hand', n >= 3);
  app.classList.remove('is-picking');
  setBranch(false);
  setAgent(n >= 3 ? 'codex' : 'claude', false);
  if (n !== 1) resetRows();
  if (reduce) return;

  if (n === 1) {
    const script = [
      ['login', 'wait'], ['db', 'run'], ['readme', 'idle'], ['login', 'run'], ['db', 'done'], ['e2e', 'run'], ['db', 'wait'], ['e2e', 'idle'],
    ];
    await wait(700);
    for (let i = 0; alive(); i = (i + 1) % script.length) {
      setRow(rows[script[i][0]], script[i][1], true);
      await wait(1700);
    }
  }
  if (n === 2) {
    const late = $('.is-late .bubble');
    const text = ['9月の内訳も出して', '列に前年比を足して'];
    await wait(2200);
    for (let k = 1; alive(); k++) {
      late.style.opacity = 0;
      setBranch(k % 2 === 1);
      await wait(420);
      late.textContent = text[k % 2];
      late.style.opacity = 1;
      await wait(2600);
    }
  }
  if (n === 3) {
    setAgent('claude', false);
    app.classList.remove('has-hand');
    await wait(500);
    if (!alive()) return;
    app.classList.add('is-picking');
    await wait(500);
    if (!alive()) return;
    setAgent('codex', true);
    await wait(500);
    app.classList.remove('is-picking');
    app.classList.add('has-hand');
    trackArcs(app);
  }
}

function onSteps() {
  const line = innerHeight * 0.5;
  let best = 0, bestD = Infinity;
  steps.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const c = innerWidth < 960 ? r.top + r.height * 0.5 : r.top + r.height / 2;
    const d = Math.abs(c - line);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best === step) return;
  step = best;
  steps.forEach((el, i) => el.classList.toggle('is-on', i === step));
  app.dataset.step = step;
  playStep(step);
  placeCamera();
  clearTimeout(onSteps.t);
  onSteps.t = setTimeout(placeCamera, 900);
}
addEventListener('scroll', onSteps, { passive: true });
addEventListener('resize', onSteps);
onSteps();

// 任せる: 使用量が満ちてから決まる
const deleg = $('.v-deleg');
deleg.addEventListener('enter', async () => {
  await wait(reduce ? 0 : 1400);
  deleg.classList.add('is-decided');
});

// 外から: 許可する
const phone = $('.phone');
trackArcs(phone);
if (reduce) phone.classList.add('is-approved');
else {
  let pg = 0, on = false;
  new IntersectionObserver(async ([e]) => {
    on = e.isIntersecting;
    if (!on) return;
    const g = ++pg;
    const alive = () => on && g === pg;
    while (alive()) {
      phone.classList.remove('is-approved', 'is-press');
      await wait(2600);
      if (!alive()) return;
      phone.classList.add('is-press');
      await wait(180);
      phone.classList.remove('is-press');
      phone.classList.add('is-approved');
      await wait(4200);
    }
  }, { threshold: 0.4 }).observe(phone);
}
