// git パネルのコミットのグラフ（docs/design-system.md「git の動き」、ADR 0135）。DOM に触れない部分（レーンの割り当て・範囲の判定）と、
// 1 行ぶんの SVG の文字列を作る部分。線の色は線の族だけ（HEAD の筋は --line-blue、ほかは --line-strong。差分の緑・赤は使わない）。

export const ROW_H = 30;
export const ROW_MID = 15;
const LANE_MAX = 3;                      // 描く筋は 3 本まで（4 本目以降は右端に重ねる）
export const laneX = (lane) => 10 + Math.min(lane, LANE_MAX - 1) * 13;
export const WT_KEY = 'worktree';         // 作業ツリーの仮の行の鍵

/**
 * レーンの割り当て。commits は新しい順（親が子より後ろ）の [{ hash, parents }]。withWorktree なら先頭に作業ツリーの仮の行（HEAD へ点線）を置く。
 * @returns {{ rows: { key: string, lane: number, merge: boolean, wt: boolean }[], edges: { a: number, b: number|null, la: number, lb: number|null, mid: number, dash: boolean }[], lanes: number }}
 *   edges の b が null は読み込んだ分の外の親（下へ伸びて切れる）。mid は縦の線を引く筋
 */
export function layoutGraph(commits, { withWorktree = false, headHash = null } = {}) {
  const items = [];
  if (withWorktree) items.push({ hash: WT_KEY, parents: headHash ? [headHash] : [], wt: true });
  for (const c of commits) items.push({ hash: c.hash, parents: c.parents ?? [], wt: false });
  const rowOf = new Map(items.map((c, i) => [c.hash, i]));
  const active = [];                     // 筋 → その筋が次に待つコミットの hash（空きは null）
  // 作業ツリーの行が無いときも、レーン 0 は HEAD の筋のために空けておく（HEAD より新しいブランチが青い筋を取らない）
  if (!withWorktree && headHash) active[0] = headHash;
  const rows = [], edges = [];
  const pending = [];                    // 筋に出した辺: { a, la, lane, parent, dash }
  let lanes = 0;
  items.forEach((c, r) => {
    let lane = active.indexOf(c.hash);
    if (lane < 0) { lane = active.indexOf(null); if (lane < 0) lane = active.length; }
    // このコミットを待っていたほかの筋はここで合流して空く
    for (let k = 0; k < active.length; k++) if (k !== lane && active[k] === c.hash) active[k] = null;
    active[lane] = null;
    for (const e of pending) if (e.parent === c.hash && e.b === undefined) { e.b = r; e.lb = lane; }
    c.parents.forEach((p, i) => {
      let target = active.indexOf(p);
      if (target < 0) {
        target = i === 0 ? lane : active.indexOf(null);
        if (target < 0) target = active.length;
        active[target] = p;
      }
      pending.push({ a: r, la: lane, mid: target, parent: p, dash: c.wt === true });
    });
    rows.push({ key: c.hash, lane, merge: c.parents.length > 1, wt: c.wt, head: c.hash === headHash });
    lanes = Math.max(lanes, active.length, lane + 1);
  });
  for (const e of pending) edges.push({ a: e.a, b: rowOf.has(e.parent) ? e.b ?? null : null, la: e.la, lb: e.lb ?? null, mid: e.mid, dash: e.dash });
  return { rows, edges, lanes };
}

/**
 * 範囲に入るコミット（行の添字の Set）と、比べる起点の行。
 *  - uncommitted: 作業ツリーの行だけ。起点は HEAD
 *  - session: 会話の始まりの HEAD から今までに増えたコミット（git log 始まり..HEAD）と作業ツリー。起点は会話の始まりの HEAD。
 *    始まりが読み込んだ分に無ければ null（呼び出し側が先を読む）
 *  - commit: 押したコミットだけ。起点は null
 */
