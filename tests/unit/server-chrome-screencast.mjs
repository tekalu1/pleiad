import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';

export const name = 'server-chrome-screencast';
export const title = 'Chrome の窓の映像（サーバー越し）: chromeWindow イベントがホストの画面にもリモートの端末にも届く・接続の直後に今の分・hostCapabilities.chromeWindow・source: chrome の映像と view-only（偽の Chrome・parentPort の身代わり。ADR 0148 第 5 段）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (cond, ms = 10000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
};

/** リモートの接続（x-forwarded-for が付くとホストの画面ではない）。受けた全部を frames に残す */
async function remoteClient(server) {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  ws.on('message', raw => { try { frames.push(JSON.parse(raw.toString())); } catch { /* 無視 */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let n = 0;
  const ask = (command, args = {}) => new Promise(resolve => {
    const id = `r${++n}`;
    const on = raw => { const m = JSON.parse(raw.toString()); if (m.kind === 'response' && m.id === id) { ws.off('message', on); resolve(m); } };
    ws.on('message', on);
    ws.send(JSON.stringify({ kind: 'command', command, id, args }));
  });
  const windowEvents = () => frames.filter(f => f.kind === 'event' && f.event?.type === 'chromeWindow').map(f => f.event);
  return { ws, frames, ask, windowEvents, close() { ws.terminate(); } };
}

/** エージェントの側（agent-browser の代わり） */
function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => { const msg = JSON.parse(data.toString()); if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
    ws.once('open', () => resolve({
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-chrome-sc-'));
  const entry = path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs');
  const chrome = await startFakeChrome({ permission: 'auto' });
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_AGENT_BROWSER: 'chrome', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir, entry });
  let c, remote, late, a;
  try {
    c = await open({ port: server.port, token: server.token });
    remote = await remoteClient(server);
    t.ok('ホストの画面の hostCapabilities.chromeWindow は true', (await c.cmd('hostCapabilities')).chromeWindow === true);
    const remoteCaps = await remote.ask('hostCapabilities');
    t.ok('リモートの端末の hostCapabilities.chromeWindow も true（Chrome の窓の映像は端末からも見られる。chromeBrowser は false のまま）', remoteCaps.result.chromeWindow === true && remoteCaps.result.chromeBrowser === false, JSON.stringify(remoteCaps.result));

    // 会話のターンを走らせて、agent-browser の端点（会話ごとの鍵付きの中継）を作らせる
    const from = c.mark();
    c.cmd('runTurn', { backend: 'fake', cwd: dataDir, prompt: 'slow' }).catch(() => {});
    await c.waitFor(e => e.type === 'session' && e.sessionId, { from, ms: 20000 });
    const cdpUrl = await until(async () => {
      const root = path.join(dataDir, 'agent-browser');
      for (const d of await fs.readdir(root).catch(() => [])) {
        const text = await fs.readFile(path.join(root, d, 'agent-browser.json'), 'utf8').catch(() => null);
        if (text) return JSON.parse(text).cdp;
      }
      return null;
    }, 20000, 'agent-browser config');
    t.ok('窓を開く前は、chromeWindow の知らせは無い', c.events.every(e => e.type !== 'chromeWindow') && remote.windowEvents().length === 0);

    // エージェントが窓を開く
    a = await agent(cdpUrl);
    const opened = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
    t.ok('エージェントが窓を開けた（偽の Chrome にタブができた）', !!opened && chrome.browser.targets().some(x => x.targetId === opened));
    const hostEvent = await until(() => c.events.filter(e => e.type === 'chromeWindow' && e.windows > 0).at(-1), 10000, 'chromeWindow (host)');
    t.ok('ホストの画面に chromeWindow（窓 1 つ・操作中）が届く', hostEvent.windows === 1 && hostEvent.operating === true && typeof hostEvent.sessionId === 'string', JSON.stringify(hostEvent));
    const remoteEvent = await until(() => remote.windowEvents().filter(e => e.windows > 0).at(-1), 10000, 'chromeWindow (remote)');
    t.ok('リモートの端末にも同じ chromeWindow が届く', remoteEvent.sessionId === hostEvent.sessionId && remoteEvent.windows === 1 && remoteEvent.operating === true, JSON.stringify(remoteEvent));
    const id = hostEvent.sessionId;

    // 後から接続した端末には、今の分が接続の直後に届く
    late = await remoteClient(server);
    t.ok('後から接続した端末には、今の窓の知らせが続けて届く', await until(() => late.windowEvents().some(e => e.sessionId === id && e.windows === 1), 10000, 'chromeWindow (late)'));

    // 映像: リモートの端末から source: chrome で見る。ホストの画面からも見られる
    const watch = await remote.ask('browserScreencast', { sessionId: id, source: 'chrome', width: 400, height: 300, scale: 1 });
    t.ok('リモートの端末から browserScreencast（source: chrome）で見始められる', watch.ok === true && typeof watch.result?.tabId === 'string', JSON.stringify(watch));
    await until(() => chrome.browser.screencasting(opened), 10000, 'screencasting');
    chrome.browser.screencastFrame(opened);
    const frame = await until(() => remote.frames.find(f => f.kind === 'screencast' && f.type === 'frame'), 10000, 'frame');
    t.ok('フレームは source: chrome 付きで、見ている端末にだけ届く', frame.source === 'chrome' && frame.sessionId === id && !late.frames.some(f => f.kind === 'screencast') && !c.events.some(e => e.type === 'frame'));
    const input = await remote.ask('browserScreencastInput', { sessionId: id, source: 'chrome', input: { type: 'tap', x: 1, y: 1 } });
    t.ok('入力は view-only で断る（見るだけ）', input.ok === false && input.code === 'view-only', JSON.stringify(input));
    const nav = await remote.ask('browserScreencastNav', { sessionId: id, source: 'chrome', action: 'reload' });
    t.ok('移動も view-only', nav.ok === false && nav.code === 'view-only');
    const hostWatch = await c.cmd('browserScreencast', { sessionId: id, source: 'chrome', width: 400, height: 300 });
    const inapp = await c.cmd('browserScreencast', { sessionId: id, width: 400, height: 300 }).then(() => null, e => e.code);
    t.ok('ホストの画面（local）からも source: chrome で見られる（source なしの内蔵ブラウザーは remote-only のまま）', typeof hostWatch.tabId === 'string' && inapp === 'remote-only', String(inapp));
    const nobody = await remote.ask('browserScreencast', { sessionId: 'nobody', source: 'chrome' });
    t.ok('窓の無い会話は no-window', nobody.ok === false && nobody.code === 'no-window', JSON.stringify(nobody));

    // 見る端末の接続が切れても、もう一方が見ていれば続き、全員いなくなれば止まる
    remote.close();
    await sleep(300);
    t.ok('見ている端末の接続が切れても、ホストの画面が見ていれば映像は続く', chrome.browser.screencasting(opened));
    await c.cmd('browserScreencastStop', { sessionId: id, source: 'chrome' });
    t.ok('全員が見るのをやめると screencast を止める', await until(() => !chrome.browser.screencasting(opened), 10000, 'screencast stopped'));

    // 窓が閉じると chromeWindow が 0 になって両方へ届く
    chrome.browser.closeTab(opened);
    t.ok('窓が閉じると windows: 0 の chromeWindow が届く（入口が消える）', await until(() => c.events.filter(e => e.type === 'chromeWindow').at(-1)?.windows === 0 && late.windowEvents().at(-1)?.windows === 0, 10000, 'windows 0'));
  } finally {
    a?.close(); remote?.close(); late?.close(); c?.close();
    await server.stop();
    await chrome.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
