import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeScreencast } from '../../core/chrome/screencast.mjs';
import { createChromeWindowCloser } from '../../core/chrome/close-window.mjs';
import { createBrowserBridge } from '../../core/browser-bridge.mjs';
import { delegatedChromeTarget } from '../../core/chrome/delegation.mjs';
import { browserOps } from '../../core/ops/browser.mjs';
import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'chrome-close-window';
export const title = '会話の Chrome の窓を閉じる: 撮影・人の ×・再利用・一時停止とカード・会話削除・切断（偽の Chrome）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) return false; await sleep(10); } return true; }

async function rig() {
  const chrome = await startFakeChrome();
  const desktop = fakeChromeOs({ chrome });
  const connection = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: desktop, pollMs: 20 });
  const relay = createChromeRelay({ connection, os: desktop, locate: { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true } });
  const screencast = createChromeScreencast({ host: relay.view });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-chrome-close-'));
  const records = [], cards = [], openCards = new Set();
  let recordHook = null;
  const closer = createChromeWindowCloser({ relay, screencast, handoffs: { forget: id => { cards.push(id); openCards.delete(id); }, current: id => openCards.has(id) ? { reason: 'login' } : null }, dataDir,
    record: async (id, payload) => { await recordHook?.(id); records.push({ id, ...payload }); } });
  return { chrome, desktop, connection, relay, screencast, dataDir, records, cards, openCards, closer, setRecordHook: hook => { recordHook = hook; },
    async stop() { closer.stop(); screencast.close(); relay.close(); await connection.close(); await chrome.stop(); await fs.rm(dataDir, { recursive: true, force: true }); } };
}

