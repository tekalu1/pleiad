// 内蔵ブラウザーのプロフィール（docs/inapp-browser.md「プロフィール」、ADR 0078）。
//   - 共有の読み方（web/browser-profiles.mjs）: 一覧の正規化・新しい会話の規則・設定の検査・古い「このサイトは常に」の読み方
//   - main（desktop/browser-panel.cjs を偽の electron で）: 保存領域の名前・session ごとに 1 回の設定・ポップアップと clearSiteData はタブの session・
//     会話ごとの絞り込みと切り替え・エージェントが操作中は人の切り替えを止める・エージェントの切り替えの知らせ・削除と次の起動での片付け・大きさ
//   - 中継（desktop/browser-relay.cjs）: tabsFor / createFor は会話の今のプロフィール。切り替えでタブの集合を替える
//   - サーバー: 会話の今のプロフィールの解決と保存・ply_browser の口・確認の鍵の移行・サーバー越しの通し（fake + parentPort の身代わり）
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { profileList, profileForNew, validProfilePref, siteProfile, defaultProfile, folderKey, monogram, profileName, newProfileId, MAX_PROFILES } from '../../web/browser-profiles.mjs';
import { validBrowserPref } from '../../web/browser-confirm-policy.mjs';
import { createBrowserProfiles, createBrowserBridge, findProfile, browserTools } from '../../core/browser-profiles.mjs';
import { agentDefinition } from '../../core/backends/antigravity-context.mjs';
import { createBrowserSiteApprovals } from '../../core/browser-confirm.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const bp = require('../../desktop/browser-panel.cjs');
const { createBrowserRelay } = require('../../desktop/browser-relay.cjs');

export const name = 'browser-profiles';
export const title = '内蔵ブラウザーのプロフィール: 保存領域・会話ごとの今のプロフィール・中継の絞り込み・AI の切り替え・確認の鍵';

const WORK = 'pbbbbbbbb', HOME = 'pcccccccc';

