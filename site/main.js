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

// ナビ: 面はヒーローを過ぎたら、ダウンロードはヒーローのボタンが見えなくなったら
const nav = $('.nav');
new IntersectionObserver(([e]) => nav.classList.toggle('show-dl', !e.isIntersecting)).observe($('.hero .cta'));

// 離れる理由: 読み進めた分だけ濃くなる
const leave = $('.leave');
const leaveView = $('.leave-sticky');
const lines = $$('.leave-line', leave);
function onLeave() {
  const r = leave.getBoundingClientRect();
  const p = -r.top / (r.height - innerHeight);
  lines.forEach((el, i) => el.style.setProperty('--t', clamp((p - 0.02 - i * 0.16) / 0.1).toFixed(3)));
  leave.classList.toggle('is-done', p > 0.56);
  leaveView.style.setProperty('--out', clamp((p - 0.78) / 0.14).toFixed(3));
}

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
const APP_W = 1080, APP_H = 680, MAIN_X = 268;
// 照らす場所。寄るときはここを収める（左端は面の端に揃える）
const FOCUS = {
  wide: [
    { sel: ['.msg.is-ai[data-zone="see"]'], x: MAIN_X },
    { sel: ['.side-head', '.rows:last-of-type'], x: 0 },
    { sel: ['.fork-svg', '.fk-b-node', '.is-late .bubble'], x: MAIN_X },
    { sel: ['.handoff', '.is-late2', '.composer'], x: MAIN_X },
  ],
  narrow: [
    { sel: ['.viz'], x: null },
    { sel: ['.side-head', '.rows:last-of-type'], x: 0 },
    { sel: ['.fork-svg', '.fk-b-node', '.is-late .bubble'], x: MAIN_X },
    { sel: ['.handoff span', '.is-late2 .spk img', '.chip-agent'], x: MAIN_X },
  ],
};
let step = -1;

new IntersectionObserver(([e]) => { if (e.isIntersecting) screen.classList.add('in'); }, { rootMargin: '0px 0px -10% 0px' }).observe(screen);

