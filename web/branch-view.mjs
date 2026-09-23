import { el, svgEl } from "./dom.mjs";
import { t } from "./i18n.mjs";

export const BRANCH = { X: 20, SPLIT: 16, Y: 96, HEIGHT: 176, STEP: 104 };
export const EASING = "cubic-bezier(.22,.72,.18,1)";
export function curve(a, b) {
  const h = (b.y - a.y) * .48;
  return `M${a.x},${a.y} C${a.x},${a.y + h} ${b.x},${b.y - h} ${b.x},${b.y}`;
}
export function ease(t) {
  if (t <= 0 || t >= 1) return t;
  const at = (u, a, b) => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u * u * b + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const u = (lo + hi) / 2; if (at(u, .22, .18) < t) lo = u; else hi = u; }
  return at((lo + hi) / 2, .72, 1);
}
export const motionDuration = (ms) => matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
export function animateBranch(ms, frame) {
  const duration = motionDuration(ms), start = performance.now();
  return new Promise(resolve => {
    const tick = now => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      frame(ease(t), t);
      if (t < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// Preserve the other slots; only the chosen node trades places with the previous main.
export function branchOrder(ids, selected, previous = []) {
  const order = previous.filter(id => ids.includes(id));
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const at = order.indexOf(selected);
  if (at > 0) [order[0], order[at]] = [order[at], order[0]];
  return order;
}

// Show the split, growing edge and labels before starting motion. Scroll only
// the conversation pane; a short viewport prioritizes the top of the group.
function revealBranch(row) {
  const log = row.closest('#log');
  if (!log) return;
  const view = log.getBoundingClientRect(), box = row.getBoundingClientRect();
  const margin = Math.min(24, log.clientHeight / 8);
  const height = Math.min(box.height, log.clientHeight - margin * 2);
  const top = view.top + margin, bottom = view.top + log.clientHeight - margin;
  if (box.top < top) log.scrollTop += box.top - top;
  else if (box.top + height > bottom) log.scrollTop += box.top + height - bottom;
}

export function makeBranchRow(key, entries, selected, onPick, previous) {
  const row = el("div", "branch-row");
  row.dataset.key = key;
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", t("timeline.branch.pick"));
  const track = el("div", "branch-track"), svg = svgEl("svg", { class: "branch-edges", "aria-hidden": "true" });
  track.append(svg); row.append(track);
  const order = branchOrder(entries.map(e => e.id), selected, previous?.order);
  const nodes = entries.map(entry => {
    const tip = el("button", "branch-tip");
    tip.type = "button";
    tip.dataset.session = entry.id;
    tip.setAttribute("aria-pressed", String(entry.id === selected));
    tip.setAttribute("aria-label", t("timeline.branch.switchTo", { name: entry.name, count: entry.n }));
    tip.title = entry.name;
    const ring = svgEl("svg", { class: "branch-ring", viewBox: "0 0 16 16", "aria-hidden": "true" });
    ring.append(svgEl("circle", { cx: 8, cy: 8, r: 5 }));
    tip.append(ring, el("span", "branch-name", entry.name), el("span", "branch-note", entry.id === selected ? t("timeline.branch.current") : t("timeline.branch.continues", { count: entry.n })));
    tip.onclick = () => { if (!row.locked && entry.id !== selected) onPick(entry.id, row); };
    tip.onkeydown = e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const at = order.indexOf(entry.id);
      const i = e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + order.length) % order.length;
      nodes.find(n => n.id === order[i]).tip.focus();
    };
    track.append(tip);
    return { ...entry, tip, x: 0, growth: null };
  });
  // DOM/tab order matches the visual order, including after a selection.
  for (const id of order) track.append(nodes.find(n => n.id === id).tip);
  const step = () => Math.min(BRANCH.STEP, Math.max(64, (row.clientWidth - 48) / Math.max(1, nodes.length - 1)));
  const target = n => BRANCH.X + order.indexOf(n.id) * step();
  function draw() {
    const width = Math.max(row.clientWidth, 48 + (nodes.length - 1) * step());
    track.style.width = `${width}px`;
    svg.setAttribute("width", String(width));
    svg.replaceChildren();
    for (const n of nodes) {
      n.tip.style.left = `${n.x}px`;
      const p = svgEl("path", { d: curve({ x: BRANCH.X, y: BRANCH.SPLIT }, { x: n.x, y: BRANCH.Y }), class: n.id === selected || n.growth != null ? "active" : "" });
      p.dataset.session = n.id;
      if (n.growth != null) {
        p.setAttribute("pathLength", "1");
        p.style.strokeDasharray = "1";
        p.style.strokeDashoffset = String(1 - n.growth);
      }
      svg.append(p);
    }
    const n = nodes.find(n => n.id === selected);
    if (n) svg.append(svgEl("path", { class: "active branch-lower", d: curve({ x: n.x, y: BRANCH.Y }, { x: BRANCH.X, y: BRANCH.HEIGHT }) }));
  }
  row.layout = () => { if (!row.locked) for (const n of nodes) n.x = target(n); draw(); };
  row.snapshot = () => ({ order, positions: Object.fromEntries(nodes.map(n => [n.id, n.x])) });
  row.lock = () => { row.locked = true; for (const n of nodes) n.tip.disabled = true; };
  row.unlock = () => { row.locked = false; for (const n of nodes) n.tip.disabled = false; row.layout(); };
  row.promote = async snapshot => {
    row.lock(); row.dataset.phase = "switching";
    row.scrollLeft = 0;
    for (const n of nodes) n.x = snapshot?.positions[n.id] ?? target(n);
    draw();
    revealBranch(row);
    await animateBranch(560, e => {
      if (!row.isConnected) return;
      for (const n of nodes) { const from = snapshot?.positions[n.id] ?? target(n); n.x = from + (target(n) - from) * e; }
      draw();
    });
    row.dataset.phase = "idle"; row.unlock();
    nodes.find(n => n.id === selected)?.tip.focus({ preventScroll: true });
  };
  row.grow = async id => {
    const n = nodes.find(n => n.id === id);
    if (!n) return;
    row.lock(); row.dataset.phase = "growing";
    n.growth = 0; n.tip.classList.add("growing", "emerging"); n.tip.style.setProperty("--reveal", "0");
    draw();
    revealBranch(row);
    await animateBranch(780, (e, t) => {
      n.growth = e;
      n.tip.style.setProperty("--reveal", String(ease(Math.max(0, (t - .65) / .35))));
      draw();
    });
    // Keep the completed edge blue while the target history is being prepared.
    n.growth = 1; n.tip.classList.remove("growing");
    row.dataset.phase = "grown"; draw();
  };
  row.layout();
  return row;
}

// The spine is segmented around each group; no straight line runs behind a moving node.
export function layoutBranchSpine(thread) {
  const svg = thread.querySelector(".spine");
  if (!svg) return;
  svg.replaceChildren();
  let y = 0;
  const segment = to => {
    if (to > y) svg.append(svgEl("path", { d: curve({ x: BRANCH.X, y }, { x: BRANCH.X, y: to }) }));
  };
  for (const row of thread.querySelectorAll(".branch-row")) {
    row.layout(); segment(row.offsetTop + BRANCH.SPLIT); y = row.offsetTop + BRANCH.HEIGHT;
  }
  const last = [...thread.querySelectorAll(".mw.node,.mw.activity")].at(-1);
  const tip = last?.querySelector(".activity-tip");
  // Follow the circle's actual position, including its 1px outer outline.
  segment(Math.max(y, last ? last.offsetTop + (tip ? tip.offsetTop - 1 : 16) : thread.offsetHeight));
}