// ---- 偽の electron（プロフィールごとの session を数える）
function fakeElectron() {
  const log = { partitions: [], ua: [], cleared: [], storage: [], cookieRemoved: [], added: [], removed: [], sent: [] };
  const handlers = { handle: {}, on: {} };
  const sessions = new Map();
  const session = {
    fromPartition: partition => {
      log.partitions.push(partition);
      if (!sessions.has(partition)) sessions.set(partition, {
        partition,
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        setUserAgent: ua => log.ua.push([partition, ua]),
        on() {},
        clearStorageData: async opts => { log.storage.push([partition, opts ?? null]); },
        clearCache: async () => { log.cleared.push(partition); },
        cookies: { get: async () => [{ domain: '.example.com', path: '/', name: 'sid', secure: true }], remove: async (url, name) => { log.cookieRemoved.push([partition, url, name]); } },
      });
      return sessions.get(partition);
    },
  };
  class Contents {
    constructor(ses) { this.session = ses; this.url = 'about:blank'; this.events = {}; this.closed = false;
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; }
    on(name, fn) { (this.events[name] ??= []).push(fn); }
    emit(name, ...args) { for (const fn of this.events[name] ?? []) fn(...args); }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    getURL() { return this.url; } getTitle() { return ''; } isLoading() { return false; } isDestroyed() { return this.closed; }
    reload() { log.reloaded = (log.reloaded ?? 0) + 1; } stop() {}
    close() { this.closed = true; this.emit('destroyed'); }
    capturePage() { return Promise.resolve({ toDataURL: () => '' }); }
  }
  class WebContentsView {
    constructor(opts) { this.opts = opts; this.webContents = new Contents(opts.webPreferences.session); }
    setBounds(b) { this.bounds = b; } getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; } setBackgroundColor() {} setBorderRadius() {}
  }
  const window = { webContents: { send: (ch, state) => log.sent.push([ch, state]), getZoomFactor: () => 1, on() {} }, isDestroyed: () => false,
    contentView: { addChildView: v => log.added.push(v), removeChildView: v => log.removed.push(v) } };
  const ipcMain = { handle: (ch, fn) => { handlers.handle[ch] = fn; }, on: (ch, fn) => { handlers.on[ch] = fn; } };
  const app = { userAgentFallback: 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 Safari/537.36', getPath: () => os.tmpdir() };
  const trust = { check: event => { if (event?.kind !== 'local') throw new Error('Invalid sender'); } };
  return { log, handlers, deps: { window, WebContentsView, BrowserWindow: class {}, session, shell: {}, ipcMain, app, trust } };
}
const local = { kind: 'local' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 中継のテスト用の panel。tabsFor / createFor は会話の今のプロフィールで絞る・作る（desktop/browser-panel.cjs と同じ約束） */
function profilePanel() {
  let serial = 0;
  const tabs = [], listeners = new Set(), profileListeners = new Set(), profileOf = new Map();
  const profileFor = id => profileOf.get(id) ?? 'main';
  function createFor(sessionId, initial = '') {
    const id = `t${++serial}`;
    let url = initial || 'about:blank';
    const debuggerApi = new EventEmitter();
    let attached = false;
    debuggerApi.isAttached = () => attached;
    debuggerApi.attach = () => { attached = true; };
    debuggerApi.sendCommand = async (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${id}` } } };
      if (method === 'Page.navigate') { url = params.url; return { frameId: `frame-${id}` }; }
      return {};
    };
    const tab = { id, sessionId, profile: profileFor(sessionId), webContents: { debugger: debuggerApi, isDestroyed: () => false, getTitle: () => id, getURL: () => url } };
    tabs.push(tab);
    for (const listener of listeners) listener('created', tab);
    return tab;
  }
  return {
    tabs, createFor, profileFor,
    tabsFor: sessionId => tabs.filter(x => x.sessionId === sessionId && x.profile === profileFor(sessionId)),
    setProfileFor(sessionId, profile) { if (profileFor(sessionId) === profile) { profileOf.set(sessionId, profile); return; } profileOf.set(sessionId, profile); for (const l of profileListeners) l(sessionId, profile); },
    selectFor() {}, closeFor() {}, rebindSession() {},
    onTabsChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onProfileChanged(listener) { profileListeners.add(listener); return () => profileListeners.delete(listener); },
  };
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [];
    ws.on('message', raw => events.push(JSON.parse(raw.toString())));
    ws.once('open', () => resolve({ ws, events }));
    ws.once('error', reject);
  });
}
function ask({ ws, events }, method, params = {}, sessionId) {
  const id = Math.floor(Math.random() * 1e9);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return (async () => {
    for (let i = 0; i < 200; i++) { const msg = events.find(e => e.id === id); if (msg) return msg; await wait(10); }
    throw new Error(`CDP timeout: ${method}`);
  })();
}
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) return false; await wait(10); }
  return true;
}

export default async function (t) {
  // ---- 共有の読み方
  {
    const prefs = { browserProfiles: [{ id: WORK, name: ' 仕事 ', memo: 'GitHub 用' }, { id: 'main', memo: 'ふだん' }, { id: 'bad id', name: 'x' }, { id: HOME, name: '' }, { id: WORK, name: '重複' }] };
    const list = profileList(prefs);
    assert.deepEqual(list, [{ id: 'main', memo: 'ふだん' }, { id: WORK, name: '仕事', memo: 'GitHub 用' }], 'メインは先頭・形の悪い行と名前の無い行と重複は落とす');
    assert.deepEqual(profileList({}), [{ id: 'main' }], '設定が無ければメインだけ（今までの保存領域）');
    assert.equal(profileName(list[0], 'メイン'), 'メイン'); assert.equal(profileName(list[1], 'メイン'), '仕事');
    assert.equal(monogram('仕事'), '仕'); assert.equal(monogram('work'), 'W'); assert.equal(monogram('😀x'), '😀');
    assert.match(newProfileId(() => '0123456789ab'), /^p0123456789ab$/);
    assert.equal(defaultProfile({ ...prefs, browserDefaultProfile: WORK }), WORK); assert.equal(defaultProfile({ ...prefs, browserDefaultProfile: HOME }), 'main', '消えた既定はメイン');
    const key = folderKey('D:/dev/Project/', 'win32');
    assert.equal(key, 'd:\\dev\\project'); assert.equal(folderKey('D:\\DEV\\project', 'win32'), key, 'Windows は区切りと大文字小文字を区別しない');
    const last = { ...prefs, browserLastProfiles: { [key]: WORK } };
    assert.equal(profileForNew(last, 'D:\\dev\\project', 'win32'), WORK, '既定の規則は作業フォルダーで最後に使ったもの');
    assert.equal(profileForNew(last, 'D:\\dev\\other', 'win32'), 'main', '無ければ既定');
    assert.equal(profileForNew({ ...last, browserNewProfile: 'default' }, 'D:\\dev\\project', 'win32'), 'main', '規則が「既定」なら既定');
    assert.equal(profileForNew({ ...last, browserProfiles: [] }, 'D:\\dev\\project', 'win32'), 'main', '最後に使ったものが消えていれば既定');
    assert(validProfilePref('browserProfiles', [{ id: 'main' }, { id: WORK, name: '仕事', memo: 'm' }]));
    assert(!validProfilePref('browserProfiles', [{ id: WORK, name: '仕事' }]), 'メインは消せない');
    assert(!validProfilePref('browserProfiles', [{ id: 'main' }, { id: WORK, name: '' }]), '名前の無いプロフィールは作れない');
    assert(!validProfilePref('browserProfiles', [{ id: 'main' }, { id: WORK, name: 'a', color: 'red' }]), '知らない項目は受けない');
    assert(!validProfilePref('browserProfiles', Array.from({ length: MAX_PROFILES + 1 }, (_, i) => ({ id: i ? `p${String(i).padStart(8, '0')}` : 'main', name: 'x' }))));
    assert(validProfilePref('browserDefaultProfile', WORK, prefs)); assert(!validProfilePref('browserDefaultProfile', HOME, prefs));
    assert(validProfilePref('browserNewProfile', 'default')); assert(!validProfilePref('browserNewProfile', 'random'));
    assert.equal(siteProfile({ agent: 'claude', origin: 'https://github.com', mode: 'always' }), 'main', 'プロフィールを持たない古い行はメインのもの');
    assert.equal(siteProfile({ profile: WORK }), WORK);
    assert(validBrowserPref('agentSitePermissions', [{ agent: 'claude', origin: 'https://github.com', mode: 'always', profile: WORK }]));
    assert(!validBrowserPref('agentSitePermissions', [{ agent: 'claude', origin: 'https://github.com', mode: 'always', profile: '../x' }]));
    assert.equal(findProfile(prefs, ' 仕事 ', 'メイン')?.id, WORK, '名前でも選べる'); assert.equal(findProfile(prefs, 'メイン', 'メイン')?.id, 'main');
    assert.equal(findProfile(prefs, WORK, 'メイン')?.id, WORK); assert.equal(findProfile(prefs, '個人', 'メイン'), null);
  }
  t.ok('共有の読み方: メインは先頭で消せない・新しい会話は作業フォルダーで最後に使ったもの / 既定・設定の検査・古い「常に」はメイン・名前でも id でも選べる', true);

  // ---- main: 保存領域と session
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-browser-profiles-'));
  try {
    assert.equal(bp.partitionOf('main'), 'persist:pleiad-browser', 'メインは今までの保存領域のまま');
    assert.equal(bp.partitionOf(WORK), `persist:pleiad-browser-${WORK}`);
    assert.equal(bp.partitionOf('../evil'), 'persist:pleiad-browser', '知らない id はメインに倒す（別の保存領域を作らない）');
    assert.equal(bp.partitionDir(WORK), `pleiad-browser-${WORK}`);
    // 前の起動で消したプロフィールのディレクトリは、次の起動で session を作る前に消す
    const stale = path.join(userData, 'Partitions', 'pleiad-browser-p00000001');
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(userData, 'browser-profiles-removed.json'), JSON.stringify(['pleiad-browser-p00000001', '../../etc']));
    const mainDir = path.join(userData, 'Partitions', 'pleiad-browser');
    await fs.mkdir(mainDir, { recursive: true });
    await fs.writeFile(path.join(mainDir, 'Cookies'), 'x'.repeat(1000));

    const fe = fakeElectron();
    const resolved = { 'conv-a': WORK };
    const asked = [];
    const panel = bp.createBrowserPanel({ ...fe.deps, userData, resolveProfile: async id => { asked.push(id); return resolved[id] ?? null; } });
    panel.attach();
    const call = (action, args) => fe.handlers.handle['ply:browser'](local, action, args);
    assert.equal(fss.existsSync(stale), false, '消すと決めたディレクトリを起動で消す');
    assert.equal(fss.existsSync(path.join(userData, 'browser-profiles-removed.json')), false);
    assert.deepEqual(fe.log.partitions, ['persist:pleiad-browser'], '起動ではメインの session だけ作る');
    panel.setProfiles({ ids: ['main', WORK, HOME], defaultProfile: 'main' });

    let state = await call('context', { sessionId: 'conv-a' });
    assert.equal(state.profile, WORK, '会話の今のプロフィールをサーバーに引く'); assert.deepEqual(asked, ['conv-a']);
    state = await call('open', { url: 'https://github.com/' });
    const workTab = state.tabs[0];
    assert.equal(workTab.profile, WORK, 'タブはプロフィールを持つ');
    const workContents = panel.contentsOf(workTab.id);
    assert.equal(workContents.session.partition, `persist:pleiad-browser-${WORK}`, 'そのプロフィールの保存領域で開く');
    await call('open', { url: 'https://github.com/pulls', newTab: true });
    assert.equal(fe.log.partitions.filter(p => p === `persist:pleiad-browser-${WORK}`).length, 1, 'session は 1 度だけ作る');
    assert.equal(fe.log.ua.length, 2, '権限・UA・ダウンロードの設定は session ごとに 1 回');
    // ポップアップ・サイトのデータを消すは、開いた元のタブの session
    const popup = workContents.openHandler({ url: 'https://accounts.example/login', disposition: 'new-window', features: 'width=400,height=500' });
    assert.equal(popup.overrideBrowserWindowOptions.webPreferences.session.partition, `persist:pleiad-browser-${WORK}`, 'ログインのポップアップは元のタブの保存領域');
    await call('select', { id: workTab.id });
    await call('clearSiteData');
    assert.deepEqual(fe.log.storage.at(-1), [`persist:pleiad-browser-${WORK}`, { origin: 'https://github.com' }], 'サイトのデータはそのタブのプロフィールから消す');
    assert(fe.log.cookieRemoved.every(([partition]) => partition === `persist:pleiad-browser-${WORK}`));
    t.ok('main: メインは persist:pleiad-browser・ほかは別の接頭辞・session ごとに 1 回の設定・ポップアップと clearSiteData はタブの session・消したディレクトリは次の起動で消す', true);

    // ---- 会話ごとの絞り込みと切り替え
    let sent = [];
    const unsubscribe = panel.onProfileChanged((sessionId, profile) => sent.push([sessionId, profile]));
    state = await call('profile', { profile: 'main' });
    assert.equal(state.profile, 'main'); assert.equal(state.tabs.length, 0, '切り替えるとタブの列がそのプロフィールのものに替わる');
    assert.deepEqual(sent, [['conv-a', 'main']], '中継にも知らせる');
    assert.equal(panel.tabsFor('conv-a').length, 0, '中継から見えるのも今のプロフィールのタブだけ');
    const mainTab = panel.createFor('conv-a', 'https://example.com/');
    assert.equal(mainTab.profile, 'main', '中継が作るタブは会話の今のプロフィール');
    state = await call('profile', { profile: WORK });
    assert.deepEqual(state.tabs.map(x => x.url), ['https://github.com/', 'https://github.com/pulls'], '前のプロフィールのタブは閉じずに残り、戻すとまた並ぶ');
    assert.equal(state.current, workTab.id, '選んでいたタブも戻る');
    assert.equal(panel.tabsFor('conv-a').length, 2);
    await assert.rejects(call('profile', { profile: 'p99999999' }), /unknown-profile/);
    // 会話に属さないタブも今のプロフィールのものだけ
    const loose = panel.createFor(null, 'https://loose.example/');
    assert.equal(loose.profile, 'main', '会話に属さないタブは、会話を開いていないときのプロフィール（既定）');
    state = await call('state');
    assert(!state.tabs.some(x => x.id === loose.id), '別のプロフィールの会話なしのタブは出さない');
    // 別の会話: サーバーが答えなければ既定
    state = await call('context', { sessionId: 'conv-b' });
    assert.equal(state.profile, 'main'); assert.deepEqual(state.tabs.map(x => x.id), [loose.id]);
    // エージェントが操作中は人の切り替えを止める
    await call('context', { sessionId: 'conv-a' });
    panel.setAgent('conv-a', workTab.id);
    state = await call('profile', { profile: HOME });
    assert.equal(state.error, 'agent-busy'); assert.equal(state.profile, WORK, 'エージェントが操作中は替えない');
    panel.setAgent('conv-a', null);
    // エージェントの切り替え: 画面に 1 回だけ知らせる
    sent = [];
    assert.equal(panel.setProfileFor('conv-a', HOME, { agent: 'Claude' }), true);
    state = await call('state');
    assert.equal(state.profile, HOME); assert.equal(state.tabs.length, 0);
    assert.deepEqual({ ...state.notice, seq: 0 }, { seq: 0, sessionId: 'conv-a', profile: HOME, agent: 'Claude' }, '切り替えたエージェントの名前を画面へ');
    assert.deepEqual(sent, [['conv-a', HOME]]);
    assert.equal(panel.setProfileFor('conv-a', 'p99999999'), false, '知らないプロフィールには替えない');
    // 新しい会話の仮のキーから本物の ID へ: 今のプロフィールも移す
    panel.setProfileFor('new:k', WORK);
    const fresh = panel.createFor('new:k', 'https://fresh.example/');
    panel.rebindSession('new:k', 'real-id');
    assert.equal(panel.profileFor('real-id'), WORK); assert.deepEqual(panel.tabsFor('real-id').map(x => x.id), [fresh.id]);
    unsubscribe();
    t.ok('main: 会話は今のプロフィールを 1 つ持ち、一覧と中継はそのタブだけ・切り替えても前のタブは残り選択も戻る・エージェントが操作中は人の切り替えを止める・エージェントの切り替えは画面へ知らせる・仮のキーからの付け替え', true);

    // ---- 大きさ・消す・削除
    const sizes = (await call('profileSizes')).sizes;
    assert.equal(sizes.main, 1000, 'プロフィールの保存領域の大きさ'); assert.equal(sizes[WORK], 0);
    await call('clearProfile', { profile: WORK });
    assert(fe.log.cleared.includes(`persist:pleiad-browser-${WORK}`), 'ログインとデータを消す（キャッシュも）');
    assert.deepEqual(fe.log.storage.at(-1), [`persist:pleiad-browser-${WORK}`, null]);
    assert.equal((await call('deleteProfile', { profile: 'main' })).ok, false, 'メインは削除できない');
    assert.equal((await call('deleteProfile', { profile: WORK })).ok, true);
    assert.equal(panel.tabsFor('real-id').length, 0, '削除したプロフィールのタブは閉じる');
    assert.equal(panel.profileFor('real-id'), 'main', 'そのプロフィールを使っていた会話は既定へ');
    assert(workContents.closed);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(userData, 'browser-profiles-removed.json'), 'utf8')), [`pleiad-browser-${WORK}`], 'ディレクトリは次の起動で消す');
    t.ok('main: 保存領域の大きさ・ログインとデータを消す・削除はタブを閉じて既定へ戻し、ディレクトリは次の起動で消す（メインは削除できない）', true);
  } finally { await fs.rm(userData, { recursive: true, force: true }); }

  // ---- 中継: 会話の今のプロフィールのタブだけ。切り替えるとタブの集合を替える
  {
    const panel = profilePanel();
    const relay = createBrowserRelay(panel);
    try {
      const url = await relay.endpoint('conv', { profile: WORK });
      assert.equal(panel.profileFor('conv'), WORK, '中継の準備でサーバーが決めたプロフィールを覚える');
      panel.createFor('conv', 'https://main-only.example/');   // 覚える前に作られた…ではなく、同じプロフィールのタブ
      const client = await connect(url);
      await ask(client, 'Target.setDiscoverTargets', { discover: true });
      await ask(client, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await until(() => client.events.some(e => e.method === 'Target.attachedToTarget'));
      const first = client.events.find(e => e.method === 'Target.attachedToTarget');
      let targets = (await ask(client, 'Target.getTargets')).result.targetInfos;
      assert.deepEqual(targets.map(x => x.url), ['https://main-only.example/']);
      // 人かエージェントが切り替えた: 前のタブは外し（操作中の接続も切る）、新しいプロフィールのタブを見せる。無ければ 1 枚作る
      const before = client.events.length;
      panel.setProfileFor('conv', 'main');
      await until(() => client.events.slice(before).some(e => e.method === 'Target.attachedToTarget'));
      const after = client.events.slice(before).map(e => e.method);
      assert(after.includes('Target.detachedFromTarget'), '操作中のタブの接続を切る');
      assert(after.includes('Target.targetDestroyed'), '前のプロフィールのタブはエージェントから消える');
      assert(after.includes('Target.targetCreated'), '新しいプロフィールのタブを見せる');
      targets = (await ask(client, 'Target.getTargets')).result.targetInfos;
      assert.equal(targets.length, 1); assert.equal(panel.tabs.find(x => `frame-${x.id}` === targets[0].targetId).profile, 'main', '新しいプロフィールのタブは中継が 1 枚作る');
      const denied = await ask(client, 'Runtime.evaluate', { expression: '1' }, first.params.sessionId);
      assert.match(denied.error?.message ?? '', /session denied/, '前のプロフィールのタブへのコマンドは断る');
      const created = await ask(client, 'Target.createTarget', { url: 'about:blank' });
      assert.equal(panel.tabs.find(x => `frame-${x.id}` === created.result.targetId).profile, 'main', 'createTarget は会話の今のプロフィールで作る');
      client.ws.close();
    } finally { relay.close(); }
  }
  t.ok('中継: tabsFor / createFor は会話の今のプロフィールで絞る・作る。切り替えると接続は保ったまま、前のタブを外して新しいタブ集合を見せる', true);

  // ---- サーバー: 解決と保存・ply_browser の口・確認の鍵
  {
    let prefs = { browserProfiles: [{ id: 'main' }, { id: WORK, name: '仕事', memo: 'GitHub 用' }] };
    const sessions = { s1: { cwd: 'D:\\dev\\a', backend: 'claude' }, s2: { cwd: 'D:\\dev\\a', backend: 'claude', browserProfile: WORK }, s3: { cwd: 'D:\\dev\\b', backend: 'codex', browserProfile: HOME } };
    const remembered = [];
    const profiles = createBrowserProfiles({ getPrefs: async () => prefs, getSession: async id => sessions[id] ?? { history: [] },
      setSessionData: async (id, field, value) => { (sessions[id] ??= {})[field] = value; },
      rememberLast: async (key, id) => { remembered.push([key, id]); prefs = { ...prefs, browserLastProfiles: { ...(prefs.browserLastProfiles ?? {}), [key]: id } }; }, platform: 'win32' });
    assert.equal(await profiles.resolve('s1'), 'main'); assert.equal(sessions.s1.browserProfile, 'main', '持たない会話（この機能より前の会話）は規則で決めて残す');
    assert.equal(await profiles.resolve('s2'), WORK);
    assert.equal(await profiles.resolve('s3'), 'main', '消えたプロフィールを指していれば規則で決め直す');
    assert.equal(await profiles.resolve('unknown'), 'main'); assert.equal(sessions.unknown, undefined, '無い会話には書かない');
    assert.equal(await profiles.resolve(null), 'main');
    assert.equal(await profiles.set('s1', WORK, 'D:\\dev\\a'), true);
    assert.deepEqual(remembered, [['d:\\dev\\a', WORK]], '作業フォルダーで最後に使ったものを覚える');
    assert.equal(await profiles.forNew('D:/dev/a'), WORK, '同じ作業フォルダーの新しい会話は最後に使ったもの');
    assert.equal(await profiles.forNew('D:/dev/a', { browserProfile: 'main' }), 'main', '引き継ぎ元があればそのプロフィール');
    assert.equal(await profiles.set('s1', HOME, 'D:\\dev\\a'), false, '知らないプロフィールには替えない');
    assert.equal(await profiles.label('main', 'メイン'), 'メイン');
  }
  {
    const calls = [];
    const bridge = createBrowserBridge({ call: async (owner, name, args) => { calls.push([owner(), name, args]); if (args.profile === 'none') throw new Error('no such profile'); return { ok: name }; } });
    const server = http.createServer((req, res) => bridge.handle(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const binding = bridge.open({ origin: `http://127.0.0.1:${server.address().port}`, owner: () => 'conv-1', locale: 'ja' });
      const rpc = async (method, params, headers = binding.headers) => (await fetch(binding.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
      assert.match(binding.url, /\/mcp\/browser$/);
      const list = await (await rpc('tools/list', {})).json();
      assert.deepEqual(list.result.tools.map(x => x.name), ['list_browser_profiles', 'use_browser_profile']);
      assert.deepEqual(browserTools('en')[1].inputSchema.required, ['profile']);
      const used = await (await rpc('tools/call', { name: 'use_browser_profile', arguments: { profile: '仕事' } })).json();
      assert.deepEqual(JSON.parse(used.result.content[0].text), { ok: 'use_browser_profile' }); assert.deepEqual(calls.at(-1), ['conv-1', 'use_browser_profile', { profile: '仕事' }]);
      const bad = await (await rpc('tools/call', { name: 'use_browser_profile', arguments: { profile: 'x', extra: 1 } })).json();
      assert.equal(bad.result.isError, true, '知らない引数は断る');
      const failed = await (await rpc('tools/call', { name: 'use_browser_profile', arguments: { profile: 'none' } })).json();
      assert.equal(failed.result.isError, true); assert.match(failed.result.content[0].text, /no such profile/);
      assert.equal((await rpc('tools/list', {}, { Authorization: `Bearer ${'0'.repeat(64)}` })).status, 401, '鍵の違う呼び出しは断る');
      binding.close();
      assert.equal((await rpc('tools/list', {})).status, 401, '閉じた口は断る');
    } finally { server.close(); }
  }
  {
    const asked = [], remembered = [];
    const prefs = { confirmAgentSites: true, browserProfiles: [{ id: 'main' }, { id: WORK, name: '仕事' }],
      agentSitePermissions: [{ agent: 'claude', origin: 'https://github.com', mode: 'always' }] };
    const authorize = createBrowserSiteApprovals({ getPrefs: async () => prefs, getAgent: async () => ({ id: 'claude', label: 'Claude', sessionId: 's' }),
      askPermission: async request => { asked.push(request); return { allow: true, always: true }; }, remember: async row => remembered.push(row),
      translate: (key, params) => `${key}${params ? JSON.stringify(params) : ''}`, profileLabel: async id => id === WORK ? '仕事' : 'メイン' });
    assert.deepEqual(await authorize({ sessionId: 's', url: 'https://github.com/x' }), { allow: true }, '古い「常に」はメインのプロフィールで効く');
    assert.deepEqual(await authorize({ sessionId: 's', url: 'https://github.com/x', profile: 'main' }), { allow: true });
    assert.equal(asked.length, 0);
    const answer = await authorize({ sessionId: 's', url: 'https://github.com/x', profile: WORK, account: 'tekalu' });
    assert.equal(answer.allow, true); assert.equal(asked.length, 1, '別のプロフィールでは聞き直す');
    assert.match(asked[0].title, /permission\.browserNotes.*permission\.browserProfile.*仕事/, '確認の文にプロフィール名を添える');
    assert.match(asked[0].title, /browserAccountName/); assert.equal(asked[0].browserSite.profile, '仕事');
    assert.deepEqual(remembered, [{ agent: 'claude', origin: 'https://github.com', mode: 'always', profile: WORK }], '「このサイトは常に」はプロフィールごとに覚える');
    const single = createBrowserSiteApprovals({ getPrefs: async () => ({ confirmAgentSites: true }), getAgent: async () => ({ id: 'codex', label: 'Codex', sessionId: 's' }),
      askPermission: async request => { asked.push(request); return { allow: true }; }, remember: async () => {}, translate: key => key });
    await single({ sessionId: 's', url: 'https://example.com/' });
    assert(!/browserProfile/.test(asked.at(-1).title), 'プロフィールが 1 つなら名前を添えない');
  }
  t.ok('サーバー: 会話の今のプロフィールの解決と保存（持たない会話は規則・消えたら決め直す）・作業フォルダーの最後・ply_browser の口（鍵・引数の検査）・確認の鍵はエージェント + プロフィール + origin（古い記録はメイン）', true);

  // ---- サーバー越し: 設定 → 新しい会話 → ターンの中継の準備 → AI の切り替え（fake の browser: 台本）
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-browser-profiles-server-'));
  const log = path.join(scratch, 'parent-port.ndjson');
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const cwd = path.join(scratch, 'work');
  await fs.mkdir(cwd);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', FAKE_PARENT_PORT_LOG: log }, dataDir, entry: path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs') });
  let c;
  const messages = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const meta = async id => JSON.parse(await fs.readFile(path.join(dataDir, 'sessions.json'), 'utf8'))[id] ?? {};
  try {
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    await c.cmd('setPref', { key: 'browserProfiles', value: [{ id: 'main' }, { id: WORK, name: '仕事', memo: 'seamth.com の Google アカウント' }] });
    await assert.rejects(c.cmd('setPref', { key: 'browserProfiles', value: [{ id: WORK, name: '仕事' }] }), 'メインの無い一覧は断る');
    const prefsMessage = (await messages()).filter(m => m.type === 'agent-browser-prefs').at(-1);
    assert.deepEqual(prefsMessage.profiles, ['main', WORK], '使えるプロフィールを main に知らせる');
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd });
    assert.equal((await meta(sessionId)).browserProfile, 'main', '新しい会話は作るときにプロフィールを決める');
    const turn = await c.runTurn({ backend: 'fake', cwd, sessionId, prompt: 'browser:[{"name":"list_browser_profiles","arguments":{}},{"name":"use_browser_profile","arguments":{"profile":"仕事"}}]' });
    const endpoint = (await messages()).filter(m => m.type === 'agent-browser-endpoint').at(-1);
    assert.equal(endpoint.profile, 'main', '中継の準備で会話の今のプロフィールを渡す');
    const results = turn.events.filter(e => e.type === 'tool.result');
    assert.deepEqual(turn.tools, ['mcp__ply_browser__list_browser_profiles', 'mcp__ply_browser__use_browser_profile'], '会話のツール履歴に残る');
    const listed = JSON.parse(results[0].text);
    assert.deepEqual(listed.profiles.map(p => [p.id, p.name, !!p.current, !!p.default, p.memo ?? null]), [['main', 'メイン', true, true, null], [WORK, '仕事', false, false, 'seamth.com の Google アカウント']], '一覧に id・名前・今・既定・用途のメモ');
    const used = JSON.parse(results[1].text);
    assert.equal(used.changed, true); assert.equal(used.profile.id, WORK);
    const switched = (await messages()).filter(m => m.type === 'agent-browser-profile').at(-1);
    assert.deepEqual({ sessionId: switched.sessionId, profile: switched.profile }, { sessionId, profile: WORK }, 'main にエージェントの切り替えを知らせる');
    assert(switched.agent, '切り替えたエージェントの名前を添える');
    assert.equal((await meta(sessionId)).browserProfile, WORK, '会話に残す（再起動しても残る）');
    const second = await c.runTurn({ backend: 'fake', cwd, sessionId, prompt: 'browser-instructions' });
    assert.equal((await messages()).filter(m => m.type === 'agent-browser-endpoint').at(-1).profile, WORK, '次のターンは切り替えたプロフィールで中継を準備する');
    assert(second.events.some(e => e.type === 'text.end' || e.type === 'text.delta'));
    const text = second.events.filter(e => e.type === 'text.delta').map(e => e.text ?? e.delta ?? '').join('') || second.events.find(e => e.type === 'text.end')?.text || '';
    assert.match(text, /use_browser_profile/, 'エージェント向けの指示に切り替えのツールを書く');
    const again = await c.cmd('newSession', { backend: 'fake', cwd });
    assert.equal((await meta(again.sessionId)).browserProfile, WORK, '同じ作業フォルダーの新しい会話は最後に使ったもの');
    await c.cmd('setPref', { key: 'browserNewProfile', value: 'default' });
    const third = await c.cmd('newSession', { backend: 'fake', cwd });
    assert.equal((await meta(third.sessionId)).browserProfile, 'main', '規則が「既定」なら既定');
    await c.cmd('setBrowserProfile', { sessionId: third.sessionId, profile: WORK });
    assert.equal((await meta(third.sessionId)).browserProfile, WORK, '人がパネルで替えたプロフィールを会話に残す');
    await assert.rejects(c.cmd('setBrowserProfile', { sessionId: third.sessionId, profile: HOME }), '知らないプロフィールは断る');
    // プロフィールを消すと、そのプロフィールの「常に」と既定を片付ける
    await c.cmd('setPref', { key: 'agentSitePermissions', value: [{ agent: 'fake', origin: 'https://github.com', mode: 'always', profile: WORK }, { agent: 'fake', origin: 'https://example.com', mode: 'always' }] });
    await c.cmd('setPref', { key: 'browserDefaultProfile', value: WORK });
    const after = await c.cmd('setPref', { key: 'browserProfiles', value: [{ id: 'main', name: 'ふだん' }] });
    assert.deepEqual(after.agentSitePermissions, [{ agent: 'fake', origin: 'https://example.com', mode: 'always' }], '消したプロフィールの「常に」を片付ける');
    assert.equal(after.browserDefaultProfile, undefined, '消したプロフィールが既定なら既定をメインに戻す');
    await c.runTurn({ backend: 'fake', cwd, sessionId, prompt: 'ok' });
    assert.equal((await messages()).filter(m => m.type === 'agent-browser-endpoint').at(-1).profile, 'main', '消えたプロフィールの会話は既定へ戻る');
  } finally { c?.close?.(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
  t.ok('サーバー越し: 設定を main に知らせる・新しい会話は作るときに決める・中継の準備にプロフィール・AI が一覧を読み切り替える（ツール履歴に残り、main に名前付きで知らせ、会話に残る）・人の切り替えを残す・消したプロフィールを片付ける', true);

  // ---- agy: 2 つ以上のサーバーは 1 本の中継に束ねる（agy は agent.md の mcpServers の先頭 1 本しか起こさない。1.2.14 で実測）
  {
    const servers = opts => JSON.parse(/\nmcpServers: (\[[^\n]*\])\n/.exec(agentDefinition({ owners: {}, prompt: 'P', cwd: 'C:/w', home: 'C:/h', ...opts }))[1]);
    const one = servers({ contextEnabled: false, browserEnabled: true });
    t.ok('agy: 1 つだけなら従来どおりのサーバー名と旗', one.length === 1 && one[0].serverName === 'ply_browser' && one[0].args.at(-1) === '--browser'
      && servers({ contextEnabled: true })[0].args.length === 1 && servers({ contextEnabled: false, computerEnabled: true })[0].args.at(-1) === '--computer', JSON.stringify(one));
    const bundled = servers({ contextEnabled: false, computerEnabled: true, browserEnabled: true });
    t.ok('agy: ply_computer と ply_browser は 1 本の中継に旗を並べる', bundled.length === 1 && bundled[0].serverName === 'ply_computer' && bundled[0].args.slice(-2).join() === '--computer,--browser', JSON.stringify(bundled));
    const all = servers({ contextEnabled: true, computerEnabled: true, browserEnabled: true });
    t.ok('agy: 3 つとも渡しても 1 本（先頭の名前）', all.length === 1 && all[0].serverName === 'ply_context' && all[0].args.slice(-3).join() === '--context,--computer,--browser', JSON.stringify(all));

    const seen = [];
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const m = JSON.parse(body);
        const kind = req.url.split('/').pop();
        seen.push(`${kind} ${m.method}${m.params?.name ? ` ${m.params.name}` : ''} ${req.headers.authorization?.slice(0, 8)}`);
        const tools = { context: ['instructions_for_path'], computer: ['screenshot'], browser: ['list_browser_profiles', 'use_browser_profile'] }[kind].map(n => ({ name: n, inputSchema: { type: 'object' } }));
        const result = m.method === 'tools/list' ? { tools } : m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: kind === 'context' ? { tools: {}, resources: {} } : { tools: {} }, serverInfo: { name: kind, version: '1' } }
          : m.method === 'resources/list' ? { resources: [] } : { content: [{ type: 'text', text: `${kind}:${m.params?.name}` }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${upstream.address().port}/mcp`;
      const auth = 'Bearer ' + 'a'.repeat(64);
      const child = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs'), '--context', '--computer', '--browser'], {
        env: { ...process.env, PLY_CONTEXT_URL: `${base}/context`, PLY_CONTEXT_AUTHORIZATION: auth, PLY_COMPUTER_URL: `${base}/computer`, PLY_COMPUTER_AUTHORIZATION: auth, PLY_BROWSER_URL: `${base}/browser`, PLY_BROWSER_AUTHORIZATION: auth },
        stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ply_computer_screenshot', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'use_browser_profile', arguments: { profile: 'x' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'instructions_for_path', arguments: {} } },
        { jsonrpc: '2.0', id: 6, method: 'resources/list' },
      ];
      for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
      const deadline = Date.now() + 10000;
      while (out.split('\n').filter(Boolean).length < requests.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      child.kill();
      const replies = Object.fromEntries(out.split('\n').filter(Boolean).map(l => JSON.parse(l)).map(m => [m.id, m]));
      const names = (replies[2]?.result?.tools ?? []).map(x => x.name).sort().join();
      t.ok('agy: 束ねた中継は接続先ごとの tools/list を足し合わせる（computer は ply_computer_ 付き、browser は付けない）',
        names === 'instructions_for_path,list_browser_profiles,ply_computer_screenshot,use_browser_profile', names);
      t.ok('agy: initialize は context の返事（resources を持つ）。呼び出しは名前で振り分け、computer の接頭辞は外す',
        replies[1]?.result?.capabilities?.resources && replies[3]?.result?.content?.[0]?.text === 'computer:screenshot' && replies[4]?.result?.content?.[0]?.text === 'browser:use_browser_profile'
        && replies[5]?.result?.content?.[0]?.text === 'context:instructions_for_path' && replies[6]?.result?.resources && seen.includes('browser tools/call use_browser_profile Bearer a'), JSON.stringify([replies, seen]).slice(0, 600));
      // つながらない接続先（env 無し）は黙って外し、残りで動く
      const partial = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs'), '--computer', '--browser'], {
        env: { ...process.env, PLY_COMPUTER_URL: '', PLY_COMPUTER_AUTHORIZATION: '', PLY_BROWSER_URL: `${base}/browser`, PLY_BROWSER_AUTHORIZATION: auth }, stdio: ['pipe', 'pipe', 'ignore'] });
      let pout = '';
      partial.stdout.on('data', d => { pout += d; });
      partial.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      const until = Date.now() + 10000;
      while (!pout.includes('\n') && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      partial.kill();
      t.ok('agy: 接続先が欠けても束ねた中継は残りのツールだけを出す', JSON.parse(pout.split('\n')[0]).result.tools.map(x => x.name).join() === 'list_browser_profiles,use_browser_profile', pout.slice(0, 300));
    } finally { upstream.close(); }
  }
}
