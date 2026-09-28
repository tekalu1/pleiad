// web/tree.mjs の単体テスト。ブラウザは要らない（tests/lib/dom-stub.mjs の最小 DOM で回す）。
// 見るのは: 開閉・選択・絞り込み・キーボード・遅延読み込みと「さらに表示」・差し替えで開閉を保つ・横の位置合わせ（scrollX）。見た目は tests/unit/design-lint.mjs の担当。
import { createTree, scrollLeftFor } from '../../web/tree.mjs';

export const name = 'tree';
export const title = 'ツリー部品の開閉・選択・絞り込み・キーボード';

const make = () => [
  { id: 'r', name: 'root', open: true, children: [
    { id: 'a', name: 'alpha', children: [{ id: 'a1', name: 'apple' }, { id: 'a2', name: 'avocado' }] },
    { id: 'b', name: 'beta' },
    { id: 'c', name: 'cherry' },
  ] },
];

export default async function (t) {
  const root = document.createElement('div');
  const selected = [];
  const nodes = make();
  const tree = createTree(root, { nodes, onSelect: (n) => selected.push(n.id) });
  const rows = () => root.querySelectorAll('.tree-row');
  const names = () => rows().map((r) => r.querySelector('.nm').textContent).join(',');
  const rowOf = (id) => rows()[rows().map((r) => r.querySelector('.nm').textContent).indexOf(nodeName(id))];
  const nodeName = (id) => tree.node(id).name;
  const key = (k) => root.dispatchEvent({ type: 'keydown', key: k, preventDefault() {} });

  t.ok('role と tabindex を自分で付ける', root.getAttribute('role') === 'tree' && root.getAttribute('tabindex') === '0');
  t.ok('開いている節だけ子を描く', names() === 'root,alpha,beta,cherry', names());
  t.ok('葉には aria-expanded を付けない', rowOf('b').getAttribute('aria-expanded') === undefined);

  // ---- 開閉 ----
  rowOf('a').querySelector('.chev').onclick({ stopPropagation() {} });
  t.ok('chevron で開く', names() === 'root,alpha,apple,avocado,beta,cherry', names());
  t.ok('開いた節の aria-expanded が true', rowOf('a').getAttribute('aria-expanded') === 'true');
  t.ok('state() で開いている節の id を返す', tree.state().sort().join() === 'a,r', tree.state().join());
  rowOf('a').ondblclick();
  t.ok('ダブルクリックで閉じる', names() === 'root,alpha,beta,cherry', names());

  // ---- 選択 ----
  rowOf('b').onclick();
  t.ok('単押しは選択だけ', tree.selected().id === 'b' && names() === 'root,alpha,beta,cherry');
  t.ok('選んだ行に sel と aria-selected が付く', rowOf('b').className.includes('sel') && rowOf('b').getAttribute('aria-selected') === 'true');
  t.ok('選んだ行を aria-activedescendant が指す', root.getAttribute('aria-activedescendant') === rowOf('b').id);
  t.ok('onSelect が 1 回だけ届く', selected.join() === 'b', selected.join());

  // ---- キーボード ----
  key('ArrowDown');
  t.ok('↓ で次の行へ', tree.selected().id === 'c');
  key('ArrowUp'); key('ArrowUp');
  t.ok('↑ で前の行へ', tree.selected().id === 'a', tree.selected().id);
  key('ArrowRight');
  t.ok('→ で閉じた節を開く', names() === 'root,alpha,apple,avocado,beta,cherry', names());
  key('ArrowRight');
  t.ok('開いた節で → は子へ', tree.selected().id === 'a1');
  key('ArrowLeft');
  t.ok('葉で ← は親へ', tree.selected().id === 'a');
  key('ArrowLeft');
  t.ok('開いた節で ← は閉じる', names() === 'root,alpha,beta,cherry' && tree.selected().id === 'a');
  key('End');
  t.ok('End で最後の行へ', tree.selected().id === 'c');
  key('Home');
  t.ok('Home で最初の行へ', tree.selected().id === 'r');
  const before = selected.length;
  key('Enter');
  t.ok('Enter は同じ行を送り直す', selected.length === before + 1 && selected[selected.length - 1] === 'r');
  key('b');
  t.ok('文字でその文字から始まる行へ', tree.selected().id === 'b');

  // ---- 絞り込み ----
  tree.filter((n) => n.name.startsWith('av'));
  t.ok('一致行と祖先だけ残し、祖先は自動で開く', names() === 'root,alpha,avocado', names());
  t.ok('一致行に hit が付く', rowOf('a2').className.includes('hit') && !rowOf('a').className.includes('hit'));
  tree.filter(() => false);
  t.ok('一致が無ければ一行だけ出す', rows().length === 0 && root.children.length === 2 && root.lastChild.textContent === '一致なし');
  tree.filter(null);
  t.ok('解除で元の開閉に戻る', names() === 'root,alpha,beta,cherry', names());

  // ---- 差し替え ----
  tree.select('c');
  const next = make();
  next[0].children.push({ id: 'd', name: 'date' });
  tree.setNodes(next);
  t.ok('差し替えても同じ id の選択を保つ', tree.selected().id === 'c' && names() === 'root,alpha,beta,cherry,date', names());
  t.ok('消えた節は state() に残さない', tree.state().join() === 'r', tree.state().join());

  // ---- 見つからない行は選択を外す ----
  tree.select('c');
  t.ok('見つからない id を選ぶと前の選択を外す', tree.select('zzz', false) === null && tree.selected() === null
    && !rows().some((r) => r.className.includes('sel')) && root.getAttribute('aria-activedescendant') === '');
  tree.select('c');
  tree.select(null, false);
  t.ok('null でも選択を外す', tree.selected() === null);

  // ---- 遅延読み込み ----
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const waits = [];
  const loads = [];
  const lazyRoot = document.createElement('div');
  const lazy = createTree(lazyRoot, {
    nodes: [{ id: 'R', name: 'R', open: true, children: [
      { id: 'L', name: 'lazy', lazy: true },
      { id: 'E', name: 'empty', children: [] },
      { id: 'X', name: 'broken', lazy: true },
    ] }],
    failed: '読めない',
    onLoad: (n) => { loads.push(n.id); return new Promise((resolve, reject) => waits.push({ id: n.id, resolve, reject })); },
    onMore: (n) => Promise.resolve({ children: [...n.children, { id: 'L3', name: 'l3' }], more: 0 }),
    moreLabel: (n) => `さらに ${n.more} 件`,
  });
  const lrows = () => lazyRoot.querySelectorAll('.tree-row');
  const lnames = () => lrows().map((r) => r.querySelector('.nm').textContent).join(',');
  const lrow = (name) => lrows().find((r) => r.querySelector('.nm').textContent === name);
  t.ok('lazy のフォルダーは chevron と aria-expanded=false（未読み込み）', lrow('lazy').getAttribute('aria-expanded') === 'false' && !lrow('lazy').querySelector('.chev').className.includes('none'));
  t.ok('空の [] のフォルダーは葉と同じ（中身が無いと分かっている）', lrow('empty').getAttribute('aria-expanded') === undefined);
  lrow('lazy').querySelector('.chev').onclick({ stopPropagation() {} });
  await settle();
  t.ok('開くと読み込み、その間は「読み込み中…」の行', loads.join() === 'L' && lnames() === 'R,lazy,読み込み中…,empty,broken', lnames());
  t.ok('読み込み中の行は選べない（aria-disabled）', lrow('読み込み中…').getAttribute('aria-disabled') === 'true');
  waits.shift().resolve({ children: [{ id: 'L1', name: 'l1' }, { id: 'L2', name: 'l2' }], more: 5 });
  await settle();
  t.ok('読めたら子と「さらに表示」の行', lnames() === 'R,lazy,l1,l2,さらに 5 件,empty,broken', lnames());
  t.ok('読んだ子は id で引ける', lazy.node('L2')?.name === 'l2' && lazy.node('L').lazy === false);
  lrow('さらに 5 件').onclick();
  await settle();
  t.ok('「さらに表示」で続きを足す', lnames() === 'R,lazy,l1,l2,l3,empty,broken', lnames());
  lrow('broken').querySelector('.chev').onclick({ stopPropagation() {} });
  await settle();
  waits.shift().reject(new Error('権限がありません'));
  await settle();
  t.ok('読めなければ失敗の行（理由は title）', lnames().endsWith('broken,読めない') && lrow('読めない').getAttribute('title') === '権限がありません', lnames());
  lrow('broken').querySelector('.chev').onclick({ stopPropagation() {} });
  lrow('broken').querySelector('.chev').onclick({ stopPropagation() {} });
  await settle();
  t.ok('閉じて開き直すと読み直す', loads.join() === 'L,X,X', loads.join());
  waits.shift().resolve({ children: [] });
  await settle();

  // ---- 差し替えても開閉を保つ・すべて折りたたむ ----
  lazy.setNodes([{ id: 'R', name: 'R', open: true, children: [
    { id: 'L', name: 'lazy', children: [{ id: 'L1', name: 'l1' }] },
    { id: 'E', name: 'empty', children: [] },
  ] }]);
  t.ok('setNodes で差し替えても開いていたフォルダーは開いたまま', lnames() === 'R,lazy,l1,empty', lnames());
  lazy.collapseAll();
  t.ok('すべて折りたたむと根の直下だけ残る', lnames() === 'R,lazy,empty' && lazy.state().join() === 'R', lnames());
  t.ok('reveal で祖先を開き直せる', lazy.reveal('L1') && lnames() === 'R,lazy,l1,empty', lnames());
  lazy.scrollToRow('L1');   // 最小 DOM は大きさを持たない。呼んでも落ちないことだけ

  // ---- 横の位置合わせ（純粋な関数）: 座標は中身の左端から。欄 200、⋯ の分 30 ----
  const x = (o) => scrollLeftFor({ width: 200, reserve: 30, ...o });
  t.ok('名前が欄に収まれば 0 に戻す', x({ scroll: 120, start: 20, end: 150 }) === 0);
  t.ok('収まっていて頭も見えていれば動かさない', x({ scroll: 10, start: 20, end: 150 }) === 10);
  t.ok('force なら見えていても 0 に合わせ直す', x({ scroll: 10, start: 20, end: 150, force: true }) === 0);
  t.ok('収まらなければ名前の終わり＋⋯が見える最小の量', x({ scroll: 0, start: 160, end: 300 }) === 130);
  t.ok('名前の終わりと頭が見えていれば動かさない', x({ scroll: 150, start: 160, end: 300 }) === 150);
  t.ok('force なら見えていても最小の量へ合わせ直す', x({ scroll: 150, start: 160, end: 300, force: true }) === 130);
  t.ok('右へ行き過ぎていれば最小の量へ戻す', x({ scroll: 400, start: 160, end: 300 }) === 130);
  t.ok('頭と終わりが同時に見えなければ名前の終わりを優先', x({ scroll: 0, start: 160, end: 500 }) === 330);
  t.ok('その位置のままなら動かさない', x({ scroll: 330, start: 160, end: 500 }) === 330);

  // ---- 横の位置合わせ（部品）: 行の部品の位置を深さから作る最小の幾何で回す ----
  const hroot = document.createElement('div');
  Object.assign(hroot, { clientWidth: 200, clientLeft: 0, scrollLeft: 0, scrollTop: 0 });
  hroot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 280, right: 200, bottom: 280 });
  const depth = { H: 0, S: 1, D: 9 };
  const rectAt = (left, width, row) => () => {
    const i = hroot.querySelectorAll('.tree-row').indexOf(row);
    return { left: left - hroot.scrollLeft, right: left + width - hroot.scrollLeft, width, top: i * 28 - hroot.scrollTop, bottom: i * 28 + 28 - hroot.scrollTop, height: 28 };
  };
  const htree = createTree(hroot, {
    scrollX: true,
    nodes: [{ id: 'H', name: 'root', open: true, children: [{ id: 'S', name: 'short' }, { id: 'D', name: 'deep-long-name' }] }],
    render(n, row) {
      const left = 24 + depth[n.id] * 16;
      const ic = document.createElement('span'); ic.className = 'ic'; ic.getBoundingClientRect = rectAt(left, 16, row);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = n.name; nm.getBoundingClientRect = rectAt(left + 21, n.name.length * 20, row);
      const more = document.createElement('button'); more.className = 'tree-more'; more.getBoundingClientRect = rectAt(0, 22, row);
      row.append(ic, nm, more);
      row.getBoundingClientRect = rectAt(0, 600, row);
      row.scrollIntoView = () => { hroot.scrollLeft = 100; };   // ブラウザーの scrollIntoView は横にも動かす
    },
  });
  htree.select('D', false, { scroll: false });
  htree.scrollToRow('D');
  // 深い行: 頭 168、名前の終わり 168+21+280=469、⋯ 22（行の間隔・余白は getComputedStyle が無いので 0）
  t.ok('scrollX: 深い行を送ると名前の終わり＋⋯が見える最小の量へ', hroot.scrollLeft === 469 + 22 - 200, String(hroot.scrollLeft));
  htree.scrollToRow('S');
  t.ok('scrollX: 浅い行へ移ると 0 に戻る', hroot.scrollLeft === 0, String(hroot.scrollLeft));
  hroot.scrollLeft = 5;
  htree.scrollToRow('S');
  t.ok('scrollX: 見えていれば動かさない', hroot.scrollLeft === 5, String(hroot.scrollLeft));
  htree.scrollToRow('S', { force: true });
  t.ok('scrollX: force なら合わせ直す', hroot.scrollLeft === 0, String(hroot.scrollLeft));
  htree.select('S', false);
  const hkey = (k) => hroot.dispatchEvent({ type: 'keydown', key: k, preventDefault() {} });
  hkey('ArrowDown');
  t.ok('scrollX: キーボードで選んだ行も名前が見える位置へ（scrollIntoView の横の送りは打ち消す）', htree.selected().id === 'D' && hroot.scrollLeft === 291, String(hroot.scrollLeft));
  hkey('ArrowUp');
  t.ok('scrollX: キーボードで浅い行へ戻ると 0', htree.selected().id === 'S' && hroot.scrollLeft === 0, String(hroot.scrollLeft));
  htree.collapseAll();
  t.ok('scrollX: すべて折りたたむと左端へ戻す', hroot.scrollLeft === 0, String(hroot.scrollLeft));
  tree.select('c');
  tree.collapseAll();
  t.ok('scrollX の無い使い手は横に触らない', root.scrollLeft === undefined);
}
