// ヒーローの星図。星は会話の節、線は分岐、色はアプリと同じ意味（青 = 今いる枝、赤紫 = あなたを待っている）。
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const C = {
  bg: new THREE.Color('#f5f6fa'),
  ink: new THREE.Color('#1c2247'),
  node: new THREE.Color('#6d76a3'),
  line: new THREE.Color('#9aa3d4'),
  current: new THREE.Color('#5665cd'),
  run: new THREE.Color('#1c2247'),
  done: new THREE.Color('#5665cd'),
  wait: new THREE.Color('#aa2678'),
  dust: new THREE.Color('#c3c9e2'),
};

const KIND = { msg: 0, fork: 1, done: 2, run: 3, wait: 4, tip: 5 };
const STEP = 0.34;
const STEP_T = 0.055;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTree(rand) {
  const branches = [];
  const grow = (origin, dir, depth, t0, parent, forkAt) => {
    const steps = depth === 0 ? 20 : Math.max(6, Math.round(9 + rand() * 9 - depth * 1.8));
    const pts = [origin.clone()];
    const d = dir.clone();
    const p = origin.clone();
    const curlAxis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    const curl = (0.035 + rand() * 0.06) * (depth === 0 ? 0.5 : 1);
    for (let i = 0; i < steps; i++) {
      d.applyAxisAngle(curlAxis, curl);
      d.x += (rand() - 0.5) * 0.07;
      d.y += (rand() - 0.5) * 0.07;
      d.z += (rand() - 0.5) * 0.07;
      d.normalize();
      p.addScaledVector(d, STEP);
      pts.push(p.clone());
    }
    const b = { pts, depth, t0, steps, forks: [], parent, forkAt, children: [] };
    branches.push(b);
    if (parent) parent.children.push(b);
    if (depth < 3) {
      const chance = [0.8, 0.55, 0.3][depth];
      for (let i = 3; i < steps - 2; i += 2 + Math.floor(rand() * 3)) {
        if (branches.length > 22 || rand() > chance) continue;
        const tan = pts[i + 1].clone().sub(pts[i]).normalize();
        const axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
        const perp = new THREE.Vector3().crossVectors(tan, axis).normalize();
        const a = 0.75 + rand() * 0.65;
        const nd = tan.clone().multiplyScalar(Math.cos(a)).addScaledVector(perp, Math.sin(a)).normalize();
        b.forks.push(i);
        grow(pts[i], nd, depth + 1, t0 + i * STEP_T, b, i);
      }
    }
    return b;
  };
  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 1, 0.1).normalize(), 0, 0.25, null, 0);
  return branches;
}

const vert = /* glsl */ `
  attribute float size;
  attribute float kind;
  attribute float birth;
  attribute vec3 color;
  uniform float uTime, uPR, uScale, uFogNear, uFogFar;
  varying vec3 vColor;
  varying float vKind, vAlpha, vFog, vAge;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float age = uTime - birth;
    float g = smoothstep(0.0, 0.3, age);
    float pop = 1.0 + 0.45 * exp(-max(age, 0.0) * 7.0) * step(0.0, age);
    gl_PointSize = size * g * pop * uPR * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
    vColor = color; vKind = kind; vAlpha = g; vAge = age;
    vFog = smoothstep(uFogNear, uFogFar, -mv.z);
  }
`;

