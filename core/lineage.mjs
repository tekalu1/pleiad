// 系譜。同じ根を持つセッション群を、一覧の行（listSessions の合成結果）から集める。
//
// parent は sidecar（host が分けたもの）にもバックエンド（codex の forkedFromId のように
// 向こうで分けたもの）にもあり、一覧の行は両方を合わせて持つ。ここは行の parent だけを見る。
// 純粋な関数なので、サーバを立てずにテストできる（tests/unit/lineage.mjs）。

const MAX_DEPTH = 64;     // 根へ遡る段数の上限。自己参照・循環はその前に止まる
const MAX_FAMILY = 200;   // 家族の上限。筋に描ける量を超えたものは切る

/**
 * @param {Array<{id:string, parent?:{sessionId:string}|null}>} rows 一覧の行
 * @param {string} sessionId 起点
 * @returns {{ rootId: string, ids: string[] }} 根と、根から幅優先で集めた家族（起点を含む）
 */
export function familyOf(rows, sessionId) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 親 -> 子 の索引を 1 パスで作る。行ごとに全体を舐め直さない
  const children = new Map();
  for (const r of rows) {
    const p = r.parent?.sessionId;
    if (!p || p === r.id) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(r.id);
  }
  // 根へ。一覧に無い親（消えたセッション）・自己参照・循環・深すぎる連鎖はそこで打ち切る
  let root = sessionId;
  const seen = new Set([root]);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const p = byId.get(root)?.parent?.sessionId;
    if (!p || seen.has(p) || !byId.has(p)) break;
    seen.add(p);
    root = p;
  }
  // 子孫を幅優先で
  const ids = [root];
  const taken = new Set(ids);
  for (let i = 0; i < ids.length && ids.length < MAX_FAMILY; i++) {
    for (const c of children.get(ids[i]) ?? []) {
      if (taken.has(c)) continue;
      taken.add(c);
      ids.push(c);
      if (ids.length >= MAX_FAMILY) break;
    }
  }
  return { rootId: root, ids };
}
