// 端末から PC の Chrome の窓を操作する（第 7 段 C。by: 'device'）と、ビューアの⋯「Chrome で開く」（openForConversation）。偽の Chrome・偽の OS の層。
//   - core/chrome/input.mjs の変換は、内蔵ブラウザー（desktop/browser-screencast.cjs）と Chrome の窓（core/chrome/screencast.mjs）で同じ CDP になる
//   - 入力が通るのは端末が引き継いでいる間（paused・by: 'device'）だけ。ホストの画面の接続からは受けない
//   - 端末が引き継ぐと、窓は見せず映像も止めず、ページの大きさを端末の映像の箱にする。戻すと大きさを戻す。後から押したほうは今の状態を返すだけ
//   - openForConversation は接続が無ければ Chrome の許可を待つ（接続の案内のカードは出さない）。開いたタブを今のタブにする
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';
import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';
import { inputCommands, deviceViewport, deviceMetrics } from '../../core/chrome/input.mjs';
import { browserOps } from '../../core/ops/browser.mjs';

const require = createRequire(import.meta.url);
const { createBrowserScreencast } = require('../../desktop/browser-screencast.cjs');

export const name = 'chrome-device';
export const title = '端末から Chrome の窓を操作する（第 7 段 C）: 入力の変換は内蔵ブラウザーと同じ CDP・by: device の間だけ入力が通る・ページの大きさを合わせて戻す・窓は見せず映像も止めない・後から押したほうは断る・Chrome で開く（偽の Chrome・偽の OS の層）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => { const msg = JSON.parse(data.toString()); if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
    ws.once('open', () => resolve({
      ws,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

/** desktop/browser-panel.cjs の身代わり（タブの webContents.debugger が受けたコマンドを残す） */
function fakePanel() {
  let serial = 0;
  const tabs = [], commands = [];
  return {
    commands,
    createFor(sessionId, url = '') {
      const id = `t${++serial}`;
      const dbg = new EventEmitter();
      let attached = false;
      dbg.isAttached = () => attached; dbg.attach = () => { attached = true; };
      dbg.sendCommand = async (method, params) => { commands.push([method, params]); return {}; };
      const contents = new EventEmitter();
      Object.assign(contents, { debugger: dbg, url, isDestroyed: () => false, getURL: () => contents.url, getTitle: () => 'page', isLoading: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false } });
      const tab = { id, sessionId, webContents: contents };
      tabs.push(tab);
      return tab;
    },
    tabsFor: sessionId => tabs.filter(tab => tab.sessionId === sessionId),
    pin() {},
    onTabsChanged: () => () => {},
  };
}

const TIMING = { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200, boundsWaitMs: 100 };

async function rig({ permission = 'auto', handoff = null } = {}) {
  const chrome = await startFakeChrome({ permission });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const logs = [];
  const scope = createChromeWindows({ os: os_, locate, log: line => logs.push(line), timing: TIMING });
  const relay = createChromeRelay({ connection: conn, os: os_, locate, scope, log: line => logs.push(line), ...(handoff ? { handoff } : {}) });
  const bridge = createChromeScreencast({ host: relay.view, log: line => logs.push(line) });
  // control が映像の口（suspend・resume・operate）に何を頼んだかも残す
  const captureLog = [];
  const capture = {
    suspend: id => { captureLog.push(['suspend', id]); return bridge.suspend(id); },
    resume: id => { captureLog.push(['resume', id]); return bridge.resume(id); },
    operate: (id, viewport) => { captureLog.push(['operate', id, viewport]); return bridge.operate(id, viewport); },
  };
  const control = createChromeControl({ relay, os: os_, capture, log: line => logs.push(line) });
  const hub = createScreencastHub({ bridge, source: 'chrome' });
  const messages = [];
  const client = { send: message => messages.push(message) };
  const live = [];
  return {
    chrome, fake: chrome.browser, os: os_, conn, scope, relay, bridge, control, hub, client, messages, captureLog, logs,
    async agent(sessionId) { const a = await agent(await relay.endpoint(sessionId)); live.push(a); return a; },
    /** WS の browserScreencastInput（リモートの端末から。local: true はホストの画面） */
    input: (sessionId, input, { local = false } = {}) => screencastCommand({ command: 'browserScreencastInput', args: { sessionId, source: 'chrome', input }, local, client, chrome: { hub, bridge } }),
    async stop() { for (const a of live) { try { a.close(); } catch { /* 閉じていてもよい */ } } hub.close?.(); bridge.close(); control.close(); relay.close(); await conn.close(); await chrome.stop(); },
  };
}

const viewSession = (r, targetId) => r.fake.sessions().find(s => s.targetId === targetId && s.screencast)?.id ?? null;
const callsOn = (r, sessionId, from = 0) => r.chrome.calls.slice(from).filter(c => c.sessionId === sessionId);
const inputsOn = (r, sessionId, from = 0) => callsOn(r, sessionId, from).filter(c => c.method.startsWith('Input.')).map(c => [c.method, c.params]);
const concealed = (r, targetId) => {
  const windowId = r.fake.targets().find(x => x.targetId === targetId)?.windowId;
  const h = r.os.hwnds().find(x => x.windowId === windowId);
  return h?.concealed === true && h.alpha === 0;
};

/** 端末から送る入力の見本（範囲の外の座標・大きすぎるスクロールも混ぜる） */
const SAMPLES = [
  { type: 'tap', x: 100, y: 200 },
  { type: 'tap', x: 5000, y: -3 },
  { type: 'scroll', x: 10, y: 20, dx: 0, dy: 300 },
  { type: 'scroll', x: 10, y: 20, dx: -99999, dy: 0 },
  { type: 'text', text: 'こんにちは' },
  { type: 'key', key: 'Enter' },
  { type: 'key', key: 'Backspace' },
  { type: 'key', key: 'ArrowDown' },
];

export default async function (t) {
  // ===== 1. 入力の変換（core/chrome/input.mjs）: 決まった CDP の形 =====
  {
    const tap = inputCommands({ type: 'tap', x: 100, y: 200 }, { width: 390, height: 700 });
    t.ok('タップは mouseMoved → mousePressed → mouseReleased（左・1 回）', JSON.stringify(tap) === JSON.stringify([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 200, button: 'none', buttons: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 200, button: 'left', buttons: 0, clickCount: 1 }],
    ]), JSON.stringify(tap));
    const enter = inputCommands({ type: 'key', key: 'Enter' });
    t.ok('Enter は keyDown（text は \\r）と keyUp。仮想キーは 13', enter[0][1].type === 'keyDown' && enter[0][1].text === '\r' && enter[0][1].windowsVirtualKeyCode === 13 && enter[1][1].type === 'keyUp');
    t.ok('座標は端末のページの大きさに丸める', JSON.stringify(inputCommands({ type: 'tap', x: 5000, y: -3 }, { width: 390, height: 700 })[0][1]) === JSON.stringify({ type: 'mouseMoved', x: 390, y: 0, button: 'none', buttons: 0 }));
    t.ok('知らない入力・決めていないキーは送らない', inputCommands({ type: 'drag' }).length === 0 && inputCommands({ type: 'key', key: 'F12' }).length === 0 && inputCommands(undefined).length === 0);
    const v = deviceViewport({ width: 100.4, height: 9999, scale: 5 });
    t.ok('端末の箱の大きさは範囲に丸める（幅 240〜1600・高さ 240〜2400・倍率 1〜3）', v.width === 240 && v.height === 2400 && v.scale === 3, JSON.stringify(v));
    t.ok('大きさが数でなければ null（引き継げない）', deviceViewport({ width: 'x', height: 700 }) === null && deviceViewport() === null);
    t.ok('ページの大きさのコマンドは mobile: false（meta の無いページで座標がずれない）', JSON.stringify(deviceMetrics({ width: 390, height: 700, scale: 2 })) === JSON.stringify({ width: 390, height: 700, deviceScaleFactor: 2, mobile: false }));
  }

  // ===== 2. 内蔵ブラウザーの映像（desktop）と端末から操作する Chrome の窓が、同じ入力に同じ CDP を出す =====
  const desktop = [];
  {
    const panel = fakePanel();
    const sc = createBrowserScreencast(panel, { post: () => {} });
    await sc.start('s1', { width: 390, height: 700, scale: 2 });
    for (const input of SAMPLES) {
      const from = panel.commands.length;
      await sc.input('s1', input);
      desktop.push(panel.commands.slice(from).filter(([method]) => method.startsWith('Input.')));
    }
    t.ok('内蔵ブラウザーの映像は core/chrome/input.mjs の変換をそのまま送る', JSON.stringify(desktop) === JSON.stringify(SAMPLES.map(input => inputCommands(input, { width: 390, height: 700 }))));
    sc.close();
  }

  // ===== 3. 端末から引き継ぐ: 窓は見せず・映像は止めず・大きさを合わせ・入力は映像のセッションで =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const tab = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await until(() => r.relay.view.current('one') === tab);
      await r.hub.watch(r.client, 'one', { width: 390, height: 700, scale: 2, quality: 'auto' });
      const view = viewSession(r, tab);
      t.ok('映像を見始めた（中継自身のセッション）', !!view && r.fake.screencasting(tab));

      const before = await r.input('one', { type: 'tap', x: 10, y: 10 });
      t.ok('引き継ぐ前の入力は view-only（見るだけ）', before.ok === false && before.code === 'view-only' && inputsOn(r, view).length === 0, JSON.stringify(before));
      const pcPaused = await r.control.takeOver('one');
      const pcInput = await r.input('one', { type: 'tap', x: 10, y: 10 });
      t.ok('PC で引き継いでいる間（by: pc）の入力も view-only', pcPaused.by === 'pc' && pcInput.code === 'view-only' && inputsOn(r, view).length === 0, JSON.stringify(pcInput));
      const lateDevice = await r.control.takeOver('one', { by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('PC が引き継いでいる所へ端末が後から押しても、今の状態（by: pc）を返すだけ（大きさを変えない）', lateDevice.state === 'paused' && lateDevice.by === 'pc' && !r.captureLog.some(([op]) => op === 'operate'), JSON.stringify(lateDevice));
      await r.control.resume('one');
      // 戻すと agent-browser がつなぎ直す。映像は付け直しで同じタブを追う
      const a2 = await r.agent('one');
      await until(() => r.fake.screencasting(tab) && r.control.captureBlocked('one') === false);
      const view2 = viewSession(r, tab);
      r.captureLog.length = 0;

      const invalid = await r.control.takeOver('one', { by: 'device' }).then(() => null, error => error);
      t.ok('端末の箱の大きさが無ければ INVALID（一時停止にしない・接続も切らない）', invalid?.code === 'INVALID' && r.control.state('one').state === 'running' && a2.ws.readyState === 1, JSON.stringify(invalid?.code));
      const reveals = r.os.calls('reveal').length;
      const mark = r.chrome.calls.length;
      const took = await r.control.takeOver('one', { by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('端末から引き継ぐ → paused・by: device', took.state === 'paused' && took.by === 'device', JSON.stringify(took));
      t.ok('窓は PC の画面に見せない（reveal も前に出すも呼ばない。隠れたまま）', r.os.calls('reveal').length === reveals && concealed(r, tab));
      t.ok('エージェントの接続は切る（1000 paused）', (await a2.closed).reason === 'paused');
      t.ok('映像は止めない（suspend を呼ばない・captureBlocked は false・screencast も続く）', !r.captureLog.some(([op]) => op === 'suspend') && r.control.captureBlocked('one') === false && !r.bridge.isSuspended('one') && r.fake.screencasting(tab), JSON.stringify(r.captureLog));
      const metrics = callsOn(r, view2, mark).filter(c => c.method === 'Emulation.setDeviceMetricsOverride');
      t.ok('映像のセッションでページの大きさを端末の箱にする（mobile: false）', metrics.length === 1 && JSON.stringify(metrics[0].params) === JSON.stringify({ width: 390, height: 700, deviceScaleFactor: 2, mobile: false }), JSON.stringify(metrics));
      const lateOnPc = await r.control.takeOver('one');
      t.ok('端末が引き継いでいる所へ PC が後から押しても、今の状態（by: device）を返すだけ（窓は見せない）', lateOnPc.by === 'device' && r.os.calls('reveal').length === reveals);

      const local = await r.input('one', { type: 'tap', x: 10, y: 10 }, { local: true });
      t.ok('ホストの画面の接続からの入力は受けない（view-only）', local.ok === false && local.code === 'view-only');
      const chromeSide = [];
      for (const input of SAMPLES) {
        const from = r.chrome.calls.length;
        const sent = await r.input('one', input);
        if (!sent.ok) chromeSide.push(['failed', sent.code]);
        else chromeSide.push(inputsOn(r, view2, from));
      }
      t.ok('端末の入力は映像のセッションで送り、内蔵ブラウザーと同じ CDP になる', JSON.stringify(chromeSide) === JSON.stringify(desktop), JSON.stringify(chromeSide).slice(0, 400));
      t.ok('入力はエージェントのセッションでは送らない（映像のセッションだけ）', r.chrome.calls.slice(mark).filter(c => c.method.startsWith('Input.')).every(c => c.sessionId === view2));
      const bad = await r.input('one', { type: 'drag' });
      t.ok('知らない入力は invalid-input', bad.ok === false && bad.code === 'invalid-input');

      const mark2 = r.chrome.calls.length;
      const back = await r.control.resume('one');
      t.ok('戻す → 一時停止が解ける（窓を隠し直さない。もともと見せていない）', back.state !== 'paused' && back.by === null && concealed(r, tab), JSON.stringify(back));
      const cleared = callsOn(r, view2, mark2).map(c => c.method);
      t.ok('戻すとページの大きさを戻す（clearDeviceMetricsOverride）', cleared.includes('Emulation.clearDeviceMetricsOverride'), cleared.join());
      t.ok('大きさを戻してから解く（operate(null) の後に running）', JSON.stringify(r.captureLog.filter(([op]) => op === 'operate').map(([, , v]) => v === null)) === '[false,true]');
      const after = await r.input('one', { type: 'tap', x: 10, y: 10 });
      t.ok('戻した後の入力は view-only に戻る', after.code === 'view-only' && !r.bridge.operating('one'));
    } finally { await r.stop(); }
  }

  // ===== 4. 窓の無い会話・見ていない間に引き継いだ・見るのをやめた =====
  {
    const r = await rig();
    try {
      const none = await r.control.takeOver('nobody', { by: 'device', width: 390, height: 700 }).then(() => null, error => error);
      t.ok('会話が中継に無ければ NO_WINDOW', none?.code === 'NO_WINDOW');
      const a = await r.agent('one');
      const early = await r.control.takeOver('one', { by: 'device', width: 390, height: 700 }).then(() => null, error => error);
      t.ok('タブがまだ無ければ NO_WINDOW（一時停止を残さない）', early?.code === 'NO_WINDOW' && r.control.state('one').state === 'running' && a.ws.readyState === 1);
      const tab = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await until(() => r.relay.view.current('one') === tab);
      await r.control.takeOver('one', { by: 'device', width: 400, height: 640, scale: 1 });
      t.ok('映像を見ていなくても引き継げる（大きさは付けたときに合わせる）', r.control.state('one').by === 'device' && r.bridge.operating('one'));
      const mark = r.chrome.calls.length;
      await r.hub.watch(r.client, 'one', { width: 400, height: 640, scale: 1, quality: 'auto' });
      const view = viewSession(r, tab);
      const methods = callsOn(r, view, mark).map(c => c.method);
      const set = callsOn(r, view, mark).find(c => c.method === 'Emulation.setDeviceMetricsOverride');
      t.ok('見始めると、screencast の前にページの大きさを端末に合わせる', set?.params.width === 400 && set.params.mobile === false && methods.indexOf('Emulation.setDeviceMetricsOverride') < methods.indexOf('Page.startScreencast'), methods.join());
      const mark2 = r.chrome.calls.length;
      await r.hub.unwatch(r.client, 'one');
      t.ok('見るのをやめると、映像のセッションを外す前に大きさを戻す', callsOn(r, view, mark2).some(c => c.method === 'Emulation.clearDeviceMetricsOverride'), callsOn(r, view, mark2).map(c => c.method).join());
      const mark3 = r.chrome.calls.length;
      await r.control.resume('one');
      t.ok('見ていない間に戻しても、大きさのコマンドは送らない（もう外してある）', !r.chrome.calls.slice(mark3).some(c => c.method.startsWith('Emulation.') && c.method.includes('DeviceMetrics')) && !r.bridge.operating('one'));
    } finally { await r.stop(); }
  }

  // ===== 5. ops: chromeTakeOver の by: device の引数 =====
  {
    const op = browserOps.find(o => o.id === 'browser.chromeTakeOver');
    const calls = [];
    const ctx = { locale: 'ja', chrome: { status: () => ({ state: 'connected' }) }, chromeControl: {
      takeOver: async (sessionId, options) => {
        calls.push([sessionId, options]);
        if (options.by === 'device' && !Number.isFinite(options.width)) throw Object.assign(new Error('x'), { code: 'INVALID' });
        return { sessionId, state: 'paused', since: 1, error: null, by: options.by };
      } } };
    await op.handler(ctx, { sessionId: 's', by: 'device', width: 390, height: 700, scale: 2 });
    await op.handler(ctx, { sessionId: 's', width: 390 });
    t.ok('chromeTakeOver: by: device は大きさを渡し、それ以外は by: pc（大きさは捨てる）', JSON.stringify(calls) === JSON.stringify([['s', { by: 'device', width: 390, height: 700, scale: 2 }], ['s', { by: 'pc' }]]), JSON.stringify(calls));
    const invalid = await op.handler(ctx, { sessionId: 's', by: 'device' }).then(() => null, error => error);
    t.ok('大きさが無ければ INVALID（画面の言語の字）', invalid?.code === 'INVALID' && typeof invalid.message === 'string' && invalid.message.length > 0, JSON.stringify(invalid?.message));
    t.ok('入力の形: by は pc か device・大きさは正の数', op.input.safeParse({ sessionId: 's', by: 'phone' }).success === false && op.input.safeParse({ sessionId: 's', by: 'device', width: -1 }).success === false && op.input.safeParse({ sessionId: 's', by: 'device', width: 390, height: 700, scale: 2 }).success === true);
  }

  // ===== 6. ビューアの⋯「Chrome で開く」（relay.openForConversation） =====
  {
    const connects = [];
    const handoff = { connect: id => { connects.push(id); return null; } };
    const r = await rig({ permission: 'hold', handoff });
    try {
      const notHttp = await r.relay.openForConversation('fresh', 'file:///C:/secret.txt').then(() => null, error => error);
      t.ok('http(s) でない URL は断る（接続も始めない）', notHttp && /denied/.test(notHttp.message) && r.chrome.pending() === 0, String(notHttp?.message));
      const opening = r.relay.openForConversation('fresh', 'https://a.example/');
      t.ok('接続が無ければ Chrome の許可を待つ', await until(() => r.chrome.pending() === 1));
      t.ok('待つ間に接続の案内のカードは出さない（handoff.connect を呼ばない）', connects.length === 0);
      r.chrome.approve();
      const { targetId } = await opening;
      const target = r.fake.targets().find(x => x.targetId === targetId);
      t.ok('許可されると会話の窓に URL を開く', target?.url === 'https://a.example/', JSON.stringify(target));
      t.ok('開いたタブを会話の範囲に入れ、今のタブにする（映像が追う）', r.relay.view.tabs('fresh').some(x => x.targetId === targetId) && r.relay.view.current('fresh') === targetId);
      t.ok('窓は画面の外に隠す（エージェントの窓と同じ）', await until(() => concealed(r, targetId)));
      t.ok('ターンは始めない（エージェントには知らせない。状態は idle）', r.control.state('fresh').state === 'idle');
      const second = await r.relay.openForConversation('fresh', 'https://b.example/');
      t.ok('つながっていれば待たずに同じ会話の範囲へ開く', second.targetId !== targetId && r.relay.view.tabs('fresh').length === 2 && r.relay.view.current('fresh') === second.targetId);
    } finally { await r.stop(); }
  }
  {
    const r = await rig({ permission: 'hold' });
    try {
      const ac = new AbortController();
      const waiting = r.relay.openForConversation('other', 'https://c.example/', { signal: ac.signal }).then(() => 'opened', () => 'rejected');
      await until(() => r.chrome.pending() === 1);
      ac.abort();
      t.ok('許可の待ちは signal でやめられる（タブは開かない）', await waiting === 'rejected' && r.relay.view.tabs('other').length === 0);
    } finally { await r.stop(); }
  }
}