const frag = /* glsl */ `
  uniform float uTime, uHead, uTail;
  uniform vec3 uBg;
  varying vec3 vColor;
  varying float vKind, vAlpha, vFog, vAge;
  float disc(float r, float rad, float aa) { return 1.0 - smoothstep(rad - aa, rad + aa, r); }
  float ring(float r, float rad, float w, float aa) { return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(r - rad)); }
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float aa = fwidth(r) * 0.75;
    float a = 0.0;
    if (vKind < 0.5) {
      a = disc(r, 0.62, aa);
    } else if (vKind < 1.5) {
      a = ring(r, 0.6, 0.26, aa);
    } else if (vKind < 2.5) {
      a = disc(r, 0.5, aa);
    } else if (vKind < 3.5) {
      // アプリの走っている印と同じ弧（台は置かない）
      float ang = atan(-p.y, p.x);
      float len = uHead - uTail;
      float d = mod(ang - uTail, 6.2831853);
      float arc = smoothstep(-0.12, 0.05, d) * (1.0 - smoothstep(len - 0.05, len + 0.12, d));
      a = ring(r, 0.6, 0.14, aa) * arc;
    } else if (vKind < 4.5) {
      // 承認待ち: ◆
      float dm = abs(p.x) + abs(p.y);
      float daa = fwidth(dm) * 0.75;
      a = 1.0 - smoothstep(0.62 - daa, 0.62 + daa, dm);
    } else {
      a = disc(r, 0.5, aa) * (1.0 - smoothstep(0.0, 0.4, vAge));
    }
    a *= vAlpha * (1.0 - vFog * 0.8);
    if (a < 0.01) discard;
    gl_FragColor = vec4(mix(vColor, uBg, vFog * 0.7), a);
  }
`;

// docs/design-system.md §6 の弧。先端も尾も戻らない
const theta = (t) => Math.PI * (t - (0.6 * 2.4 / (2 * Math.PI)) * Math.cos((2 * Math.PI * t) / 2.4) - (0.3 * 1.7 / (2 * Math.PI)) * Math.cos((2 * Math.PI * t) / 1.7 + 1.1));

