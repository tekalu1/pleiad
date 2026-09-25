// 右パネルの枠（web/side-panel.mjs）: モードごとの部品の表と、渡されなかった部品を必ず隠す当て方。
// 可視化の ⋯ の中身（web/file-actions.mjs の visualizationMenuItems）もここで見る。
import assert from 'node:assert/strict';
import { applySlots, fileSlots, visualizationSlots, customSlots, subtitleFor } from '../../web/side-panel.mjs';
import { visualizationMenuItems } from '../../web/file-actions.mjs';
import { visualizationDocument } from '../../web/visualize-document.mjs';

export const name = 'side-panel';
export const title = '右パネルの枠: モードごとの部品・渡さない部品は隠す・可視化の ⋯ と見出しの下の行';

const labels = items => items.filter(i => !i.sep).map(i => i.label);

/** 枠の部品を最小の DOM（tests/lib/dom-stub.mjs）で作る */
function makeParts() {
  const node = (tag = 'div') => document.createElement(tag);
  const ids = ['tree', 'more', 'wide', 'close', 'browser', 'visualBrowser', 'path', 'reload', 'origin', 'reveal', 'save', 'visualSave', 'use'];
  const buttons = Object.fromEntries(ids.map(id => { const b = node('button'); b.textContent = id; return [id, b]; }));
  return { panel: node('aside'), name: node('span'), kind: node('span'), path: node('div'), actions: node(), toolbar: node(), switcher: node(),
    tools: node(), location: node(), note: node(), treePane: node(), footer: node('footer'), footActions: node(), status: node('span'),
    content: node(), buttons };
}
const shown = (parts, container) => parts[container].children.map(c => c.textContent);

