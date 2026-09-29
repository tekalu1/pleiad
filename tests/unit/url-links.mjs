// 文中の URL のリンク（docs/design-system.md「文中の URL」）: 範囲の判定・リンクにする場所としない場所・行き先と右クリックのメニュー
import assert from 'node:assert/strict';
import { bareUrl, wholeUrl, findUrls } from '../../web/url-detect.mjs';
import { renderMarkdown, plainTextHtml, renderToolCall } from '../../web/render.mjs';
import { sysFold } from '../../web/system-messages.mjs';
import { linkDestination, statusParts, linkMenuItems, menuTitle } from '../../web/link-menu.mjs';
import { appLinkOf } from '../../web/link-open.mjs';
import { audit } from '../lib/audit.mjs';

export const name = 'url-links';
export const title = '文中の URL をリンクにする（範囲は ASCII の字まで）/ 行き先の一行と右クリックのメニュー';

const urls = s => findUrls(s).map(x => x.url);
const hrefs = html => [...html.matchAll(/<a class="md-link[^"]*" href="([^"]*)" target="_blank"/g)].map(m => m[1]);

export default async function (t) {
  // ---- 範囲の判定（モックの 02 の表の各行）----
  const cases = [
    ['仕様は https://developer.mozilla.org/ja/docs/Web/API/URL にあります。', ['https://developer.mozilla.org/ja/docs/Web/API/URL']],
    ['Node の説明（https://nodejs.org/api/url.html）も同じ内容です。', ['https://nodejs.org/api/url.html']],
    ['「https://example.com/docs」を開くと', ['https://example.com/docs']],
    ['See https://en.wikipedia.org/wiki/Fish_(disambiguation), and https://example.com/a.',
      ['https://en.wikipedia.org/wiki/Fish_(disambiguation)', 'https://example.com/a']],
    ['URLはhttps://example.com/pathです。', ['https://example.com/path']],
    ['資料：https://ja.wikipedia.org/wiki/日本語、ほか', ['https://ja.wikipedia.org/wiki/']],
    ['（https://example.com/a?x=1&y=2）', ['https://example.com/a?x=1&y=2']],
    ['認証付き https://user:secret@example.com/private は作らない', []],
    ['xhttps://example.com や localhost:5173 だけ・www.example.com は作らない', []],
    ['手元は http://localhost:5173/ で動いてる。', ['http://localhost:5173/']],
    ['末尾の記号 https://example.com/a?b=c!!?. と https://example.com/x;,:', ['https://example.com/a?b=c', 'https://example.com/x']],
    ['対にならない閉じ (see https://example.com/a) と [https://example.com/b]', ['https://example.com/a', 'https://example.com/b']],
    ['対になる括弧は残す https://example.com/f(x)(y) と https://example.com/[a]', ['https://example.com/f(x)(y)', 'https://example.com/[a]']],
    ['ftp://example.com と file:///C:/a.html と javascript:alert(1)', []],
    ['http:// だけ・https://. だけ', []],
  ];
  for (const [text, want] of cases) assert.deepEqual(urls(text), want, text);
  t.ok('範囲: ASCII の字まで・末尾の句読点と対にならない ) ] は外す・日本語の字の手前で終わる', true);

  assert.deepEqual(urls('https://user:pass@example.com/'), []);
  assert.equal(bareUrl('https://user@example.com/x'), null);
  assert.equal(bareUrl('https://' + 'a'.repeat(1990) + '.com/'), null, '2,000 字を超えるものはリンクにしない');
  assert.equal(bareUrl('https://example.com/' + 'a'.repeat(100)), 'https://example.com/' + 'a'.repeat(100));
  assert.equal(wholeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(wholeUrl('https://example.com/a.'), null, '末尾の . が付くと全体ではない');
  assert.equal(wholeUrl('curl https://example.com/a'), null);
  assert.equal(wholeUrl('https://example.com/日本語'), null);
  t.ok('userinfo 付き・長すぎるものは作らない。インラインコードは中身全体が URL のときだけ', true);

  // ---- AI の本文 ----
  const md = renderMarkdown([
    '1. 仕様は https://developer.mozilla.org/ja/docs/Web/API/URL にあります。',
    '2. URLはhttps://example.com/pathです',
    '3. 認証付き https://user:secret@example.com/private は開かない',
    '4. `https://api.example.com/v1?id=42` と `curl https://x.example.com` と `web/render.mjs`',
    '5. [名前](https://a.example.com) と [https://b.example.com](https://b.example.com) と <https://c.example.com> と **https://d.example.com/x**',
    '',
    '```',
    'curl https://code.example.com/',
    '```',
  ].join('\n'));
  assert.deepEqual(hrefs(md), [
    'https://developer.mozilla.org/ja/docs/Web/API/URL', 'https://example.com/path',
    'https://api.example.com/v1?id=42',
    'https://a.example.com', 'https://b.example.com', 'https://c.example.com', 'https://d.example.com/x',
  ]);
  assert.ok(md.includes('認証付き https://user:secret@example.com/private は開かない'), 'userinfo 付きは字のまま');
  assert.ok(md.includes('<code>curl https://x.example.com</code>'), 'コードの一部が URL なだけならリンクにしない');
  assert.ok(!hrefs(md).some(h => h.includes('code.example.com')), 'コードブロックの中はリンクにしない');
  assert.ok(md.includes('<a class="md-link code-link" href="https://api.example.com/v1?id=42"'), '中身全体が URL のインラインコードはリンク');
  assert.ok(!/<a [^>]*>[^<]*<a /.test(md), 'リンクの入れ子を作らない');
  assert.equal(audit(md).length, 0, audit(md).join(' / '));
  t.ok('AI の本文: 裸の URL とインラインコード全体の URL はリンク、コードブロックと userinfo 付きはしない', true);

  const poison = renderMarkdown('https://example.com/?a="onmouseover="x と https://example.com/<script>');
  assert.equal(audit(poison).length, 0, audit(poison).join(' / '));
  t.ok('URL に引用符・タグが混じっても属性の外へ出ない', true);

  // ---- 自分の発言 / 知らせ / 依頼 ----
  const mine = plainTextHtml('https://github.com/tekalu1/pleiad/issues/24 の件。参考：https://ja.wikipedia.org/wiki/URL、それと [この記事](https://example.com/md) と `https://q.example.com/x` も');
  assert.deepEqual(hrefs(mine), ['https://github.com/tekalu1/pleiad/issues/24', 'https://ja.wikipedia.org/wiki/URL', 'https://example.com/md', 'https://q.example.com/x']);
  assert.ok(mine.includes('[この記事](<a ') && mine.includes('`<a '), '字は書いたとおり（括弧と ` は残る）');
  const unescaped = mine.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  assert.equal(unescaped, 'https://github.com/tekalu1/pleiad/issues/24 の件。参考：https://ja.wikipedia.org/wiki/URL、それと [この記事](https://example.com/md) と `https://q.example.com/x` も');
  const plain = plainTextHtml('PR: https://github.com/x/pull/31 D:\\dev\\a.md', { paths: false });
  assert.deepEqual(hrefs(plain), ['https://github.com/x/pull/31']);
  assert.ok(!plain.includes('file-link'), 'paths:false ではパスは字のまま');
  const notice = sysFold('Pleiad タスクの結果を受け取って再開しました', 'PR を作りました: https://github.com/tekalu1/pleiad/pull/31\n実行先: codex').outerHTML;
  assert.deepEqual(hrefs(notice), ['https://github.com/tekalu1/pleiad/pull/31']);
  t.ok('自分の発言・完了通知・委譲の依頼: 字は書いたとおり、URL だけリンク（通知と依頼のパスは字のまま）', true);

  // ---- WebFetch の見出し ----
  const fetched = renderToolCall('WebFetch', { url: 'https://github.com/tekalu1/pleiad/issues/24', prompt: 'issue の要点' }).outerHTML;
  assert.match(fetched, /<a class="md-link tc-main tc-link" href="https:\/\/github\.com\/tekalu1\/pleiad\/issues\/24" target="_blank"/);
  assert.ok(!/<a [^>]*href="javascript:/.test(renderToolCall('WebFetch', { url: 'javascript:alert(1)' }).outerHTML));
  assert.ok(!/<a [^>]*tc-link/.test(renderToolCall('Bash', { command: 'curl https://example.com' }).outerHTML), '取得以外の見出しは動詞だけ');
  t.ok('取得のカードの見出しに URL のリンクを戻す（http(s) 以外はリンクにしない）', true);

  // ---- 押したときの行き先・行き先の一行・メニュー ----
  const host = { inAppAvailable: true, hostScreen: true, pcBrowser: false, pageOrigin: 'http://127.0.0.1:7420' };
  const remote = { inAppAvailable: false, hostScreen: false, pcBrowser: true, pageOrigin: 'http://192.168.0.5:7420' };
  const inapp = { linkOpen: 'inapp' }, external = { linkOpen: 'external' };
  const href = 'https://example.com/a', local = 'http://localhost:5173/';
  assert.equal(linkDestination({ href, prefs: inapp, ...host }), 'inapp');
  assert.equal(linkDestination({ href, prefs: external, ...host }), 'external');
  assert.equal(linkDestination({ href, prefs: inapp, ctrl: true, ...host }), 'external', 'Ctrl/⌘ を押している間は既定のブラウザー');
  assert.equal(linkDestination({ href: local, prefs: inapp, ...host }), 'inapp', 'ホストの画面の localhost は設定どおり');
  assert.equal(linkDestination({ href, prefs: inapp, ...remote }), 'choose');
  assert.equal(linkDestination({ href: local, prefs: inapp, ctrl: true, ...remote }), 'pc');
  assert.equal(linkDestination({ href, prefs: inapp, inAppAvailable: false, hostScreen: true }), 'external', '内蔵ブラウザーの無い画面');
  const shown = statusParts({ href: 'https://example.com/a', dest: 'inapp', inAppSetting: true, hostScreen: true });
  assert.deepEqual(shown.slice(0, 2), ['内蔵ブラウザーで開く', 'example.com/a']);
  assert.match(shown[2], /Ctrl/);
  assert.equal(statusParts({ href, dest: 'external', ctrl: true, inAppSetting: true, hostScreen: true })[2], '', 'Ctrl 中は案内を出さない');
  assert.equal(statusParts({ href, dest: 'choose' })[0], '開き先を選ぶ');
  assert.equal(statusParts({ href, dest: 'pc' })[0], 'PC のブラウザーで見る');
  t.ok('行き先: ホストは設定と Ctrl/⌘、リモートは開き先を選ぶ / PC のブラウザーで見る、内蔵ブラウザーの無い画面は既定', true);

  const act = Object.fromEntries(['openInApp', 'openExternal', 'openHere', 'openOnPc', 'copy'].map(k => [k, () => k]));
  const labels = items => items.map(i => (i.sep ? '―' : i.label));
  const hostMenu = linkMenuItems({ href, prefs: inapp, ...host, act });
  assert.deepEqual(labels(hostMenu), ['内蔵ブラウザーで開く', '既定のブラウザーで開く', '―', 'リンクをコピー']);
  assert.equal(hostMenu[0].hint, 'クリック');
  assert.equal(hostMenu[1].hint, 'Ctrl+クリック');
  const extMenu = linkMenuItems({ href, prefs: external, ...host, act });
  assert.equal(extMenu[0].hint, undefined);
  assert.equal(extMenu[1].hint, 'クリック');
  assert.equal(hostMenu[0].onClick(), 'openInApp');
  const remoteMenu = linkMenuItems({ href, prefs: inapp, ...remote, act });
  assert.deepEqual(labels(remoteMenu), ['この端末で開く', 'PC のブラウザーで見る', '―', 'リンクをコピー']);
  const localMenu = linkMenuItems({ href: local, prefs: inapp, ...remote, act });
  assert.deepEqual(labels(localMenu), ['PC のブラウザーで見る', '―', 'リンクをコピー'], 'localhost は「この端末で開く」を出さない');
  assert.equal(localMenu[0].note, 'この URL は PC からだけ開けます。');
  assert.equal(linkMenuItems({ href, prefs: inapp, inAppAvailable: false, hostScreen: true, act }), null, '内蔵ブラウザーの無い画面はブラウザーの標準メニュー');
  assert.equal(linkMenuItems({ href, prefs: inapp, ...remote, pcBrowser: false, act }), null, 'PC のブラウザーを見られないリモートも標準メニュー');
  assert.equal(menuTitle('https://example.com/a'), 'https://example.com/a');
  assert.equal(menuTitle('https://example.com/' + 'x'.repeat(80)).length, 44);
  assert.ok(menuTitle('https://example.com/' + 'x'.repeat(80)).startsWith('…'));
  t.ok('右クリックのメニュー: ホストは内蔵 / 既定 / コピー（今の設定に「クリック」）、リモートはシートと同じ語、標準に任せる画面は null', true);

  // ---- 押した先を決める要素 ----
  const anchor = (h, target = '_blank', cls = true) => ({ closest: sel => (sel.includes('a.md-link') && cls && target === '_blank' ? { getAttribute: () => h } : null) });
  assert.ok(appLinkOf(anchor('https://example.com/')));
  assert.equal(appLinkOf(anchor('javascript:alert(1)')), null);
  assert.equal(appLinkOf(anchor('/local-file?path=a')), null, 'ファイルリンクは対象外');
  assert.equal(appLinkOf(anchor('https://example.com/', '_self')), null);
  assert.equal(appLinkOf(null), null);
  t.ok('設定へ回すのは target=_blank の http(s) の a.md-link だけ（会話の列の外も）', true);
}