export function initSky({ canvas, labelsEl, labels, avoid }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seed = Number(new URLSearchParams(location.search).get('seed')) || 5;
  const rand = rng(seed);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.bg, 12, 24);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const CAM_Z = 17;
  camera.position.set(0, 0, CAM_Z);

  const root = new THREE.Group();
  const tree = new THREE.Group();
  root.add(tree);
  scene.add(root);

  const branches = buildTree(rand);

  // 中心と大きさを揃える
  const box = new THREE.Box3();
  branches.forEach((b) => b.pts.forEach((p) => box.expandByPoint(p)));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2;
  tree.position.copy(center).multiplyScalar(-1);

  // 葉（枝の終わり）に状態を振る
  const leaves = branches.map((b) => ({ b, pos: b.pts[b.pts.length - 1], t: b.t0 + b.steps * STEP_T }));
  const order = leaves.slice().sort((x, y) => y.pos.z - x.pos.z);
  const want = ['run', 'run', 'done', 'run', 'done'];
  // 承認待ちは、最初の向きで右側（見出しと重ならない側）の葉
  const sx = (l) => (l.pos.x - center.x) * Math.cos(-0.5) + (l.pos.z - center.z) * Math.sin(-0.5);
  const waitLeaf = leaves.slice().sort((x, y) => sx(y) - sx(x))[1];
  waitLeaf.kind = 'wait';
  order.filter((l) => l !== waitLeaf).forEach((l, i) => (l.kind = want[i] || (i % 3 === 0 ? 'done' : 'msg')));

  // 今いる枝: 実行中のうち手前の葉までの経路
  const currentLeaf = order.find((l) => l.kind === 'run');
  const chain = [];
  for (let b = currentLeaf.b; b; b = b.parent) chain.unshift(b);
  const pathPts = [];
  chain.forEach((b, i) => {
    const next = chain[i + 1];
    const end = next ? next.forkAt : b.pts.length - 1;
    for (let k = i === 0 ? 0 : 1; k <= end; k++) pathPts.push(b.pts[k]);
  });

  const lineMats = [];
  const mkMat = (color, width, opacity) => {
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, worldUnits: false });
    m.fog = true;
    m.depthWrite = false;
    lineMats.push(m);
    return m;
  };
  const baseMat = mkMat(C.line, 1.6, 1);
  const trunkMat = mkMat(C.node, 1.6, 0.9);
  const curMat = mkMat(C.current, 3, 1);

  const lines = [];
  const addLine = (pts, t0, mat, order) => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const per = 6;
    const n = (pts.length - 1) * per;
    const flat = [];
    curve.getSpacedPoints(n).forEach((p) => flat.push(p.x, p.y, p.z));
    const geo = new LineGeometry();
    geo.setPositions(flat);
    const line = new Line2(geo, mat);
    line.renderOrder = order;
    line.frustumCulled = false;
    tree.add(line);
    lines.push({ geo, t0, dur: (pts.length - 1) * STEP_T, segs: n, curve });
  };
  branches.forEach((b) => addLine(b.pts, b.t0, b.depth === 0 ? trunkMat : baseMat, 1));
  addLine(pathPts, 0.25, curMat, 2);

  // 節
  const pos = [], col = [], sz = [], kd = [], bt = [];
  const push = (p, kind, s, c, birth) => {
    pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); sz.push(s); kd.push(kind); bt.push(birth);
  };
  branches.forEach((b) => {
    for (let i = 2; i < b.pts.length - 1; i += 2) {
      if (b.forks.includes(i)) continue;
      push(b.pts[i], KIND.msg, 6.5, C.node, b.t0 + i * STEP_T);
    }
    b.forks.forEach((i) => push(b.pts[i], KIND.fork, 10, C.ink, b.t0 + i * STEP_T));
  });
  const leafSpec = {
    run: [KIND.run, 30, C.run],
    wait: [KIND.wait, 21, C.wait],
    done: [KIND.done, 12, C.done],
    msg: [KIND.msg, 7, C.node],
  };
  leaves.forEach((l) => {
    const [k, s, c] = leafSpec[l.kind];
    push(l.pos, k, s, c, l.t);
  });
  // 最初の発言
  push(branches[0].pts[0], KIND.done, 20, C.ink, 0.2);

  // 伸びている先端の光
  const tipIndex = pos.length / 3;
  lines.forEach(() => push(new THREE.Vector3(), KIND.tip, 9, C.current, 0));

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.Float32BufferAttribute(pos, 3);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.Float32BufferAttribute(sz, 1));
  geo.setAttribute('kind', new THREE.Float32BufferAttribute(kd, 1));
  const birthAttr = new THREE.Float32BufferAttribute(bt, 1);
  geo.setAttribute('birth', birthAttr);

  const uniforms = {
    uTime: { value: 0 },
    uPR: { value: 1 },
    uScale: { value: CAM_Z },
    uFogNear: { value: 13 },
    uFogFar: { value: 23 },
    uBg: { value: C.bg },
    uHead: { value: 0 },
    uTail: { value: 0 },
  };
  const pmat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, transparent: true, depthWrite: false });
  const points = new THREE.Points(geo, pmat);
  points.renderOrder = 3;
  points.frustumCulled = false;
  tree.add(points);

  // ラベル: 葉に会話のタイトル。一度に 1 つずつ
  const labeled = [];
  const used = new Set();
  labels.forEach((spec) => {
    const l = order.find((x) => x.kind === spec.kind && !used.has(x));
    if (!l) return;
    used.add(l);
    const el = document.createElement('div');
    el.className = `sky-label is-${l.kind}`;
    el.innerHTML = `<img src="${spec.logo}" alt="" width="14" height="14"><span class="t">${spec.title}</span><span class="s">${spec.status}</span>`;
    labelsEl.appendChild(el);
    labeled.push({ el, l, o: 0, x: 0, y: 0, ok: true });
  });
  const grown = Math.max(...leaves.map((l) => l.t)) + 0.3;
  const HOLD = 3.6;
  let active = 0, since = grown;

  // 大きさと配置
  let W = 1, H = 1, fitScale = 1, avoidRect = null;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    let pr = Math.min(devicePixelRatio, 2);
    if (W * H * pr * pr > 4.2e6) pr = Math.max(1, Math.sqrt(4.2e6 / (W * H)));
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    uniforms.uPR.value = renderer.getPixelRatio();
    lineMats.forEach((m) => m.resolution.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio()));
    const halfH = Math.tan(THREE.MathUtils.degToRad(15)) * CAM_Z;
    const halfW = halfH * camera.aspect;
    const wide = camera.aspect > 1.15;
    const target = wide ? Math.min(halfH * 1.02, halfW * 0.56) : Math.min(halfW * 0.78, halfH * 0.3);
    fitScale = target / radius;
    root.scale.setScalar(fitScale);
    root.position.set(wide ? halfW * 0.22 : 0, wide ? 0 : halfH * 0.44, 0);
    avoidRect = avoid ? avoid.getBoundingClientRect() : null;
    const cr = canvas.getBoundingClientRect();
    if (avoidRect) avoidRect = { l: avoidRect.left - cr.left, t: avoidRect.top - cr.top, r: avoidRect.right - cr.left, b: avoidRect.bottom - cr.top };
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / innerWidth) * 2 - 1;
    pointer.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loop(); });

  const clock = new THREE.Clock();
  let time = reduce ? 60 : 0;
  let running = false;
  const v = new THREE.Vector3();
  const tipPos = geo.attributes.position;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!reduce) time += dt;
    uniforms.uTime.value = time;
    const head = theta(time);
    uniforms.uHead.value = head % (Math.PI * 2);
    uniforms.uTail.value = uniforms.uHead.value - (head - Math.min(theta(time - 0.65), head - 0.42));

    // 枝を伸ばす
    lines.forEach((ln, i) => {
      const f = THREE.MathUtils.clamp((time - ln.t0) / ln.dur, 0, 1);
      ln.geo.instanceCount = Math.max(0, Math.floor(f * ln.segs));
      const ti = tipIndex + i;
      if (f > 0 && f < 1) {
        ln.curve.getPointAt(f, v);
        tipPos.setXYZ(ti, v.x, v.y, v.z);
        birthAttr.setX(ti, time);
      }
    });
    tipPos.needsUpdate = true;
    birthAttr.needsUpdate = true;

    pointer.x += (pointer.tx - pointer.x) * 0.04;
    pointer.y += (pointer.ty - pointer.y) * 0.04;
    const sp = Math.min(scrollY / innerHeight, 1.5);
    root.rotation.y = -0.5 + (reduce ? 0 : time * 0.045) + pointer.x * 0.22 + sp * 0.6;
    root.rotation.x = 0.08 + pointer.y * 0.1 - sp * 0.15;

    renderer.render(scene, camera);

    // ラベル
    root.updateMatrixWorld();
    labeled.forEach((it) => {
      const { el, l } = it;
      v.copy(l.pos).applyMatrix4(tree.matrixWorld);
      const depth = v.clone().applyMatrix4(camera.matrixWorldInverse).z;
      v.project(camera);
      const x = (v.x * 0.5 + 0.5) * W;
      const y = (-v.y * 0.5 + 0.5) * H;
      const w = el.offsetWidth || 180;
      const flip = x + 24 + w > W - 16;
      it.x = Math.max(-8, flip ? x - w - 48 : x);
      it.y = y;
      const fog = THREE.MathUtils.smoothstep(-depth, 15.5, 21);
      const a = avoidRect;
      const hit = a && it.x + 24 < a.r + 12 && it.x + 24 + w > a.l && y > a.t - 16 && y < a.b + 16;
      it.ok = !hit && fog < 0.6 && x > 0 && x < W && y > 60 && y < H - 20;
      it.fog = fog;
    });
    if (time > grown) {
      const cur = labeled[active];
      if ((!reduce && time - since > HOLD) || !cur.ok) {
        for (let k = 1; k <= labeled.length; k++) {
          const n = (active + k) % labeled.length;
          if (labeled[n].ok) { active = n; break; }
        }
        since = time;
      }
    }
    labeled.forEach((it, i) => {
      const on = time > grown && i === active && it.ok;
      it.o += ((on ? 1 - it.fog : 0) - it.o) * (reduce ? 1 : 0.08);
      it.el.style.opacity = it.o.toFixed(3);
      it.el.style.transform = `translate3d(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px, 0)`;
    });
  }

  function loop() {
    if (running) return;
    running = true;
    clock.getDelta();
    const tick = () => {
      if (!visible || document.hidden) { running = false; return; }
      frame();
      if (reduce) { running = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  loop();
}
