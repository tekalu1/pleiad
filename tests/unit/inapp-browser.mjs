// 内蔵ブラウザー（docs/inapp-browser.md、ADR 0041）の、Electron を起こさずに確かめられる部分。
//   - 右パネルの表（browserSlots）と、ほかのモードへ切り替えたときにタブの列・道具が残らないこと
//   - アドレス欄の正規化（スキームが無ければ https、localhost:ポートは http、開けないものは null）と見せ方
//   - リンクの開き先の設定の値と、使えない画面（ブラウザーで開いた Pleiad・リモートの窓）で出ないこと
//   - preload: ローカルの窓にだけ browser の口を出す
//   - main（desktop/browser-panel.cjs）を偽の electron で: タブ・位置・重なりの freeze・権限・新しい窓・既定のブラウザー・送り元の確認
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { N } from '../lib/dom-stub.mjs';
import { applySlots, fileSlots, visualizationSlots, customSlots, browserSlots } from '../../web/side-panel.mjs';
import { normalizeAddress, addressParts, tabLabel, isLocalHost, linkOpenPref, linkOpenTarget } from '../../web/browser-address.mjs';
import { browserPanelAvailable, openInBrowserPanel, createBrowserPanel } from '../../web/browser-panel.mjs';
import { setupBrowserSettings } from '../../web/browser-settings.mjs';
import { setupBrowserEntry } from '../../web/header-entries.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bp = require('../../desktop/browser-panel.cjs');

export const name = 'inapp-browser';
export const title = '内蔵ブラウザー: 右パネルの表・アドレス欄・リンクの開き先・使える画面・main のタブと位置';

function makeParts() {
  const node = (tag = 'div') => document.createElement(tag);
  const ids = ['tree', 'more', 'wide', 'close', 'browser', 'visualBrowser', 'path', 'reload', 'origin', 'reveal', 'save', 'visualSave', 'use',
    'back', 'forward', 'reloadPage', 'address', 'openExternal', 'browserMore'];
  const buttons = Object.fromEntries(ids.map(id => { const b = node('button'); b.textContent = id; return [id, b]; }));
  return { panel: node('aside'), name: node('span'), kind: node('span'), path: node('div'), actions: node(), toolbar: node(), switcher: node(),
    tools: node(), location: node(), note: node(), treePane: node(), footer: node('footer'), footActions: node(), status: node('span'),
    content: node(), tabs: node(), buttons };
}
const shown = (parts, container) => parts[container].children.map(c => c.textContent);

/** 画面のグローバル（window・観察・フレーム）を一時的に差し替えて fn を走らせる */
async function withWindow(win, fn) {
  const keys = ['window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener', 'getComputedStyle'];
  const saved = Object.fromEntries(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const savedBody = document.body, savedQuery = document.querySelectorAll;
  const observer = class { observe() {} disconnect() {} };
  Object.assign(globalThis, { window: win, ResizeObserver: observer, MutationObserver: observer, requestAnimationFrame: f => { f(); return 1; },
    cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ borderTopLeftRadius: '12px', visibility: 'visible' }) });
  document.body = new N('body'); document.querySelectorAll = () => [];
  N.prototype.getBoundingClientRect = function () { return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  try { return await fn(); }
  finally {
    for (const k of keys) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; }
    document.body = savedBody; document.querySelectorAll = savedQuery;
    delete N.prototype.getBoundingClientRect;
  }
}

/** 偽のブリッジ（preload の plyDesktop.browser）。command と layout を覚え、状態は手で流す */
function fakeBridge() {
  const calls = [], layouts = [];
  let listener = null, state = { tabs: [], current: null }, n = 0;
  const bridge = {
    calls, layouts,
    command: async (action, args) => {
      calls.push([action, args]);
      if (action === 'newTab' || (action === 'open' && (args?.newTab || !state.tabs.length))) {
        const id = `t${++n}`;
        state = { tabs: [...state.tabs, { id, url: args?.url ?? '', title: '', loading: false, canGoBack: false, canGoForward: false }], current: id };
      } else if (action === 'open') {
        state = { ...state, tabs: state.tabs.map(tab => tab.id === state.current ? { ...tab, url: args.url } : tab) };
      } else if (action === 'close') {
        const tabs = state.tabs.filter(tab => tab.id !== args.id);
        state = { tabs, current: tabs.at(-1)?.id ?? null };
      } else if (action === 'freeze') return { image: 'data:image/png;base64,AAAA' };
      else if (!['state', 'context'].includes(action)) return { ok: true };
      return state;
    },
    layout: message => layouts.push(message),
    onState: fn => { listener = fn; return () => {}; },
    push: next => { state = next; listener?.(next); },
  };
  return bridge;
}

// ---- 偽の electron（desktop/browser-panel.cjs 用）
function fakeElectron() {
  const log = { external: [], opened: [], openError: '', added: [], removed: [], windows: [], devtools: [] };
  const handlers = { handle: {}, on: {} };
  let permissionRequest, permissionCheck;
  const session = {
    fromPartition: partition => ({
      partition,
      setPermissionRequestHandler: fn => { permissionRequest = fn; },
      setPermissionCheckHandler: fn => { permissionCheck = fn; },
      setUserAgent: ua => { log.ua = ua; },
      on: () => {},
      clearStorageData: async opts => { log.cleared = opts; },
      cookies: { get: async () => [{ domain: '.example.com', path: '/', name: 'sid', secure: true }], remove: async (url, name) => { log.cookieRemoved = [url, name]; } },
    }),
  };
  class Contents {
    constructor() { this.url = 'about:blank'; this.title = ''; this.events = {}; this.history = []; this.index = -1; this.closed = false;
      this.navigationHistory = { canGoBack: () => this.index > 0, canGoForward: () => this.index < this.history.length - 1,
        goBack: () => { this.index--; this.url = this.history[this.index]; }, goForward: () => { this.index++; this.url = this.history[this.index]; } }; }
    on(name, fn) { (this.events[name] ??= []).push(fn); }
    emit(name, ...args) { for (const fn of this.events[name] ?? []) fn(...args); }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    loadURL(url) { this.history = [...this.history.slice(0, this.index + 1), url]; this.index = this.history.length - 1; this.url = url; this.emit('did-navigate'); return Promise.resolve(); }
    getURL() { return this.url; } getTitle() { return this.title; } isLoading() { return false; } isDestroyed() { return this.closed; }
    reload() { log.reloaded = this.url; } stop() {} openDevTools(opts) { log.devtools.push([this.url, opts]); }
    close() { this.closed = true; this.emit('destroyed'); }
    capturePage() { return Promise.resolve({ toDataURL: () => `data:image/png;base64,${this.url}` }); }
  }
  class WebContentsView {
    constructor(opts) { this.opts = opts; this.webContents = new Contents(); this.bounds = null; }
    setBounds(b) { this.bounds = b; } getBounds() { return this.bounds ?? { x: 0, y: 0, width: 800, height: 600 }; }
    setBackgroundColor() {} setBorderRadius(r) { this.radius = r; }
  }
  const mainContents = { send: (ch, state) => { log.sent = [ch, state]; }, getZoomFactor: () => 1.25, on: (name, fn) => { handlers.main = fn; } };
  const window = {
    webContents: mainContents, isDestroyed: () => false,
    contentView: { addChildView: v => log.added.push(v), removeChildView: v => log.removed.push(v) },
  };
  class BrowserWindow {
    constructor(opts) { this.opts = opts; this.children = []; this.events = {}; log.windows.push(this);
      this.contentView = { addChildView: v => this.children.push(v) }; }
    removeMenu() {} getContentSize() { return [900, 700]; } on(name, fn) { this.events[name] = fn; } isDestroyed() { return false; } setTitle(text) { this.title = text; }
  }
  const ipcMain = { handle: (ch, fn) => { handlers.handle[ch] = fn; }, on: (ch, fn) => { handlers.on[ch] = fn; } };
  const shell = { openExternal: async url => { log.external.push(url); }, openPath: async file => { log.opened.push(file); return log.openError; } };
  const app = { userAgentFallback: 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 agent-host/0.1.0-beta.49 Safari/537.36', getPath: () => 'C:/Users/x/Downloads' };
  const trust = { check: (event, kinds) => { if (event?.kind !== 'local' || !kinds.includes('local')) throw new Error('Invalid sender'); } };
  return { log, handlers, deps: { window, WebContentsView, BrowserWindow, session, shell, ipcMain, app, trust, icon: 'icon.png' },
    permission: () => ({ permissionRequest, permissionCheck }) };
}

function runPreload(file) {
  const exposed = {}, sent = [], invoked = [], listeners = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: { send: (ch, ...a) => sent.push([ch, ...a]), invoke: (ch, ...a) => { invoked.push([ch, ...a]); return Promise.resolve(null); }, on: (ch, fn) => { (listeners[ch] ??= []).push(fn); }, removeListener: () => {} },
  };
  const code = fs.readFileSync(path.join(ROOT, 'desktop', file), 'utf8');
  vm.runInNewContext(code, { require: m => { if (m === 'electron') return electron; throw new Error(m); }, process: { argv: [], platform: 'win32' }, decodeURIComponent, JSON },
    { filename: file });
  return { exposed, sent, invoked, listeners };
}

