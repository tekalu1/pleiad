// git パネルのグラフ（web/git-graph.mjs）: レーンの割り当て（合流・分岐・作業ツリーの行）と、範囲の帯に入るコミットの判定。
import { layoutGraph, rangeNodes, rowSvg, WT_KEY } from '../../web/git-graph.mjs';

export const name = 'git-graph';
export const title = 'git のグラフ: レーン・合流・分岐・作業ツリーの行・範囲の帯';

const c = (hash, ...parents) => ({ hash, parents });

export default async function (t) {
  // 一直線
  const line = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')], { headHash: 'c' });
  t.ok('一直線は全部レーン 0・辺 2 本', line.rows.every((r) => r.lane === 0) && line.edges.length === 2 && line.rows[0].head === true);

  // 分岐と合流:  m(merge of b2, f)  b2  f  b1(= base)
  const merged = layoutGraph([c('m', 'b2', 'f'), c('f', 'b1'), c('b2', 'b1'), c('b1')], { headHash: 'm' });
  t.ok('マージ: 第 1 親は同じ筋・第 2 親は別の筋', merged.rows[0].lane === 0 && merged.rows[0].merge === true && merged.rows[1].lane === 1, JSON.stringify(merged.rows));
  t.ok('合流: 共通の親 b1 は先に待っていた筋 1 に入り、筋 0 の b2 からの辺は筋 1 へ寄って b1 に着く', merged.rows[3].lane === 1 && merged.edges.some((e) => e.a === 2 && e.b === 3 && e.la === 0 && e.mid === 1 && e.lb === 1), JSON.stringify(merged.edges));
  t.ok('辺の行き先は親の行', merged.edges.every((e) => e.b === null || merged.rows[e.b].key !== undefined) && merged.edges.length === 4);

  // 読み込んだ分の外の親
  const cut = layoutGraph([c('b', 'a'), c('x', 'a')], {});
  t.ok('外の親へは b が null（下へ伸びて切れる）', cut.edges.every((e) => e.b === null));

  // 作業ツリーの行
  const wt = layoutGraph([c('h', 'p'), c('p')], { withWorktree: true, headHash: 'h' });
  t.ok('作業ツリーの行は先頭で、HEAD へ点線の辺', wt.rows[0].wt === true && wt.rows[0].key === WT_KEY && wt.edges[0].dash === true && wt.edges[0].a === 0 && wt.edges[0].b === 1);
  t.ok('SVG は作業ツリーの点を wt、HEAD の点を head にする', rowSvg(wt, 0).includes('class="n wt') && rowSvg(wt, 1).includes('class="n head'));

  // 範囲: 会話の始まりの HEAD は p。HEAD h と、別の枝 s（始まり p から出たが HEAD から辿れない）
  const commits = [c('s', 'p'), c('h', 'p2'), c('p2', 'p'), c('p', 'o'), c('o')];
  const lay = layoutGraph(commits, { withWorktree: true, headHash: 'h' });
  const un = rangeNodes(lay, commits, { kind: 'uncommitted', head: 'h' });
  t.ok('コミットしていない分: 作業ツリーの行だけ・起点は HEAD の行', [...un.nodes].join() === '0' && un.base === 2);
  const se = rangeNodes(lay, commits, { kind: 'session', head: 'h', start: 'p' });
  t.ok('この会話の間: 始まりの HEAD..HEAD のコミットと作業ツリー。HEAD から辿れない枝は入らない', [...se.nodes].sort().join() === '0,2,3' && se.base === 4, JSON.stringify([...se.nodes]));
  const unknown = rangeNodes(lay, commits, { kind: 'session', head: 'h', start: 'zzz' });
  t.ok('始まりが読み込みの外なら unknownStart', unknown.unknownStart === true);
  const one = rangeNodes(lay, commits, { kind: 'commit', hash: 'p2' });
  t.ok('コミットを押した: そのコミットだけ', [...one.nodes].join() === '3' && one.base === null);
}
