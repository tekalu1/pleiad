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
  const exposed = {}, sent = [], invoked = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: { send: (ch, ...a) => sent.push([ch, ...a]), invoke: (ch, ...a) => { invoked.push([ch, ...a]); return Promise.resolve(null); }, on: () => {}, removeListener: () => {} },
  };
  const code = fs.readFileSync(path.join(ROOT, 'desktop', file), 'utf8');
  vm.runInNewContext(code, { require: m => { if (m === 'electron') return electron; throw new Error(m); }, process: { argv: [], platform: 'win32' }, decodeURIComponent, JSON },
    { filename: file });
  return { exposed, sent, invoked };
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
  });
  t.ok('画面: openInBrowserPanel は正規化して開き、枠の位置を送り、状態から戻る・進む・印・タブを描き、隠すと外す', true);

  // ---- preload
  const local = runPreload('preload.cjs'), remote = runPreload('remote-preload.cjs');
  assert.equal(typeof local.exposed.plyDesktop.browser?.command, 'function');
  local.exposed.plyDesktop.browser.command('open', { url: 'https://example.com/' });
  local.exposed.plyDesktop.browser.layout({ visible: false });
  assert.deepEqual(local.invoked.at(-1), ['ply:browser', 'open', { url: 'https://example.com/' }]);
  assert.deepEqual(local.sent.at(-1), ['ply:browser-layout', { visible: false }]);
  assert(!('browser' in (remote.exposed.plyDesktop ?? {})), 'リモートの窓に browser を出さない');
  t.ok('preload: ローカルの窓にだけ browser の口（ply:browser・ply:browser-layout）を出す', true);

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
  // 会話ごとのタブ（次の段階の足場）
  await call('context', { sessionId: 'sess-b' });
  const addedBeforeBlank = fe.log.added.length, shownBeforeBlank = fe.log.added.at(-1);
  await call('newTab');
  assert.equal(panel.tabsFor('sess-a').length, 2); assert.equal(panel.tabsFor('sess-b').length, 1);
  state = await call('state');
  assert.equal(state.tabs.at(-1).url, '', '空のタブ');
  assert.equal(fe.log.added.length, addedBeforeBlank, '空のタブは View を載せない（画面の案内を見せる）');
  assert.equal(fe.log.removed.at(-1), shownBeforeBlank, '前のタブの View は外す');
  // 別の窓に出す
  await call('select', { id: state.tabs[1].id });
  const detached = await call('detach');
  assert.equal(detached.ok, true);
  const win = fe.log.windows.at(-1);
  assert.equal(win.children.length, 1); assert.deepEqual(win.children[0].bounds, { x: 0, y: 0, width: 900, height: 700 });
  state = await call('state');
  assert.equal(state.tabs.length, 2, '別の窓に出したタブは一覧から外れる');
  // タブを閉じる
  state = await call('close', { id: state.tabs[0].id });
  assert.equal(state.tabs.length, 1);
  // 画面を読み直したら View を外す（ページ内の移動では外さない）
  state = await call('select', { id: state.tabs[0].id });
  const attachedNow = fe.log.added.at(-1);
  assert.equal(attachedNow.webContents.url, 'https://example.org/');
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
