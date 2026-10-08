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
const within = (promise, ms, detail) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(detail())), ms); })]).finally(() => clearTimeout(timer));
};

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

  // ---- エージェントの Chrome の窓の止める・引き継ぐ・戻す（chromeTakeOver・chromeResume・chromeStop。Chrome の中継があるデスクトップ版）
  {
    await fs.mkdir(dirs('data4'));
    const s = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir: dirs('data4'), entry });
    let u, v;
    try {
      u = await open({ port: s.port, token: s.token, autoAllow: true });
      const noWindow = await fail(u.cmd('chromeTakeOver', { sessionId: 'nobody' }));
      t.ok('引き継げる窓が無ければ NO_WINDOW（画面の言語の文で断る）', noWindow?.code === 'NO_WINDOW' && /引き継げる Chrome の窓がありません/.test(noWindow.message), JSON.stringify(noWindow));
      const stopped = await u.cmd('chromeStop', { sessionId: 'nobody' });
      t.ok('止めるものが無ければ idle（投げない）', stopped.state === 'idle' && stopped.sessionId === 'nobody', JSON.stringify(stopped));
      const resumed = await u.cmd('chromeResume', { sessionId: 'nobody' });
      t.ok('戻すものが無ければ idle', resumed.state === 'idle');
      t.ok('sessionId が無ければ入力の検査で断る', (await fail(u.cmd('chromeTakeOver', {})))?.code === 'INVALID');

      // ターンを走らせると中継の端点が渡される → 会話ごとの状態の便り（running → idle）が全部の接続へ届く
      const turn = await u.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ok' });
      const ofTurn = () => u.events.filter(e => e.type === 'chromeControl' && e.sessionId === turn.sessionId).map(e => e.state);
      await until(() => ofTurn().at(-1) === 'idle', 8000, 'chromeControl idle');
      t.ok('ターンの間は running、終わると idle の便りが会話の id つき（付け替えた後の本物の id）で届く', ofTurn().includes('running') && ofTurn().at(-1) === 'idle', ofTurn().join());

      // リモートの接続（x-forwarded-for）にも便りが届き、操作は受ける（ホストの画面だけではない）
      v = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${s.token}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
      const frames = [];
      v.on('message', raw => { try { frames.push(JSON.parse(raw.toString())); } catch { /* 無視 */ } });
      await new Promise((resolve, reject) => { v.once('open', resolve); v.once('error', reject); });
      const ask = (command, args) => new Promise(resolve => {
        const id = `r${Math.random()}`;
        const on = raw => { const m = JSON.parse(raw.toString()); if (m.kind === 'response' && m.id === id) { v.off('message', on); resolve(m); } };
        v.on('message', on);
        v.send(JSON.stringify({ kind: 'command', command, id, args }));
      });
      const remote = await ask('chromeTakeOver', { sessionId: 'nobody' });
      t.ok('リモートの端末からも受ける（ホストの画面だけではない）。窓が無いので NO_WINDOW', remote.ok === false && remote.code === 'NO_WINDOW', JSON.stringify(remote));
      await u.runTurn({ backend: 'fake', cwd: ROOT, sessionId: turn.sessionId, prompt: 'again' });
      await until(() => frames.some(f => f.kind === 'event' && f.event?.type === 'chromeControl'), 8000, 'remote chromeControl');
      t.ok('リモートの接続にも会話ごとの状態の便りが届く', frames.some(f => f.kind === 'event' && f.event?.type === 'chromeControl' && f.event.sessionId === turn.sessionId));

      // 操作の面: 人だけ（MCP・CLI には出さない）
      const agent = { by: 'agent', via: 'mcp', sessionId: null };
      for (const id of ['browser.chromeTakeOver', 'browser.chromeResume', 'browser.chromeStop']) {
        const r = await registry.invoke(agent, id, { sessionId: 'x' }, { locale: 'ja' });
        t.ok(`${id} は MCP からは見つからない（画面とリモートの端末だけ）`, r.ok === false && r.code === 'NOT_FOUND' && registry.get(id).risk === 'write' && registry.get(id).surfaces.mcp === false && registry.get(id).surfaces.cli === false && registry.get(id).hostScreenOnly === false);
      }

      // ---- ビューアの⋯「Chrome で開く」（chromeOpen）: ホストの画面だけ。つながっていなければ Chrome の許可を待つ（接続の案内のカードは出さない）
      const badUrl = await fail(u.cmd('chromeOpen', { sessionId: turn.sessionId, url: 'file:///C:/secret.txt' }));
      t.ok('chromeOpen: http(s) でない URL は INVALID（画面の言語の字）', badUrl?.code === 'INVALID' && /http・https/.test(badUrl.message), JSON.stringify(badUrl));
      const remoteOpen = await ask('chromeOpen', { sessionId: turn.sessionId, url: 'https://a.example/' });
      t.ok('chromeOpen: リモートの端末からは断る（HOST_SCREEN_ONLY）', remoteOpen.ok === false && remoteOpen.code === 'HOST_SCREEN_ONLY', JSON.stringify(remoteOpen));
      const opening = u.cmd('chromeOpen', { sessionId: turn.sessionId, url: 'https://a.example/' });
      await until(() => chrome.pending() >= 1, 8000, 'chromeOpen upgrade pending');
      chrome.approve();
      const opened = await opening;
      t.ok('chromeOpen: 許可されると会話の窓に URL を開き、targetId を返す', opened.sessionId === turn.sessionId && chrome.browser.targets().some(x => x.targetId === opened.targetId && x.url === 'https://a.example/'), JSON.stringify(opened));
      t.ok('chromeOpen: 待つ間に承認のカードを出さない', !u.events.some(e => e.type === 'permission'));
      const openOp = registry.get('browser.chromeOpen');
      const viaMcp = await registry.invoke(agent, 'browser.chromeOpen', { sessionId: 'x', url: 'https://a.example/' }, { locale: 'ja' });
      t.ok('browser.chromeOpen は MCP・CLI に出さない（write・ホストの画面だけ）', viaMcp.ok === false && viaMcp.code === 'NOT_FOUND' && openOp.risk === 'write' && openOp.surfaces.mcp === false && openOp.surfaces.cli === false && openOp.hostScreenOnly === true);

      // ---- 端末から引き継ぐ（chromeTakeOver の by: device）
      const noSize = await fail(u.cmd('chromeTakeOver', { sessionId: turn.sessionId, by: 'device' }));
      t.ok('by: device で大きさが無ければ INVALID（画面の言語の字）', noSize?.code === 'INVALID' && /映像の箱の大きさ/.test(noSize.message), JSON.stringify(noSize));
      const device = await ask('chromeTakeOver', { sessionId: turn.sessionId, by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('リモートの端末から by: device で引き継ぐ → paused・by: device', device.ok === true && device.result.state === 'paused' && device.result.by === 'device', JSON.stringify(device));
      await until(() => u.events.some(e => e.type === 'chromeControl' && e.sessionId === turn.sessionId && e.state === 'paused' && e.by === 'device'), 8000, 'chromeControl by device');
      t.ok('状態の便りに by: device が載る', true);
      const back = await ask('chromeResume', { sessionId: turn.sessionId });
      t.ok('端末から戻す → 一時停止が解け、by は null', back.ok === true && back.result.state !== 'paused' && back.result.by === null, JSON.stringify(back));
      const closeOp = registry.get('browser.chromeCloseWindow');
      const closeFromMcp = await registry.invoke(agent, 'browser.chromeCloseWindow', { sessionId: turn.sessionId }, { locale: 'ja' });
      t.ok('browser.chromeCloseWindow は write で MCP・CLI に出さない', closeOp.risk === 'write' && closeOp.surfaces.mcp === false && closeOp.surfaces.cli === false && closeFromMcp.code === 'NOT_FOUND');
      const closed = await within(ask('chromeCloseWindow', { sessionId: turn.sessionId }), 10000, () => `chromeCloseWindow timed out\n${s.tail(60)}`);
      t.ok('リモートの端末から窓を閉じると、最後の画面の記録が届き窓の数が 0 になる', closed.ok === true && closed.result.closed === true
        && await until(() => u.events.some(e => e.type === 'present' && e.sessionId === turn.sessionId && e.kind === 'chromeClosed' && e.path?.endsWith('.png')))
        && await until(() => u.events.some(e => e.type === 'chromeWindow' && e.sessionId === turn.sessionId && e.windows === 0)));
      const reopened = await u.cmd('chromeOpen', { sessionId: turn.sessionId, url: 'https://again.example/' });
      const closedLines = u.events.filter(e => e.type === 'present' && e.sessionId === turn.sessionId && e.kind === 'chromeClosed').length;
      const deleted = await u.cmd('deleteSession', { sessionId: turn.sessionId });
      t.ok('会話を消すと開き直した窓も閉じ、閉じた行を新しく残さない', deleted === 'deleted'
        && !chrome.browser.targets().some(tab => tab.targetId === reopened.targetId)
        && u.events.filter(e => e.type === 'present' && e.sessionId === turn.sessionId && e.kind === 'chromeClosed').length === closedLines);
    } finally { v?.terminate(); u?.close(); await s.stop(); }
  }

  // ---- 中継が無い（Electron の無いホスト）→ 操作は UNSUPPORTED、便りは出ない
  {
    await fs.mkdir(dirs('data5'));
    const s = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir: dirs('data5') });
    let u;
    try {
      u = await open({ port: s.port, token: s.token, autoAllow: true });
      const take = await fail(u.cmd('chromeTakeOver', { sessionId: 'x' }));
      t.ok('中継が無ければ chromeTakeOver は UNSUPPORTED', take?.code === 'UNSUPPORTED', JSON.stringify(take));
      await u.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ok' });
      t.ok('chromeControl の便りは出さない', !u.events.some(e => e.type === 'chromeControl'));
    } finally { u?.close(); await s.stop(); }
  }

  await chrome.stop();
  await fs.rm(scratch, { recursive: true, force: true });
}
