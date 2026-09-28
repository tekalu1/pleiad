// リモートの端末から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」、ADR 0041）。
//   - worker 側（core/browser-screencast.mjs）: フレームの配り方と間引き（端末の受け取り・最短の間隔）、止める条件、
//     コマンドの断り（ローカルの接続・見ていない接続・エージェントが操作中）
//   - main 側（desktop/browser-screencast.cjs）を偽のパネルで: タブを作る・窓の外に載せる・ビューポート・入力の変換・エージェント
//   - 画面（web/remote-browser.mjs・web/link-sheet.mjs）: 座標の変換とシートの出し分け
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createScreencastHub, screencastCommand, parentPortScreencast, QUALITY } from '../../core/browser-screencast.mjs';
import { COMMANDS, SCREENCAST } from '../../core/protocol.mjs';
import { containRect, toPageCoords, toPageDelta, framesPerSecond } from '../../web/remote-browser.mjs';
import { linkChoices } from '../../web/link-sheet.mjs';
import { watchHostOnlyLinks } from '../../web/host-only-links.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { createBrowserScreencast, inputCommands, screencastSettings } = require('../../desktop/browser-screencast.cjs');

export const name = 'remote-browser-view';
export const title = 'リモートから PC の内蔵ブラウザーを見る: 間引き・止める条件・断る条件・入力の変換・シートの出し分け';

/** 手で進める時計とタイマー */
function clock() {
  let time = 1000;
  const timers = new Set();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const timer = { at: time + ms, fn }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due); time = due.at; due.fn();
      }
      time = end;
    },
  };
}
function fakeBridge() {
  const on = { frame: null, state: null, ended: null };
  const requests = [], acks = [];
  return {
    ready: true, requests, acks,
    request: async (action, sessionId, args) => { requests.push([action, sessionId, args]); if (action === 'input' && args.input?.type === 'agent') throw new Error('agent-active'); return action === 'start' ? { tabId: 't1', state: { url: 'http://localhost:5173/' } } : {}; },
    ack: (sessionId, frameId) => acks.push([sessionId, frameId]),
    onFrame: fn => { on.frame = fn; }, onState: fn => { on.state = fn; }, onEnded: fn => { on.ended = fn; },
    frame: (sessionId, id, data = 'AAAA') => on.frame(sessionId, { id, data, metadata: { deviceWidth: 390, deviceHeight: 700 } }),
    state: (sessionId, state) => on.state(sessionId, state),
    ended: (sessionId, reason) => on.ended(sessionId, reason),
  };
}
const client = () => { const got = []; return { got, send: message => got.push(message) }; };

function fakePanel() {
  let serial = 0;
  const tabs = [], listeners = new Set(), agentListeners = new Set(), log = { pinned: new Set(), human: [], commands: [] };
  let agent = null;
  function createFor(sessionId, url = '') {
    const id = `t${++serial}`;
    const dbg = new EventEmitter();
    let attached = false;
    dbg.isAttached = () => attached; dbg.attach = () => { attached = true; };
    dbg.sendCommand = async (method, params) => { log.commands.push([id, method, params]); return {}; };
    const contents = new EventEmitter();
    Object.assign(contents, { debugger: dbg, url, destroyed: false, isDestroyed: () => contents.destroyed, getURL: () => contents.url, getTitle: () => 'page',
      isLoading: () => false, navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: () => log.commands.push([id, 'goBack']), goForward() {} },
      reload: () => log.commands.push([id, 'reload']), stop() {}, loadURL: async next => { contents.url = next; log.commands.push([id, 'loadURL', next]); } });
    const tab = { id, sessionId, webContents: contents };
    tabs.push(tab);
    for (const listener of listeners) listener('created', tab);
    return tab;
  }
  return {
    log, createFor,
    tabsFor: sessionId => tabs.filter(tab => tab.sessionId === sessionId),
    onTabsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    onAgentChanged: fn => { agentListeners.add(fn); return () => agentListeners.delete(fn); },
    agentFor: () => agent,
    setAgent: (sessionId, tabId) => { agent = tabId ? { sessionId, tabId } : null; for (const fn of agentListeners) fn(sessionId); },
    pin: (id, on) => { if (on) log.pinned.add(id); else log.pinned.delete(id); },
    human: id => log.human.push(id),
    destroy: id => { const index = tabs.findIndex(tab => tab.id === id); const [tab] = tabs.splice(index, 1); tab.webContents.destroyed = true; for (const fn of listeners) fn('destroyed', tab); },
  };
}

