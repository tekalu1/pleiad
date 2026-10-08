// main が居ない間の機能ごとの扱いの、main（desktop/）側（無停止の更新 段階 1 の 1-5。docs/zero-downtime-update/design.md §7.2）。
//   パネルのタブの写し（exportState / restoreState）・
//   橋（desktop/browser-viewer-bridge.cjs）の流れ: 復元の依頼 → タブを開き直す → 写しの報告。既定（handover なし）は読み込みの方針の依頼だけ
//   切り替えで替わったサーバー（空から始まる）へ、つながった印（ready）で写しを 1 回送り直す
//   ホストへ任せる橋（remote-agent-bridge）: つなぎ直したサーバーへ、ready で一覧と、つながっている線の ready を送り直す
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachBrowserViewerBridge } = require('../../desktop/browser-viewer-bridge.cjs');
const bp = require('../../desktop/browser-panel.cjs');
const { attachRemoteAgentBridge } = require('../../desktop/remote-agent-bridge.cjs');

export const name = 'main-away-desktop';
export const title = '内蔵ブラウザーの付け直し（main 側）: 中継を同じポートと鍵で立て直す・タブの写しの書き出しと開き直し・橋の流れ';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) return false; await sleep(10); } return true; };

/** 橋の試験用のタブの入れ物（タブの数と作成だけ） */
function fakeTabs() {
  let serial = 0;
  const tabs = [];
  const listeners = new Set();
  const createFor = (sessionId, initial = '') => {
    const id = `t${++serial}`;
    const webContents = { isDestroyed: () => false, getTitle: () => id, getURL: () => initial || 'about:blank' };
    const tab = { id, sessionId, webContents };
    tabs.push(tab);
    for (const listener of listeners) listener('created', tab);
    return tab;
  };
  return { tabs, createFor, tabsFor: sessionId => tabs.filter(tab => tab.sessionId === sessionId), selectFor() {}, closeFor() {}, rebindSession() {}, onTabsChanged: l => { listeners.add(l); return () => listeners.delete(l); } };
}

