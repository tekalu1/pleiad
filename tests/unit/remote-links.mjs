// リモート（スマホ・デスクトップ版のリモートの窓・LAN のブラウザー）でリンクを押したときの行き先（docs/remote.md §8.5）。
//   - web/host-only-links.mjs: localhost・ループバックは、サーバーのある PC の画面でなければ開かずに知らせる
//   - desktop/remote-windows.cjs の linkTarget: 写し（アプリの中の窓）・Web（既定のブラウザー）・localhost（知らせだけ）・それ以外
//   - Android の殻（HostActivity・LinkPolicy）: 新しい窓を殻が受けて振り分ける取り決めを文字列で。規則そのものは
//     mobile/android の LinkPolicyTest（Gradle）が同じ表で確かめる
//   - web/file-preview.mjs: リモートの窓では「ブラウザーで開く」が写しの URL を直接渡す
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isHostOnlyUrl, watchHostOnlyLinks } from '../../web/host-only-links.mjs';

export const name = 'remote-links';
export const title = 'リモートのリンク: localhost は知らせるだけ・写しはアプリの中・Web は端末のブラウザー';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { linkTarget, isLoopbackHost } = require('../../desktop/remote-windows.cjs');

const LOOPBACK = ['http://localhost:3000/', 'http://LOCALHOST/', 'http://app.localhost:5173/', 'http://127.0.0.1:5173/', 'http://127.1.2.3/',
  'http://0.0.0.0:8080/', 'http://[::1]:3000/', 'https://localhost./', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/'];
const WEB = ['https://example.com/a?b=c', 'http://example.org/', 'http://192.168.1.10:3000/', 'https://localhost.example.com/'];

export default async function (t) {
  // ---- 画面（web/host-only-links.mjs）
  const page = 'http://127.0.0.1:51234';
  t.ok('ループバックの http(s) はホストの PC でだけ開ける（10 進の IPv4・IPv4 射影の IPv6 も）',
    LOOPBACK.every(u => isHostOnlyUrl(u, page)), LOOPBACK.filter(u => !isHostOnlyUrl(u, page)).join(' '));
  t.ok('Web のページ・画面自身のオリジン・相対・ほかのスキームは止めない',
    [...WEB, `${page}/visualization-snapshot?id=x`, '/local-file?path=x', '#top', 'mailto:a@example.com', 'not a url']
      .every(u => !isHostOnlyUrl(u, page)));

  const listeners = {};
  const root = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: type => { delete listeners[type]; } };
  let onHost = false;
  const told = [];
  watchHostOnlyLinks({ root, onHostScreen: () => onHost, notify: text => told.push(text), origin: () => page });
  const click = (href, extra = {}) => {
    const anchor = { getAttribute: () => href };
    const ev = { type: 'click', button: 0, defaultPrevented: false, target: { closest: sel => (sel === 'a[href]' ? anchor : null) },
      preventDefault() { this.defaultPrevented = true; }, ...extra };
    (listeners[ev.type])(ev);
    return ev.defaultPrevented;
  };
  t.ok('ほかの端末の画面では localhost のリンクを止めて知らせる（文言は辞書）',
    click('http://localhost:3000/') && told.length === 1 && /localhost/.test(told[0]) && !told[0].includes('timeline.link'));
  t.ok('Web のリンクは止めない（行き先はブラウザー・殻が決める）', !click('https://example.com/') && told.length === 1);
  t.ok('中クリック（auxclick）も同じ。右クリックは見ない',
    click('http://127.0.0.1:5173/', { type: 'auxclick', button: 1 }) && !click('http://127.0.0.1:5173/', { type: 'auxclick', button: 2 }));
  onHost = true;
  t.ok('サーバーのある PC の画面では止めない', !click('http://localhost:3000/'));

  // ---- デスクトップ版のリモートの窓（desktop/remote-windows.cjs）
  const origin = 'http://127.0.0.1:51234';
  t.ok('写しはこの窓のプロキシの /visualization-snapshot だけ（ほかのページ・ほかのポートは写しにしない）',
    linkTarget(`${origin}/visualization-snapshot?sessionId=s&id=i`, origin) === 'snapshot'
      && linkTarget(`${origin}/`, origin) === 'blocked' && linkTarget(`${origin}/local-file?path=x`, origin) === 'blocked'
      && linkTarget(`${origin}/visualization-snapshot/x`, origin) === 'blocked'
      && linkTarget('http://127.0.0.1:51235/visualization-snapshot?id=i', origin) === 'host-only');
  t.ok('Web は http も https も既定のブラウザー、localhost は host-only',
    WEB.every(u => linkTarget(u, origin) === 'external') && LOOPBACK.every(u => linkTarget(u, origin) === 'host-only'));
  t.ok('資格情報つき・ほかのスキーム・壊れた URL は開かない',
    ['https://user:pass@example.com/', 'file:///C:/x.html', 'javascript:alert(1)', 'intent://x#Intent;end', 'about:blank', '::']
      .every(u => linkTarget(u, origin) === 'blocked'));
  t.ok('isLoopbackHost は [] 付きの IPv6 と末尾の点を受ける', isLoopbackHost('[::1]') && isLoopbackHost('localhost.') && !isLoopbackHost('128.0.0.1'));
  const rw = read('desktop/remote-windows.cjs');
  t.ok('リモートの窓は新しい窓を開かせず行き先で振り分け、写しは preload の無い同じ保存領域の窓で開く',
    /setWindowOpenHandler\(\(\{ url \}\) => \{\s*const kind = linkTarget\(url, entry\.origin\);/.test(rw)
      && /webPreferences: \{ session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true \}/.test(rw)
      && !/function openSnapshot[\s\S]*?preload[\s\S]*?function openHostsWindow/.test(rw));
  t.ok('クリップボードの許可はリモートの窓そのものだけ（同じオリジンの写しの窓には出さない）',
    /contents === windows\.get\(hostId\)\?\.win\.webContents/.test(rw));

  // ---- Android の殻（HostActivity）
  const host = read('mobile/android/app/src/main/kotlin/com/procway/pleiad/HostActivity.kt');
  t.ok('新しい窓は殻が受ける（setSupportMultipleWindows(true)）。押したときだけ（isUserGesture）',
    /setSupportMultipleWindows\(true\)/.test(host) && /override fun onCreateWindow\([^)]*\): Boolean \{\s*if \(!isUserGesture\) return false/.test(host));
  const popup = host.slice(host.indexOf('private fun newPopup'), host.indexOf('private fun place'));
  t.ok('受けた窓にはホストの画面の口を入れない（plyRemote・ダウンロード・さらに窓を開く）',
    popup.length > 0 && !/injectRemote|addDocumentStartJavaScript|setDownloadListener/.test(popup) && /setSupportMultipleWindows\(false\)/.test(popup)
      && /allowFileAccess = false/.test(popup));
  t.ok('振り分けは LinkPolicy（写しはシート、Web は ACTION_VIEW、localhost は知らせ）',
    /LinkPolicy\.classify\(/.test(host) && /LinkTarget\.SNAPSHOT/.test(host) && /Intent\.ACTION_VIEW/.test(host) && /R\.string\.link_host_only/.test(host));
  const policy = read('mobile/android/remote-core/src/main/kotlin/com/procway/pleiad/remote/LinkPolicy.kt');
  t.ok('LinkPolicy の写しのパスは画面・サーバーと同じ', policy.includes('const val SNAPSHOT_PATH = "/visualization-snapshot"'));
  const ui = { ja: JSON.parse(read('web/locales/ja/ui.json')), en: JSON.parse(read('web/locales/en/ui.json')) };
  const res = lang => read(`mobile/android/app/src/main/res/${lang === 'ja' ? 'values-ja' : 'values'}/strings.xml`);
  const str = (xml, key) => xml.match(new RegExp(`<string name="${key}">([^<]*)</string>`))?.[1]?.replace(/\\'/g, "'");
  t.ok('殻の知らせは画面の辞書と同じ文言（ja・en）',
    ['ja', 'en'].every(l => str(res(l), 'link_host_only') === ui[l].timeline.link.hostOnly) && str(res('ja'), 'sheet_close') && str(res('en'), 'sheet_close'));

  // ---- 「ブラウザーで開く」（web/file-preview.mjs）
  const fp = read('web/file-preview.mjs');
  t.ok('リモートの窓では写しの URL を直接渡す（空の窓では殻が行き先を知れない）',
    /if \(window\.plyRemote\) \{\s*window\.open\(new URL\(`\/visualization-snapshot\?\$\{query\}`, window\.location\.href\)\.href, '_blank', 'noopener'\);/.test(fp));
}