export default async function (t) {
  // ---- モードの表
  const loading = fileSlots({ file: null, osActions: true });
  assert.deepEqual(loading.head, ['tree', 'wide', 'close'], '取得前は ⋯ を出さない');
  assert.equal(loading.aside, true); assert.equal(loading.views, false);
  assert.deepEqual(loading.footer, ['use']);
  const html = fileSlots({ file: { kind: 'html', text: '<p>', downloadable: true }, osActions: true });
  assert.deepEqual(html.head, ['tree', 'more', 'wide', 'close']);
  assert.deepEqual(html.toolbar, ['browser', 'path', 'reload'], 'HTML の「ブラウザーで開く」は切り替えのすぐ右');
  assert.deepEqual(html.footer, ['reveal', 'save', 'use']);
  const remote = fileSlots({ file: { kind: 'html', text: '<p>', downloadable: true }, osActions: false });
  assert.deepEqual(remote.toolbar, ['path', 'reload']); assert.deepEqual(remote.footer, ['save', 'use']);
  assert.equal(fileSlots({ file: { kind: 'text', text: 'x' } }).views, false, 'テキストは切り替えを出さない');
  assert.equal(fileSlots({ file: { kind: 'markdown', text: '# x' } }).kind, 'ファイル');
  t.ok('ファイル: 取得の前後・HTML・遠隔で出す部品', true);

  const visual = visualizationSlots({ origin: 'D:/w/out/q.html', html: '<p>', canBrowse: true, canUse: true });
  assert.equal(visual.aside, false, '可視化はツリーの枠を出さない');
  assert.deepEqual(visual.head, ['more', 'wide', 'close'], 'ツリーの切り替えは無く、⋯ はある');
  assert.deepEqual(visual.toolbar, ['visualBrowser', 'path', 'origin']);
  assert.deepEqual(visual.footer, ['visualSave', 'use']);
  assert.equal(visual.kind, '可視化'); assert(visual.note.includes('元のファイルを開く'));
  const orphan = visualizationSlots({ origin: null, html: '<p>', canBrowse: true });
  assert.deepEqual(orphan.toolbar, ['visualBrowser'], '元が無ければパス・元のファイルを開くは出さない');
  assert.deepEqual(orphan.footer, ['visualSave']); assert.equal(orphan.note, '');
  assert.deepEqual(visualizationSlots({ origin: 'D:/a.html', canBrowse: false, canUse: false }).toolbar, ['path', 'origin']);
  assert.deepEqual(visualizationSlots({ origin: 'D:/a.html', canUse: false }).footer, ['visualSave']);
  const custom = customSlots({ label: 'コンテキスト' });
  assert.deepEqual(custom.head, ['close']); assert.equal(custom.footer, null); assert.equal(custom.aside, false);
  t.ok('可視化: ツリー無し・⋯ あり・元の有無で出し分け。コンテキストは閉じるだけ', true);

  // ---- 枠に当てる。前のモードの部品が残らない
  const parts = makeParts();
  applySlots(parts, { ...html, title: 'a.html', subtitle: 'docs/a.html', note: '', status: 'HTML · 12:00 に取得' });
  assert.deepEqual(shown(parts, 'actions'), ['tree', 'more', 'wide', 'close']);
  assert.equal(parts.treePane.hidden, false); assert.equal(parts.kind.textContent, 'ファイル');
  parts.location.hidden = false;
  applySlots(parts, { ...visual, title: '売上', subtitle: 'out/q.html', note: visual.note, status: '14:31 に保存した表示' });
  assert.equal(parts.treePane.hidden, true, 'ファイルの次に可視化を開いてもツリーの枠が残らない');
  assert.deepEqual(shown(parts, 'actions'), ['more', 'wide', 'close']);
  assert.deepEqual(shown(parts, 'tools'), ['visualBrowser', 'path', 'origin']);
  assert.deepEqual(shown(parts, 'footActions'), ['visualSave', 'use']);
  assert.equal(parts.location.hidden, false, '「パス」があれば開いた行はそのまま');
  assert.equal(parts.note.hidden, false); assert.equal(parts.panel.dataset.mode, 'visualization');
  assert.equal(parts.panel.getAttribute('aria-label'), '可視化のプレビュー');
  applySlots(parts, { ...orphan, subtitle: '会話に保存された表示', note: '' });
  assert.equal(parts.location.hidden, true, '「パス」が無いモードではパスの行を閉じる');
  assert.equal(parts.note.hidden, true);
  applySlots(parts, { ...custom, title: 'コンテキスト', subtitle: '', note: '' });
  assert.equal(parts.toolbar.hidden, true); assert.equal(parts.footer.hidden, true); assert.equal(parts.kind.hidden, true);
  assert.deepEqual(shown(parts, 'actions'), ['close']); assert(parts.panel.classList.contains('custom'));
  applySlots(parts, { ...loading, title: 'b.md' });
  assert(!parts.panel.classList.contains('custom')); assert.equal(parts.footer.hidden, false); assert.equal(parts.treePane.hidden, false);
  assert.equal(parts.name.textContent, 'b.md');
  t.ok('枠: 渡された部品だけを並べ、ほかは隠す（ファイル → 可視化 → コンテキスト → ファイル）', true);

  // ---- 見出しの下の行
  assert.equal(subtitleFor('D:\\w\\out\\q.html', 'D:\\w'), 'out/q.html');
  assert.equal(subtitleFor('d:/W/out/q.html', 'D:/w/'), 'out/q.html', 'Windows は大文字小文字を問わない');
  assert.equal(subtitleFor('/home/a/x.html', '/home/b'), '/home/a/x.html', '外ならそのまま');
  assert.equal(subtitleFor('/home/a/x.html', null), '/home/a/x.html');
  assert.equal(subtitleFor(null, '/w', '会話に保存された表示'), '会話に保存された表示');
  t.ok('見出しの下: 作業ディレクトリの中は相対、外はそのまま、元が無ければ説明', true);

  // ---- 可視化の ⋯
  const run = () => {};
  assert.deepEqual(labels(visualizationMenuItems({ origin: 'D:/a.html' }, { osActions: true, run })),
    ['元のパスをコピー', '相対パスをコピー', 'ブラウザーで開く', '元のファイルを開く', 'エクスプローラーで表示', 'HTML を保存', '会話で使う']);
  assert.deepEqual(labels(visualizationMenuItems({ origin: 'D:/a.html' }, { osActions: false, canUse: false, run })),
    ['元のパスをコピー', '相対パスをコピー', 'ブラウザーで開く', '元のファイルを開く', 'HTML を保存'], '遠隔ではエクスプローラーを出さない');
  const bare = visualizationMenuItems({ origin: null }, { osActions: true, canBrowse: false, run });
  assert.deepEqual(labels(bare), ['HTML を保存'], '元も写しの印も無ければ保存だけ');
  assert(!bare.some(i => i.sep));
  t.ok('可視化の ⋯: 並びと、使えない項目を出さないこと', true);

  // ---- 単体で開く写し（サーバーが返す文書）
  const doc = visualizationDocument('<p>x</p>', { resize: false, title: '<売上>' });
  assert(!doc.includes('ply-visualize-height')); assert(doc.includes('<title>&#60;売上&#62;</title>'));
  assert(visualizationDocument('<p>x</p>').includes('ply-visualize-height'), '会話の枠は今までどおり高さを知らせる');
  t.ok('写しの文書: 単体では高さのスクリプトを持たず、題はエスケープする', true);
}