function focusRect(f) {
  const a = app.getBoundingClientRect();
  const k = a.width / APP_W;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  f.sel.forEach((sel) => {
    const r = $(sel, app).getBoundingClientRect();
    if (!r.height) return;
    x0 = Math.min(x0, (r.left - a.left) / k); y0 = Math.min(y0, (r.top - a.top) / k);
    x1 = Math.max(x1, (r.right - a.left) / k); y1 = Math.max(y1, (r.bottom - a.top) / k);
  });
  const pad = 24;
  x0 = f.x == null ? x0 - pad : Math.min(x0, f.x);
  return { x: x0, y: y0 - pad, w: x1 + pad - x0, h: y1 - y0 + pad * 2 };
}
function placeCamera() {
  const cw = cam.clientWidth, ch = cam.clientHeight;
  if (!cw) return;
  const base = Math.min(cw / APP_W, ch / APP_H);
  const narrow = cw < 700;
  const f = focusRect(FOCUS[narrow ? 'narrow' : 'wide'][Math.max(step, 0)]);
  const s = clamp(Math.min(cw / f.w, ch / f.h), base, narrow ? 1 : base * 1.45);
  const fit = (size, view, lo, hi) => {
    if (size * s <= view) return (view - size * s) / 2;
    const center = view / 2 - ((lo + hi) / 2) * s;
    return clamp(center, view - size * s, 0);
  };
  // 横は面の左端に揃える。縦は照らす場所の中央
  const tx = APP_W * s <= cw ? (cw - APP_W * s) / 2 : clamp(-f.x * s, cw - APP_W * s, 0);
  const ty = fit(APP_H, ch, f.y, f.y + f.h);
  app.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`;
}
new ResizeObserver(placeCamera).observe(cam);

// 脇の一覧の印
const MARK = {
  run: () => '<svg class="arc" viewBox="0 0 14 14"><path/></svg>',
  wait: () => '<i class="dia"></i><span class="wait">承認待ち</span>',
  done: () => '<i class="dot"></i>',
  stale: () => '<span class="stale">◌ 9日</span>',
  idle: () => '',
};
const rows = Object.fromEntries($$('.row').map((r) => [r.dataset.row, r]));
function setRow(key, s, flash) {
  const row = rows[key];
  if (row.dataset.s === s && row.dataset.drawn) return;
  row.dataset.s = s;
  row.dataset.drawn = 1;
  const mk = $('.mk', row);
  mk.innerHTML = MARK[s]();
  trackArcs(mk);
  if (flash) {
    row.classList.add('is-flash');
    setTimeout(() => row.classList.remove('is-flash'), 900);
  }
}
const INITIAL = { login: 'run', sales: 'run', db: 'wait', readme: 'done', e2e: 'idle', pay: 'stale' };
const resetRows = () => Object.entries(INITIAL).forEach(([k, s]) => setRow(k, s));
resetRows();
trackArcs(app);

// 分岐: x=20 にいるのが今の会話
const nodeA = $('.fk-a-node'), nodeB = $('.fk-b-node');
function setBranch(toB) {
  nodeA.classList.toggle('is-cur', !toB);
  nodeA.classList.toggle('is-right', toB);
  nodeB.classList.toggle('is-cur', toB);
  nodeB.classList.toggle('is-right', !toB);
}
const late = $('.is-late .bubble');
const LATE = ['9月の内訳も出して', '列に前年比を足して'];

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

// 場面ごとの動き。1 回やって、最後の形で止まる
let gen = 0;
async function playStep(n) {
  const g = ++gen;
  const alive = () => g === gen;
  app.classList.add('is-drawn');
  app.classList.toggle('has-fork', n >= 2);
  app.classList.toggle('has-hand', n >= 3);
  app.classList.remove('is-picking', 'is-moving');
  setBranch(false);
  late.textContent = LATE[0];
  late.style.opacity = 1;
  setAgent(n >= 3 ? 'codex' : 'claude', false);
  if (n !== 1) resetRows();
  if (reduce) return;

  if (n === 1) {
    const script = [['db', 'run'], ['readme', 'idle'], ['login', 'wait']];
    await wait(800);
    for (const [k, s] of script) {
      if (!alive()) return;
      setRow(k, s, true);
      await wait(1300);
    }
  }
  if (n === 2) {
    await wait(1700);
    if (!alive()) return;
    app.classList.add('is-moving');
    late.style.opacity = 0;
    await wait(130);
    setBranch(true);
    await wait(560);
    if (!alive()) return;
    late.textContent = LATE[1];
    late.style.opacity = 1;
    app.classList.remove('is-moving');
  }
  if (n === 3) {
    setAgent('claude', false);
    app.classList.remove('has-hand');
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
}

function onScreen() {
  const r = screen.getBoundingClientRect();
  const q = -r.top / (r.height - innerHeight);
  const n = clamp(Math.floor(q * 4), 0, 3);
  if (n === step) return;
  step = n;
  steps.forEach((el, i) => el.classList.toggle('is-on', i === step));
  app.dataset.step = step;
  playStep(step);
  placeCamera();
  clearTimeout(onScreen.t);
  onScreen.t = setTimeout(placeCamera, 900);
}

// スクロールは 1 フレームに 1 回だけ読む
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    nav.classList.toggle('is-scrolled', scrollY > 24);
    onLeave();
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

// 外から: 見えたら一度だけ許可する
const phone = $('.phone');
trackArcs(phone);
if (reduce) phone.classList.add('is-approved');
else {
  new IntersectionObserver(async ([e], obs) => {
    if (!e.isIntersecting) return;
    obs.disconnect();
    await wait(2200);
    phone.classList.add('is-press');
    await wait(180);
    phone.classList.remove('is-press');
    phone.classList.add('is-approved');
  }, { threshold: 0.5 }).observe(phone);
}