/** パネルの試験用の偽の electron（desktop/browser-panel.cjs が使う分） */
function fakeElectron() {
  let contentsId = 0;
  const session = { fromPartition: partition => ({ partition, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setUserAgent() {}, on() {}, webRequest: { onBeforeRequest() {} } }) };
  class Contents {
    constructor() { this.id = ++contentsId; this.url = 'about:blank'; this.events = {}; this.closed = false; this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; }
    on(name, fn) { (this.events[name] ??= []).push(fn); }
    emit(name, ...args) { for (const fn of this.events[name] ?? []) fn(...args); }
    setWindowOpenHandler() {}
    loadURL(url) { this.url = url; return Promise.resolve(); }
    getURL() { return this.url; } getTitle() { return ''; } isLoading() { return false; } isDestroyed() { return this.closed; }
    close() { this.closed = true; this.emit('destroyed'); }
  }
  class WebContentsView {
    constructor(opts) { this.webContents = new Contents(); this.webContents.session = opts?.webPreferences?.session; }
    setBounds() {} getBounds() { return { x: 0, y: 0, width: 800, height: 600 }; } setBackgroundColor() {} setBorderRadius() {}
  }
  const sent = [];
  const window = { webContents: { send: (channel, state) => sent.push([channel, state]), getZoomFactor: () => 1, on() {} }, isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } };
  return { sent, deps: { window, WebContentsView, BrowserWindow: class {}, session, shell: {}, ipcMain: { handle() {}, on() {} },
    app: { userAgentFallback: 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 agent-host/0.1.0 Safari/537.36', getPath: () => '.' }, trust: { check() {} }, icon: 'icon.png' } };
}

/** パネルのタブの写し（exportState）の試験用の部品 */
function newPanel() {
  const electron = fakeElectron();
  const panel = bp.createBrowserPanel({ ...electron.deps, userData: null });
  panel.attach?.();
  const contents = () => [...panel.__tabs ?? []];
  return { panel, electron, contents };
}

/** 橋の試験用の偽の worker（main から見たサーバーとの口）と、偽のパネル */
function bridgeKit() {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.postMessage = message => { worker.sent.push(message); };
  worker.say = message => worker.emit('message', message);
  const base = fakeTabs();
  const log = { restored: [], state: { tabs: [{ sessionId: 's1', url: 'https://example.com/a', selected: true }] } };
  const stateListeners = new Set();
  const applied = [];
  const panel = { ...base, setLoadPolicy: policy => applied.push(policy),
    exportState: () => structuredClone(log.state),
    restoreState: state => { log.restored.push(state); for (const tab of state.tabs) base.createFor(tab.sessionId, tab.url); return state.tabs.length; },
    onStateChanged: l => { stateListeners.add(l); return () => stateListeners.delete(l); } };
  return { worker, panel, log, applied, changed: () => { for (const l of stateListeners) l(); }, stateListeners };
}

export default async function (t) {
  // ---- パネル: タブの写しの書き出しと開き直し
  {
    const { panel, electron } = newPanel();
    const a = panel.createFor('s1', 'https://example.com/a');
    panel.createFor('s1', 'https://example.com/b');
    panel.createFor('s1', 'file:///C:/private.html');
    panel.createFor('s1', 'about:blank');
    panel.createFor('s2', 'https://work.example.com/');
    panel.createFor(null, 'http://localhost:3000/');
    panel.selectFor(a.id);
    const state = panel.exportState();
    const urls = state.tabs.map(tab => tab.url);
    t.ok('exportState: http(s) のタブだけ（file:・空のタブは写さない）。会話・URL を持つ', urls.join() === 'https://example.com/a,https://example.com/b,https://work.example.com/,http://localhost:3000/'
      && !('profile' in state.tabs[0]) && state.tabs.find(tab => tab.url.includes('localhost')).sessionId === null);
    t.ok('exportState: 会話ごとに最後に選んだタブに印を付ける', state.tabs.find(tab => tab.url === 'https://example.com/a').selected === true && state.tabs.find(tab => tab.url === 'https://example.com/b').selected === false);
    t.ok('exportState の中身は JSON で運べる（クローンでなく文字列にできる）', JSON.parse(JSON.stringify(state)).tabs.length === 4);
    const changes = [];
    panel.onStateChanged(() => changes.push(1));
    panel.createFor('s1', 'https://example.com/c');
    await sleep(60);
    t.ok('onStateChanged: タブの変化のあとで呼ばれる（まとめて 1 回）', changes.length >= 1);

    // 開き直す（付け直した main のパネルは空）
    const fresh = newPanel();
    const made = fresh.panel.restoreState(JSON.parse(JSON.stringify(state)));
    t.ok('restoreState: 写しのタブを開き直す（数を返す）', made === 4);
    const again = fresh.panel.exportState();
    t.ok('開き直したタブの URL・会話は前と同じ', JSON.stringify(again.tabs.map(tab => [tab.sessionId, tab.url])) === JSON.stringify(state.tabs.map(tab => [tab.sessionId, tab.url])));
    t.ok('会話ごとに最後に選んでいたタブを選び直す', again.tabs.find(tab => tab.url === 'https://example.com/a').selected === true && again.tabs.find(tab => tab.url === 'https://example.com/b').selected === false);
    t.ok('開き直したタブは元の会話に属する（中継のタブの絞り込みが会話で効く）', fresh.panel.tabsFor('s2').length === 1 && fresh.panel.tabsFor('s1').length === 2);
    const hostile = newPanel();
    const none = hostile.panel.restoreState({ tabs: [{ sessionId: 's1', url: 'file:///C:/Windows/win.ini' }, { sessionId: 's1', url: 'javascript:alert(1)' }, { sessionId: 's1', url: 'https://example.com/ok' }, null, 'x'] });
    t.ok('restoreState: file:・javascript: は開かない', none === 1 && hostile.panel.exportState().tabs.length === 1);
    t.ok('restoreState: 空・知らない形でも落ちない', newPanel().panel.restoreState() === 0 && newPanel().panel.restoreState({ tabs: 'x' }) === 0);
    void electron;
  }

  // ---- ホストへ任せる橋: つなぎ直したサーバーへ一覧と ready を送り直す
  {
    const worker = new EventEmitter();
    worker.sent = [];
    worker.postMessage = message => { worker.sent.push(message); };
    const device = new EventEmitter();
    const lines = new Map([['h1', new EventEmitter()], ['h2', new EventEmitter()]]);
    let synced = 0;
    device.list = async () => [
      { hostId: 'h1', label: 'Desk', hostName: 'DESK', agentUse: true, agent: { state: 'ready', allowed: true } },
      { hostId: 'h2', label: 'Lap', hostName: 'LAP', agentUse: true, agent: { state: 'offline', allowed: false } },
      { hostId: 'h3', label: 'Off', hostName: 'OFF', agentUse: false },
    ];
    device.agentSync = async () => { synced++; };
    device.store = { hosts: async () => [{ hostId: 'h1' }, { hostId: 'h2' }] };
    device.agent = hostId => lines.get(hostId) ?? null;
    const bridge = attachRemoteAgentBridge(worker, { getDevice: async () => device });
    await bridge.refresh();
    const types = () => worker.sent.map(m => m.type).join();
    t.ok('起動の refresh: 一覧だけを送る（ready の便りは線がつながったときに出る）', types() === 'remote-agent-hosts' && worker.sent[0].hosts.length === 3 && synced === 1);
    worker.sent.length = 0;
    worker.emit('message', { type: 'locale', locale: 'ja' });
    await sleep(30);
    t.ok('ready 以外の便りでは何も送らない', worker.sent.length === 0);
    // 切り替えで新しい版のサーバーに替わった（つながるたびに ready が届く）
    worker.emit('message', { type: 'ready', port: 7611, token: 't', appVersion: '2.0.0' });
    await until(() => worker.sent.some(m => m.type === 'remote-agent-ready'));
    const ready = worker.sent.filter(m => m.type === 'remote-agent-ready');
    t.ok('ready: 一覧を送り直し、線を張り直す（agentSync）', worker.sent.some(m => m.type === 'remote-agent-hosts' && m.hosts.length === 3) && synced === 2);
    t.ok('ready: つながっている線（ready のホスト）だけ、サーバーが追いつくための ready を送り直す', ready.length === 1 && ready[0].hostId === 'h1' && ready[0].state === 'ready' && ready[0].allowed === true && ready[0].hostName === 'DESK');
    // 線の便りはサーバーへ流れ続ける（聞き手は二重に付かない）
    worker.sent.length = 0;
    lines.get('h1').emit('event', { t: 'relays', relays: [] });
    await sleep(10);
    t.ok('切り替えの後も、ホストの便りはサーバーへ 1 回ずつ届く', worker.sent.filter(m => m.type === 'remote-agent-event').length === 1);
    await bridge.close();
  }

  // ---- 橋の流れ
  {
    const kit = bridgeKit();
    const bridge = attachBrowserViewerBridge(kit.worker, kit.panel, { handover: true, reportMs: 30, restoreWaitMs: 400 });
    t.ok('起動で browser-restore-request を送る（読み込みの方針の依頼の後）', kit.worker.sent.map(m => m.type).join() === 'browser-load-policy-request,browser-restore-request');
    kit.changed();
    await sleep(80);
    t.ok('復元の答えが届くまでは報告しない（空の状態でサーバーの写しを上書きしない）', !kit.worker.sent.some(m => m.type === 'browser-state-report'));
    kit.worker.say({ type: 'browser-restore', tabs: [{ sessionId: 's1', url: 'https://example.com/a', selected: true }], relay: null });
    await until(() => kit.worker.sent.some(m => m.type === 'browser-state-report'));
    t.ok('browser-restore: タブを開き直す', kit.log.restored.length === 1 && kit.panel.tabs.length === 1);
    const reports = () => kit.worker.sent.filter(m => m.type === 'browser-state-report');
    t.ok('復元の後は、写しを報告する（タブ）', reports().length === 1 && reports()[0].tabs[0].url === 'https://example.com/a' && reports()[0].relay === undefined);
    kit.changed(); kit.changed(); kit.changed();
    await sleep(100);
    t.ok('中身が同じなら報告しない（loading の細かい変化で送り続けない）', reports().length === 1);
    kit.log.state = { tabs: [...kit.log.state.tabs, { sessionId: 's1', url: 'https://example.com/b', selected: false }] };
    kit.changed(); kit.changed();
    await until(() => reports().length === 2);
    t.ok('変わったら 1 秒ほどまとめて 1 回報告する', reports().length === 2 && reports()[1].tabs.length === 2);
    kit.worker.say({ type: 'browser-restore', tabs: [{ sessionId: 's9', url: 'https://again.example.com/' }], relay: null });
    t.ok('browser-restore が 2 回来ても、タブは開き直さない（重ねない）', kit.log.restored.length === 1);
    kit.log.state = { tabs: [] };
    bridge.close();
    t.ok('close: 終わる前に最後の写しを渡す', reports().length === 3 && reports()[2].tabs.length === 0);
  }
  {
    // 切り替えで替わったサーバー（S2）は空から始まる。つながるたびに届く ready で、写しを 1 回送り直す（中身が変わらなくても）
    const kit = bridgeKit();
    const bridge = attachBrowserViewerBridge(kit.worker, kit.panel, { handover: true, reportMs: 30, restoreWaitMs: 400 });
    const reports = () => kit.worker.sent.filter(m => m.type === 'browser-state-report');
    kit.worker.say({ type: 'ready', port: 7611, token: 'early' });
    t.ok('復元が済む前の ready では送らない（復元の流れが報告を始める）', reports().length === 0);
    kit.worker.say({ type: 'browser-restore', tabs: kit.log.state.tabs, relay: null });
    await until(() => reports().length === 1);
    kit.worker.say({ type: 'ready', port: 7611, token: 'switched' });
    t.ok('S2 につながった（ready）直後に、中身が同じでも写しを送り直す', reports().length === 2 && reports()[1].tabs[0].url === 'https://example.com/a');
    kit.changed();
    await sleep(100);
    t.ok('送り直しの後も、中身が同じなら報告しない（重ねて送らない）', reports().length === 2);
    bridge.close();
  }
  {
    // 復元の待ちの上限を過ぎて報告を始めた後（古いサーバーなど）の ready でも送り直す。handover なしは何もしない
    const kit = bridgeKit();
    attachBrowserViewerBridge(kit.worker, kit.panel, { handover: true, reportMs: 10, restoreWaitMs: 40 });
    await sleep(120);
    kit.worker.say({ type: 'ready', port: 7611, token: 't' });
    t.ok('復元の答えが無いまま待ちの上限を過ぎた後の ready でも、写しを送り直す', kit.worker.sent.filter(m => m.type === 'browser-state-report').length === 2);
    const plain = bridgeKit();
    attachBrowserViewerBridge(plain.worker, plain.panel);
    plain.worker.say({ type: 'ready', port: 7611, token: 't' });
    t.ok('既定（handover なし）: ready で何も送らない', !plain.worker.sent.some(m => m.type === 'browser-state-report'));
  }
  {
    // 答えが来ない（古いサーバー）ときも、少し待てば報告を始める
    const kit = bridgeKit();
    attachBrowserViewerBridge(kit.worker, kit.panel, { handover: true, reportMs: 10, restoreWaitMs: 60 });
    await sleep(150);
    kit.changed();
    await until(() => kit.worker.sent.some(m => m.type === 'browser-state-report'));
    t.ok('復元の答えが無くても、待ちの上限の後は報告を始める', kit.worker.sent.some(m => m.type === 'browser-state-report'));
  }
  {
    // 既定（handover なし）: 復元の依頼も報告もしない
    const kit = bridgeKit();
    const bridge = attachBrowserViewerBridge(kit.worker, kit.panel);
    kit.changed();
    await sleep(80);
    bridge.close();
    t.ok('既定（handover なし）: 起動で読み込みの方針の依頼だけ。報告も復元もしない・状態の購読もしない', kit.worker.sent.map(m => m.type).join() === 'browser-load-policy-request' && kit.stateListeners.size === 0);
  }
  {
    // 読み込みの方針（ADR 0079）: worker からの browser-load-policy を panel.setLoadPolicy へ
    const kit = bridgeKit();
    const bridge = attachBrowserViewerBridge(kit.worker, kit.panel);
    kit.worker.say({ type: 'browser-load-policy', confirm: true, origins: ['https://ok.example'] });
    kit.worker.say({ type: 'browser-load-policy', confirm: 'yes', origins: 'nope' });
    t.ok('読み込みの方針を panel に渡す（true 以外は OFF。形の検査は panel.setLoadPolicy）', JSON.stringify(kit.applied) === JSON.stringify([{ confirm: true, origins: ['https://ok.example'] }, { confirm: false, origins: 'nope' }]));
    bridge.close();
  }
}