export default async function (t) {
  // ---- 右パネルの表
  const slots = browserSlots();
  assert.equal(slots.mode, 'browser'); assert.equal(slots.label, 'ブラウザー'); assert.equal(slots.kind, '');
  assert.deepEqual(slots.head, ['wide', 'close']);
  assert.deepEqual(slots.toolbar, ['back', 'forward', 'reloadPage', 'address', 'openExternal', 'browserMore'], '既定のブラウザーで開くはアドレス欄の右に常に');
  assert.equal(slots.tabs, true); assert.equal(slots.aside, false); assert.equal(slots.footer, null); assert.equal(slots.views, false);
  for (const other of [fileSlots({ file: { kind: 'html', text: '<p>' }, osActions: true }), visualizationSlots({ origin: 'a.html', html: '<p>' }), customSlots({ label: 'x' })]) {
    assert(!other.tabs, `${other.mode} はタブの列を出さない`);
    assert(!other.toolbar.some(id => ['back', 'forward', 'reloadPage', 'address', 'openExternal', 'browserMore'].includes(id)));
  }
  const parts = makeParts();
  applySlots(parts, { ...slots, title: 'ブラウザー', subtitle: '', note: '', status: '' });
  assert.equal(parts.tabs.hidden, false); assert.equal(parts.treePane.hidden, true); assert.equal(parts.footer.hidden, true);
  assert.deepEqual(shown(parts, 'actions'), ['wide', 'close']);
  assert.deepEqual(shown(parts, 'tools'), ['back', 'forward', 'reloadPage', 'address', 'openExternal', 'browserMore']);
  assert.equal(parts.panel.dataset.mode, 'browser'); assert.equal(parts.kind.hidden, true);
  applySlots(parts, { ...fileSlots({ file: { kind: 'html', text: '<p>', downloadable: true }, osActions: true }), title: 'a.html' });
  assert.equal(parts.tabs.hidden, true, 'ファイルへ移るとタブの列を隠す');
  assert.deepEqual(shown(parts, 'tools'), ['browser', 'path', 'reload'], 'ブラウザーの道具が残らない');
  applySlots(parts, { ...slots });
  applySlots(parts, { ...customSlots({ label: 'コンテキスト' }), title: 'c' });
  assert.equal(parts.tabs.hidden, true); assert.equal(parts.toolbar.hidden, true); assert.deepEqual(shown(parts, 'tools'), []);
  applySlots(parts, { ...slots });
  applySlots(parts, { ...visualizationSlots({ origin: null, html: '<p>' }) });
  assert.equal(parts.tabs.hidden, true); assert.deepEqual(shown(parts, 'tools'), ['visualBrowser']);
  const noTabs = makeParts(); delete noTabs.tabs;
  applySlots(noTabs, { ...slots });   // タブの列を持たない枠（ブラウザーの無い画面）でも落ちない
  t.ok('右パネル: browserSlots の部品と、ファイル・コンテキスト・可視化へ移ったときにタブと道具が残らない', true);

  // ---- アドレス欄
  const cases = [
    ['example.com', 'https://example.com/'], ['http://example.com', 'http://example.com/'], ['https://github.com/tekalu1/pleiad', 'https://github.com/tekalu1/pleiad'],
    ['localhost:5173', 'http://localhost:5173/'], ['localhost:5173/projects?x=1', 'http://localhost:5173/projects?x=1'], ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:3000', 'http://[::1]:3000/'], ['localhost', 'http://localhost/'], ['app.localhost:3000', 'http://app.localhost:3000/'],
    ['example.com:8443/a', 'https://example.com:8443/a'], ['  https://example.com  ', 'https://example.com/'],
    ['file:///D:/dev/demo/index.html', 'file:///D:/dev/demo/index.html'],
    ['', null], ['hello', null], ['two words', null], ['javascript:alert(1)', null], ['data:text/html,x', null], ['chrome://settings', null],
    ['https://user:pass@example.com', null], ['user@example.com', null], ['mailto:a@example.com', null], ['C:\\dev\\a.html', null],
  ];
  for (const [input, want] of cases) assert.equal(normalizeAddress(input), want, `normalizeAddress(${JSON.stringify(input)})`);
  assert(isLocalHost('127.3.4.5') && isLocalHost('LOCALHOST') && isLocalHost('[::1]') && !isLocalHost('localhost.example.com'));
  assert.deepEqual(addressParts('https://github.com/tekalu1/pleiad'), { kind: 'secure', scheme: 'https://', host: 'github.com', rest: '/tekalu1/pleiad' });
  assert.deepEqual(addressParts('http://localhost:5173/projects'), { kind: 'local', scheme: 'http://', host: 'localhost:5173', rest: '/projects' });
  assert.deepEqual(addressParts('http://example.com/'), { kind: 'insecure', scheme: 'http://', host: 'example.com', rest: '' });
  assert.deepEqual(addressParts('file:///D:/dev/demo/index.html'), { kind: 'file', scheme: '', host: '', rest: 'D:/dev/demo/index.html' });
  assert.equal(addressParts('').kind, 'blank');
  assert.equal(tabLabel({ url: 'https://example.com/a', title: 'Example' }), 'Example');
  assert.equal(tabLabel({ url: 'https://example.com/a', title: '' }), 'example.com');
  assert.equal(tabLabel({ url: '', title: '' }), '');
  t.ok('アドレス欄: スキームが無ければ https・localhost:ポートは http・開けない入力は null。見せ方は鍵・PC・ホスト名', true);

  // ---- リンクの開き先
  assert.equal(linkOpenPref({}), 'inapp', '既定は内蔵ブラウザー');
  assert.equal(linkOpenPref({ linkOpen: 'external' }), 'external');
  assert.equal(linkOpenPref({ linkOpen: 'bogus' }), 'inapp');
  assert.equal(linkOpenTarget({ available: true, prefs: {} }), 'inapp');
  assert.equal(linkOpenTarget({ available: true, prefs: { linkOpen: 'external' } }), 'external');
  assert.equal(linkOpenTarget({ available: false, prefs: { linkOpen: 'inapp' } }), 'external', '使えない画面では設定によらず既定のブラウザー');
  t.ok('リンクの開き先: 既定は内蔵ブラウザー、使えない画面では既定のブラウザー', true);

  // ---- 使える画面
  await withWindow({}, async () => {
    assert.equal(browserPanelAvailable(), false, 'ブラウザーで開いた Pleiad（plyDesktop が無い）');
    assert.equal(openInBrowserPanel('https://example.com'), false);
  });
  await withWindow({ plyDesktop: { platform: 'win32' }, plyRemote: { hostId: 'x' } }, async () => {
    assert.equal(browserPanelAvailable(), false, 'リモートの窓（preload が browser を出さない）');
  });
  await withWindow({ plyDesktop: { browser: fakeBridge() }, plyRemote: { hostId: 'x' } }, async () => {
    assert.equal(browserPanelAvailable(), false, 'plyRemote があれば browser があっても使わない');
  });
  // 設定 › ブラウザー: 使えない画面では脇の項目を出さず、中身も作らない
  const settingNodes = { browserTab: new N('button'), browserPanel: new N('section') };
  const savedGet = document.getElementById;
  document.getElementById = id => settingNodes[id] ?? null;
  try {
    const hidden = setupBrowserSettings({ available: false, cmd: async () => {}, getPrefs: () => ({}) });
    assert.equal(settingNodes.browserTab.hidden, false); assert.equal(settingNodes.browserPanel.querySelectorAll('input').length, 1); hidden.paint();
    let prefs = {}; const sent = [];
    const settings = setupBrowserSettings({ available: true, cmd: async (c, a) => { sent.push([c, a]); }, getPrefs: () => prefs });
    assert.equal(settingNodes.browserTab.hidden, false);
    const seg = settingNodes.browserPanel.querySelector('.browser-link-open');
    const [inapp, external] = seg.children;
    assert.equal(inapp.getAttribute('aria-pressed'), 'true'); assert.equal(external.getAttribute('aria-pressed'), 'false');
    external.onclick(); inapp.onclick();
    assert.deepEqual(sent, [['setPref', { key: 'linkOpen', value: 'external' }]], '今の値を押し直しても送らない');
    prefs = { linkOpen: 'external' }; settings.paint();
    assert.equal(external.getAttribute('aria-pressed'), 'true');
  } finally { document.getElementById = savedGet; }
  t.ok('ブラウザーで開いた画面にも外部読み込みの設定を出す', true);

  // ---- 画面の部品（偽のブリッジ）
  await withWindow({ plyDesktop: { browser: null } }, async () => {
    const bridge = fakeBridge();
    window.plyDesktop.browser = bridge;
    assert.equal(browserPanelAvailable(), true);
    let opened = 0, emptied = 0;
    const panel = createBrowserPanel({ bridge, showMenu: () => {}, getSessionId: () => 's1' });
    panel.connect({ openPanel: () => { opened++; panel.show(); }, onEmpty: () => { emptied++; } });
    panel.body.rect = { left: 700, top: 120, right: 1180, bottom: 820, width: 480, height: 700 };
    panel.body.isConnected = true; panel.body.parentElement = new N('div');
    assert.equal(openInBrowserPanel('localhost:5173'), true);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(opened, 1);
    assert.deepEqual(bridge.calls.find(c => c[0] === 'open'), ['open', { url: 'http://localhost:5173/', newTab: false }]);
    assert.deepEqual(bridge.calls.find(c => c[0] === 'context'), ['context', { sessionId: 's1' }], 'タブを開いた会話を main へ知らせる');
    const visible = bridge.layouts.at(-1);
    assert.deepEqual(visible, { visible: true, rect: { x: 700, y: 120, width: 480, height: 700 }, radius: 12 });
    assert.equal(openInBrowserPanel('not a url'), false, '開けない URL は何もしない');
    bridge.push({ tabs: [{ id: 't1', url: 'http://localhost:5173/', title: 'Workspace', loading: false, canGoBack: true, canGoForward: false, external: true }], current: 't1' });
    assert.equal(panel.buttons.back.disabled, false); assert.equal(panel.buttons.forward.disabled, true);
    assert.equal(panel.buttons.openExternal.disabled, false);
    assert.equal(panel.buttons.address.dataset.kind, 'local');
    assert.equal(panel.tabsRow.querySelectorAll('.browser-tab').length, 1);
    assert(panel.tabsRow.shown.includes('Workspace'));
    // 既定のブラウザーで開くを押せるかは main の external に従う（file: の HTML は画面が明示して開いたものだけ true になる）
    const tabWith = (url, external) => bridge.push({ tabs: [{ id: 't1', url, title: '', loading: false, canGoBack: false, canGoForward: false, external }], current: 't1' });
    tabWith('file:///D:/dev/demo/index.html', true);
    assert.equal(panel.buttons.openExternal.disabled, false, '画面が開いた file: の HTML は押せる');
    tabWith('file:///D:/dev/demo/other.html', false);
    assert.equal(panel.buttons.openExternal.disabled, true, 'ページの中で移った file: は押せない');
    tabWith('https://example.com/', undefined);
    assert.equal(panel.buttons.openExternal.disabled, true, 'main が押せると言わなければ押せない');
    tabWith('', false);
    assert.equal(panel.buttons.openExternal.disabled, true, '空のタブは押せない');
    tabWith('http://localhost:5173/', true);
    panel.hide();
    assert.deepEqual(bridge.layouts.at(-1), { visible: false, rect: null }, '隠すと View を外す');
    // 最後のタブを閉じたらパネルを閉じる
    panel.show();
    bridge.push({ tabs: [], current: null });
    assert.equal(emptied, 1);
    // タブの無い会話へ移っただけなら閉じない（パネルは開いたまま、空の表示）
    bridge.push({ tabs: [{ id: 't2', url: 'https://example.com/', title: '', loading: false, canGoBack: false, canGoForward: false }], current: 't2', sessionId: 's1' });
    bridge.push({ tabs: [], current: null, sessionId: 's2' });
    assert.equal(emptied, 1, '会話を移って 0 枚になってもパネルを閉じない');
    bridge.push({ tabs: [{ id: 't3', url: 'https://example.com/', title: '', loading: false, canGoBack: false, canGoForward: false }], current: 't3', sessionId: 's2' });
    bridge.push({ tabs: [], current: null, sessionId: 's2' });
    assert.equal(emptied, 2, '同じ会話で最後のタブを閉じたら閉じる');
    // タブの無いプロフィールへ切り替えただけなら閉じない（ADR 0078）
    bridge.push({ tabs: [{ id: 't4', url: 'https://example.com/', title: '', loading: false, canGoBack: false, canGoForward: false }], current: 't4', sessionId: 's2', profile: 'main' });
    bridge.push({ tabs: [], current: null, sessionId: 's2', profile: 'pbbbbbbbb' });
    assert.equal(emptied, 2, 'タブの無いプロフィールへ切り替えてもパネルを閉じない');
  });
  t.ok('画面: openInBrowserPanel は正規化して開き、枠の位置を送り、状態から戻る・進む・印・タブを描き、隠すと外す', true);

  // ---- 画面: タブの列の左端のプロフィール（ADR 0078）
  await withWindow({ plyDesktop: { browser: null } }, async () => {
    const bridge = fakeBridge();
    window.plyDesktop.browser = bridge;
    const menus = [], changed = [], opened = [];
    const profiles = [{ id: 'main', name: 'メイン' }, { id: 'pbbbbbbbb', name: '仕事' }];
    const panel = createBrowserPanel({ bridge, getSessionId: () => 's1', getAgentName: () => 'Claude', showMenu: (x, y, items, title, opts) => menus.push({ items, title, opts }),
      getProfiles: () => profiles, onProfileChanged: (sessionId, profile) => changed.push([sessionId, profile]), openProfiles: options => opened.push(options) });
    const toast = () => document.body.children.find(n => n.className === 'file-toast')?.textContent ?? '';
    // 知らせ（web/file-actions.mjs の notify）は画面下の .file-toast を探して使い回す
    const savedQuery = document.querySelector, savedText = document.createTextNode;
    document.createTextNode = text => { const n = new N('span'); n.textContent = text; return n; };
    document.querySelector = sel => sel === '.file-toast' ? document.body.children.find(n => n.className === 'file-toast') ?? null : null;
    bridge.push({ tabs: [], current: null, sessionId: 's1', profile: 'pbbbbbbbb' });
    const pick = panel.tabsRow.children[0];
    assert.equal(pick.className, 'browser-profile-pick', 'タブの列の左端');
    assert.equal(pick.children[0].textContent, '仕', 'モノグラム'); assert.equal(pick.children[1].textContent, '仕事');
    assert.equal(pick.getAttribute('aria-label'), 'プロフィール: 仕事');
    pick.onclick();
    const menu = menus.at(-1);
    assert.deepEqual(menu.items.map(i => i.head ?? i.label ?? (i.sep ? '—' : '')), ['Pleiad', 'メイン', '仕事', '—', '新しいプロフィール…', 'プロフィールを管理…']);
    assert.equal(menu.items.find(i => i.label === '仕事').checked, true); assert.equal(menu.title, undefined);
    assert.equal(pick.getAttribute('aria-expanded'), 'true'); menu.opts.onClose(); assert.equal(pick.getAttribute('aria-expanded'), 'false');
    // 選ぶと main に頼み、会話に残すのは呼び出し元。知らせを 1 回出す
    bridge.command = async (action, args) => { bridge.calls.push([action, args]); return action === 'profile' ? { tabs: [], current: null, sessionId: 's1', profile: args.profile } : {}; };
    menu.items.find(i => i.label === 'メイン').onClick();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(bridge.calls.at(-1), ['profile', { profile: 'main' }]);
    assert.deepEqual(changed, [['s1', 'main']]);
    assert.equal(toast(), 'この会話は「メイン」で開きます。エージェントもこのプロフィールを使います。');
    assert.equal(pick.children[1].textContent, 'メイン');
    menus.at(-1).items.at(-2).onClick(); menus.at(-1).items.at(-1).onClick();
    assert.deepEqual(opened, [{ add: true }, { add: false }], '新しいプロフィール…・プロフィールを管理… は設定 › ブラウザーへ');
    // エージェントが操作中は、メニューの頭に理由を出し、ほかのプロフィールは押せない
    bridge.push({ tabs: [], current: null, sessionId: 's1', profile: 'main', agent: { sessionId: 's1', tabId: 't1' } });
    pick.onclick();
    const locked = menus.at(-1);
    assert.deepEqual(locked.title, { text: 'エージェントが操作中は切り替えられません。止めてから選びます。', wrap: true });
    assert.equal(locked.items.find(i => i.label === '仕事').disabled, true); assert.equal(locked.items.find(i => i.label === 'メイン').disabled, false);
    // エージェントが切り替えた（main の notice）: 今の会話のものだけ 1 回知らせる
    bridge.push({ tabs: [], current: null, sessionId: 's1', profile: 'pbbbbbbbb', notice: { seq: 1, sessionId: 's1', profile: 'pbbbbbbbb', agent: 'Claude' } });
    assert.equal(toast(), 'Claude が「仕事」に切り替えました。');
    document.body.children.find(n => n.className === 'file-toast').textContent = '';
    bridge.push({ tabs: [], current: null, sessionId: 's1', profile: 'pbbbbbbbb', notice: { seq: 1, sessionId: 's1', profile: 'pbbbbbbbb', agent: 'Claude' } });
    assert.equal(toast(), '', '同じ知らせは出し直さない');
    bridge.push({ tabs: [], current: null, sessionId: 's1', profile: 'pbbbbbbbb', notice: { seq: 2, sessionId: 's9', profile: 'main', agent: 'Codex' } });
    assert.equal(toast(), '', '別の会話の切り替えは出さない');
    document.querySelector = savedQuery; document.createTextNode = savedText;
  });
  t.ok('画面: プロフィールはタブの列の左端（モノグラム・名前）・メニューは Pleiad の見出しの下に選択と管理・選ぶと main へ頼み会話に残して知らせる・エージェントが操作中は止める・エージェントの切り替えは 1 回だけ知らせる', true);

  // ---- 頭の行の内蔵ブラウザーのボタン（web/header-entries.mjs）と近道
  await withWindow({ plyDesktop: { browser: null } }, async () => {
    const bridge = fakeBridge();
    let fromPage = null;
    bridge.onShortcut = fn => { fromPage = fn; return () => {}; };
    window.plyDesktop.browser = bridge;
    const listeners = [], focused = [];
    const savedAdd = document.addEventListener, savedFocus = N.prototype.focus, savedText = document.createTextNode;
    document.addEventListener = (type, fn) => { if (type === 'keydown') listeners.push(fn); };
    document.createTextNode = text => { const n = new N('span'); n.textContent = text; return n; };
    N.prototype.focus = function () { focused.push(this); };
    N.prototype.select = function () {};
    let entry = null;
    const panel = createBrowserPanel({ bridge, showMenu: () => {}, getSessionId: () => 's1', onChange: () => entry?.paint() });
    panel.body.rect = { left: 700, top: 120, right: 1180, bottom: 820, width: 480, height: 700 };
    panel.body.isConnected = true; panel.body.parentElement = new N('div');
    // 右パネル（web/file-preview.mjs）の代わり。openBrowser・browserOpen・close の約束だけ持つ
    let open = false, opener = null;
    const preview = {
      browserOpen: () => open,
      openBrowser(element) { if (element) opener = element; if (!open) { open = true; panel.show(); entry?.paint(); } },
      close(restore = true) { open = false; panel.hide(); entry?.paint(); if (restore) opener?.focus(); },
    };
    panel.connect({ openPanel: () => preview.openBrowser(), onEmpty: () => preview.close() });
    const button = new N('button'); button.hidden = true;
    const mark = () => { const s = new N('span'); s.className = 'run'; return s; };
    try {
      entry = setupBrowserEntry({ button, browser: panel, preview, bridge, getSessionId: () => 's1', getAgentName: () => 'Claude', mac: false, mark });
      assert.equal(button.hidden, false, 'デスクトップ版のホストの画面では出す');
      assert.equal(button.attrs.title, '内蔵ブラウザー（Ctrl+Shift+B）');
      assert.equal(button.getAttribute('aria-label'), '内蔵ブラウザー');
      assert.equal(button.getAttribute('aria-keyshortcuts'), 'Control+Shift+B');
      assert.equal(button.getAttribute('aria-pressed'), 'false');
      const newTabs = () => bridge.calls.filter(c => c[0] === 'newTab').length;
      const click = async () => { button.dispatchEvent({ type: 'click' }); await new Promise(r => setTimeout(r, 0)); };

      await click();
      assert.equal(open, true, '押すと右パネルがブラウザーになる');
      assert.equal(newTabs(), 1, 'タブが無ければ空の新しいタブを作る');
      assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.equal(button.classList.contains('on'), true, '表示中は青い字');
      assert.equal(opener, button, '閉じたときのフォーカスの戻り先はボタン');
      await click();
      assert.equal(open, false, 'もう一度押すと閉じる');
      assert.equal(focused.at(-1), button, 'フォーカスはボタンへ戻る');
      assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal(button.classList.contains('on'), false);
      await click();
      assert.equal(open, true); assert.equal(newTabs(), 1, '前のタブがあればそのまま（新しいタブを作らない）');
      assert(!bridge.calls.some(c => c[0] === 'reload' || c[0] === 'open'), '開き直しで再読み込みしない');
      preview.close();   // Esc・閉じるボタンの経路（右パネルが閉じる）
      assert.equal(button.getAttribute('aria-pressed'), 'false', '右パネルの側で閉じても押されていない状態に戻る');
      assert.equal(focused.at(-1), button);

      // エージェントが操作中
      const tab = { id: 't1', url: 'https://example.com/', title: '', loading: false, canGoBack: false, canGoForward: false };
      bridge.push({ tabs: [tab], current: 't1', agent: { sessionId: 's1', tabId: 't1' } });
      assert.equal(button.getAttribute('aria-label'), '内蔵ブラウザー · Claude が操作中');
      assert.equal(button.querySelectorAll('.entry-run').length, 1, '操作中は右上に走っている弧');
      bridge.push({ tabs: [tab], current: 't1', agent: { sessionId: 's1', tabId: 't1' } });
      assert.equal(button.querySelectorAll('.entry-run').length, 1, '描き直しても弧は 1 つ');
      bridge.push({ tabs: [tab], current: 't1', agent: { sessionId: 'other', tabId: 't1' } });
      assert.equal(button.querySelectorAll('.entry-run').length, 0, 'ほかの会話のエージェントの操作では出さない');
      assert.equal(button.getAttribute('aria-label'), '内蔵ブラウザー');
      bridge.push({ tabs: [tab], current: 't1', agent: null });
      assert.equal(button.querySelectorAll('.entry-run').length, 0, '操作が終われば外す');

      // 近道: 画面の keydown と、ページにフォーカスがあるとき（main から）
      const wasOpen = open;
      const press = over => { const ev = { key: 'B', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, isComposing: false, keyCode: 66, defaultPrevented: false, prevented: false, ...over };
        ev.preventDefault = () => { ev.prevented = true; }; for (const fn of listeners) fn(ev); return ev; };
      assert.equal(press().prevented, true);
      assert.equal(open, !wasOpen, 'Ctrl+Shift+B で開閉する');
      assert.equal(press({ isComposing: true }).prevented, false);
      assert.equal(open, !wasOpen, 'IME の変換中は効かない');
      assert.equal(press({ keyCode: 229 }).prevented, false);
      assert.equal(press({ shiftKey: false }).prevented, false, 'Ctrl+B は取らない');
      assert.equal(typeof fromPage, 'function', 'ページからの近道を受ける');
      fromPage();
      assert.equal(open, wasOpen, 'ページにフォーカスがあるときの近道でも開閉する');
    } finally {
      document.addEventListener = savedAdd; document.createTextNode = savedText;
      N.prototype.focus = savedFocus; delete N.prototype.select;
    }
  });
  t.ok('頭の行のブラウザー: 押すと開く・もう一度で閉じてボタンへ戻る・タブが無いときだけ新しいタブ・aria-pressed・操作中の弧と名前・近道（IME の変換中は効かない・ページから）', true);

  // ---- preload
  const local = runPreload('preload.cjs'), remote = runPreload('remote-preload.cjs');
  assert.equal(typeof local.exposed.plyDesktop.browser?.command, 'function');
  local.exposed.plyDesktop.browser.command('open', { url: 'https://example.com/' });
  local.exposed.plyDesktop.browser.layout({ visible: false });
  assert.deepEqual(local.invoked.at(-1), ['ply:browser', 'open', { url: 'https://example.com/' }]);
  assert.deepEqual(local.sent.at(-1), ['ply:browser-layout', { visible: false }]);
  assert(!('browser' in (remote.exposed.plyDesktop ?? {})), 'リモートの窓に browser を出さない');
  let heard = 0;
  local.exposed.plyDesktop.browser.onShortcut(() => { heard++; });
  for (const fn of local.listeners['ply:browser-shortcut'] ?? []) fn({});
  assert.equal(heard, 1, 'ページにフォーカスがあるときの近道（ply:browser-shortcut）を画面へ渡す');
  t.ok('preload: ローカルの窓にだけ browser の口（ply:browser・ply:browser-layout・近道の知らせ）を出す', true);

  // ---- main（偽の electron）
  const fe = fakeElectron();
  const panel = bp.createBrowserPanel(fe.deps);
  panel.attach();
  const local$ = { kind: 'local' };
  const call = (action, args) => fe.handlers.handle['ply:browser'](local$, action, args);
  assert.equal(panel.session.partition, 'persist:pleiad-browser');
  assert(!/Electron|agent-host/.test(fe.log.ua), 'UA から Electron と Pleiad の印を外す');
  const { permissionRequest, permissionCheck } = fe.permission();
  let granted = null; permissionRequest(null, 'media', v => { granted = v; });
  assert.equal(granted, false); assert.equal(permissionCheck(), false);
  assert.throws(() => fe.handlers.handle['ply:browser']({ kind: 'remote' }, 'state'), /Invalid sender/, 'リモートの窓からは受けない');

  await call('context', { sessionId: 'sess-a' });
  let state = await call('open', { url: 'https://example.com/' });
  assert.equal(state.tabs.length, 1); assert.equal(state.tabs[0].sessionId, 'sess-a'); assert.equal(state.tabs[0].url, 'https://example.com/');
  const [view1] = [panel.contentsOf(state.current)];
  assert(view1, 'タブの webContents を引ける（次の段階の中継の足場）');
  assert.equal(fe.log.added.length, 0, '画面が位置を送るまで窓に載せない');
  fe.handlers.on['ply:browser-layout'](local$, { visible: true, rect: { x: 100, y: 80, width: 400, height: 600 }, radius: 12 });
  assert.equal(fe.log.added.length, 1);
  assert.deepEqual(fe.log.added[0].bounds, { x: 125, y: 100, width: 500, height: 750 }, '画面の倍率を掛ける');
  assert.equal(fe.log.added[0].radius, 15);
  fe.handlers.on['ply:browser-layout']({ kind: 'remote' }, { visible: false });
  assert.equal(fe.log.removed.length, 0, 'リモートの窓からの位置は無視');
  await assert.rejects(call('open', { url: 'javascript:alert(1)' }), /invalid-url/);
  // ページにフォーカスがあるときの開閉の近道（Ctrl+Shift+B、macOS は ⌘⇧B）。この近道だけページへ渡さず、本体の画面へ知らせてフォーカスを戻す
  {
    let focusedMain = 0;
    fe.deps.window.webContents.focus = () => { focusedMain++; };
    const mod = process.platform === 'darwin' ? { meta: true, control: false } : { control: true, meta: false };
    const fire = over => {
      let prevented = false;
      view1.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'B', shift: true, alt: false, isComposing: false, isAutoRepeat: false, ...mod, ...over });
      return prevented;
    };
    fe.log.sent = null;
    assert.equal(fire(), true, '近道はページへ渡さない');
    assert.deepEqual(fe.log.sent, ['ply:browser-shortcut', undefined], '本体の画面へ知らせる');
    assert.equal(focusedMain, 1, '本体の画面へフォーカスを戻す（閉じた後はボタンへ）');
    fe.log.sent = null;
    assert.equal(fire({ type: 'keyUp' }), false, '離したときはページへ渡す');
    assert.equal(fire({ shift: false }), false, 'Ctrl+B などほかのキーはページのもの');
    assert.equal(fire({ key: 'c' }), false);
    assert.equal(fire({ isComposing: true }), false, 'IME の変換中は奪わない');
    assert.equal(fire({ alt: true }), false);
    assert.equal(fe.log.sent, null);
    assert.equal(fire({ isAutoRepeat: true }), true);
    assert.equal(fe.log.sent, null, '押しっぱなしの繰り返しでは開閉しない');
    delete fe.deps.window.webContents.focus;
  }
  assert.equal(bp.isPanelShortcut({ type: 'keyDown', key: 'b', meta: true, shift: true }, 'darwin'), true);
  assert.equal(bp.isPanelShortcut({ type: 'keyDown', key: 'b', control: true, shift: true }, 'darwin'), false, 'macOS の Ctrl+Shift+B は取らない');
  assert.equal(bp.isPanelShortcut({ type: 'keyDown', key: 'B', control: true, shift: true }, 'win32'), true);
  assert.equal(bp.isPanelShortcut({ type: 'keyDown', key: 'B', control: true, meta: true, shift: true }, 'win32'), false);
  // 戻る・進む
  await call('open', { url: 'https://example.com/b' });
  state = await call('state');
  assert.equal(state.tabs[0].canGoBack, true);
  state = await call('back');
  assert.equal(state.tabs[0].url, 'https://example.com/'); assert.equal(state.tabs[0].canGoForward, true);
  // 新しい窓は新しいタブ。javascript: などは開かない
  const firstContents = fe.log.added[0].webContents;
  assert.deepEqual(firstContents.openHandler({ url: 'https://example.org/', disposition: 'foreground-tab' }), { action: 'deny' });
  firstContents.openHandler({ url: 'javascript:alert(1)', disposition: 'foreground-tab' });
  state = await call('state');
  assert.equal(state.tabs.length, 2); assert.equal(state.tabs[1].url, 'https://example.org/'); assert.equal(state.current, state.tabs[1].id);
  assert.equal(state.tabs[1].sessionId, 'sess-a', '開いた元のタブの会話を引き継ぐ');
  assert.equal(fe.log.removed.at(-1), fe.log.added[0], '見えるのは今のタブだけ');
  // ポップアップ（disposition: 'new-window'）は action: 'allow' になり別の窓で開く
  const popupResult = firstContents.openHandler({ url: 'https://example.org/popup', disposition: 'new-window', features: 'width=400,height=300' });
  assert.equal(popupResult.action, 'allow');
  assert.deepEqual(popupResult.overrideBrowserWindowOptions.webPreferences, { session: panel.session, contextIsolation: true, sandbox: true, nodeIntegration: false }, 'ポップアップに本体の preload を付けない');
  assert.equal(popupResult.overrideBrowserWindowOptions.width, 400);
  assert.equal(popupResult.overrideBrowserWindowOptions.height, 300);
  // ログインのポップアップは空の窓を先に開けてから行き先を入れることがある
  assert.equal(firstContents.openHandler({ url: 'about:blank', disposition: 'new-window', features: 'width=400,height=300' }).action, 'allow', '空のポップアップも窓で開く');
  assert.equal(firstContents.openHandler({ url: '', disposition: 'new-window', features: '' }).action, 'allow');
  assert.equal(firstContents.openHandler({ url: 'file:///C:/a.html', disposition: 'new-window', features: '' }).action, 'deny', 'file: のポップアップは開かない');
  let prevented = false;
  const popupWin = { webContents: { on: (n, f) => { if (n === 'will-navigate') f({ preventDefault: () => { prevented = true; } }, 'file:///C:/a'); }, setWindowOpenHandler: () => {} }, setMenuBarVisibility: () => {} };
  firstContents.emit('did-create-window', popupWin, { url: 'https://example.org/popup' });
  // ページから file: や独自のスキームへは移らない
  firstContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'file:///C:/Windows/win.ini');
  assert.equal(prevented, true);
  // 重なりの間は写しを返して外す
  const frozen = await call('freeze');
  assert.equal(frozen.image, 'data:image/png;base64,https://example.org/');
  assert.equal(fe.log.removed.at(-1).webContents.url, 'https://example.org/');
  const before = fe.log.added.length;
  await call('unfreeze');
  assert.equal(fe.log.added.length, before + 1, '重なりが消えたら載せ直す');
  // 既定のブラウザー・DevTools・データを消す
  await call('external');
  assert.deepEqual(fe.log.external, ['https://example.org/']);
  await call('openExternal', { url: 'http://localhost:5173/' });
  assert.deepEqual(fe.log.external.at(-1), 'http://localhost:5173/', 'リンクの既定のブラウザーは http の localhost も渡す');
  assert.deepEqual(await call('openExternal', { url: 'file:///C:/a.html' }), { ok: false });
  await call('devtools');
  assert.deepEqual(fe.log.devtools.at(-1), ['https://example.org/', { mode: 'detach' }]);
  await call('clearSiteData');
  assert.deepEqual(fe.log.cleared, { origin: 'https://example.org' });
  assert.deepEqual(fe.log.cookieRemoved, ['https://example.com/', 'sid']);
  // 会話ごとのタブ。一覧と今のタブは、今の会話のものと、会話に属さないものだけ
  const addedBeforeBlank = fe.log.added.length, shownBeforeBlank = fe.log.added.at(-1);
  state = await call('context', { sessionId: 'sess-b' });
  assert.equal(state.tabs.length, 0, '別の会話のタブは一覧に出さない'); assert.equal(state.current, null, '見えるタブが無ければ current なし');
  assert.equal(fe.log.removed.at(-1), shownBeforeBlank, '別の会話へ移ったら、前の会話のタブの View を窓から外す');
  await call('newTab');
  assert.equal(panel.tabsFor('sess-a').length, 2); assert.equal(panel.tabsFor('sess-b').length, 1);
  state = await call('state');
  assert.equal(state.tabs.length, 1); assert.equal(state.tabs[0].url, '', '空のタブ');
  assert.equal(fe.log.added.length, addedBeforeBlank, '空のタブは View を載せない（画面の案内を見せる）');
  // 会話を戻すと、その会話で最後に選んだタブ
  state = await call('context', { sessionId: 'sess-a' });
  assert.equal(state.tabs.length, 2); assert.equal(state.current, state.tabs[1].id, '戻した会話で最後に選んだタブへ');
  assert.equal(fe.log.added.at(-1).webContents.url, 'https://example.org/', 'そのタブの View を載せ直す');
  // 別の窓に出す
  await call('select', { id: state.tabs[1].id });
  const detached = await call('detach');
  assert.equal(detached.ok, true);
  const win = fe.log.windows.at(-1);
  assert.equal(win.children.length, 1); assert.deepEqual(win.children[0].bounds, { x: 0, y: 0, width: 900, height: 700 });
  state = await call('state');
  assert.equal(state.tabs.length, 1, '別の窓に出したタブは一覧から外れる');
  // タブを閉じる
  state = await call('close', { id: state.tabs[0].id });
  assert.equal(state.tabs.length, 0); assert.equal(state.current, null);
  assert.equal(panel.tabsFor('sess-b').length, 1, '別の会話のタブは閉じない');
  // 画面を読み直したら View を外す（ページ内の移動では外さない）
  state = await call('open', { url: 'https://example.net/' });
  const attachedNow = fe.log.added.at(-1);
  assert.equal(attachedNow.webContents.url, 'https://example.net/');
  const removedBefore = fe.log.removed.length;
  fe.handlers.main(null, 'http://127.0.0.1/#x', true, true);
  assert.equal(fe.log.removed.length, removedBefore);
  fe.handlers.main(null, 'http://127.0.0.1/', false, true);
  assert.equal(fe.log.removed.at(-1), attachedNow);
  t.ok('main: 分けた保存領域・権限は断る・送り元の確認・位置と倍率・今のタブだけ載せる・新しい窓はタブ・file: へ移らない・freeze・既定のブラウザー・会話ごとのタブ・別の窓', true);

  // ---- main: 画面が開いた file: の HTML を既定のブラウザーで（shell.openPath）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-inapp-external-'));
  try {
    const html = path.join(dir, 'page.html'), other = path.join(dir, 'other.htm'), png = path.join(dir, 'a.png'), missing = path.join(dir, 'gone.html');
    for (const file of [html, other, png]) fs.writeFileSync(file, '<p>x</p>');
    const fileUrl = file => pathToFileURL(file).href;
    let clock = 0;
    const fx = fakeElectron();
    const filePanel = bp.createBrowserPanel({ ...fx.deps, now: () => clock });
    filePanel.attach();
    const run = (action, args) => fx.handlers.handle['ply:browser'](local$, action, args);
    const now$ = s => s.tabs.find(tab => tab.id === s.current);
    let s = await run('open', { url: 'https://example.com/' });
    assert.equal(now$(s).external, true, 'https は押せる');
    const contents = filePanel.contentsOf(s.current);
    s = await run('open', { url: 'http://localhost:5173/' });
    assert.equal(now$(s).external, true, 'http は押せる');
    contents.url = fileUrl(html);   // http(s) のタブがページの中で file: へ移った（allowFile なし）
    s = await run('state');
    assert.equal(now$(s).external, false, '画面が file: を開いていないタブの file: は押せない');
    assert.deepEqual(await run('external'), { ok: false });
    s = await run('open', { url: `${fileUrl(html)}#top` });
    assert.equal(now$(s).external, true, '画面が開いた file: の HTML は押せる');
    assert.deepEqual(await run('external'), { ok: true });
    // 製品は fs.promises.realpath（OS の解決。8.3 の短い名前も長い名前に戻す）なので、期待値も .native で作る
    assert.deepEqual(fx.log.opened, [fs.realpathSync.native(html)], '実体を解決したパスを openPath に渡す');
    assert.deepEqual(fx.log.external, [], 'file: は URL として openExternal に渡さない');
    contents.url = fileUrl(other);   // ページの中で別の file: へ移った
    s = await run('state');
    assert.equal(now$(s).external, false, 'ページの中で移った先の file: は押せない');
    assert.deepEqual(await run('external'), { ok: false });
    s = await run('open', { url: fileUrl(png) });
    assert.equal(now$(s).external, false, 'file: の HTML 以外は押せない');
    assert.deepEqual(await run('external'), { ok: false });
    s = await run('open', { url: fileUrl(missing) });
    assert.deepEqual(await run('external'), { ok: false }, '無いファイルは断る');
    s = await run('newTab');
    assert.equal(now$(s).external, false, '空のタブは押せない');
    await run('context', { sessionId: 'sess-x' });
    const blank = filePanel.createFor('sess-x');
    s = await run('select', { id: blank.id });
    assert.equal(now$(s).url, 'about:blank'); assert.equal(now$(s).external, false, 'about:blank は押せない');
    assert.deepEqual(await run('external'), { ok: false });
    assert.equal(fx.log.opened.length, 1);
    // openPath の失敗と連打（サーバーの openPath と同じ 5 回 / 10 秒）
    s = await run('open', { url: fileUrl(html) });
    fx.log.openError = 'No application is associated';
    assert.deepEqual(await run('external'), { ok: false }, 'openPath の失敗は断ったと返す');
    fx.log.openError = '';
    for (let i = 0; i < 3; i++) assert.deepEqual(await run('external'), { ok: true });
    assert.deepEqual(await run('external'), { ok: false, reason: 'too-many' }, '10 秒に 6 回目は断る');
    assert.equal(fx.log.opened.length, 5);
    clock += 10_001;
    assert.deepEqual(await run('external'), { ok: true }, '時間が経てばまた開ける');
    assert.equal(bp.externalFile(fileUrl(html), { allowFile: true, requested: fileUrl(html) }), html);
    assert.equal(bp.externalFile('file://server/share/a.html', { allowFile: true, requested: 'file://server/share/a.html' }), null, 'UNC は断る');
    assert.equal(bp.externalFile(fileUrl(html), { allowFile: false, requested: fileUrl(html) }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  t.ok('main: 既定のブラウザーで開くは http・https と、画面が開いた file: の HTML だけ（実体を解決して openPath・連打の制限）。ページで移った file:・HTML 以外・about:blank は断る', true);

  // ---- main: パネルの一覧と今のタブは、今の会話のタブと、会話に属さないタブだけ
  {
    const fv = fakeElectron();
    const vp = bp.createBrowserPanel(fv.deps);
    vp.attach();
    const go = (action, args) => fv.handlers.handle['ply:browser'](local$, action, args);
    const urls = st => st.tabs.map(tab => tab.url || tab.id);
    const attachedView = () => { const last = fv.log.added.at(-1); return last && fv.log.removed.lastIndexOf(last) < fv.log.added.lastIndexOf(last) ? last : null; };
    fv.handlers.on['ply:browser-layout'](local$, { visible: true, rect: { x: 0, y: 0, width: 400, height: 600 }, radius: 0 });

    const a1 = vp.createFor('conv-a', 'https://a1.example/'), a2 = vp.createFor('conv-a', 'https://a2.example/');
    const b1 = vp.createFor('conv-b', 'https://b1.example/');
    let st = await go('context', { sessionId: 'conv-a' });
    assert.deepEqual(urls(st), ['https://a1.example/', 'https://a2.example/'], '今の会話のタブだけ並べる');
    assert.equal(st.current, a2.id, 'その会話で最後に作った（選んだ）タブ');
    assert.equal(attachedView().webContents.url, 'https://a2.example/');
    assert.equal(vp.tabsFor('conv-b').length, 1, '見えない会話のタブは消えず、中継からは引ける');

    // 別の会話のタブを中継が作っても、今のタブと窓の View は動かない
    const before = fv.log.added.length;
    const b2 = vp.createFor('conv-b', 'https://b2.example/');
    st = await go('state');
    assert.deepEqual(urls(st), ['https://a1.example/', 'https://a2.example/']); assert.equal(st.current, a2.id);
    assert.equal(fv.log.added.length, before, '別の会話のタブを作っても View を載せない');
    vp.selectFor(b1.id);   // エージェントが別の会話のタブを前に出した。今の画面は動かさず、その会話で選んだタブとして覚える
    st = await go('state'); assert.equal(st.current, a2.id, '別の会話のタブは今のタブにしない（selectFor）');
    await go('select', { id: b1.id });
    st = await go('state'); assert.equal(st.current, a2.id, '別の会話のタブは選ばせない（select）');

    // 会話に属さないタブはどの会話でも見える
    const loose = vp.createFor(null, 'https://loose.example/');
    st = await go('state');
    assert.deepEqual(urls(st), ['https://a1.example/', 'https://a2.example/', 'https://loose.example/'], '会話に属さないタブは出す');
    assert.equal(st.current, loose.id);
    st = await go('context', { sessionId: 'conv-b' });
    assert.deepEqual(urls(st), ['https://b1.example/', 'https://b2.example/', 'https://loose.example/']);
    assert.equal(st.current, b1.id, '会話を移ると、その会話で最後に選んだタブ（selectFor で前に出した b1）');
    assert.equal(attachedView().webContents.url, 'https://b1.example/', '窓に載るのは今の会話のタブだけ');
    await go('select', { id: b2.id });
    st = await go('context', { sessionId: 'conv-a' });
    assert.equal(st.current, loose.id, '戻した会話で最後に選んだタブ');
    st = await go('context', { sessionId: 'conv-b' });
    assert.equal(st.current, b2.id, 'conv-b は b2 を最後に選んだ');
    await go('select', { id: b1.id });

    // 閉じたときの移り先は、見えるタブの中から
    st = await go('close', { id: b1.id });
    assert.deepEqual(urls(st), ['https://b2.example/', 'https://loose.example/']);
    assert.equal(st.current, b2.id, '見えるタブの隣へ（別の会話のタブへは移らない）');
    await go('close', { id: b2.id });
    st = await go('close', { id: loose.id });
    assert.equal(st.tabs.length, 0); assert.equal(st.current, null, '見えるタブが無ければ current なし');
    assert.equal(attachedView(), null, '見えるタブが無ければ View を窓に残さない');
    st = await go('context', { sessionId: 'conv-a' });
    assert.deepEqual(urls(st), ['https://a1.example/', 'https://a2.example/']);
    assert.equal(st.current, a1.id, '最後に選んだタブ（loose）が閉じていれば、見えるタブの先頭'); assert.equal(attachedView().webContents.url, 'https://a1.example/');
    st = await go('context', { sessionId: 'conv-none' });
    assert.equal(st.tabs.length, 0); assert.equal(st.current, null, 'タブの無い会話では current なし');
    assert.equal(attachedView(), null, '前の会話のタブの View を窓に残さない');

    // 新規会話: 仮のキーで作ったタブが本物の会話 ID へ移ると、その会話を見ている画面に出る
    const fresh = vp.createFor('new:key', 'https://fresh.example/');
    st = await go('context', { sessionId: null });
    assert.equal(st.tabs.length, 0, '仮のキーのタブは会話を決めていない画面には出ない');
    vp.rebindSession('new:key', 'real-id');
    st = await go('context', { sessionId: 'real-id' });
    assert.deepEqual(urls(st), ['https://fresh.example/']); assert.equal(st.current, fresh.id);
    // エージェントの操作中の表示は会話ごと。別の会話の操作では今のタブを動かさない
    const other = vp.createFor('conv-a', 'https://agent.example/');
    vp.setAgent('conv-a', other.id);
    st = await go('state');
    assert.equal(st.current, fresh.id); assert.equal(st.agent, null, '別の会話の操作中は出さない');
    st = await go('context', { sessionId: 'conv-a' });
    assert.equal(st.current, other.id, '操作中のタブを最後に選んだものとして覚える'); assert.deepEqual(st.agent, { sessionId: 'conv-a', tabId: other.id });
    // 人が開く・新しいタブは今の会話のものになる
    st = await go('open', { url: 'https://human.example/', newTab: true });
    assert.equal(vp.tabsFor('conv-a').length, 4); assert.equal(st.tabs.at(-1).sessionId, 'conv-a');
  }
  t.ok('main: パネルの一覧と今のタブは今の会話と会話なしのタブだけ・別の会話のタブを作っても動かない・会話を移ると最後に選んだタブ・閉じた移り先・View を残さない・仮のキーからの付け替え', true);

  // ---- 補助
  assert.equal(bp.openable('https://a.example/'), 'https://a.example/'); assert.equal(bp.openable('chrome://gpu'), null);
  assert.equal(bp.openable('https://u:p@a.example/'), null);
  assert.equal(bp.externalUrl('http://localhost:5173/'), 'http://localhost:5173/'); assert.equal(bp.externalUrl('file:///C:/a.html'), null);
  assert.equal(bp.cleanRect({ x: 1, y: 2, width: 0, height: 5 }), null); assert.equal(bp.cleanRect({ x: 'a' }), null);
  assert.equal(bp.plainUserAgent('A Chrome/1 Electron/44.3.0 agent-host/0.1.0 Safari/1'), 'A Chrome/1 Safari/1');
  const taken = new Set([path.join('D:/dl', 'a.zip'), path.join('D:/dl', 'a (2).zip')]);
  assert.equal(bp.uniquePath('D:/dl', 'a.zip', p => taken.has(p)), path.join('D:/dl', 'a (3).zip'));
  assert.equal(bp.uniquePath('D:/dl', '../../evil.exe', () => false), path.join('D:/dl', 'evil.exe'));
  t.ok('main の補助: 開ける URL・既定のブラウザーへ渡す URL・枠・UA・ダウンロードの名前', true);
}