export function rangeNodes(layout, commits, { kind, hash = null, head = null, start = null }) {
  const offset = layout.rows[0]?.wt ? 1 : 0;
  const index = new Map(commits.map((c, i) => [c.hash, i + offset]));
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const parentsOf = (h) => byHash.get(h)?.parents ?? [];
  const reach = (from) => {
    const seen = new Set(), stack = from ? [from] : [];
    while (stack.length) { const h = stack.pop(); if (seen.has(h) || !index.has(h)) continue; seen.add(h); stack.push(...parentsOf(h)); }
    return seen;
  };
  const hasWt = layout.rows[0]?.wt === true;
  if (kind === 'uncommitted') return { nodes: new Set(hasWt ? [0] : []), base: head && index.has(head) ? index.get(head) : null };
  if (kind === 'commit') return { nodes: new Set(index.has(hash) ? [index.get(hash)] : []), base: null };
  if (!start || !index.has(start)) return { nodes: new Set(hasWt ? [0] : []), base: null, unknownStart: true };
  const excluded = reach(start);
  const nodes = new Set(hasWt ? [0] : []);
  for (const h of reach(head)) if (!excluded.has(h)) nodes.add(index.get(h));
  return { nodes, base: index.get(start) };
}

/** 辺が行 r の中で描く線（無ければ null）。y は 0〜ROW_H */
export function edgePiece(e, r, rowCount, laneOf) {
  const x = (l) => laneX(l);
  const end = e.b ?? rowCount;           // 外の親は最後の行の下まで
  if (r === e.a) {
    const x1 = x(e.la), x2 = x(e.mid);
    return x1 === x2 ? `M${x1} ${ROW_MID}V${ROW_H}` : `M${x1} ${ROW_MID}C${x1} ${ROW_MID + 9} ${x2} ${ROW_H - 6} ${x2} ${ROW_H}`;
  }
  if (r > e.a && r < end) return `M${x(e.mid)} 0V${ROW_H}`;
  if (e.b != null && r === e.b) {
    const x1 = x(e.mid), x2 = x(laneOf(e.b));
    return x1 === x2 ? `M${x1} 0V${ROW_MID}` : `M${x1} 0C${x1} 6 ${x2} ${ROW_MID - 9} ${x2} ${ROW_MID}`;
  }
  return null;
}

const laneClass = (lane) => (lane === 0 ? ' l0' : '');   // HEAD の筋（レーン 0）は --line-blue、ほかは --line-strong（色は web/git.css）

/** 行 r の SVG（文字列）。辺と点に data-e / data-n を付け、強調は呼び出し側が on / dim の class で切り替える */
export function rowSvg(layout, r) {
  const laneOf = (i) => layout.rows[i].lane;
  let halo = '', core = '';
  layout.edges.forEach((e, i) => {
    const d = edgePiece(e, r, layout.rows.length, laneOf);
    if (!d) return;
    halo += `<path class="h" data-e="${i}" d="${d}"/>`;
    core += `<path class="e${laneClass(e.mid)}" data-e="${i}" d="${d}"${e.dash ? ' stroke-dasharray="3 3"' : ''}/>`;
  });
  const row = layout.rows[r], x = laneX(row.lane);
  const kind = row.wt ? 'wt' : row.head ? 'head' : row.merge ? 'merge' : '';
  const radius = row.head ? 5 : row.merge ? 3.6 : 4.3;
  return `<svg class="g" viewBox="0 0 44 ${ROW_H}" aria-hidden="true">${halo}<circle class="hn" data-n="${r}" cx="${x}" cy="${ROW_MID}" r="6.5"/>${core}<circle class="n ${kind}${laneClass(row.lane)}" data-n="${r}" cx="${x}" cy="${ROW_MID}" r="${radius}"/></svg>`;
}

/** 「さらに N 件」の行の頭に付ける、下へ切れる線 */
export function tailSvg(lane = 0) {
  return `<svg class="g" viewBox="0 0 44 28" aria-hidden="true"><path class="tail" d="M${laneX(lane)} 0V12"/></svg>`;
}
