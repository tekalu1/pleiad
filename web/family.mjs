// 脇の一覧で、fork した会話を親とひとまとめにする（docs/design-system.md §4.1「グループ」）。
//
// **グループは持ち物ではない。** 親子でつながり・状態が同じ・人が外していない、の 3 つで決まる。
// だから「状態を変える」だけでグループから出られ、「状態を根に合わせる」だけで戻れる。
// 覚えるのは人が外した／解除したことだけ（sidecar の ungrouped）。
//
// core/lineage.mjs と同じ考え方（親を辿って根に着く）だが、こちらは**絞り込みで見えている行だけ**で組む。
// 見えない親（別のディレクトリ・検索に外れた行）と、条件に合わない祖先（状態が違う・外された）は
// 飛ばして、さらに上を見る。付ける先が無ければ、その行が根になる。器に入るのは根とその子孫で、
// 枝の枝も同じ器に平らに並べる（入れ子の器は作らない。枝の前後関係は会話側の枝の表示が持つ）。
//
// 描画も DOM も知らない純粋な関数なので、ブラウザ無しで回せる（tests/unit/family.mjs）。
const MAX_DEPTH = 64;   // 根へ遡る段数の上限。壊れた親・長すぎる連鎖はその前に止まる

/** 子を親のまとまりに入れてよいか。状態が同じで、どちらも外されていないこと */
const canGroup = (child, parent) =>
  Boolean(parent) && !child.ungrouped && !parent.ungrouped && (child.status ?? null) === (parent.status ?? null);

/**
 * 見えている祖先のうち、r が入れる一番近いものの id。無ければ null。
 * 自己参照・循環・一覧に無い親はそこで打ち切る。
 */
function nearest(r, byId, shown) {
  if (r.ungrouped) return null;
  const seen = new Set([r.id]);
  let p = r.parent?.sessionId;
  for (let i = 0; p && i < MAX_DEPTH; i++) {
    if (seen.has(p)) return null;
    seen.add(p);
    const up = byId.get(p);
    if (shown.has(p) && canGroup(r, up)) return p;
    p = up?.parent?.sessionId;
  }
  return null;
}

/**
 * 行をグループにまとめる。
 * @param {Array<{id:string, parent?:{sessionId:string}|null, status?:string|null, ungrouped?:boolean}>} visible
 *        絞り込みを通った行（この順を保つ）
 * @param {Array<object>} [all] 一覧の全部の行（見えない親を辿るため）
 * @returns {Array<{root: object, kin: object[]}>} 根の並び。kin は幅優先の子孫（根は含まない）
 */
export function familiesOf(visible, all = visible) {
  const byId = new Map(all.map((r) => [r.id, r]));
  const shown = new Set(visible.map((r) => r.id));
  const kids = new Map();      // 親の id -> 子の行
  const attached = new Set();  // 誰かの子になった行
  for (const r of visible) {
    const p = nearest(r, byId, shown);
    if (p == null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(r);
    attached.add(r.id);
  }

  const covered = new Set();
  const grow = (root) => {
    covered.add(root.id);
    const kin = [];
    const queue = [root.id];
    for (let i = 0; i < queue.length; i++) {
      for (const c of kids.get(queue[i]) ?? []) {
        if (covered.has(c.id)) continue;
        covered.add(c.id);
        kin.push(c);
        queue.push(c.id);
      }
    }
    return { root, kin };
  };

  const out = [];
  for (const r of visible) if (!attached.has(r.id)) out.push(grow(r));
  // 循環で根が一人も居ない塊。落として消すより、見えた順に根として出す
  for (const r of visible) if (!covered.has(r.id)) out.push(grow(r));
  return out;
}
