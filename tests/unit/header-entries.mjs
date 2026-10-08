// 会話の頭の行のアイコンボタン（docs/design-system.md「会話の頭の行のアイコン」、web/header-entries.mjs）。
//   - プラグイン: 件数は title と名前にだけ。「変更あり」は右上の点（変更がある間だけ DOM に置く）。管理していない会話は件数を入れない
//   - 内蔵ブラウザーの近道の判定（Ctrl+Shift+B・macOS は ⌘⇧B・IME の変換中は奪わない）
//   - 内蔵ブラウザーのボタンは、ブラウザーの部品が無い画面では出さない
//   - 頭の行の並び（目次・プラグイン・ブラウザーが同じ 30px のアイコンボタン）と、プラグインの字・件数の要素が無いこと
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { contextTotal, isManagedContext, contextEntryText, paintContextEntry, isBrowserShortcut, browserShortcutLabel, browserEntryMark, browserViewToOpen, setupBrowserEntry } from '../../web/header-entries.mjs';

export const name = 'header-entries';
export const title = '会話の頭の行: プラグインの件数と変更ありの出し方・内蔵ブラウザーの近道と出す画面';

export default async function (t) {
  // ---- プラグインの名前と点
  const report = { status: 'ply', owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' }, entries: [
    { kind: 'instruction', status: 'supplied' }, { kind: 'instruction', status: 'loaded' },
    ...Array.from({ length: 9 }, () => ({ kind: 'skill', status: 'available' })),
    { kind: 'skill', status: 'excluded' }, { kind: 'mcp', status: 'connected' }, { kind: 'mcp', status: 'failed' },
  ] };
  assert.equal(contextTotal(report), 12, '実際に渡ったものだけ数える');
  assert.equal(isManagedContext(report), true);
  const summary = '指示 2 · Skills 9 · MCP 1';
  assert.deepEqual(contextEntryText({ report, summary, changed: true }),
    { title: 'この会話のプラグイン：指示 2 · Skills 9 · MCP 1 · 変更あり', label: 'プラグイン 12 変更あり', changed: true });
  assert.deepEqual(contextEntryText({ report, summary, changed: false }),
    { title: 'この会話のプラグイン：指示 2 · Skills 9 · MCP 1', label: 'プラグイン 12', changed: false });
  const native = { status: 'native', owners: {}, entries: [] };
  assert.deepEqual(contextEntryText({ report: native, summary: 'エージェント任せ', changed: false }),
    { title: 'この会話のプラグイン：エージェント任せ', label: 'プラグイン', changed: false }, 'エージェント任せの会話は件数を入れない');
  assert.deepEqual(contextEntryText({ report: null, changed: false }), { title: 'この会話のプラグイン', label: 'プラグイン', changed: false }, '報告がまだ無い');

  const button = new N('button');
  paintContextEntry(button, { visible: true, report, summary, changed: true });
  assert.equal(button.hidden, false);
  assert.equal(button.attrs.title, 'この会話のプラグイン：指示 2 · Skills 9 · MCP 1 · 変更あり');
  assert.equal(button.getAttribute('aria-label'), 'プラグイン 12 変更あり');
  assert.equal(button.querySelectorAll('.entry-dot').length, 1, '変更ありは右上の点');
  assert.equal(button.querySelector('.entry-dot').getAttribute('aria-hidden'), 'true', '点は読み上げない（名前に字で入っている）');
  assert.equal(button.shown.trim(), '', '件数・「プラグイン」・「変更あり」の字は画面に出さない');
  paintContextEntry(button, { visible: true, report, summary, changed: true });
  assert.equal(button.querySelectorAll('.entry-dot').length, 1, '描き直しても点は 1 つ');
  paintContextEntry(button, { visible: true, report, summary, changed: false });
  assert.equal(button.querySelectorAll('.entry-dot').length, 0, '変更が無くなったら点を外す');
  assert.equal(button.classList.contains('ply'), false, '管理しているときの青い字は使わない');
  paintContextEntry(button, { visible: false, report, summary, changed: true });
  assert.equal(button.hidden, true, '会話を選んでいないときは出さない');
  t.ok('プラグイン: 件数は title と名前にだけ、変更ありは右上の点（変更がある間だけ）。管理していない会話は件数を入れない', true);

  // ---- 近道
  const key = (over) => ({ key: 'B', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false, keyCode: 66, defaultPrevented: false, ...over });
  assert.equal(isBrowserShortcut(key(), false), true, 'Ctrl+Shift+B');
  assert.equal(isBrowserShortcut(key({ key: 'b' }), false), true);
  assert.equal(isBrowserShortcut(key({ shiftKey: false }), false), false, 'Ctrl+B はサイドバー');
  assert.equal(isBrowserShortcut(key({ altKey: true }), false), false);
  assert.equal(isBrowserShortcut(key({ metaKey: true }), false), false);
  assert.equal(isBrowserShortcut(key({ isComposing: true }), false), false, 'IME の変換中は奪わない');
  assert.equal(isBrowserShortcut(key({ keyCode: 229 }), false), false, '変換の確定の keyCode 229 も奪わない');
  assert.equal(isBrowserShortcut(key({ defaultPrevented: true }), false), false);
  assert.equal(isBrowserShortcut(key({ ctrlKey: false, metaKey: true }), true), true, 'macOS は ⌘⇧B');
  assert.equal(isBrowserShortcut(key(), true), false, 'macOS の Ctrl+Shift+B は奪わない');
  assert.equal(browserShortcutLabel(false), 'Ctrl+Shift+B');
  assert.equal(browserShortcutLabel(true), '⌘⇧B');
  t.ok('近道: Ctrl+Shift+B（macOS は ⌘⇧B）。Ctrl+B・Alt 付き・IME の変換中は取らない', true);

  assert.equal(browserEntryMark({ requested:true, paused:true, working:true }), 'requested');
  assert.equal(browserEntryMark({ paused:true, working:true }), 'paused');
  assert.equal(browserEntryMark({ working:true }), 'working');
  assert.equal(browserEntryMark({}), '');
  assert.equal(browserViewToOpen({ viewer:true, chrome:true, urgent:true, last:'viewer' }), 'chrome');
  assert.equal(browserViewToOpen({ viewer:true, chrome:true, last:'viewer' }), 'viewer');
  assert.equal(browserViewToOpen({ viewer:true, chrome:true, last:'chrome' }), 'chrome');
  assert.equal(browserViewToOpen({ viewer:false, chrome:true }), 'chrome');
  t.ok('統合した入口: 依頼待ち・人の操作・エージェントの操作の順。開くときだけ状態と最後に見た方を使う', true);

  // ---- 出す画面（ブラウザーの部品が無い画面では出さない）
  const hiddenButton = new N('button'); hiddenButton.hidden = false;
  assert.equal(setupBrowserEntry({ button: hiddenButton, browser: null, preview: {} }), null);
  assert.equal(hiddenButton.hidden, true, 'ブラウザーで開いた Pleiad・リモートの窓・スマホでは出さない');
  t.ok('内蔵ブラウザーのボタン: 内蔵ブラウザーの無い画面では出さない', true);

  // ---- 頭の行の並び
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<header class="top">');
  const header = html.slice(start, html.indexOf('</header>', start));
  const order = ['id="tocEntry"', 'id="contextEntry"', 'id="browserEntry"'].map((id) => header.indexOf(id));
  assert(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], '目次・プラグイン・ブラウザーの順');
  for (const id of ['tocEntry', 'contextEntry', 'browserEntry']) assert.match(header, new RegExp(`class="btn btn-icon" id="${id}"`), `${id} は 30px のアイコンボタン`);
  assert.match(header, /id="browserEntry" hidden/, 'ブラウザーは使える画面でだけ出す（既定は隠す）');
  assert.doesNotMatch(header, /id="chromeEntry"/, '頭の行のブラウザー入口は地球の一つ');
  assert.match(header, /id="browserEntry"[^>]*aria-controls="filePreview" aria-expanded="false"/, '開閉の ARIA を揃える');
  assert.doesNotMatch(header, /contextEntryCount|contextEntryChanged|data-i18n="session\.context\.label"/, 'プラグインの字・件数・変更ありの字は置かない');
  assert.match(header, /id="contextEntry"[^>]*><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v4M15 3v4"\/>/, 'プラグインは縦向きの差し込みプラグ');
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.entry-dot\{position:absolute;top:4px;right:4px;width:7px;height:7px;border-radius:50%;color:var\(--ink-strong\);background:currentColor;box-shadow:0 0 0 2px var\(--surface-paper\)/);
  assert.doesNotMatch(css, /\.ctxlink\.ply/, 'Pleiad が管理しているときの青い字はやめた');
  t.ok('頭の行: 目次・プラグイン・ブラウザーを同じアイコンボタンで並べ、変更ありの点は 7px の強い字', true);
}
