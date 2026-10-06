// 貼り付けの HTML → 入力欄の形（web/html-paste.mjs。docs/adr/0141、docs/design-system.md「入力欄の編集欄」）。
//   - Chrome の選択 HTML の形（ブロックに長い style・語の間の <span> </span>・絶対 URL の img）・Slack 風・Google ドキュメント風・色だけの span（VS Code 風）
//   - 見出し・リスト（入れ子・番号）・引用・pre・インラインコード・太字・斜体・取り消し線・リンク・表・画像（data: / https / 小さな画像 / 非表示 / 上限）
//   - 構造の無い HTML は null（text/plain を使う）。非表示・script・style は読まない。字の中の記号の逃がし方
//   - 往復: 変換した Markdown は markdownToDoc → docToMarkdown で 1 文字も変わらない
// DOM は無いので、tests/lib/mini-html.mjs の最小のパーサーで読む（本物の DOMParser は tests/browser/rich-paste.cjs が通す）。
import { htmlToRich, PASTE_IMAGE_MAX } from '../../web/html-paste.mjs';
import { markdownToDoc, docToMarkdown } from '../../web/md-doc.mjs';
import { parseMini } from '../lib/mini-html.mjs';

export const name = 'html-paste';
export const title = '貼り付けの HTML → 入力欄の形: 書式・リスト・引用・コード・リンク・表・画像の振り分け・構造の無い HTML は対象外・往復で崩れない';

const conv = (html, o) => htmlToRich(html, { parse: parseMini, ...o });
const md = (html, o) => { const r = conv(html, o); return r ? r.lines.map((l) => (l.image ? `<img ${l.image.kind}${l.image.alt ? ` alt=${l.image.alt}` : ''}>` : l.md)).join('\n') : null; };
const LONG = 'color: rgb(28, 34, 71); font-family: &quot;Segoe UI&quot;, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial;';
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgo=';

