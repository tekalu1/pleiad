import { WebSocket } from 'ws';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeChrome, } from '../lib/fake-chrome.mjs';
import { USER_TABS } from '../lib/fake-chrome-browser.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { runAgentBrowser } from '../lib/agent-browser-cli.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { WINDOW_DIP } from '../../core/chrome/windows.mjs';
import { browserEnvironment, chromeRelayBrowser, browserSocketDirectory } from '../../core/agent-browser.mjs';
import { rpc as nativeRpc } from '../../core/backends/codex-rpc.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open as openHost } from '../lib/ws-client.mjs';
import fs from 'node:fs/promises';
import { backend as codex } from '../../core/backends/codex.mjs';

export const name = 'chrome-relay';
export const title = 'Chrome の絞り込みの中継: 会話の窓の範囲・断る／真似る一覧・sessionId の持ち主・サイトの利用の確認（Fetch・window.open の後追い）・止める・鍵・agent-browser の本物の通し（偽の Chrome。ADR 0148・0153）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

/** エージェントの側（agent-browser の代わり）。受けた生の文字列も全部残す（範囲の外の URL が漏れていないかを見る） */
function agent(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const events = [], raw = [], waiting = new Map();
    let next = 0;
    ws.on('message', data => {
      const text = data.toString();
      raw.push(text);
      const msg = JSON.parse(text);
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
      else events.push(msg);
    });
    ws.once('open', () => resolve({
      ws, events, raw,
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
const refused = (url, options) => agent(url, options).then(client => { client.close(); return false; }, () => true);

async function rig({ permission = 'auto', connectWaitMs, authorize, handoff, connectWaitText } = {}) {
  const chrome = await startFakeChrome({ permission });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const logs = [];
  const asked = [];
  let answer = async () => ({ allow: true });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const relay = createChromeRelay({ connection: conn, os: os_, locate, deniedMessage: () => 'DENIED-TEXT', log: line => logs.push(line), ...(connectWaitMs ? { connectWaitMs } : {}), ...(handoff ? { handoff } : {}), ...(connectWaitText ? { connectWaitText } : {}),
    authorize: authorize ?? (async (request, signal) => { asked.push(request); return answer(request, signal); }) });
  return {
    chrome, conn, relay, logs, asked, fake: chrome.browser, os: os_,
    answer: fn => { answer = fn; },
    async stop() { relay.close(); await conn.close(); await chrome.stop(); },
  };
}

export default async function (t) {
  // ===== 1. 範囲: 会話の窓のタブだけ。ほかの窓・ほかの会話は見えない。上りへブラウザー全体の setAutoAttach を送らない =====
  {
    const r = await rig();
    let a1, a2;
    try {
      const url1 = await r.relay.endpoint('one');
      const url2 = await r.relay.endpoint('two');
      t.ok('端点は会話ごとの鍵付きの loopback の ws（会話ごとに別の鍵）', /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]{48}$/.test(url1) && url1 !== url2 && (await r.relay.endpoint('one')) === url1);
      a1 = await agent(url1);
      t.ok('Browser.getVersion は上りの Chrome の値を返す', (await a1.cmd('Browser.getVersion')).result?.product === 'Chrome/154.0.8037.97');
      await a1.cmd('Target.setDiscoverTargets', { discover: true });
      t.ok('つないだだけでは何も見えない（利用者のタブ 2 つと Chrome の内部のターゲットは出さない）', (await a1.cmd('Target.getTargets')).result.targetInfos.length === 0 && a1.events.length === 0);
      const created = await a1.cmd('Target.createTarget', { url: 'about:blank', browserContextId: 'SOMEONE-ELSE', newWindow: false });
      const tabId = created.result?.targetId;
      const tab = r.fake.targets().find(x => x.targetId === tabId);
      const win = r.fake.windows().find(w => w.windowId === tab?.windowId);
      t.ok('createTarget は context・newWindow の指定を捨てて、会話の新しい窓に作る（利用者の窓に入れない）', !!tab && tab.windowId !== r.fake.userWindow, JSON.stringify(tab));
      const hwnd = r.os.hwnds().find(h => h.windowId === tab?.windowId);
      t.ok(`窓は最小化せず、決めた大きさ（${WINDOW_DIP.width}×${WINDOW_DIP.height} DIP）で開く（画面の外へは OS の層が動かす）`, win?.state === 'normal' && win.bounds.width === WINDOW_DIP.width && win.bounds.height === WINDOW_DIP.height, JSON.stringify(win));
      t.ok('窓の HWND を隠す（画面の外・タスクバーと Alt+Tab から外す・透明度 0・マウスの素通し）', hwnd?.concealed === true && hwnd.alpha === 0 && hwnd.ex.toolwindow && hwnd.ex.layered && hwnd.ex.transparent && !hwnd.ex.appwindow, JSON.stringify(hwnd));
      t.ok('窓の状態（最小化・復元）を上りへ送らない', !r.chrome.calls.some(c => c.method === 'Browser.setWindowBounds' && c.params.bounds?.windowState));
      t.ok('作ったタブだけが getTargets と targetCreated に出る', JSON.stringify((await a1.cmd('Target.getTargets')).result.targetInfos.map(x => x.targetId)) === JSON.stringify([tabId])
        && a1.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.targetId === tabId));
      r.fake.openUserTab('https://user-new.example/private', 'Private title');
      const userTab = r.fake.targets().find(x => x.url === USER_TABS[1].url).targetId;
      r.fake.navigateUser(userTab, 'https://bank.example/transfer');
      await sleep(100);
      const leaked = [...USER_TABS.flatMap(x => [x.url, x.title]), 'user-new.example', 'Private title', 'bank.example', 'chrome-extension'].filter(s => a1.raw.some(text => text.includes(s)));
      t.ok('利用者が開いた・動かしたタブの URL・題は、エージェントの ws に一度も届かない', leaked.length === 0, leaked.join());
      t.ok('中継のログにも出ない', !r.logs.some(line => /example|Private/.test(line)), r.logs.join(' | '));
      const denials = await Promise.all([
        a1.cmd('Target.attachToTarget', { targetId: userTab, flatten: true }), a1.cmd('Target.getTargetInfo', { targetId: userTab }), a1.cmd('Target.closeTarget', { targetId: userTab }),
        a1.cmd('Target.activateTarget', { targetId: userTab }), a1.cmd('Browser.getWindowForTarget', { targetId: userTab }), a1.cmd('Browser.getWindowBounds', { windowId: r.fake.userWindow }),
        a1.cmd('Browser.setContentsSize', { windowId: r.fake.userWindow, width: 10, height: 10 }), a1.cmd('Target.getTargetInfo', {}),
      ]);
      t.ok('利用者のタブ・窓へは attach・情報・閉じる・前に出す・窓の大きさのどれも断る', denials.every(m => m.error), JSON.stringify(denials.map(m => m.error?.message ?? 'ok')));
      t.ok('利用者のタブは閉じられていない', r.fake.targets().some(x => x.targetId === userTab));
      t.ok('自分の窓の大きさは見られる・変えられる（agent-browser の set viewport）', !(await a1.cmd('Browser.getWindowBounds', { windowId: tab.windowId })).error && !(await a1.cmd('Browser.setContentsSize', { windowId: tab.windowId, width: 800, height: 600 })).error);

      const attached = await a1.cmd('Target.attachToTarget', { targetId: tabId, flatten: false });
      const sid1 = attached.result?.sessionId;
      t.ok('attach は flatten を強いて通す（attachedToTarget が応答より先に届く）', !!sid1 && r.chrome.calls.some(c => c.method === 'Target.attachToTarget' && c.params.targetId === tabId && c.params.flatten === true)
        && a1.events.some(e => e.method === 'Target.attachedToTarget' && e.params.sessionId === sid1));
      t.ok('セッションの上のコマンドとイベントが通る', (await a1.cmd('Runtime.evaluate', { expression: 'document.title' }, sid1)).sessionId === sid1);

      a2 = await agent(url2);
      t.ok('ほかの会話には、この会話のタブは見えない', (await a2.cmd('Target.getTargets')).result.targetInfos.length === 0);
      t.ok('ほかの会話のタブへの attach を断る', !!(await a2.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).error);
      t.ok('ほかの会話の sessionId は使えない（コマンド・detach とも）', !!(await a2.cmd('Runtime.evaluate', { expression: '1' }, sid1)).error && !!(await a2.cmd('Target.detachFromTarget', { sessionId: sid1 })).error);
      t.ok('同じ会話の別の接続でも、attach していない sessionId は使えない', await (async () => { const a1b = await agent(url1); const m = await a1b.cmd('Runtime.evaluate', { expression: '1' }, sid1); a1b.close(); return !!m.error; })());

      // ブラウザー全体の setAutoAttach は真似る（上りへ送らず、範囲のタブにだけ attach する）
      const a1c = await agent(url1);
      await a1c.cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      t.ok('エージェントのブラウザー全体の setAutoAttach は、範囲のタブにだけ attach して真似る', await until(() => a1c.events.filter(e => e.method === 'Target.attachedToTarget').map(e => e.params.targetInfo.targetId).join() === tabId));
      const sessionsBefore = r.fake.sessions().length;
      a1c.close();
      t.ok('接続が閉じたら、その接続が attach したセッションを上りで外す', await until(() => r.fake.sessions().length === sessionsBefore - 1), `${sessionsBefore} -> ${r.fake.sessions().length}`);
      t.ok('上りへブラウザー全体の Target.setAutoAttach を一度も送っていない', r.fake.autoAttachCalls.length === 0 && !r.chrome.calls.some(c => c.method === 'Target.setAutoAttach' && !c.sessionId));

      // ===== 2. 断る一覧 =====
      const browserDenied = ['Browser.close', 'Browser.crash', 'Browser.setDownloadBehavior', 'Browser.setWindowBounds', 'Browser.grantPermissions', 'Storage.getCookies', 'Network.getAllCookies',
        'Target.createBrowserContext', 'Target.disposeBrowserContext', 'Target.exposeDevToolsProtocol', 'Target.setRemoteLocations', 'Target.sendMessageToTarget', 'SystemInfo.getInfo'];
      const replies = await Promise.all(browserDenied.map(method => a1.cmd(method, method === 'Browser.setWindowBounds' ? { windowId: tab.windowId, bounds: { windowState: 'normal' } } : {})));
      t.ok('ブラウザー全体の操作を断る（Browser.close・Storage.*・Cookie の一括・context・窓を戻すなど）', replies.every(m => m.error), browserDenied.filter((_, i) => !replies[i].error).join());
      // 中継自身が窓の大きさを決める setWindowBounds（windowState なし）は除く
      const forwarded = r.chrome.calls.filter(c => browserDenied.includes(c.method) && !(c.method === 'Browser.setWindowBounds' && !c.params.bounds?.windowState));
      t.ok('断ったものは上りへ送っていない', forwarded.length === 0, forwarded.map(c => c.method).join());
      const sessionDenied = [['Target.createTarget', { url: 'about:blank' }], ['Browser.getVersion', {}], ['Storage.getCookies', {}], ['Network.getAllCookies', {}], ['Network.clearBrowserCookies', {}],
        ['Network.clearBrowserCache', {}], ['Page.navigate', { url: 'file:///C:/Windows/win.ini' }], ['Page.navigate', { url: 'chrome://settings' }], ['Page.navigate', { url: 'https://user:pass@example.com/' }],
        ['Network.setCookie', { name: 'x', value: 'y', domain: 'bank.example' }], ['Network.deleteCookies', { name: 'session' }], ['Network.setCookies', { cookies: [{ name: 'x', value: 'y', url: 'https://bank.example/' }] }]];
      const sessionReplies = [];
      for (const [method, params] of sessionDenied) sessionReplies.push(await a1.cmd(method, params, sid1));
      t.ok('セッションの上でも、Target.*・Browser.*・Storage.*・Cookie の一括・file:/chrome: への移動・ほかのサイトの Cookie を断る', sessionReplies.every(m => m.error), sessionDenied.filter((_, i) => !sessionReplies[i].error).map(x => x[0]).join());
      await a1.cmd('Network.getCookies', { urls: ['https://bank.example/'] }, sid1);
      const cookieCall = r.chrome.calls.filter(c => c.method === 'Network.getCookies').at(-1);
      t.ok('Network.getCookies は urls を外して、今のページの Cookie だけにする', !!cookieCall && !('urls' in cookieCall.params), JSON.stringify(cookieCall));

      // ほかの origin を引数で指せて、自分のタブの外に届くコマンド（保存データ・Cookie・資格情報つきの取得・横取りの古い口）
      const bank = 'https://bank.example';
      const storageId = { securityOrigin: bank, isLocalStorage: true };
      const crossOrigin = [
        ['DOMStorage.getDOMStorageItems', { storageId }], ['DOMStorage.setDOMStorageItem', { storageId, key: 'k', value: 'v' }], ['DOMStorage.removeDOMStorageItem', { storageId, key: 'k' }], ['DOMStorage.clear', { storageId }],
        ['IndexedDB.requestDatabaseNames', { securityOrigin: bank }], ['IndexedDB.requestData', { securityOrigin: bank, databaseName: 'db', objectStoreName: 's', indexName: '', skipCount: 0, pageSize: 10 }],
        ['IndexedDB.deleteDatabase', { securityOrigin: bank, databaseName: 'db' }], ['IndexedDB.clearObjectStore', { securityOrigin: bank, databaseName: 'db', objectStoreName: 's' }],
        ['CacheStorage.requestCacheNames', { securityOrigin: bank }], ['CacheStorage.requestEntries', { cacheId: 'c' }], ['CacheStorage.deleteCache', { cacheId: 'c' }],
        ['Database.executeSQL', { databaseId: '1', query: 'select 1' }], ['FileSystem.getDirectory', { bucketFileSystemLocator: { storageKey: `${bank}/`, pathComponents: [] } }],
        ['ServiceWorker.unregister', { scopeURL: `${bank}/` }], ['ServiceWorker.deliverPushMessage', { origin: bank, registrationId: '1', data: '' }], ['BackgroundService.startObserving', { service: 'backgroundFetch' }],
        ['Network.loadNetworkResource', { frameId: tabId, url: `${bank}/account`, options: { disableCache: true, includeCredentials: true } }], ['Network.getCertificate', { origin: bank }],
        ['Network.enableDeviceBoundSessions', { enable: true }], ['Network.deleteDeviceBoundSession', { key: { site: bank, id: 'x' } }],
        ['Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }], ['Network.continueInterceptedRequest', { interceptionId: 'x', url: `${bank}/` }],
      ];
      const crossReplies = [];
      for (const [method, params] of crossOrigin) crossReplies.push(await a1.cmd(method, params, sid1));
      t.ok('ほかの origin の保存データ（DOMStorage・IndexedDB・CacheStorage・Database・FileSystem・ServiceWorker・BackgroundService）・資格情報つきの取得・横取りの古い口を断る',
        crossReplies.every(m => m.error), crossOrigin.filter((_, i) => !crossReplies[i].error).map(x => x[0]).join());
      const crossForwarded = r.chrome.calls.filter(c => crossOrigin.some(([method]) => method === c.method));
      t.ok('断ったものは上りへ送っていない（保存データ・取得）', crossForwarded.length === 0, crossForwarded.map(c => c.method).join());
      const deleteCookie = await a1.cmd('Page.deleteCookie', { cookieName: 'session', url: `${bank}/` }, sid1);
      t.ok('Page.deleteCookie（任意の url の Cookie を消せる）を断り、上りへ送らない', !!deleteCookie.error && !r.chrome.calls.some(c => c.method === 'Page.deleteCookie'), JSON.stringify(deleteCookie));

      // エージェントの Fetch: 止めた要求の url の差し替えは同じ origin の中だけ
      await a1.cmd('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document' }] }, sid1);
      const navigating = a1.cmd('Page.navigate', { url: 'https://site2.example/' }, sid1);
      await until(() => a1.events.some(e => e.method === 'Fetch.requestPaused' && e.sessionId === sid1));
      const requestId = a1.events.find(e => e.method === 'Fetch.requestPaused' && e.sessionId === sid1)?.params.requestId;
      const swapped = await a1.cmd('Fetch.continueRequest', { requestId, url: `${bank}/account` }, sid1);
      t.ok('エージェントの Fetch.continueRequest で、ほかの origin へ送り先を差し替えるのを断る（確認を通らずに届くため）', !!swapped.error && !r.chrome.calls.some(c => c.method === 'Fetch.continueRequest' && c.params.url?.startsWith(bank)), JSON.stringify(swapped));
      const sameOrigin = await a1.cmd('Fetch.continueRequest', { requestId, url: 'https://site2.example/other' }, sid1);
      t.ok('同じ origin の中の差し替えは通す', !sameOrigin.error && !(await navigating).error, JSON.stringify(sameOrigin));
      await a1.cmd('Fetch.disable', {}, sid1);

      // Cookie の書き込み: url と domain の両方を見る（Chrome は domain を url より優先して使うことがある）
      const cookieCases = [
        ['Network.deleteCookies', { name: 'session', url: 'https://site2.example/', domain: 'bank.example' }],
        ['Network.setCookie', { name: 'x', value: 'y', url: 'https://site2.example/', domain: '.bank.example' }],
        ['Network.setCookies', { cookies: [{ name: 'x', value: 'y', url: 'https://site2.example/', domain: 'bank.example' }] }],
      ];
      const cookieReplies = [];
      for (const [method, params] of cookieCases) cookieReplies.push(await a1.cmd(method, params, sid1));
      t.ok('今のページの url とほかのサイトの domain を並べた Cookie の書き込み・削除を断る', cookieReplies.every(m => m.error), cookieCases.filter((_, i) => !cookieReplies[i].error).map(x => x[0]).join());
      const ownCookie = await a1.cmd('Network.setCookie', { name: 'x', value: 'y', url: 'https://site2.example/' }, sid1);
      const ownDelete = await a1.cmd('Network.deleteCookies', { name: 'x', domain: 'site2.example' }, sid1);
      t.ok('今のページの Cookie は書ける・消せる', !ownCookie.error && !ownDelete.error, JSON.stringify([ownCookie, ownDelete]));

      // ブラウザーの上の Target.createTarget も、Page.navigate と同じ規則（http(s)・認証情報なし・about:blank）
      const createsBefore = r.chrome.calls.filter(c => c.method === 'Target.createTarget').length;
      const badUrls = ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'https://user:pass@example.com/', 'https://user@example.com/', 'chrome://settings', 'data:text/html,hi', 'view-source:https://example.com/'];
      const createReplies = [];
      for (const url of badUrls) createReplies.push(await a1.cmd('Target.createTarget', { url }));
      t.ok('Target.createTarget の file:・javascript:・認証情報つき・chrome: などの URL を断り、タブも作らない', createReplies.every(m => m.error) && r.chrome.calls.filter(c => c.method === 'Target.createTarget').length === createsBefore,
        badUrls.filter((_, i) => !createReplies[i].error).join());

      const key = url1.split('/').pop();
      t.ok('鍵の文字列は中継のログに出ない', !r.logs.some(line => line.includes(key)), r.logs.join(' | '));
    } finally { a1?.close(); a2?.close(); await r.stop(); }
  }

  // ===== 3. サイトの利用の確認（Fetch）・window.open の後追い =====
  {
    const r = await rig();
    let a;
    try {
      const fake = r.fake;
      fake.setPage('https://allow.example/', { title: 'Allow', elements: [{ role: 'link', name: 'same', open: { url: 'https://allow.example/x' } }, { role: 'link', name: 'pop', open: { url: 'https://popup.example/' } }, { role: 'link', name: 'win', open: { url: 'https://popwin.example/', popup: true } }] });
      fake.setPage('https://redir.example/', { title: 'Redir', redirect: 'https://other.example/land' });
      a = await agent(await r.relay.endpoint('conf'));
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      await a.cmd('Page.enable', {}, sid);
      t.ok('確認が OFF のときは中継自身のセッションを付けない', !fake.sessions().some(s => s.fetch));
      r.relay.setConfirm(true);
      t.ok('確認を ON にすると、範囲のタブに中継自身のセッションで Fetch を付ける', await until(() => fake.sessions().some(s => s.targetId === tabId && s.fetch)));
      t.ok('Fetch は主フレームの Document の要求だけ', r.chrome.calls.some(c => c.method === 'Fetch.enable' && JSON.stringify(c.params.patterns) === JSON.stringify([{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }])));

      let release;
      r.answer(() => new Promise(resolve => { release = resolve; }));
      const going = a.cmd('Page.navigate', { url: 'https://allow.example/' }, sid);
      t.ok('移動は要求を出す前に止まり、確認（会話の id・URL）を聞く', await until(() => r.asked.length === 1) && r.asked[0].sessionId === 'conf' && r.asked[0].url === 'https://allow.example/' && !fake.served.includes('https://allow.example/'));
      release({ allow: true });
      const went = await going;
      t.ok('許可で移動する', !went.error && fake.served.includes('https://allow.example/'), JSON.stringify(went));
      r.answer(async () => ({ allow: true }));
      await a.cmd('Page.navigate', { url: 'https://allow.example/' }, sid);
      t.ok('同じ origin は聞かない', r.asked.length === 1);
      r.answer(async () => ({ allow: false }));
      const blocked = await a.cmd('Page.navigate', { url: 'https://deny.example/' }, sid);
      t.ok('断られた移動は要求が出ず、エージェントには断られた文で返る', blocked.error?.message === 'DENIED-TEXT' && !fake.served.includes('https://deny.example/'), JSON.stringify(blocked));
      r.answer(async () => ({ allow: false, message: 'ユーザーの理由' }));
      const reasoned = await a.cmd('Page.navigate', { url: 'https://deny2.example/' }, sid);
      t.ok('確認の答えに文があればそれを返す', reasoned.error?.message === 'ユーザーの理由');

      // 302 で別の origin へ移る: 移った先も聞く
      r.answer(async request => ({ allow: request.url.startsWith('https://redir.example') }));
      const asked = r.asked.length;
      const redirected = await a.cmd('Page.navigate', { url: 'https://redir.example/' }, sid);
      t.ok('リダイレクトの先の別の origin も聞き、断れば届かない', r.asked.length === asked + 2 && r.asked.at(-1).url === 'https://other.example/land' && !!redirected.error && !fake.served.includes('https://other.example/land'));

      // window.open のタブ: 最初の要求は止められない（実機と同じ）。開いた後に聞き、断られたら閉じる
      r.answer(async () => ({ allow: true }));
      await a.cmd('Page.navigate', { url: 'https://allow.example/' }, sid);
      r.answer(async () => ({ allow: false }));
      const before = r.asked.length;
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 60, button: 'left' }, sid);   // 2 つ目の要素（pop）
      const popupCreated = await until(() => a.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === tabId));
      const popupId = a.events.find(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === tabId)?.params.targetInfo.targetId;
      t.ok('範囲のタブが開いたタブは範囲に入る（openerId）', popupCreated && !!popupId);
      t.ok('window.open のタブは最初の要求の後に聞き、断られたら閉じる', await until(() => r.asked.length === before + 1 && !fake.targets().some(x => x.targetId === popupId))
        && r.asked.at(-1).url === 'https://popup.example/' && fake.served.includes('https://popup.example/') && a.events.some(e => e.method === 'Target.targetDestroyed' && e.params.targetId === popupId));
      const asked2 = r.asked.length;
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 30, button: 'left' }, sid);   // 1 つ目（同じ origin）
      await until(() => fake.targets().some(x => x.url === 'https://allow.example/x'));
      await sleep(50);
      t.ok('同じ origin の window.open は聞かずに残す', r.asked.length === asked2 && fake.targets().some(x => x.url === 'https://allow.example/x'));
      r.answer(async () => ({ allow: true }));
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 90, button: 'left' }, sid);   // 3 つ目（popup の別窓）
      await until(() => fake.targets().some(x => x.url === 'https://popwin.example/'));
      const popwin = fake.targets().find(x => x.url === 'https://popwin.example/');
      t.ok('popup の別窓は、その窓も会話の範囲に足す', await until(async () => !(await a.cmd('Browser.getWindowBounds', { windowId: popwin.windowId })).error)
        && (await a.cmd('Target.getTargets')).result.targetInfos.some(x => x.targetId === popwin.targetId));

      // 人の操作（エージェントが動かしていないタブ）は止めない
      r.relay.endTurn('conf');
      const asked3 = r.asked.length;
      await fake.navigateUser(tabId, 'https://human.example/');
      t.ok('ターンが終わった後（人の操作）の移動は聞かずに通す', r.asked.length === asked3 && fake.served.includes('https://human.example/'));

      // ターンの終わりは、出ている確認を取り下げる
      r.answer((_request, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ allow: false }), { once: true })));
      const hanging = a.cmd('Page.navigate', { url: 'https://late.example/' }, sid);
      await until(() => r.asked.at(-1)?.url === 'https://late.example/');
      r.relay.endTurn('conf');
      t.ok('ターンの終わりで確認を取り下げ、移動は止めたまま', !!(await hanging).error && !fake.served.includes('https://late.example/'));

      r.relay.setConfirm(false);
      t.ok('確認を OFF にすると、中継自身のセッションを外す', await until(() => !fake.sessions().some(s => s.fetch)));
      r.answer(async () => ({ allow: false }));
      const free = await a.cmd('Page.navigate', { url: 'https://free.example/' }, sid);
      t.ok('OFF なら聞かずに移動する', !free.error && fake.served.includes('https://free.example/'));

      // createTarget に URL があるときも、確認を通してから移る（断られたらタブを閉じる）
      r.relay.setConfirm(true);
      const tabsBefore = fake.targets().length;
      const createdDenied = await a.cmd('Target.createTarget', { url: 'https://newtab.example/' });
      t.ok('URL つきの createTarget も確認を通し、断られたら作ったタブを閉じる', !!createdDenied.error && !fake.served.includes('https://newtab.example/') && await until(() => fake.targets().length === tabsBefore));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 3b. サイトの確認の抜け道: 確認を ON にした直後・断った後の同じ origin・履歴の移動（要求を出さない bfcache の復元） =====
  {
    const r = await rig();
    let a;
    try {
      const fake = r.fake;
      a = await agent(await r.relay.endpoint('loop'));
      const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const tabUrl = () => fake.targets().find(x => x.targetId === tabId)?.url;

      // 確認を ON にした直後（中継の Fetch.enable が済む前）の移動
      fake.delayFetchEnable(150);
      r.relay.setConfirm(true);
      const first = await a.cmd('Page.navigate', { url: 'https://first.example/' }, sid);
      t.ok('確認を ON にした直後（中継の Fetch.enable が済む前）の移動も、確認を通してから移る', r.asked.length === 1 && r.asked[0].url === 'https://first.example/' && !first.error && fake.served.includes('https://first.example/'),
        JSON.stringify({ asked: r.asked, first }));
      fake.delayFetchEnable(0);

      // 断る → 同じ origin へもう一度（受け入れの不具合 4）
      r.answer(async () => ({ allow: false }));
      const denied1 = await a.cmd('Page.navigate', { url: 'https://denied.example/x' }, sid);
      t.ok('（偽の Chrome も実機と同じく、断った後の targetInfo の URL は断られた URL）', tabUrl() === 'https://denied.example/x');
      const askedBefore = r.asked.length;
      const denied2 = await a.cmd('Page.navigate', { url: 'https://denied.example/y' }, sid);
      t.ok('断った直後に同じ origin へもう一度移ると、確認がまた出る（エラーのページを今の origin と取り違えない）', denied1.error?.message === 'DENIED-TEXT' && denied2.error?.message === 'DENIED-TEXT'
        && r.asked.length === askedBefore + 1 && r.asked.at(-1).url === 'https://denied.example/y' && !fake.served.some(u => u.startsWith('https://denied.example')), JSON.stringify({ denied1, denied2, asked: r.asked.map(x => x.url) }));
      const cookieOnError = await a.cmd('Network.setCookie', { name: 'x', value: 'y', url: 'https://denied.example/' }, sid);
      t.ok('断った先のエラーのページでは、その origin の Cookie を書けない', !!cookieOnError.error);

      // 履歴の移動（要求を出さない bfcache の復元）
      r.answer(async () => ({ allow: true }));
      await a.cmd('Page.navigate', { url: 'https://a.example/' }, sid);
      await a.cmd('Page.navigate', { url: 'https://b.example/' }, sid);
      const entryOf = async url => (await a.cmd('Page.getNavigationHistory', {}, sid)).result.entries.filter(e => e.url === url).at(-1)?.id;
      const servedA = fake.served.filter(u => u === 'https://a.example/').length;
      let release;
      r.answer(() => new Promise(resolve => { release = resolve; }));
      const askedHistory = r.asked.length;
      const back = a.cmd('Page.navigateToHistoryEntry', { entryId: await entryOf('https://a.example/') }, sid);
      t.ok('許可の無い origin へ履歴で戻る（要求を出さない）と、移った後に確認を出す', await until(() => r.asked.length === askedHistory + 1) && r.asked.at(-1).url === 'https://a.example/'
        && fake.served.filter(u => u === 'https://a.example/').length === servedA, JSON.stringify(r.asked.map(x => x.url)));
      let read = null;
      const reading = a.cmd('Runtime.evaluate', { expression: 'location.href' }, sid).then(m => { read = m; return m; });
      await sleep(80);
      t.ok('確認の答えを待つ間、そのタブへのエージェントのコマンドは待たせる（戻ったページを読ませない）', read === null, JSON.stringify(read));
      release({ allow: false });
      const backReply = await back;
      const readReply = await reading;
      t.ok('断ると about:blank に戻し、履歴の移動は断られた文で返る。待たせたコマンドは戻した後のページで答える', backReply.error?.message === 'DENIED-TEXT' && tabUrl() === 'about:blank' && readReply.result?.result?.value === 'about:blank',
        JSON.stringify({ backReply, readReply, url: tabUrl() }));
      r.answer(async () => ({ allow: true }));
      const askedAgain = r.asked.length;
      const again = await a.cmd('Page.navigateToHistoryEntry', { entryId: await entryOf('https://a.example/') }, sid);
      t.ok('許可すれば、履歴で戻った先にとどまる', !again.error && tabUrl() === 'https://a.example/' && r.asked.length === askedAgain + 1, JSON.stringify(again));
      await a.cmd('Page.navigate', { url: 'https://a.example/2' }, sid);
      const askedSame = r.asked.length;
      const sameBack = await a.cmd('Page.navigateToHistoryEntry', { entryId: await entryOf('https://a.example/') }, sid);
      t.ok('同じ origin の中の履歴の移動は聞かない', !sameBack.error && r.asked.length === askedSame && tabUrl() === 'https://a.example/');
      r.relay.endTurn('loop');
      const askedHuman = r.asked.length;
      await a.cmd('Page.enable', {}, sid);
      await fake.navigateUser(tabId, 'https://human.example/');
      t.ok('ターンの終わりの後、有効化しか送っていないタブの人の移動は聞かない', r.asked.length === askedHuman && tabUrl() === 'https://human.example/');
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 4. 止める・鍵・rebind・会話を消す =====
  {
    const r = await rig();
    let a;
    try {
      const url = await r.relay.endpoint('stopme');
      a = await agent(url);
      await a.cmd('Browser.getVersion');
      r.relay.stop('stopme');
      const closed = await a.closed;
      t.ok('止めると、つないでいる接続を閉じる', closed.code === 1000, JSON.stringify(closed));
      t.ok('止めた後は再接続を断る（鍵を出し直さない endpoint でも）', await refused(url) && (await r.relay.endpoint('stopme')) === url && await refused(url));
      const fresh = await r.relay.endpoint('stopme', { unlock: true });
      t.ok('次の人の送信（unlock）で新しい鍵になり、つなげる。古い鍵は断る', fresh !== url && !(await refused(fresh)) && await refused(url));
      const bad = fresh.replace(/.$/, fresh.endsWith('0') ? '1' : '0');
      t.ok('違う鍵を断る', await refused(bad));
      t.ok('Host が 127.0.0.1:<port> でない接続を断る', await refused(fresh, { headers: { Host: `localhost:${r.relay.port}` } }));
      const temp = await r.relay.endpoint('new:turn-key');
      r.relay.rebind('new:turn-key', 'native-1');
      t.ok('新しい会話の id が決まったら、同じ鍵のまま移る', (await r.relay.endpoint('native-1')) === temp && !(await refused(temp)));
      r.relay.forget('native-1');
      t.ok('会話を消したら鍵を捨てる', await refused(temp));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 5. 上りが無い・切れたとき =====
  {
    const r = await rig({ permission: 'hold', connectWaitMs: 300 });
    let a;
    try {
      a = await agent(await r.relay.endpoint('wait'));
      const reply = await a.cmd('Browser.getVersion');
      t.ok('つながっていなければ接続を求め、connectWaitMs で「まだつながっていない」と返す', /not connected/.test(reply.error?.message ?? ''), JSON.stringify(reply));
      t.ok('待つ人がいなくなった試行は止まる（確認を閉じて off）', await until(() => r.conn.state().state === 'off' && r.chrome.pending() === 0), JSON.stringify(r.conn.state()));
      const second = a.cmd('Browser.getVersion');
      await until(() => r.chrome.pending() === 1);
      r.chrome.approve();
      t.ok('待つ間に許可されれば、そのまま答える', (await second).result?.product === 'Chrome/154.0.8037.97');
      r.chrome.dropConnections();
      const gone = await a.closed;
      t.ok('上りが切れたら、エージェントの接続も閉じる', gone.code === 1011, JSON.stringify(gone));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 5b. 操作待ちの案内: 接続を求めるときに handoff.connect を呼び、待ち切れたら案内の字で返す =====
  {
    const calls = [];
    const r = await rig({ permission: 'hold', connectWaitMs: 300, handoff: { connect: (id, o) => { calls.push(id); return null; } }, connectWaitText: () => 'CONNECT-WAIT-TEXT' });
    let a;
    try {
      a = await agent(await r.relay.endpoint('wait'));
      const reply = await a.cmd('Browser.getVersion');
      t.ok('つながっていなければ handoff.connect を会話の id で呼ぶ', calls.length >= 1 && typeof calls[0] === 'string', JSON.stringify(calls));
      t.ok('待ち切れたら connectWaitText の字で返す', reply.error?.message === 'CONNECT-WAIT-TEXT', JSON.stringify(reply));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 5c. 更新で出ていくとき（handOff）、確認待ちの止まった要求は出る前に断る（ADR 0167。出た後は接続の子への道が閉じて、断りが届かない）=====
  {
    const r = await rig();
    let a;
    try {
      r.fake.setPage('https://pending.example/', { title: 'Pending' });
      a = await agent(await r.relay.endpoint('hand'));
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      await a.cmd('Page.enable', {}, sid);
      r.relay.setConfirm(true);
      await until(() => r.fake.sessions().some(s => s.targetId === tabId && s.fetch));
      r.answer((_request, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ allow: false }), { once: true })));
      void a.cmd('Page.navigate', { url: 'https://pending.example/' }, sid);
      await until(() => r.asked.at(-1)?.url === 'https://pending.example/');
      const cdp = r.relay.cdp;
      r.relay.handOff();
      cdp.close();   // 出ていった後は上りへ書けない（link.mjs は ended の後の行を捨てる）
      t.ok('handOff は、確認待ちの止まった要求を出る前に Fetch.failRequest（BlockedByClient）で断る',
        await until(() => r.chrome.calls.some(c => c.method === 'Fetch.failRequest' && c.params.errorReason === 'BlockedByClient')) && !r.fake.served.includes('https://pending.example/'));
    } finally { a?.close(); await r.stop(); }
  }

  // ===== 6. 環境変数: PIN_TAB・3 つのバックエンドへの受け渡し =====
  {
    const r = await rig();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pleiad-chrome-relay-env-'));
    try {
      const bridge = chromeRelayBrowser(r.relay);
      const env = await browserEnvironment({ bridge, dataDir: dir, sessionId: 'env-1' });
      const config = JSON.parse(await readFile(env.AGENT_BROWSER_CONFIG, 'utf8'));
      t.ok('Chrome の中継では cdp に中継の URL、AGENT_BROWSER_PIN_TAB=1 を足す', config.cdp === await r.relay.endpoint('env-1') && env.AGENT_BROWSER_PIN_TAB === '1');
      bridge.rebind('env-1', 'env-native');
      const again = await browserEnvironment({ bridge, dataDir: dir, sessionId: 'env-native' });
      t.ok('id が決まった後も設定の置き場を保ち、同じ鍵を使う', again.AGENT_BROWSER_CONFIG === env.AGENT_BROWSER_CONFIG && JSON.parse(await readFile(again.AGENT_BROWSER_CONFIG, 'utf8')).cdp === config.cdp);
      const plain = await browserEnvironment({ bridge: { endpoint: async () => 'ws://127.0.0.1:1/devtools/browser/k' }, dataDir: dir, sessionId: 'env-2' });
      t.ok('pinTab の無い橋では PIN_TAB を足さない', Object.keys(plain).join() === 'AGENT_BROWSER_CONFIG,AGENT_BROWSER_SESSION,AGENT_BROWSER_SOCKET_DIR,AGENT_BROWSER_NAMESPACE');
      for (const e of [env, plain]) await rm(e.AGENT_BROWSER_SOCKET_DIR, { recursive: true, force: true });

      // Codex は共有の app-server なので、スレッドの config で渡す。PIN_TAB があるときだけ足す
      const originalRpc = { request: nativeRpc.request, attach: nativeRpc.attach, claimOrphan: nativeRpc.claimOrphan, stop: nativeRpc.stop };
      const configs = [];
      let handlers, serial = 0;
      nativeRpc.claimOrphan = h => { handlers = h; return () => {}; };
      nativeRpc.attach = (_id, h) => { handlers = h; return () => {}; };
      nativeRpc.stop = () => {};
      nativeRpc.request = async (method, params) => {
        if (method === 'config/read') return { config: {} };
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
        if (method === 'model/list') return { data: [] };
        if (method === 'thread/start' || method === 'thread/resume') { configs.push(params.config['shell_environment_policy.set']); return { thread: { id: 'pin-thread' }, sandbox: { type: 'workspaceWrite', writableRoots: [dir], networkAccess: false } }; }
        if (method === 'turn/start') { const id = `turn-${++serial}`; const current = handlers; queueMicrotask(() => current.onNotification('turn/completed', { turn: { id, status: 'completed' } })); return { turn: { id } }; }
        throw new Error(`unexpected Codex RPC: ${method}`);
      };
      try {
        const first = await codex.runTurn({ prompt: 'x', cwd: dir, mode: 'ask', emit() {}, browserEnv: env, sessionId: null });
        await codex.runTurn({ prompt: 'x', cwd: dir, mode: 'ask', emit() {}, browserEnv: plain, sessionId: first.sessionId });
        t.ok('Codex のスレッドの環境変数に AGENT_BROWSER_PIN_TAB が届き、pinTab の無い橋では足さない', configs[0]?.AGENT_BROWSER_PIN_TAB === '1' && configs[0]?.AGENT_BROWSER_CONFIG === env.AGENT_BROWSER_CONFIG && configs[1] && !('AGENT_BROWSER_PIN_TAB' in configs[1]), JSON.stringify(configs));
      } finally { Object.assign(nativeRpc, originalRpc); }
    } finally { await rm(dir, { recursive: true, force: true }); await r.stop(); }
  }

  // ===== 7. agent-browser の本物を、偽の Chrome＋中継につなぐ通し =====
  {
    const r = await rig();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pleiad-chrome-relay-ab-'));
    let env = null;
    try {
      const site = 'https://site.example/';
      r.fake.setPage(`${site}a`, { title: 'Page A', elements: [{ role: 'heading', name: 'Heading A' }, { role: 'link', name: 'go b', href: '/b' }] });
      r.fake.setPage(`${site}b`, { title: 'Page B', elements: [{ role: 'heading', name: 'Heading B' }] });
      env = await browserEnvironment({ bridge: chromeRelayBrowser(r.relay), dataDir: dir, sessionId: 'ab-real' });
      const run = args => runAgentBrowser(args, env);
      const opened = await run(['open', `${site}a`]);
      t.ok('agent-browser open が中継越しに開く', opened.status === 0 && opened.stdout.includes('Page A'), opened.stdout + opened.stderr);
      const snap = await run(['snapshot', '-i']);
      t.ok('snapshot が範囲のタブの中身を返す', snap.status === 0 && /link "go b" \[ref=e2\]/.test(snap.stdout), snap.stdout + snap.stderr);
      const clicked = await run(['click', '@e2']);
      const titled = await run(['get', 'title']);
      t.ok('click で移る', clicked.status === 0 && await until(async () => (await run(['get', 'title'])).stdout.trim() === 'Page B', 8000), titled.stdout + clicked.stderr);
      const newTab = await run(['tab', 'new']);
      const switched = await run(['tab', 't2']);
      t.ok('tab t2（別のタブへ切り替え）は成功する（bringToFront は中継が握りつぶす）', switched.status === 0, switched.stdout + switched.stderr);
      const list = await run(['tab', 'list']);
      t.ok('tab new は会話の窓に作り、tab list に利用者のタブは出ない', newTab.status === 0 && list.status === 0 && !USER_TABS.some(x => list.stdout.includes(x.url) || list.stdout.includes(x.title)), list.stdout + list.stderr);
      const closed = await run(['close']);
      t.ok('close は中継との接続を切るだけ（Browser.close を送らない）', closed.status === 0 && !r.chrome.calls.some(c => c.method === 'Browser.close'), closed.stdout + closed.stderr);
      const userTargets = r.fake.targets().filter(x => x.windowId === r.fake.userWindow);
      t.ok('利用者の窓のタブはそのまま（数・URL）、上りへブラウザー全体の setAutoAttach を送っていない',
        userTargets.length === USER_TABS.length && USER_TABS.every(x => userTargets.some(u => u.url === x.url)) && r.fake.autoAttachCalls.length === 0);
      t.ok('利用者のタブへは、中継も agent-browser も attach していない', !r.chrome.calls.some(c => c.method === 'Target.attachToTarget' && userTargets.some(u => u.targetId === c.params.targetId)));
      const agentWindows = r.fake.targets().filter(x => x.type === 'page' && x.windowId !== r.fake.userWindow).map(x => x.windowId);
      t.ok('agent-browser の窓は、最小化せず、すべて画面の外の隠した窓', agentWindows.length >= 1 && agentWindows.every(id => r.fake.windows().find(w => w.windowId === id)?.state === 'normal' && r.os.hwnds().find(h => h.windowId === id)?.concealed === true));
      t.ok('agent-browser の tab tN が送る bringToFront・activateTarget は上りへ届かない', !r.chrome.calls.some(c => c.method === 'Page.bringToFront' || c.method === 'Target.activateTarget'));
    } finally {
      if (env) { await runAgentBrowser(['close'], env, { timeoutMs: 10_000 }).catch(() => {}); await rm(browserSocketDirectory(path.dirname(env.AGENT_BROWSER_CONFIG)), { recursive: true, force: true }).catch(() => {}); }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await r.stop();
    }
  }

  // ===== 8. サーバー越し: ターンは core の中継の端点を受け取る（parentPort の往復なし） =====
  {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ply-chrome-relay-server-'));
    const chrome = await startFakeChrome({ permission: 'auto' });
    const dataDir = path.join(scratch, 'data');
    const ppLog = path.join(scratch, 'pp.ndjson');
    await fs.mkdir(dataDir);
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir, FAKE_PARENT_PORT_LOG: ppLog },
      dataDir, entry: path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs') });
    let c, a, configDir = null;
    try {
      c = await openHost({ port: server.port, token: server.token, autoAllow: true });
      const turn = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ok' });
      const configs = await fs.readdir(path.join(dataDir, 'agent-browser')).catch(() => []);
      if (configs.length) configDir = path.join(dataDir, 'agent-browser', configs[0]);
      const config = configs.length === 1 ? JSON.parse(await readFile(path.join(dataDir, 'agent-browser', configs[0], 'agent-browser.json'), 'utf8')) : null;
      const sent = (await readFile(ppLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      t.ok('ターンの agent-browser.json の cdp は core の中継（parentPort へ endpoint を頼まない）', /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]{48}$/.test(config?.cdp ?? '') && !config.cdp.startsWith('ws://127.0.0.1:1/')
        && !sent.some(m => m.type === 'agent-browser-endpoint'), JSON.stringify({ config, sent: sent.map(m => m.type) }));
      a = await agent(config.cdp);
      t.ok('その端点から偽の Chrome につながり、範囲（この会話の窓）だけが見える', (await a.cmd('Browser.getVersion')).result?.product === 'Chrome/154.0.8037.97' && (await a.cmd('Target.getTargets')).result?.targetInfos?.length === 0);
      const second = await c.runTurn({ backend: 'fake', cwd: ROOT, sessionId: turn.sessionId, prompt: 'ok' });
      const after = JSON.parse(await readFile(path.join(dataDir, 'agent-browser', configs[0], 'agent-browser.json'), 'utf8'));
      t.ok('鍵の文字列はサーバーのログに出ない', !server.tail(200).includes(config.cdp.split('/').pop()));
      const configsAfter = await fs.readdir(path.join(dataDir, 'agent-browser'));
      t.ok('会話の id が決まった後のターンも同じ設定ファイル・同じ端点（中継の rebind）', second.sessionId === turn.sessionId && after.cdp === config.cdp && configsAfter.length === 1, JSON.stringify({ configsAfter, after }));
    } finally {
      a?.close(); c?.close?.(); await server.stop(); await chrome.stop();
      if (configDir) await rm(browserSocketDirectory(configDir), { recursive: true, force: true }).catch(() => {});
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
