// git パネルの HTML の組み立て（web/git-panel.mjs の refHTML・fileRowHTML・esc、web/git-diff.mjs）: 悪意のある名前（パス・ブランチ・題・作者）で
// 属性や要素を差し込めないこと、行の識別子（data-key）にパスを入れないこと。
import { esc, fileRowHTML, refHTML } from '../../web/git-panel.mjs';
import { diffHTML } from '../../web/git-diff.mjs';

export const name = 'git-panel-html';
export const title = 'git パネルの HTML: 悪意のあるパス・ブランチ・題でも属性や要素を差し込めない';

const EVIL = [
  'a"><img src=x onerror=window.__xss=1>.js',
  "b' onmouseover='window.__xss=2",
  '<script>window.__xss=3</script>',
  'nul\u0000name\nnewline\r.txt',
  '"><svg onload=window.__xss=4>',
];

/** 組み立てた HTML のタグだけを見る: 既知のタグ名・引用符が閉じた属性・on で始まる属性が無い（文章の中の escape 済みの文字は見ない） */
function safe(html) {
  const known = new Set(['div', 'span', 'button', 'svg', 'path', 'circle', 'rect', 'code', 'a', 'b']);
  const tags = html.match(/<[^<>]*>/g) ?? [];
  // タグの外に < や > が裸で残っていない
  if (html.replace(/<[^<>]*>/g, '').match(/[<>]/)) return false;
  return tags.every((tag) => {
    const bare = tag.replace(/="[^"]*"/g, '=""');   // 値を外す
    const m = /^<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*(?:="")?)*)\s*\/?>$/.exec(bare);
    return m && known.has(m[1].toLowerCase()) && !/\son[a-z]+(=|\s|$)/i.test(m[2]);
  });
}

export default async function (t) {
  t.ok('esc: 5 つの記号を置き換える', esc('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;');
  for (const evil of EVIL) {
    const row = fileRowHTML({ path: `src/${evil}`, state: 'M', add: 1, del: 2, orig: evil }, 'w0:c:0', 0, true);
    t.ok(`ファイルの行: ${JSON.stringify(evil).slice(0, 30)}…`, safe(row), row.slice(0, 300));
    for (const kind of ['head', 'branch', 'tag', 'remote']) t.ok(`ref の札（${kind}）: ${JSON.stringify(evil).slice(0, 24)}…`, safe(refHTML({ kind, name: evil, pleiad: true })));
    const diff = diffHTML({ hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, section: evil, lines: [{ t: '-', s: evil }, { t: '+', s: `x${evil}` }] }], after: [evil, 'b', 'c', 'd', 'e', 'f', 'g'] }, { mode: 'inline' });
    t.ok(`差分: ${JSON.stringify(evil).slice(0, 24)}…`, safe(diff.html), diff.html.slice(0, 300));
    const side = diffHTML({ hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{ t: '-', s: evil }, { t: '+', s: evil }] }] }, { mode: 'side' });
    t.ok(`左右の差分: ${JSON.stringify(evil).slice(0, 24)}…`, safe(side.html));
  }
  // 識別子にパスを入れない・状態と数は決まった形にそろえる
  const row = fileRowHTML({ path: 'p"q', state: '"><x', add: '<b>', del: NaN }, 'w3:u:2', 1, false);
  t.ok('data-key は渡した識別子だけ・状態は M にそろう・数は 0', row.includes('data-key="w3:u:2"') && row.includes('class="st M"') && !row.includes('<b>') && !row.includes('p"q'), row.slice(0, 300));
  t.ok('ref の札: 名前は rn で包まれ、title に種類と名前', refHTML({ kind: 'tag', name: 'v1' }).includes('<span class="rn">v1</span>') && refHTML({ kind: 'tag', name: 'v1' }).includes('title="'));
}