export default async function (t) {
  // ---- 間引き: 端末が描き終えるまで・最短の間隔までは ack を返さない
  {
    const c = clock(), bridge = fakeBridge();
    const hub = createScreencastHub({ bridge, ...c });
    const phone = client();
    const started = await hub.watch(phone, 's1', { width: 390, height: 700, scale: 3, quality: 'auto' });
    t.ok('見始めると main に start を頼む（端末の倍率は画質の上限で丸める）',
      bridge.requests[0][0] === 'start' && bridge.requests[0][2].options.scale === QUALITY.auto.maxScale && started.tabId === 't1');
    bridge.frame('s1', 7, 'A'.repeat(4000));
    const sent = phone.got.at(-1);
    t.ok('フレームは見ている端末へ WS の screencast で届く', sent.kind === SCREENCAST && sent.type === 'frame' && sent.seq === 1 && sent.metadata.deviceWidth === 390);
    c.advance(1000);
    t.ok('端末が描き終えるまでは次のフレームを許さない', bridge.acks.length === 0);
    hub.received(phone, 's1', 1);
    t.ok('描き終えて最短の間隔（auto は 200ms）が過ぎていれば ack を返す', bridge.acks.length === 1 && bridge.acks[0][1] === 7);
    bridge.frame('s1', 8);
    hub.received(phone, 's1', 2);
    t.ok('すぐに描き終えても最短の間隔までは待つ', bridge.acks.length === 1);
    c.advance(QUALITY.auto.minInterval);
    t.ok('間隔が過ぎたら ack', bridge.acks.length === 2 && bridge.acks[1][1] === 8);
    bridge.frame('s1', 9);
    c.advance(2999);
    t.ok('端末から返事が無くても 3 秒までは待つ', bridge.acks.length === 2);
    c.advance(1);
    t.ok('3 秒で次を許す（返事の落ちた端末で止まらない）', bridge.acks.length === 3);
    const stats = hub.stats('s1');
    t.ok('送った枚数と大きさを数える', stats.frames === 3 && stats.maxBytes === 3000, JSON.stringify(stats));

    // 画質「低」は 500ms
    await hub.watch(phone, 's1', { width: 390, height: 700, quality: 'low' });
    bridge.frame('s1', 10); hub.received(phone, 's1', 4);
    c.advance(QUALITY.low.minInterval - 1);
    const before = bridge.acks.length;
    c.advance(1);
    t.ok('画質「低」は最短 500ms 間隔', bridge.acks.length === before + 1);

    // 2 台目: 片方が描き終えても、もう片方を待つ
    const tablet = client();
    await hub.watch(tablet, 's1', { width: 800, height: 1000 });
    bridge.frame('s1', 11);
    hub.received(phone, 's1', 5); c.advance(600);
    t.ok('見ている端末みなが描き終えるまで待つ', bridge.acks.length === before + 1);
    hub.received(tablet, 's1', 5); c.advance(1);
    t.ok('みなが描き終えたら ack', bridge.acks.length === before + 2);

    // 止める条件
    bridge.requests.length = 0;
    await hub.unwatch(tablet, 's1');
    t.ok('ほかに見ている端末がいれば止めない', !bridge.requests.some(([action]) => action === 'stop'));
    hub.forget(phone);
    await new Promise(resolve => setImmediate(resolve));
    t.ok('見ている端末がいなくなったら止める（接続が切れたときも）', bridge.requests.some(([action, id]) => action === 'stop' && id === 's1') && !hub.watching(phone, 's1'));

    const another = client();
    await hub.watch(another, 's2', {});
    bridge.state('s2', { url: 'https://example.com/', agent: true });
    bridge.ended('s2', 'closed');
    t.ok('状態と終わり（タブが閉じた）を端末へ知らせ、見るのをやめる',
      another.got.some(m => m.type === 'state' && m.state.agent) && another.got.at(-1).type === 'ended' && !hub.watching(another, 's2'));
  }

  // ---- コマンドの断り
  {
    const bridge = fakeBridge();
    const hub = createScreencastHub({ bridge });
    const phone = client();
    const run = (command, args, extra = {}) => screencastCommand({ command, args, local: false, hub, bridge, client: phone, ...extra });
    t.ok('ローカルの接続（ホストの画面）からは断る', (await run('browserScreencast', { sessionId: 's1' }, { local: true })).code === 'remote-only');
    t.ok('内蔵ブラウザーの無いホスト（npm start）では使えない', (await run('browserScreencast', { sessionId: 's1' }, { hub: null, bridge: null })).code === 'unavailable');
    t.ok('会話の無い依頼は断る', (await run('browserScreencast', {})).code === 'invalid-session');
    t.ok('http(s) でない URL は断る', (await run('browserScreencast', { sessionId: 's1', url: 'file:///C:/x.html' })).code === 'invalid-url');
    t.ok('見ていない接続からの入力は断る', (await run('browserScreencastInput', { sessionId: 's1', input: { type: 'tap', x: 1, y: 1 } })).code === 'not-watching');
    const opened = await run('browserScreencast', { sessionId: 's1', url: 'http://localhost:5173/' });
    t.ok('見始められる', opened.ok && bridge.requests.at(-1)[2].options.url === 'http://localhost:5173/');
    t.ok('見ている接続の入力は main へ渡す', (await run('browserScreencastInput', { sessionId: 's1', input: { type: 'tap', x: 1, y: 1 } })).ok);
    t.ok('エージェントが操作中の入力は断る（code: agent-active）', (await run('browserScreencastInput', { sessionId: 's1', input: { type: 'agent' } })).code === 'agent-active');
    t.ok('引き継ぐ・止めるは main へ渡す', (await run('browserScreencastAgent', { sessionId: 's1', action: 'takeOver' })).ok
      && bridge.requests.at(-1)[0] === 'agent' && bridge.requests.at(-1)[2].control === 'takeOver');
    let asked = null;
    const shown = await run('browserScreencast', { sessionId: 's1', visualization: { sessionId: 's0', id: 'v1' } }, { snapshotFile: async q => { asked = q; return 'file:///C:/data/visualization-snapshots/v1.html'; } });
    t.ok('可視化の写しはサーバーが書き出した file: の URL で開く（端末から file: は受けない）', shown.ok && asked.sessionId === 's0' && asked.id === 'v1'
      && bridge.requests.at(-1)[2].options.fileUrl.startsWith('file:') && !bridge.requests.at(-1)[2].options.url);
    t.ok('写しが無ければ断る', (await run('browserScreencast', { sessionId: 's1', visualization: { id: 'x' } }, { snapshotFile: async () => null })).code === 'not-found');
  }

  // ---- parentPort の口
  {
    const port = new EventEmitter();
    const posted = [];
    port.postMessage = message => posted.push(message);
    const bridge = parentPortScreencast(port);
    t.ok('main から ready が届くまでは使えない', bridge.ready === false);
    port.emit('message', { data: { type: 'browser-screencast-ready' } });
    const pending = bridge.request('start', 's1', { options: { width: 390 } });
    port.emit('message', { data: { type: 'browser-screencast', id: posted[0].id, ok: false, error: 'agent-active' } });
    let error = null;
    try { await pending; } catch (e) { error = e.message; }
    t.ok('ready の後は依頼を送り、失敗の理由をそのまま返す', bridge.ready && posted[0].action === 'start' && error === 'agent-active');
    t.ok('parentPort が無い（npm start）なら口を作らない', parentPortScreencast(null) === null);
  }

  // ---- main（desktop/browser-screencast.cjs）
  {
    const panel = fakePanel(), posted = [], control = [];
    const sc = createBrowserScreencast(panel, { post: message => posted.push(message), agentControl: (action, id) => control.push([action, id]) });
    const result = await sc.start('s1', { width: 390, height: 700, scale: 2, quality: 55 });
    const tab = panel.tabsFor('s1')[0];
    const commands = panel.log.commands.filter(([id]) => id === tab.id).map(([, method, params]) => [method, params]);
    t.ok('タブが無ければ作り、窓の外に載せる（pin）', result.tabId === tab.id && panel.log.pinned.has(tab.id));
    t.ok('ビューポートを端末の表示の大きさにしてから画面を送り始める',
      commands[0][0] === 'Emulation.setDeviceMetricsOverride' && commands[0][1].width === 390 && commands[0][1].height === 700
      && commands[1][0] === 'Page.startScreencast' && commands[1][1].maxWidth === 780 && commands[1][1].format === 'jpeg');
    tab.webContents.debugger.emit('message', {}, 'Page.screencastFrame', { data: 'QUJD', sessionId: 3, metadata: { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 } });
    t.ok('フレームを worker へ渡す（ack は worker が決める）', posted.some(m => m.type === 'browser-screencast-frame' && m.frame.id === 3 && m.frame.data === 'QUJD')
      && !panel.log.commands.some(([, method]) => method === 'Page.screencastFrameAck'));
    sc.ack('s1', 3);
    t.ok('worker の ack で Chromium に次を許す', panel.log.commands.some(([, method, params]) => method === 'Page.screencastFrameAck' && params.sessionId === 3));
    await sc.input('s1', { type: 'tap', x: 100, y: 200 });
    t.ok('タップはマウスの押す・離す。人の操作としてエージェントの操作を解除する',
      panel.log.commands.filter(([, method]) => method === 'Input.dispatchMouseEvent').length === 3 && panel.log.human.includes(tab.id));
    panel.setAgent('s1', tab.id);
    let refused = null;
    try { await sc.input('s1', { type: 'text', text: 'x' }); } catch (e) { refused = e.message; }
    let navRefused = null;
    try { await sc.navigate('s1', 'reload'); } catch (e) { navRefused = e.message; }
    t.ok('エージェントが操作中は入力も移動も断る', refused === 'agent-active' && navRefused === 'agent-active');
    sc.agent('s1', 'takeOver');
    t.ok('引き継ぐはエージェントの接続を切る（段階 2 と同じ）', control[0][0] === 'takeOver' && control[0][1] === 's1');
    panel.setAgent('s1', null);
    await sc.navigate('s1', 'open', 'http://localhost:5173/next');
    let badUrl = null;
    try { await sc.navigate('s1', 'open', 'file:///C:/secret.txt'); } catch (e) { badUrl = e.message; }
    t.ok('URL を開くのは http(s) だけ', panel.log.commands.some(([, m, u]) => m === 'loadURL' && u === 'http://localhost:5173/next') && badUrl === 'invalid-url');
    let badStart = null;
    try { await sc.start('s1', { url: 'javascript:alert(1)' }); } catch (e) { badStart = e.message; }
    t.ok('端末からの url は http(s) だけ（file: はサーバーが確かめた fileUrl でだけ）', badStart === 'invalid-url');
    tab.webContents.url = 'file:///C:/Users/x/.agent-host/visualization-snapshots/a.html';
    t.ok('PC のファイルの在り処は端末へ出さない', sc.state('s1').url === 'file:///');
    panel.destroy(tab.id);
    t.ok('タブが閉じたら終わりを知らせ、窓の外から外す', posted.at(-1).type === 'browser-screencast-ended' && posted.at(-1).reason === 'closed' && !panel.log.pinned.has(tab.id));

    const second = await sc.start('s2', {});
    await sc.stop('s2');
    const stopCommands = panel.log.commands.filter(([id]) => id === second.tabId).map(([, method]) => method);
    t.ok('止めると画面の送信とビューポートを戻す', stopCommands.includes('Page.stopScreencast') && stopCommands.includes('Emulation.clearDeviceMetricsOverride') && !panel.log.pinned.has(second.tabId));
  }

  // ---- 入力の変換（CDP）
  {
    const tap = inputCommands({ type: 'tap', x: 50, y: 5000 }, { width: 390, height: 700 });
    t.ok('タップの座標はページの大きさに収める', tap.length === 3 && tap[1][1].type === 'mousePressed' && tap[1][1].y === 700 && tap[2][1].type === 'mouseReleased');
    const enter = inputCommands({ type: 'key', key: 'Enter' });
    t.ok('Enter は文字（\\r）付きの keyDown と keyUp', enter[0][1].type === 'keyDown' && enter[0][1].text === '\r' && enter[1][1].type === 'keyUp');
    t.ok('Backspace は rawKeyDown', inputCommands({ type: 'key', key: 'Backspace' })[0][1].type === 'rawKeyDown');
    t.ok('決めたキーのほかは送らない', inputCommands({ type: 'key', key: 'F12' }).length === 0 && inputCommands({ type: 'key', key: 'Control' }).length === 0);
    t.ok('文字は insertText（長すぎれば送らない）', inputCommands({ type: 'text', text: 'こんにちは' })[0][0] === 'Input.insertText' && inputCommands({ type: 'text', text: 'x'.repeat(2001) }).length === 0);
    const wheel = inputCommands({ type: 'scroll', x: 10, y: 10, dx: 0, dy: 99999 });
    t.ok('スクロールはホイール（量は上限で丸める）', wheel[0][1].type === 'mouseWheel' && wheel[0][1].deltaY === 4000);
    t.ok('知らない入力は送らない', inputCommands({ type: 'drag' }).length === 0 && inputCommands(null).length === 0);
    const s = screencastSettings({ width: 5000, height: 10, scale: 9, quality: 100 });
    t.ok('大きさと画質は範囲に丸める', s.width === 1600 && s.height === 240 && s.scale === 2 && s.quality === 80 && s.maxWidth === 3200);
  }

  // ---- 画面: 座標の変換
  {
    const rect = containRect({ left: 0, top: 100, width: 400, height: 1000 }, { width: 780, height: 1400 });
    t.ok('contain で収めた画像の範囲', Math.abs(rect.width - 400) < 0.01 && Math.abs(rect.height - 717.95) < 0.1 && Math.abs(rect.top - (100 + (1000 - rect.height) / 2)) < 0.01);
    const meta = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0 };
    const p = toPageCoords({ x: 200, y: rect.top + rect.height / 2 }, rect, meta);
    t.ok('表示の点をページの CSS px へ（画像の倍率によらない）', p.x === 195 && p.y === 350, JSON.stringify(p));
    t.ok('画像の外（余白）は null', toPageCoords({ x: 10, y: rect.top - 5 }, rect, meta) === null);
    t.ok('移動量も同じ倍率', Math.abs(toPageDelta(100, rect, meta) - 97.5) < 0.01);
    t.ok('fps は直近 3 秒の枚数', framesPerSecond([0, 1000, 2000, 2500, 2900, 3000], 3000) === 2 && framesPerSecond([0], 5000) === 0);
  }

  // ---- シートの出し分け
  {
    const page = 'http://127.0.0.1:51234';
    t.ok('ホストの画面ではシートを出さない', linkChoices({ url: 'https://example.com/', pageOrigin: page, hostScreen: true, pcBrowser: true }) === null);
    t.ok('内蔵ブラウザーの無いホストでは出さない（今までどおり）', linkChoices({ url: 'https://example.com/', pageOrigin: page, pcBrowser: false }) === null);
    const web = linkChoices({ url: 'https://example.com/', pageOrigin: page, pcBrowser: true });
    t.ok('Web のページは「この端末で開く / PC のブラウザーで見る」', web.device && web.pc && !web.pcOnly);
    const local = linkChoices({ url: 'http://localhost:5173/projects', pageOrigin: page, pcBrowser: true });
    t.ok('localhost は「PC のブラウザーで見る」だけ', !local.device && local.pc && local.pcOnly);
    t.ok('PC のファイルも PC だけ・可視化の写しは両方', linkChoices({ kind: 'file', pcBrowser: true, pageOrigin: page }).pcOnly
      && linkChoices({ kind: 'snapshot', pcBrowser: true, pageOrigin: page }).device);

    const listeners = {}, told = [], chosen = [];
    const root = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {} };
    watchHostOnlyLinks({ root, onHostScreen: () => false, notify: text => told.push(text), choose: url => { chosen.push(url); return true; }, origin: () => page });
    let prevented = false;
    listeners.click({ target: { closest: () => ({ getAttribute: () => 'http://localhost:5173/a' }) }, preventDefault: () => { prevented = true; }, defaultPrevented: false, type: 'click' });
    t.ok('localhost のリンクはシートへ回し、知らせは出さない', prevented && chosen[0] === 'http://localhost:5173/a' && told.length === 0);
  }

  // ---- 配線
  {
    const all = ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput', 'browserScreencastNav', 'browserScreencastAgent'];
    t.ok('WS のコマンドを protocol に登録してある', all.every(command => COMMANDS.has(command)));
    const server = read('core/server.mjs');
    t.ok('サーバーは isLocalRequest の結果を渡し、hostCapabilities で pcBrowser を答える',
      /screencastCommand\(\{ command: msg\.command, args: msg\.args \?\? \{\}, local,/.test(server) && /pcBrowser: !local && !!screencastBridge\?\.ready/.test(server));
    t.ok('接続が切れたら見ていた画面を外す', /screencastHub\?\.forget\(viewer\)/.test(server));
    const relay = read('desktop/browser-relay.cjs');
    t.ok('エージェントの中継は、自分で始めていない画面のフレームを流さない', /method === 'Page\.screencastFrame' && !innerSession && !record\.screencast/.test(relay));
    const main = read('desktop/main.cjs');
    t.ok('デスクトップ版の main が橋をつなぐ', /attachBrowserScreencastBridge\(worker, browserPanel/.test(main));
    const client = read('web/client.mjs');
    t.ok('画面は screencast の知らせを表示へ渡す', /m\.kind === "screencast"\) return remoteBrowser\.onMessage\(m\)/.test(client));
  }
}