export default async function (t) {
  const same = (label, html, expected, o) => { const got = md(html, o); return t.ok(label, got === expected, got === expected ? '' : `\n--- got\n${got}\n--- want\n${expected}`); };

  // ---- Chrome の選択 HTML
  const chrome = `<meta charset='utf-8'><h2 style="${LONG}">リリース手順</h2><p style="${LONG}">今回は<span> </span><strong>本番</strong><span> </span>へ出します。詳細は<span> </span><a href="https://example.com/runbook">runbook</a><span> </span>を見てください。<span style="color: rgb(179, 38, 30); font-size: 20px;">注意</span></p>`
    + `<ul style="${LONG}"><li>ビルドを確認する</li><li>必ず<span> </span><em>ステージング</em>で試す</li></ul><ol start="1" style="${LONG}"><li>バックアップを取る</li><li>切り替える</li></ol>`
    + `<blockquote style="${LONG}">迷ったら止める</blockquote><pre style="${LONG}"><code class="language-sh">npm run build\nnpm test</code></pre>`;
  const chromeMd = ['## リリース手順', '今回は **本番** へ出します。詳細は [runbook](https://example.com/runbook) を見てください。注意', '- ビルドを確認する', '- 必ず *ステージング*で試す', '1. バックアップを取る', '2. 切り替える', '> 迷ったら止める', '```sh', 'npm run build', 'npm test', '```'].join('\n');
  same('Chrome の選択 HTML: 見出し・太字・リンク・箇条書き・番号・引用・コード。色・大きさ・style は捨てる', chrome, chromeMd);
  const round = (text) => docToMarkdown(markdownToDoc(text)) === text;
  t.ok('往復: 変換した Markdown を入力欄の文書にして戻しても 1 文字も変わらない', round(chromeMd));

  // ---- チャット風（Slack の HTML の形。専用の処理は無い）
  const chat = `<div aria-roledescription="message"><span><strong>Aoi</strong><span> 10:32</span></span><div>デプロイ前に<span> </span><img alt=":eyes:" src="https://cdn.example.com/emoji/eyes@2x.png" style="height:1.2em;width:1.2em"><span> </span>お願いします<a href="https://chat.example.com/team/U0000" style="background: #e8f5fa">@Ren</a>。本番は今夜 22:00 です。</div>`
    + `<blockquote style="border-left: 4px solid #ccc">先に<b>ステージング</b>を見ておく</blockquote><pre style="background: #f8f8f8">./deploy.sh --env prod</pre>`
    + `<a class="thumbnailWrapper" href="https://files.example.com/files-pri/T0000-F0000/image.png"><div style="height: 120px; width: 200px;"></div></a></div>`;
  same('チャット風の HTML: 名前の太字・絵文字の画像は alt の字・メンションはリンクのまま・引用・pre。認証付きの空の枠は何も残さない', chat,
    ['**Aoi** 10:32', 'デプロイ前に :eyes: お願いします[@Ren](https://chat.example.com/team/U0000)。本番は今夜 22:00 です。', '> 先に**ステージング**を見ておく', '```', './deploy.sh --env prod', '```'].join('\n'));

  // ---- 構造が無い HTML は対象外（text/plain を使う）
  const vscode = '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas, monospace;font-size: 14px;line-height: 19px;white-space: pre;"><div><span style="color: #569cd6;">const</span><span style="color: #d4d4d4;"> x = </span><span style="color: #b5cea8;">1</span><span style="color: #d4d4d4;">;</span></div><div><span style="color: #6a9955;font-style: italic;">    // コメント</span></div><div><span style="font-weight: 700;color: #c586c0">return</span> x;</div></div>';
  t.ok('色付きの span だけ（VS Code 風。style の太字・斜体を含む）は null（text/plain のまま）', conv(vscode) === null);
  t.ok('段落・div・br・色の span だけの HTML は null', conv('<meta charset="utf-8"><p style="margin:0">ただの字</p><div>二行目<br>三行目</div><span style="color:red">赤</span>') === null);
  t.ok('Google ドキュメントの包み（<b style="font-weight:normal">）だけでは構造にしない', conv('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-0000"><p dir="ltr"><span style="font-size:11pt">ただの段落</span></p></b>') === null);
  t.ok('空・字の無い HTML・meta だけは null', conv('') === null && conv('<meta charset="utf-8">') === null && conv('<div> </div>') === null && conv('<ul><li></li></ul>') === null && conv(null) === null);
  t.ok('大きすぎる HTML は読まない（null）', conv(`<h1>x</h1>${'a'.repeat(25 * 1024 * 1024)}`) === null);
  same('Google ドキュメントの包み + 見出し・style の太字は、ほかに構造があるときだけ読む',
    '<b style="font-weight:normal;" id="docs-internal-guid-0000"><h1 dir="ltr"><span style="font-size:20pt;font-weight:700">題</span></h1><p dir="ltr"><span style="font-weight:700">太字</span><span>と</span><span style="font-style:italic">斜体</span></p></b>',
    '# **題**\n**太字**と*斜体*');
  same('太字の要素でも font-weight: normal なら太字にしない', '<h2>見出し</h2><p><strong style="font-weight: normal">ふつう</strong></p>', '## 見出し\nふつう');

  // ---- リスト・引用の入れ子
  same('入れ子のリスト（2 字ずつ字下げ・番号は振り直す・start を読む）',
    '<ul><li>親<ul><li>子1</li><li>子2<ol start="3"><li>孫</li><li>孫2</li></ol></li></ul></li><li>次</li></ul>',
    '- 親\n  - 子1\n  - 子2\n    3. 孫\n    4. 孫2\n- 次');
  same('li の中の p・div は 1 つの項目（続きは字下げ）', '<ul><li><p>一段落</p><p>二段落</p></li><li><div>div</div></li></ul>', '- 一段落\n\n  二段落\n- div');
  same('li の外の入れ子のリスト（崩れた HTML）・閉じの省略', '<ul><li>a<li>b<ul><li>c</ul></ul>', '- a\n- b\n  - c');
  same('入れ子の引用は > > ・引用の中の段落', '<blockquote>外<blockquote>内</blockquote></blockquote><blockquote><p>一</p><p>二</p></blockquote>', '> 外\n> > 内\n> 一\n>\n> 二');
  same('リストの外に切り出された li（選択の途中から）', '<li>切れた項目</li><li>もう 1 つ</li>', '- 切れた項目\n- もう 1 つ');

  // ---- コード
  same('pre: 言語・空行・字下げを残す。末尾の改行は落とす', '<pre><code class="language-js">function f() {\n\n  return 1;\n}\n\n</code></pre>', '```js\nfunction f() {\n\n  return 1;\n}\n```');
  same('pre の中に ``` があるときはフェンスを長くする・色の span は字だけ・<br> は改行', '<pre>a<br>```<span class="hl">b</span>\n  c</pre>', '````\na\n```b\n  c\n````');
  same('インラインコード（code・kbd）。中の ` は区切りを増やす', '<p>実行は<code>npm test</code>と<kbd>Ctrl</kbd>、<code>a`b</code>、<code>`x`</code></p><h3>x</h3>', '実行は`npm test`と`Ctrl`、``a`b``、`` `x` ``\n### x');
  same('コードの中の太字・リンクは字だけ', '<pre><b>太</b><a href="https://example.com/">リンク</a></pre><p><code><b>x</b></code></p>', '```\n太リンク\n```\n`x`');

  // ---- インライン
  same('太字・斜体の前後の空白は区切りの外へ（行の端なら落とす）・同じ書式の隣はまとめる', '<h4>x</h4><p><b> a </b><b>b</b>と<i>c</i><i> d</i>。<em></em><b> </b></p>', '#### x\n**a b**と*c d*。');
  same('取り消し線は ~~字~~（入力欄は解釈しない。送信後の描画が読む）・下線・色は字だけ', '<h4>x</h4><p><del>消す</del><s>こちらも</s><u>下線</u><font color="red">赤</font></p>', '#### x\n~~消すこちらも~~下線赤');
  same('入れ子の書式（太字の中の斜体・リンクの中の太字）', '<h4>x</h4><p><b>太<i>斜</i>太</b> <a href="https://example.com/a"><b>リンク</b></a></p>', '#### x\n**太*斜*太** [**リンク**](https://example.com/a)');
  same('字の中の記号は最小限だけ \\ で逃がす（* ` [ ] \\ と、語の外の _）。語の中の _ は逃がさない', '<h4>x</h4><p>a*b `c` [d] \\e snake_case _private x_ ~~f~~</p>', '#### x\na\\*b \\`c\\` \\[d\\] \\\\e snake_case \\_private x\\_ \\~\\~f\\~\\~');
  same('行頭の記号（# - > 1.）は字として残すために逃がす', '<h4>x</h4><p># 見出しではない</p><p>- 項目ではない</p><p>&gt; 引用ではない</p><p>1. 番号ではない</p><p>2024. 年</p>',
    '#### x\n\\# 見出しではない\n\n\\- 項目ではない\n\n\\> 引用ではない\n\n1\\. 番号ではない\n\n2024\\. 年');
  same('行だけが --- や === の字（横線・見出しの下線になる）は逃がす。行の中の --- ・見出しの下線にならない形はそのまま',
    '<h4>x</h4><p>題</p><p>---</p><p>===</p><p>--</p><p>-</p><p>a --- b</p><p>-=</p><p>----------</p><div>前<br>---</div>',
    '#### x\n題\n\n\\---\n\n\\===\n\n\\--\n\n\\-\n\na --- b\n\n-=\n\n\\----------\n前\n\\---');
  same('<p> と <p> の間は空行・div と br は改行・<br> が 2 つ続けば空行 1 つ', '<h4>x</h4><p>一</p><p>二</p><div>三<br>四<br><br>五</div><div>六</div>', '#### x\n一\n\n二\n三\n四\n\n五\n六');
  same('語の間の <span> </span>・改行・連続する空白・nbsp は空白 1 つ', '<h4>x</h4><p>a<span> </span>b\n   c&nbsp;&nbsp;d  <span>  </span> e</p>', '#### x\na b c d e');

  // ---- リンク
  same('リンクは http・https・mailto だけ。javascript:・相対・# は字だけ。URL の ( ) と空白は %28 %29 %20', '<h4>x</h4><p><a href="https://example.com/a_(b) c">A</a> <a href="mailto:aoi@example.com">mail</a> <a href="javascript:alert(1)">js</a> <a href="/rel">相対</a> <a href="#top">top</a> <a>no href</a> <a href="ftp://x.example.com/">ftp</a></p>',
    '#### x\n[A](https://example.com/a_%28b%29%20c) [mail](mailto:aoi@example.com) js 相対 top no href ftp');
  same('リンクの字が URL に見えて行き先が違うときは、行き先も字で見せる（同じ所なら足さない）', '<h4>x</h4><p><a href="https://evil.example.net/login">https://good.example.com</a> <a href="https://www.example.com/a">example.com</a> <a href="https://example.com/b">example.com/b</a></p>',
    '#### x\n[https://good.example.com](https://evil.example.net/login) (https://evil.example.net/login) [example.com](https://www.example.com/a) [example.com/b](https://example.com/b)');
  same('リンクの字の [ ] は逃がす・字が無いリンクは落とす', '<h4>x</h4><p><a href="https://example.com/">[参照] 1</a><a href="https://example.com/z"> </a></p>', '#### x\n[\\[参照\\] 1](https://example.com/)');

  // ---- 表
  same('表: 1 行目を見出しの行にし、区切りの行を足す（| は \\| に・セルの中の書式は残す・改行は空白）',
    '<table><thead><tr><th>名前</th><th>値</th></tr></thead><tbody><tr><td>a|b</td><td><strong>1</strong></td></tr><tr><td><p>x</p><p>y</p></td><td>l1<br>l2</td></tr></tbody></table>',
    '| 名前 | 値 |\n| --- | --- |\n| a\\|b | **1** |\n| x y | l1 l2 |');
  const table = '| 名前 | 値 |\n| --- | --- |\n| a\\|b | **1** |';
  t.ok('往復: 表の行は平文の行のまま、1 文字も変わらない', round(table) && markdownToDoc(table).every((b) => b.kind === 'p'));
  same('表のセルの中の画像は alt の字（札にしない）', '<table><tr><td><img src="https://cdn.example.com/a.png" alt="図"></td><td>b</td></tr></table>', '| 図 | b |\n| --- | --- |');

  // ---- 画像
  const imgs = conv(`<p>前<img src="${PNG_DATA}" alt="図 1">後</p><p><img src="https://cdn.example.com/a.png" alt="構成図"></p><p><img src="https://cdn.example.com/b.png"></p>`);
  t.ok('画像: data: と https は独立した行（札）にし、文は前後に割る。種類・alt を持つ',
    JSON.stringify(imgs?.lines) === JSON.stringify([{ md: '前' }, { image: { src: PNG_DATA, alt: '図 1', kind: 'data' } }, { md: '後' }, { image: { src: 'https://cdn.example.com/a.png', alt: '構成図', kind: 'https' } }, { image: { src: 'https://cdn.example.com/b.png', alt: '', kind: 'https' } }]), JSON.stringify(imgs?.lines));
  same('画像だけの HTML も取り込む（text/plain は alt の字だけ）', '<img src="https://cdn.example.com/only.png" alt="だけ">', '<img https alt=だけ>');
  same('小さな画像（幅・高さの指定が 32px 以下・2em 以下・絵文字の class・1×1）は札にせず alt の字（無ければ捨てる）',
    '<h4>x</h4><p>a<img src="https://cdn.example.com/e.png" alt="👀" width="20" height="20">b<img src="https://cdn.example.com/f.png" alt=":x:" style="height:1.2em;width:1.2em">c<img src="https://cdn.example.com/g.png" class="emoji big" alt="E">d<img src="https://cdn.example.com/p.gif" width="1" height="1">e<img src="https://cdn.example.com/h.png" alt="H" style="width:32px">f<img src="https://cdn.example.com/i.png" alt="I" width="33" height="200"></p>',
    '#### x\na👀b:x:cEdeHf\n<img https alt=I>');
  same('非表示の画像・http・相対・blob・SVG の画像は札にしない（取りに行かない）',
    '<h4>x</h4><p>a<img src="https://cdn.example.com/a.png" alt="隠" style="display:none">b<img src="http://cdn.example.com/b.png" alt="平文">c<img src="/rel.png" alt="相対">d<img src="blob:https://example.com/0">e<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg"></p>',
    '#### x\nab平文c相対desvg');
  const many = conv(`<h4>x</h4>${Array.from({ length: PASTE_IMAGE_MAX + 5 }, (_, i) => `<img src="https://cdn.example.com/${i}.png" alt="n${i}">`).join('')}`);
  t.ok(`画像は 1 回の貼り付けで ${PASTE_IMAGE_MAX} 枚まで。超えた分は札にならず、何も残さない（alt の字も）`,
    many.lines.filter((l) => l.image).length === PASTE_IMAGE_MAX && many.lines.length === PASTE_IMAGE_MAX + 1 && many.lines.at(-1).image.src.endsWith(`/${PASTE_IMAGE_MAX - 1}.png`));
  t.ok('maxImages を渡せる・0 なら画像は残らない', conv(`<h4>x</h4><img src="${PNG_DATA}">`, { maxImages: 0 }).lines.length === 1);
  same('リンクに包まれた画像は画像が先（リンクは捨てる）・字が一緒にあればその字はリンクのまま', '<a href="https://example.com/p"><img src="https://cdn.example.com/a.png" alt="A"></a><a href="https://example.com/q">字<img src="https://cdn.example.com/b.png" alt="B"></a>',
    '<img https alt=A>\n[字](https://example.com/q)\n<img https alt=B>');

  // ---- 読まないもの
  same('非表示・script・style・iframe・button・svg・form の部品は読まない（見えない指示文を持ち込ませない）',
    '<h4>x</h4><p>見える<span style="display: none">隠し 1</span><span hidden>隠し 2</span><span aria-hidden="true">隠し 3</span><span style="visibility:hidden">隠し 4</span><script>alert("隠し 5")</script><style>.a{}</style><iframe src="https://example.com/"></iframe><button>隠し 6</button><svg><text>隠し 7</text></svg><input value="隠し 8"><textarea>隠し 9</textarea></p><div hidden><h2>隠し 10</h2></div>',
    '#### x\n見える');
  // 往復
  const all = ['題\n\n\\---\n\n\\===\n\\-\n前\n\\---', chromeMd, '| 名前 | 値 |\n| --- | --- |\n| a | b |', '- 親\n  - 子1\n    3. 孫', '> 外\n> > 内\n>\n> 二', '\\# 見出しではない\n\n\\- 項目ではない\n\n1\\. 番号ではない', 'a\\*b \\`c\\` \\[d\\] \\\\e snake_case \\_private', '```\na\n\n  b\n```', '[\\[参照\\] 1](https://example.com/a_%28b%29)'];
  t.ok('往復: 変換結果の Markdown は、入力欄の文書にして戻しても 1 文字も変わらない', all.every(round), all.filter((x) => !round(x)).join(' / '));
}
