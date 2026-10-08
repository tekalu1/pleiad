import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'server-chrome';
export const title = 'Chrome への接続（サーバー越し）: browser.chrome* の操作・chromeBrowser イベントはホストの画面だけ・使えない OS / Electron の無いホスト（偽の Chrome・parentPort の身代わり。ADR 0148・0153）';

const until = async (cond, ms = 8000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const states = c => c.events.filter(e => e.type === 'chromeBrowser').map(e => e.state);
/** fake backend に prompt を言わせて、返った本文を読む（browser-instructions / browser:... は渡った物をそのまま返す） */
const said = async (c, prompt) => {
  const turn = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt });
  return turn.events.filter(e => e.type === 'text.delta').map(e => e.text ?? e.delta ?? '').join('') || turn.events.find(e => e.type === 'text.end')?.text || '';
};
const fail = p => p.then(() => null, e => ({ code: e.code, message: e.message }));

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-chrome-'));
  const entry = path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs');
  const chrome = await startFakeChrome({ permission: 'hold' });
  const dirs = n => path.join(scratch, n);
  await fs.mkdir(dirs('data'));
  await fs.mkdir(dirs('data2'));
  await fs.mkdir(dirs('data3'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir, FAKE_PARENT_PORT_LOG: path.join(scratch, 'pp.ndjson') }, dataDir: dirs('data'), entry });
  let c, remote;
  try {
    c = await open({ port: server.port, token: server.token });
    await until(() => states(c).length > 0, 8000, 'initial chromeBrowser event');
    t.ok('つないだ画面に、今の状態（chromeBrowser）が届く', states(c)[0] === 'off', states(c).join());
    const caps = await c.cmd('hostCapabilities');
    t.ok('hostCapabilities.chromeBrowser はホストの画面で available', caps.chromeBrowser === 'available', JSON.stringify(caps));
    t.ok('browser.chromeStatus（chromeStatus）は状態を返す', (await c.cmd('chromeStatus')).state === 'off');

    // ---- リモートの接続（x-forwarded-for が付くと local ではない）には送らない・断る
    const frames = [];
    remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    remote.on('message', raw => { try { frames.push(JSON.parse(raw.toString())); } catch { /* 無視 */ } });
    await new Promise((resolve, reject) => { remote.once('open', resolve); remote.once('error', reject); });
    const ask = (command) => new Promise(resolve => {
      const id = `r${Math.random()}`;
      const on = raw => { const m = JSON.parse(raw.toString()); if (m.kind === 'response' && m.id === id) { remote.off('message', on); resolve(m); } };
      remote.on('message', on);
      remote.send(JSON.stringify({ kind: 'command', command, id, args: {} }));
    });
    const remoteCaps = await ask('hostCapabilities');
    t.ok('リモートの接続には hostCapabilities.chromeBrowser が false', remoteCaps.result.chromeBrowser === false, JSON.stringify(remoteCaps));
    const refused = await ask('chromeConnect');
    t.ok('リモートの接続からの chromeConnect は断る（ホストの画面だけ）', refused.ok === false && refused.code === 'HOST_SCREEN_ONLY', JSON.stringify(refused));

    // ---- つなぐ → permission → connected
    await c.cmd('chromeConnect');
    await until(() => chrome.pending() === 1, 8000, 'upgrade pending');
    await until(() => states(c).includes('permission'), 8000, 'permission event');
    chrome.approve();
    await until(() => states(c).includes('connected'), 8000, 'connected event');
    const connected = c.events.filter(e => e.type === 'chromeBrowser').at(-1);
    t.ok('browser.chromeConnect → chromeBrowser が permission → connected の順に届く（product つき）', states(c).join() === 'off,permission,connected' && connected.product === 'Chrome/154.0.8037.97', states(c).join());
    t.ok('イベントは sessionId: null の全体の便り', connected.sessionId === null);
    t.ok('第 2 段でサーバーが Chrome へ送った CDP は Browser.getVersion だけ', chrome.calls.map(x => x.method).join() === 'Browser.getVersion', chrome.calls.map(x => x.method).join());
    const raise = await c.cmd('chromeRaiseDialog');
    t.ok('chromeRaiseDialog は確認が無ければ raised: false（投げない）', raise.raised === false, JSON.stringify(raise));

    // ---- 切る → off。リモートには何も届かない
    const off = await c.cmd('chromeDisconnect');
    t.ok('browser.chromeDisconnect（切る）→ off', off.state === 'off' && off.reason === 'disconnected', JSON.stringify(off));
    await until(() => states(c).at(-1) === 'off', 8000, 'off event');
    await new Promise(resolve => setTimeout(resolve, 200));
    t.ok('リモートの接続には chromeBrowser のイベントを 1 つも送らない', !frames.some(f => f.kind === 'event' && f.event?.type === 'chromeBrowser'), JSON.stringify(frames.filter(f => f.kind === 'event').map(f => f.event.type)));

    // ---- 操作の面: chromeStatus だけが MCP・CLI に出る。つなぐ・切る・前に出すは出ない
    const agent = { by: 'agent', via: 'mcp', sessionId: null };
    const status = await registry.invoke(agent, 'browser.chromeStatus', {}, { locale: 'ja' });
    t.ok('使える OS のターンには、指示が渡る（対照）', (await said(c, 'browser-instructions')) !== '(none)');
    t.ok('browser.chromeStatus は MCP から読める（Electron の無いこの呼び出しでは unsupported）', status.ok === true && status.result.state === 'unsupported' && registry.get('browser.chromeStatus').surfaces.mcp === 'catalog');
    for (const id of ['browser.chromeConnect', 'browser.chromeDisconnect', 'browser.chromeRaiseDialog']) {
      const r = await registry.invoke(agent, id, {}, { locale: 'ja' });
      t.ok(`${id} は MCP からは見つからない（画面だけ）`, r.ok === false && r.code === 'NOT_FOUND' && registry.get(id).surfaces.mcp === false && registry.get(id).surfaces.cli === false && registry.get(id).hostScreenOnly === true);
    }
  } finally {
    remote?.terminate();
    c?.close();
    await server.stop();
  }

  // ---- OS の層が使えない OS（main が chrome-os-ready { supported: false } を返す）
  {
    const s = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir, FAKE_CHROME_OS: 'unsupported' }, dataDir: dirs('data2'), entry });
    let u;
    try {
      u = await open({ port: s.port, token: s.token, autoAllow: true });
      await until(async () => (await u.cmd('chromeStatus')).state === 'unsupported', 8000, 'unsupported');
      t.ok('OS の層が unsupported → hostCapabilities.chromeBrowser は unsupported', (await u.cmd('hostCapabilities')).chromeBrowser === 'unsupported');
      const connect = await fail(u.cmd('chromeConnect'));
      t.ok('chromeConnect は「この OS ではまだ使えません」で断る（UNSUPPORTED。upgrade は投げない）', connect?.code === 'UNSUPPORTED' && /まだ使えません/.test(connect.message) && chrome.upgrades === 1, JSON.stringify(connect));
      t.ok('状態の便りも unsupported', states(u).at(-1) === 'unsupported', states(u).join());
      t.ok('使えない OS のターンには、ブラウザーの環境変数・指示・ply_browser を渡さない', await said(u, 'browser-instructions') === '(none)' && await said(u, 'browser:{"name":"hand_to_user","arguments":{}}') === 'browser: unavailable');
    } finally { u?.close(); await s.stop(); }
  }

  // ---- Electron の無いホスト（parentPort が無い。npm start）
  {
    const s = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: dirs('data3') });
    let p;
    try {
      p = await open({ port: s.port, token: s.token, autoAllow: true });
      t.ok('Electron の無いホストでは hostCapabilities.chromeBrowser が false', (await p.cmd('hostCapabilities')).chromeBrowser === false);
      t.ok('chromeBrowser のイベントも送らない', states(p).length === 0);
      const connect = await fail(p.cmd('chromeConnect'));
      t.ok('chromeConnect は UNSUPPORTED で断る', connect?.code === 'UNSUPPORTED', JSON.stringify(connect));
      t.ok('chromeStatus は unsupported', (await p.cmd('chromeStatus')).state === 'unsupported');
      t.ok('Electron の無いホストのターンにも、ブラウザーの環境変数・指示・ply_browser を渡さない', await said(p, 'browser-instructions') === '(none)' && await said(p, 'browser:{"name":"hand_to_user","arguments":{}}') === 'browser: unavailable');
    } finally { p?.close(); await s.stop(); }
  }

  await chrome.stop();
  await fs.rm(scratch, { recursive: true, force: true });
}