export default async function (t) {
  const r = await rig();
  try {
    await r.relay.endpoint('one');
    const one = await r.relay.openForConversation('one', 'https://example.test/');
    const first = r.relay.view.tabs('one')[0];
    const result = await r.closer.close('one');
    const shot = r.records[0]?.path;
    t.ok('閉じる直前に PNG を保存し、会話の行にパスと agent の印を残す', result.closed && shot?.endsWith('.png') && r.records[0]?.kind === 'chromeClosed' && r.records[0]?.chromeClosed?.by === 'agent' && (await fs.readFile(shot)).length > 0);
    const calls = r.chrome.calls.map(c => c.method);
    t.ok('Page.captureScreenshot が Target.closeTarget より先で、他人のタブを閉じない', calls.indexOf('Page.captureScreenshot') < calls.indexOf('Target.closeTarget') && !r.chrome.browser.targets().some(x => x.targetId === first.targetId) && r.chrome.browser.targets().length >= 2);
    t.ok('閉じた後、会話の端点とターンは残り、次に使うと新しい窓が黙って開く', r.relay.state('one')?.turn === true && (await r.relay.openForConversation('one', 'https://next.test/')).targetId !== one.targetId);

    r.relay.pause('one');
    const paused = await r.closer.close('one', { by: 'human' });
    t.ok('一時停止中でも閉じられ、カードと一時停止を片付ける', paused.closed && !r.relay.state('one')?.paused && r.cards.includes('one') && r.records.at(-1)?.chromeClosed?.by === 'human');
    t.ok('引き継ぎ中に人が閉じても、窓の静止画は撮らず保存もしない', !r.records.at(-1)?.path && !r.chrome.calls.slice(-6).some(c => c.method === 'Page.captureScreenshot'));

    // 人が引き継いでいる最中・人への依頼の待ちの最中は、エージェント（子の窓なら親）が閉じられない
    const busy = await r.relay.openForConversation('busy', 'https://busy.test/');
    r.relay.pause('busy');
    const busyCalls = r.chrome.calls.length;
    const heldHuman = await r.closer.close('busy').then(() => null, error => error);
    t.ok('人が引き継いでいる窓は、エージェントが閉じようとすると BUSY（human）で断られ、窓・撮影・行は変わらない',
      heldHuman?.code === 'BUSY' && heldHuman.detail.reason === 'human' && r.relay.state('busy')?.paused
      && r.chrome.browser.targets().some(x => x.targetId === busy.targetId)
      && !r.chrome.calls.slice(busyCalls).some(c => c.method === 'Page.captureScreenshot' || c.method === 'Target.closeTarget') && !r.records.some(x => x.id === 'busy'));
    r.relay.unpause('busy');
    r.openCards.add('busy');
    const heldCard = await r.closer.close('busy').then(() => null, error => error);
    t.ok('人への依頼のカードがある窓は BUSY（waiting）で断られ、カードも消えない', heldCard?.code === 'BUSY' && heldCard.detail.reason === 'waiting'
      && r.openCards.has('busy') && !r.cards.includes('busy') && r.chrome.browser.targets().some(x => x.targetId === busy.targetId));
    r.openCards.delete('busy');
    t.ok('引き継ぎも依頼も終われば、エージェントも閉じられる', (await r.closer.close('busy')).closed === true);

    const second = await r.relay.openForConversation('two', 'https://other.test/');
    await r.screencast.request('start', 'two');
    r.chrome.browser.screencastFrame(second.targetId, { data: Buffer.from('last-frame').toString('base64') });
    t.ok('映像の最後のフレームを保持する', await until(() => Boolean(r.screencast.lastFrame('two'))));
    const windowId = r.relay.view.tabs('two')[0].windowId;
    r.chrome.browser.closeWindow(windowId);
    t.ok('人が × で直接閉じたときは最後の映像 JPEG を静止画にして行を残す', await until(() => r.records.some(x => x.id === 'two')) && r.records.find(x => x.id === 'two')?.path.endsWith('.jpg')
      && (await fs.readFile(r.records.find(x => x.id === 'two').path)).toString() === 'last-frame');

    const held = await r.relay.openForConversation('held', 'https://held.test/');
    await r.screencast.request('start', 'held');
    r.chrome.browser.screencastFrame(held.targetId, { data: Buffer.from('before-handover').toString('base64') });
    await until(() => Boolean(r.screencast.lastFrame('held')));
    r.relay.pause('held');
    r.chrome.browser.closeWindow(r.relay.view.tabs('held')[0].windowId);
    t.ok('引き継ぎ中に人が × で閉じたときは、引き継ぎ前の映像も静止画にしない', await until(() => r.records.some(x => x.id === 'held')) && !r.records.find(x => x.id === 'held').path);

    let startRecord, finishRecord;
    const recording = new Promise(resolve => { startRecord = resolve; });
    const recordGate = new Promise(resolve => { finishRecord = resolve; });
    r.setRecordHook(async id => { if (id === 'race') { startRecord(); await recordGate; } });
    const race = await r.relay.openForConversation('race', 'https://race.test/');
    await r.screencast.request('start', 'race');
    r.chrome.browser.screencastFrame(race.targetId, { data: Buffer.from('race-frame').toString('base64') });
    await until(() => Boolean(r.screencast.lastFrame('race')));
    r.chrome.browser.closeWindow(r.relay.view.tabs('race')[0].windowId);
    await recording;
    t.ok('人が × で閉じた窓の記録を書いている間は busy（無停止の更新が手を離さない）', r.closer.busy() === true);
    let forgot = false;
    const forgetting = r.closer.forget('race').then(() => { forgot = true; });
    await sleep(20);
    const waited = !forgot;
    finishRecord();
    await forgetting;
    t.ok('記録が済めば busy は戻る', await until(() => r.closer.busy() === false));
    t.ok('人の × の静止画が保存中でも、会話削除は保存を待って画像を片付ける', waited && forgot
      && !r.chrome.browser.targets().some(tab => tab.targetId === race.targetId)
      && !(await fs.stat(path.dirname(r.records.find(x => x.id === 'race').path)).then(() => true, () => false)));

    const beforeDelete = await r.relay.openForConversation('delete-me', 'https://delete.test/');
    await r.closer.forget('delete-me');
    r.relay.forget('delete-me');
    t.ok('会話を消すと窓を閉じ、閉じた行と画像は増やさない', !r.chrome.browser.targets().some(x => x.targetId === beforeDelete.targetId) && !r.records.some(x => x.id === 'delete-me') && r.relay.state('delete-me') === null);

    const op = browserOps.find(x => x.id === 'browser.chromeCloseWindow');
    t.ok('右パネルの op は write・画面とリモートだけで、MCP と CLI に出さない', op?.risk === 'write' && op.surfaces.ui === true && op.surfaces.mcp === false && op.surfaces.cli === false && !op.hostScreenOnly);
    const oldFrame = globalThis.requestAnimationFrame;
    const oldToggle = N.prototype.toggleAttribute;
    globalThis.requestAnimationFrame = () => 1; // DOM の代役では映像を始めない
    N.prototype.toggleAttribute = function (name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); };
    try {
      let panelOpen = false;
      const commands = [];
      let menuItems = [];
      const windows = createWindowTable();
      windows.apply({ sessionId: 'panel', windows: 1, windowIds: [41], currentWindowId: 41 });
      t.ok('窓の一覧は実際の窓と表示中の印を保持する', windows.count('panel') === 1 && windows.list('panel')[0].current);
      const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return { closed: true }; },
        showMenu: (_x, _y, items) => { menuItems = items; },
        preview: { openPanel: (options) => { panelOpen = true; options.toolbar[2].getBoundingClientRect = () => ({ left:0, bottom:0 }); options.toolbar[2].onclick(); }, panelOpen: () => panelOpen, close: () => { panelOpen = false; } },
        session: () => 'panel', windows });
      panel.open();
      await menuItems.find(item => item.label === 'ウィンドウを閉じる').onClick();
      t.ok('⋯ の「窓を閉じる」は自分の会話 ID で chromeCloseWindow を送る', menuItems[0].label === 'ウィンドウ 1 · 表示中' && commands.some(([name, args]) => name === 'chromeCloseWindow' && args.sessionId === 'panel'));
    } finally { globalThis.requestAnimationFrame = oldFrame; N.prototype.toggleAttribute = oldToggle; }

    const bridgeCalls = [];
    const bridge = createBrowserBridge({ handoffs: {}, closeWindow: async (id, task) => { bridgeCalls.push([id, task]); return { closed: true }; } });
    const server = http.createServer((req, res) => bridge.handle(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = bridge.open({ origin: `http://127.0.0.1:${server.address().port}`, locale: 'ja', owner: () => ({ sessionId: 'own' }) });
      const call = async args => (await (await fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'close_browser_window', arguments: args } }) })).json()).result;
      t.ok('ply_browser は引数なしで自分の会話を閉じ、task があれば所有の確認へ渡す', (await call({})).isError === false && (await call({ task: 'child' })).isError === false
        && (await call({ task: 42 })).isError === true && JSON.stringify(bridgeCalls) === JSON.stringify([['own', null], ['own', 'child']]));
      endpoint.close();
    } finally { server.close(); }

    const busyBridge = createBrowserBridge({ handoffs: {}, closeWindow: async () => { throw Object.assign(new Error('BUSY'), { code: 'BUSY', detail: { reason: 'human' } }); } });
    const busyServer = http.createServer((req, res) => busyBridge.handle(req, res));
    await new Promise(resolve => busyServer.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = busyBridge.open({ origin: `http://127.0.0.1:${busyServer.address().port}`, locale: 'ja', owner: () => ({ sessionId: 'own' }) });
      const answer = (await (await fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'close_browser_window', arguments: {} } }) })).json()).result;
      t.ok('ply_browser は BUSY を引き継ぎ中の案内の文で返す', answer.isError === true && answer.content[0].text.includes('引き継いでいる間'));
      endpoint.close();
    } finally { busyServer.close(); }

    // 子の窓を閉じるのを断るとき（所有の確認。core/chrome/delegation.mjs）も、エージェントの言語の文で返す
    const ownership = { task: id => ({ mine: { taskId: 'mine', parentSessionId: 'own', sessionId: 'kid' }, other: { taskId: 'other', parentSessionId: 'someone', sessionId: 'x' } })[id],
      meta: async id => (id === 'kid' ? { delegation: { taskId: 'moved', parentSessionId: 'own' } } : null) };
    const ownerBridge = createBrowserBridge({ handoffs: {}, closeWindow: async (id, task) => delegatedChromeTarget(id, task, ownership) });
    const ownerServer = http.createServer((req, res) => ownerBridge.handle(req, res));
    await new Promise(resolve => ownerServer.listen(0, '127.0.0.1', resolve));
    try {
      const answers = {};
      for (const locale of ['ja', 'en']) {
        const endpoint = ownerBridge.open({ origin: `http://127.0.0.1:${ownerServer.address().port}`, locale, owner: () => ({ sessionId: 'own' }) });
        const call = async task => (await (await fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'close_browser_window', arguments: { task } } }) })).json()).result;
        answers[locale] = { other: await call('other'), mine: await call('mine') };
        endpoint.close();
      }
      const text = answer => answer.content[0].text;
      t.ok('直接の子でないタスク・持ち主が変わったタスクを断る文は会話の言語（日本語で「直接委譲」「持ち主」、英語の内部の文をそのまま出さない）',
        Object.values(answers).every(group => Object.values(group).every(answer => answer.isError === true && !/not a local direct child|ownership changed/.test(text(answer))))
        && text(answers.ja.other).includes('直接委譲') && text(answers.ja.mine).includes('持ち主')
        && /directly/.test(text(answers.en.other)) && /ownership/i.test(text(answers.en.mine)) && !/[぀-ヿ]/.test(text(answers.en.other) + text(answers.en.mine)),
        JSON.stringify(answers));
    } finally { ownerServer.close(); }

    await r.relay.openForConversation('fallback', 'https://fallback.test/');
    const fallbackWindow = r.relay.scope.windows('fallback')[0]?.windowId;
    const fallbackCdp = await r.connection.demand();
    const fallbackSend = fallbackCdp.send.bind(fallbackCdp);
    fallbackCdp.send = async (method, params, sessionId) => method === 'Target.closeTarget'
      ? { success: true } : fallbackSend(method, params, sessionId);
    try {
      const beforeOs = r.desktop.calls('closeAgent').length;
      await r.closer.close('fallback');
      t.ok('CDP で窓が残ったときだけ、破棄を待ってから OS の closeAgent で閉じる',
        r.desktop.calls('closeAgent').length > beforeOs
        && !r.chrome.browser.targets().some(tab => tab.windowId === fallbackWindow));
    } finally { fallbackCdp.send = fallbackSend; }

    await r.relay.openForConversation('unable', 'https://unable.test/');
    const unableCdp = await r.connection.demand();
    const unableSend = unableCdp.send.bind(unableCdp);
    unableCdp.send = async (method, params, sessionId) => method === 'Target.closeTarget'
      ? { success: false } : unableSend(method, params, sessionId);
    r.desktop.opts.closeFails = true;
    try {
      const failed = await r.closer.close('unable');
      t.ok('CDP と OS の両方で閉じられなければ成功の行を残さず失敗を返す', failed.closed === false && failed.failed === true
        && !r.records.some(x => x.id === 'unable')
        && (await fs.readdir(path.join(r.dataDir, 'uploads', 'chrome-window', crypto.createHash('sha256').update('unable').digest('hex')))).length === 0);
    } finally { r.desktop.opts.closeFails = false; unableCdp.send = unableSend; }

    // 窓が複数あるとき、ウィンドウを 1 つだけ閉じられる（右パネルの「表示中のウィンドウを閉じる」）。ほかの窓・引き継ぎ・閉じた行には触れない
    {
      const a = await r.relay.openForConversation('multi', 'https://multi-a.test/');
      const b = await r.relay.openForConversation('multi', 'https://multi-b.test/');
      const winOf = id => r.relay.view.tabs('multi').find(tab => tab.targetId === id)?.windowId;
      const wa = winOf(a.targetId), wb = winOf(b.targetId);
      t.ok('（前提）会話に窓が 2 つある', wa != null && wb != null && wa !== wb, `${wa} ${wb}`);
      const recordsBefore = r.records.length;
      const calls = r.chrome.calls.length;
      const one = await r.closer.close('multi', { by: 'human', windowId: wa });
      t.ok('windowId を指すと、その窓だけ閉じる（もう一方の窓とタブは残り、閉じた行も静止画も作らない）',
        one.closed === true && !r.chrome.browser.targets().some(x => x.targetId === a.targetId) && r.chrome.browser.targets().some(x => x.targetId === b.targetId)
        && r.relay.view.tabs('multi').length === 1 && r.records.length === recordsBefore && !r.chrome.calls.slice(calls).some(c => c.method === 'Page.captureScreenshot'), JSON.stringify(one));
      t.ok('窓を 1 つ閉じても、会話の窓の数は残り 1 になる', r.relay.view.summary('multi').windows === 1);
      const gone = await r.closer.close('multi', { by: 'human', windowId: wa });
      t.ok('もう無い窓を指しても何も閉じない（closed: false）', gone.closed === false && r.relay.view.tabs('multi').length === 1);
      // 引き継ぎ中の一部の窓はエージェントが閉じられない。人が閉じても引き継ぎは続く
      const c = await r.relay.openForConversation('multi', 'https://multi-c.test/');
      const wc = winOf(c.targetId);
      r.relay.pause('multi');
      const refused = await r.closer.close('multi', { windowId: wb }).then(() => null, error => error);
      t.ok('引き継ぎ中の窓は、エージェントが 1 つだけ閉じようとしても BUSY で断られる', refused?.code === 'BUSY' && r.relay.view.tabs('multi').length === 2);
      const human = await r.closer.close('multi', { by: 'human', windowId: wc });
      t.ok('人が閉じるのは引き継ぎ中でもでき、引き継ぎ（一時停止）は続く', human.closed === true && r.relay.state('multi')?.paused && r.relay.view.tabs('multi').length === 1);
      r.relay.unpause('multi');
      const last = await r.closer.close('multi', { by: 'human', windowId: wb });
      t.ok('最後の 1 つを windowId 付きで閉じると、全部閉じる通常の経路（静止画と閉じた行を残す）', last.closed === true && r.relay.view.tabs('multi').length === 0 && r.records.some(x => x.id === 'multi' && x.chromeClosed?.by === 'human'));
    }

    await r.relay.openForConversation('crash', 'https://crash.test/');
    const cdp = await r.connection.demand();
    const send = cdp.send.bind(cdp);
    cdp.send = async (method, params, sessionId) => {
      const answer = await send(method, params, sessionId);
      if (method === 'Target.closeTarget') await r.chrome.turnOff();
      return answer;
    };
    await r.closer.close('crash');
    t.ok('closeTarget 直後に Chrome の ws が切れても、接続は Chrome が閉じた案内の off になり、一時停止と窓の数が残らない', await until(() => r.connection.state().state === 'off')
      && r.connection.state().reason === 'chrome-closed'
      && r.relay.view.summary('crash').tabs === 0 && !r.relay.state('crash')?.paused);
  } finally { await r.stop(); }
}
