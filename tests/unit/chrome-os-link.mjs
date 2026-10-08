// Chrome の OS の層を、名前付きパイプの経路（無停止の更新。AGENT_HOST_HANDOVER=on）で作る（docs/zero-downtime-update/design.md §7.2）。
// 本物のサーバー（core/server.mjs）に偽の main（desktop/server-link.cjs）をつなぎ、偽の Chrome で確かめる。
//   - process.parentPort が無くても OS の層が作られ、エージェントのブラウザーが使える（hostCapabilities.chromeBrowser）
//   - つなぐと、chrome-os の依頼が main に届き、main の答えで進む
//   - main が切れて付け直すと、サーバーが chrome-os-ready を求め直す
//   - main が居ない間は、待っている呼び出しを失敗（null・false）で返し、層は pending に戻る（口だけの試験）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../lib/server.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { open } from '../lib/ws-client.mjs';
import { parentPortChromeOs } from '../../core/chrome/os.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');

export const name = 'chrome-os-link';
export const title = 'Chrome の OS の層をパイプの経路で作る: parentPort が無くても層ができる・chrome-os の依頼が main に届いて答えが返る・付け直しで chrome-os-ready を求め直す・main が居ない間は呼び出しを失敗で返す';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(20);
  }
}

/** 偽の main: chrome-os-ready-request に使える層で答え、chrome-os の依頼を溜めて空の結果を返す */
function fakeMain(dataDir) {
  let client = null;
  const seen = { messages: [] };
  const attach = () => {
    const info = readLinkInfo(dataDir);
    client = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
    client.on('message', message => {
      seen.messages.push(message);
      if (message?.type === 'chrome-os-ready-request') client.postMessage({ type: 'chrome-os-ready', supported: true, features: { dialog: true, raise: true } });
      if (message?.type === 'chrome-os') client.postMessage({ type: 'chrome-os-result', id: message.id, ok: true, result: message.action === 'snapshotWindows' ? [] : null });
    });
    return client;
  };
  return { seen, attach, get link() { return client; } };
}

export default async function (t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-chrome-os-link-'));
  const chrome = await startFakeChrome({ permission: 'hold' });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_HANDOVER: 'on', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir }, dataDir: scratch, timeoutMs: 60_000 });
  const main = fakeMain(scratch);
  let client;
  try {
    await waitFor(() => readLinkInfo(scratch), 8000, 'main-link.json');
    await main.attach().connect();
    await waitFor(() => main.seen.messages.some(m => m.type === 'chrome-os-ready-request'), 8000, 'chrome-os-ready-request');
    t.ok('つながると、サーバーが chrome-os-ready を求める', true);
    client = await open({ port: server.port, token: server.token });
    t.ok('パイプの経路でも hostCapabilities.chromeBrowser が available（OS の層ができている）', (await client.cmd('hostCapabilities')).chromeBrowser === 'available');
    await client.cmd('chromeConnect');
    await waitFor(() => main.seen.messages.some(m => m.type === 'chrome-os' && m.action === 'snapshotWindows'), 8000, 'chrome-os snapshotWindows');
    await waitFor(() => chrome.pending() === 1, 8000, 'upgrade pending');
    t.ok('chromeConnect の chrome-os の依頼が main に届き、答えで Chrome への接続が進む', chrome.pending() === 1);
    chrome.approve();
    await waitFor(async () => (await client.cmd('chromeStatus')).state === 'connected', 8000, 'connected');

    // main が切れて付け直す → 求め直す
    main.link.leave();
    await sleep(200);
    main.seen.messages.length = 0;
    await main.attach().connect();
    await waitFor(() => main.seen.messages.some(m => m.type === 'chrome-os-ready-request'), 8000, 'chrome-os-ready-request（付け直し）');
    t.ok('付け直した main にも、サーバーが chrome-os-ready を求め直す', true);
  } finally {
    client?.close();
    try { main.link?.kill(); } catch { /* 終わっていれば何もしない */ }
    await server.stop();
    await chrome.stop?.();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // ---- 口だけ: main が居ない間は呼び出しを失敗で返し、戻ったら求め直す
  {
    const handlers = { message: [], connect: [], disconnect: [] };
    const posts = [];
    const port = { resumable: true, connected: true, on: (type, fn) => handlers[type]?.push(fn), postMessage: m => { posts.push(m); return port.connected; } };
    const core = parentPortChromeOs(port, { timeoutMs: 5000, readyWaitMs: 200 });
    const say = message => handlers.message.forEach(fn => fn({ data: message }));
    say({ type: 'chrome-os-ready', supported: true, features: { dialog: true } });
    const waiting = core.snapshotWindows();
    t.ok('層ができると、呼び出しは main へ送られる', posts.some(m => m.type === 'chrome-os' && m.action === 'snapshotWindows'));
    port.connected = false;
    handlers.disconnect.forEach(fn => fn());
    t.ok('main が切れたら、待っていた呼び出しを失敗（null）で返す', await waiting === null);
    t.ok('切れている間は pending に戻り、呼び出しは送らず失敗で返す', core.capabilities().reason === 'pending' && await core.close({ id: '1' }) === false && posts.filter(m => m.type === 'chrome-os').length === 1);
    posts.length = 0;
    port.connected = true;
    handlers.connect.forEach(fn => fn());
    t.ok('つながり直したら chrome-os-ready を求め直す', posts.some(m => m.type === 'chrome-os-ready-request'));
    let fired = 0;
    core.onReady(() => { fired++; });
    say({ type: 'chrome-os-ready', supported: true, features: { dialog: true } });
    t.ok('main の返事で層が戻り、onReady が呼ばれる', core.capabilities().supported === true && fired === 1);
    // 送れなかった（postMessage が false）呼び出しは待たずに失敗
    port.postMessage = () => false;
    t.ok('postMessage が false を返したら、待たずに失敗で返す', await core.foreground() === null);
  }
}
