import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserEnvironment, parentPortBrowser, browserInstruction, browserSocketDirectory } from '../../core/agent-browser.mjs';
import { rpc as nativeRpc } from '../../core/backends/codex-rpc.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { AgySession } from '../../core/backends/antigravity-cli.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';

const require = createRequire(import.meta.url);
const { createBrowserRelay } = require('../../desktop/browser-relay.cjs');
const { createBrowserNavigation } = require('../../desktop/browser-navigation.cjs');
export const name = 'agent-browser-relay';
export const title = '会話別 CDP 中継・鍵・停止・環境変数';

function fakePanel() {
  let serial = 0;
  const tabs = [];
  const listeners = new Set();
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
    const tab = { id, sessionId, webContents: { debugger: debuggerApi, isDestroyed: () => false, getTitle: () => id, getURL: () => url } };
    tabs.push(tab);
    for (const listener of listeners) listener('created', tab);
    return tab;
  }
  return { createFor, tabsFor: sessionId => tabs.filter(x => x.sessionId === sessionId), selectFor() {}, closeFor(id) { const index = tabs.findIndex(x => x.id === id); if (index < 0) return; const [tab] = tabs.splice(index, 1); for (const listener of listeners) listener('destroyed', tab); }, rebindSession(from, to) { for (const tab of tabs) if (tab.sessionId === from) tab.sessionId = to; }, onTabsChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
/** 知らせは WebSocket を通って届くので、1 回の setTimeout では足りないことがある。届くまで上限付きで待つ */
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}
function open(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.once('open', () => resolve(ws)); ws.once('error', reject); }); }
function ask(ws, method, params = {}, sessionId) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 2000);
    const receive = raw => { const msg = JSON.parse(raw.toString()); if (msg.id !== id) return; clearTimeout(timer); ws.off('message', receive); resolve(msg); };
    ws.on('message', receive);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
export default async function (t) {
  const panel = fakePanel();
  const relay = createBrowserRelay(panel);
  let ws, wsTwo;
  try {
    const url = await relay.endpoint('one');
    const urlTwo = await relay.endpoint('two');
    await relay.endpoint('idle');
    t.ok('endpoint() はタブを作らない（ターンの開始だけでは空のタブが増えない）', panel.tabsFor('one').length === 0 && panel.tabsFor('two').length === 0 && panel.tabsFor('idle').length === 0);
    ws = await open(url);
    await ask(ws, 'Browser.getVersion');
    t.ok('エージェントがつないだ会話にだけタブを 1 枚作る', panel.tabsFor('one').length === 1 && panel.tabsFor('two').length === 0 && panel.tabsFor('idle').length === 0);
    wsTwo = await open(urlTwo);
    await ask(wsTwo, 'Browser.getVersion');
    t.ok('別の会話がつないでも、その会話の分だけ作る', panel.tabsFor('one').length === 1 && panel.tabsFor('two').length === 1);
    const again = await open(url);
    await ask(again, 'Browser.getVersion'); again.close();
    t.ok('つなぎ直してもタブが残っていれば増やさない', panel.tabsFor('one').length === 1);
    const targets = (await ask(ws, 'Target.getTargets')).result.targetInfos;
    t.ok('ほかの会話と本体のターゲットは見えない', targets.length === 1 && targets[0].targetId === 'frame-t1');
    t.ok('Browser.getVersion と getBrowserContexts', !!(await ask(ws, 'Browser.getVersion')).result.product && Array.isArray((await ask(ws, 'Target.getBrowserContexts')).result.browserContextIds));
    const sid = (await ask(ws, 'Target.attachToTarget', { targetId: targets[0].targetId })).result.sessionId;
    t.ok('ページセッションに応答の sessionId が付く', (await ask(ws, 'Page.navigate', { url: 'http://localhost/test' }, sid)).sessionId === sid);
    t.ok('遷移後も同じターゲットを追う', (await ask(ws, 'Target.getTargetInfo', { targetId: 'frame-t1' })).result.targetInfo.url === 'http://localhost/test');
    t.ok('Browser.close と別会話への attach を断る', !!(await ask(ws, 'Browser.close')).error && !!(await ask(ws, 'Target.attachToTarget', { targetId: 'frame-t2' })).error);
    t.ok('ページからの file: 遷移を断る', !!(await ask(ws, 'Page.navigate', { url: 'file:///secret' }, sid)).error);
    const created = (await ask(ws, 'Target.createTarget', { url: 'about:blank' })).result.targetId;
    t.ok('新しいタブは同じ会話だけに入る', created === 'frame-t3' && panel.tabsFor('one').length === 2);
    const events = [];
    ws.on('message', raw => { const msg = JSON.parse(raw.toString()); if (msg.method) events.push(msg); });
    await ask(ws, 'Target.setDiscoverTargets', { discover: true });
    const uiTab = panel.createFor('one');
    t.ok('画面で追加したタブを発見する', await until(() => events.some(event => event.method === 'Target.targetCreated' && event.params.targetInfo.targetId === 'frame-' + uiTab.id)));
    panel.closeFor(uiTab.id);
    t.ok('画面で閉じたタブを通知する', await until(() => events.some(event => event.method === 'Target.targetDestroyed' && event.params.targetId === 'frame-' + uiTab.id)));
    panel.closeFor('t1');
    t.ok('閉じたタブへのページコマンドを断る', !!(await ask(ws, 'Page.navigate', { url: 'http://localhost/closed' }, sid)).error);
    relay.disconnect('one', true);
    await new Promise(resolve => ws.once('close', resolve));
    t.ok('止めると既存接続を切り再接続を拒否', await open(url).then(() => false, () => true));
    relay.resume('one');
    const newUrl = await relay.endpoint('one');
    const resumed = await open(newUrl); resumed.close();
    t.ok('次の送信では新しい鍵で再接続できる', newUrl !== url && resumed.readyState !== WebSocket.CONNECTING && await open(url).then(() => false, () => true));
    relay.disconnect('one');
    const takenOver = await open(newUrl); takenOver.close();
    t.ok('引き継ぐと同じ鍵で再接続できる', takenOver.readyState !== WebSocket.CONNECTING);
    const bad = url.replace(/.$/, url.endsWith('0') ? '1' : '0');
    t.ok('違う鍵を拒否', await open(bad).then(() => false, () => true));
  } finally { ws?.terminate(); wsTwo?.terminate(); relay.close(); }

  // 新規会話: 会話 ID が決まる前の turn.key で作ったタブが、rebind で本物の ID へ移り、次のターンで増えない
  const rebindPanel = fakePanel();
  const rebindRelay = createBrowserRelay(rebindPanel);
  let rebindWs, rebindWs2;
  try {
    const first = await rebindRelay.endpoint('new:turn-key');
    rebindWs = await open(first);
    await ask(rebindWs, 'Browser.getVersion');
    t.ok('新規会話の最初のターンのタブは turn.key の会話に付く', rebindPanel.tabsFor('new:turn-key').length === 1);
    rebindRelay.rebind('new:turn-key', 'real-session');
    t.ok('rebind で本物の会話 ID へ移る', rebindPanel.tabsFor('new:turn-key').length === 0 && rebindPanel.tabsFor('real-session').length === 1);
    rebindWs.terminate();
    const second = await rebindRelay.endpoint('real-session');
    rebindWs2 = await open(second);
    const targets = (await ask(rebindWs2, 'Target.getTargets')).result.targetInfos;
    t.ok('次のターンは同じ鍵・同じタブで、もう 1 枚作らない', second === first && targets.length === 1 && rebindPanel.tabsFor('real-session').length === 1);
  } finally { rebindWs?.terminate(); rebindWs2?.terminate(); rebindRelay.close(); }

  const confirmPanel = fakePanel();
  let approve, requested = 0;
  const navigation = createBrowserNavigation({ enabled: () => true, authorize: () => { requested++; return new Promise(resolve => { approve = resolve; }); } });
  const confirmRelay = createBrowserRelay(confirmPanel, { navigation });
  let confirmWs;
  try {
    confirmWs = await open(await confirmRelay.endpoint('confirm'));
    const sid = (await ask(confirmWs, 'Target.attachToTarget', { targetId: 'frame-t1' })).result.sessionId;
    const navigate = url => ask(confirmWs, 'Page.navigate', { url }, sid);
    const allowed = navigate('https://allow.example/');
    while (!approve) await new Promise(resolve => setTimeout(resolve, 5));
    t.ok('CDP navigate has not reached debugger while approval is pending', confirmPanel.tabsFor('confirm')[0].webContents.getURL() === 'about:blank');
    approve({ allow: true }); await allowed;
    t.ok('approved CDP navigation proceeds', confirmPanel.tabsFor('confirm')[0].webContents.getURL() === 'https://allow.example/');
    approve = null; const denied = navigate('https://deny.example/');
    while (!approve) await new Promise(resolve => setTimeout(resolve, 5));
    approve({ allow: false });
    t.ok('denied CDP navigation replies with a protocol error and leaves the page intact', !!(await denied).error && confirmPanel.tabsFor('confirm')[0].webContents.getURL() === 'https://allow.example/');
    await navigate('https://allow.example/next');
    t.ok('same-origin CDP navigation does not ask again', requested === 2);
    approve = null; const creating = ask(confirmWs, 'Target.createTarget', { url: 'https://new.example/' });
    while (!approve) await new Promise(resolve => setTimeout(resolve, 5));
    approve({ allow: false }); t.ok('new targets also wait for site approval and denied tabs are removed', !!(await creating).error && confirmPanel.tabsFor('confirm').length === 1);
  } finally { confirmWs?.terminate(); confirmRelay.close(); }

  const port = new EventEmitter();
  let endpointUrl = 'ws://127.0.0.1:1234/devtools/browser/key';
  port.postMessage = request => queueMicrotask(() => port.emit('message', { data: { type: request.type, id: request.id, ok: true, url: endpointUrl } }));
  const bridge = parentPortBrowser(port);
  {
    // 外部の読み込みの確認の設定を main へ（内蔵ブラウザーの file: のタブが使う。docs/inapp-browser.md）
    const policyPort = new EventEmitter(), sent = [];
    policyPort.postMessage = message => sent.push(message);
    const policyBridge = parentPortBrowser(policyPort);
    policyPort.emit('message', { data: { type: 'browser-load-policy-request' } });
    assert.deepEqual(sent.at(-1), { type: 'browser-load-policy', confirm: false, origins: [] }, '設定が来る前は確認 OFF');
    policyBridge.loadPolicy({ confirmExternalLoads: true, externalSitePermissions: [{ origin: 'https://cdn.example', mode: 'always' }, { origin: 'https://ask.example', mode: 'ask' }] });
    assert.deepEqual(sent.at(-1), { type: 'browser-load-policy', confirm: true, origins: ['https://cdn.example'] }, '「常に」だけを渡す');
    policyPort.emit('message', { data: { type: 'browser-load-policy-request' } });
    assert.deepEqual(sent.at(-1), { type: 'browser-load-policy', confirm: true, origins: ['https://cdn.example'] }, 'main が起動時に聞き直したら最新を返す');
    policyBridge.loadPolicy({});
    assert.deepEqual(sent.at(-1), { type: 'browser-load-policy', confirm: false, origins: [] });
    t.ok('外部の読み込みの確認の設定を main へ届ける（ON と「常に」の https だけ・main の問い合わせに最新を返す）', true);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pleiad-browser-test-'));
  const socketDirs = new Set();
  try {
    const env = await browserEnvironment({ bridge, dataDir: dir, sessionId: 'conversation-1' });
    socketDirs.add(env.AGENT_BROWSER_SOCKET_DIR);
    const config = JSON.parse(await readFile(env.AGENT_BROWSER_CONFIG, 'utf8'));
    t.ok('会話別の設定ファイルと環境変数', /^ply-[a-f0-9]{24}$/.test(env.AGENT_BROWSER_SESSION) && Object.keys(config).join() === 'cdp' && config.cdp.includes('/key'));
    await writeFile(path.join(env.AGENT_BROWSER_SOCKET_DIR, 'probe'), 'ok');
    t.ok('ソケット用の書ける置き場を作り、継承した namespace を解除する', (await stat(env.AGENT_BROWSER_SOCKET_DIR)).isDirectory() && env.AGENT_BROWSER_NAMESPACE === '');
    const other = await browserEnvironment({ bridge, dataDir: dir, sessionId: 'conversation-2' });
    socketDirs.add(other.AGENT_BROWSER_SOCKET_DIR);
    t.ok('会話ごとにデーモンと置き場を分ける', other.AGENT_BROWSER_SOCKET_DIR !== env.AGENT_BROWSER_SOCKET_DIR && other.AGENT_BROWSER_SESSION !== env.AGENT_BROWSER_SESSION);
    const longDir = path.join(dir, '長'.repeat(100));
    const shortSocket = browserSocketDirectory(longDir, 'darwin');
    t.ok('Unix の長い UTF-8 パスは短い置き場へ切り替える', Buffer.byteLength(path.join(shortSocket, `${env.AGENT_BROWSER_SESSION}.sock`)) < 104 && shortSocket !== path.join(longDir, 'sock'));
    t.ok('Windows は既定の一時領域に短い会話別の置き場を作る', path.dirname(browserSocketDirectory(dir, 'win32')) === os.tmpdir() && /^ply-ab-[a-f0-9]{24}$/.test(path.basename(browserSocketDirectory(dir, 'win32'))));
    t.ok('Unix は短い設定パスでも既定で書ける /tmp を使う', browserSocketDirectory('/short', 'linux').startsWith(path.join('/tmp', 'ply-ab-')));
    bridge.rebind('conversation-1', 'native-thread-1');
    endpointUrl = 'ws://127.0.0.1:1234/devtools/browser/new-key';
    const rebound = await browserEnvironment({ bridge, dataDir: dir, sessionId: 'native-thread-1' });
    t.ok('ID 確定後もデーモンの置き場を保つ', rebound.AGENT_BROWSER_SOCKET_DIR === env.AGENT_BROWSER_SOCKET_DIR);
    t.ok('新規スレッドの ID 確定後も設定パスを保ち、鍵を更新する', rebound.AGENT_BROWSER_CONFIG === env.AGENT_BROWSER_CONFIG && rebound.AGENT_BROWSER_SESSION === env.AGENT_BROWSER_SESSION && JSON.parse(await readFile(env.AGENT_BROWSER_CONFIG, 'utf8')).cdp === endpointUrl);
    t.ok('デスクトップ以外では渡さない', await browserEnvironment({ bridge: null, dataDir: dir, sessionId: 'one' }) === null);
    t.ok('指示は中継があるターンだけ', browserInstruction(env, 'ja', (_locale, key) => key) === 'browser.instructions' && browserInstruction(null, 'ja', () => 'wrong') === null);
  } finally {
    for (const socketDir of socketDirs) await rm(socketDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }

  const fake = path.resolve('tests/lib/fake-browser-env.mjs');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'pleiad-browser-env-'));
  const codexBin = process.env.AGENT_HOST_CODEX_BIN, agyBin = process.env.AGENT_HOST_AGY_BIN;
  const fakeBrowserEnvFile = process.env.FAKE_BROWSER_ENV_FILE;
  try {
    const env = { AGENT_BROWSER_CONFIG: path.join(scratch, 'agent-browser.json'), AGENT_BROWSER_SESSION: 'env-session', AGENT_BROWSER_SOCKET_DIR: path.join(scratch, 'sock'), AGENT_BROWSER_NAMESPACE: '' };
    process.env.AGENT_HOST_CODEX_BIN = `"${process.execPath}" "${fake}"`;
    process.env.FAKE_BROWSER_ENV_FILE = path.join(scratch, 'unexpected-codex.json');
    const originalRpc = { request: nativeRpc.request, attach: nativeRpc.attach, claimOrphan: nativeRpc.claimOrphan, stop: nativeRpc.stop };
    const requests = [];
    const turns = [];
    let returnedSandbox = { type: 'workspaceWrite', writableRoots: [scratch], networkAccess: false };
    let handlers, stopped = 0, turnSerial = 0;
    nativeRpc.claimOrphan = h => { handlers = h; return () => {}; };
    nativeRpc.attach = (_id, h) => { handlers = h; return () => {}; };
    nativeRpc.stop = () => { stopped++; };
    nativeRpc.request = async (method, params) => {
      if (method === 'config/read') return { config: { model_reasoning_effort: 'medium', sandbox_workspace_write: { writable_roots: [scratch] } } };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      if (method === 'model/list') return { data: [] };
      if (method === 'thread/start' || method === 'thread/resume') {
        requests.push({ method, params });
        return { thread: { id: 'browser-thread' }, sandbox: returnedSandbox };
      }
      if (method === 'turn/start') {
        turns.push(params);
        const id = `turn-${++turnSerial}`;
        const current = handlers;
        queueMicrotask(() => current.onNotification('turn/completed', { turn: { id, status: 'completed' } }));
        return { turn: { id } };
      }
      throw new Error(`unexpected Codex RPC: ${method}`);
    };
    try {
      const args = { prompt: 'browser', cwd: scratch, mode: 'ask', emit() {}, browserEnv: env, browserInstructions: 'browser guidance' };
      const first = await codex.runTurn({ ...args, sessionId: null });
      await codex.runTurn({ ...args, sessionId: first.sessionId });
      const expected = env;
      t.ok('Codex の thread/start と thread/resume に会話別 shell_environment_policy.set を渡す', requests.map(r => r.method).join() === 'thread/start,thread/resume' && requests.every(r => JSON.stringify(r.params.config['shell_environment_policy.set']) === JSON.stringify(expected)));
      t.ok('thread config にブラウザー用の writable_roots を追加しない', requests.every(r => !('sandbox_workspace_write.writable_roots' in r.params.config)));
      t.ok('ターンも既存の sandboxPolicy を保ちソケットのルートを追加しない', turns.every(r => r.sandboxPolicy === returnedSandbox && JSON.stringify(r.sandboxPolicy.writableRoots) === JSON.stringify([scratch])));
      await codex.runTurn({ ...args, mode: 'readonly', sessionId: first.sessionId });
      t.ok('読み取り専用ではルートを追加せず操作不可の指示に替える', !('sandbox_workspace_write.writable_roots' in requests.at(-1).params.config) && turns.at(-1).sandboxPolicy.type === 'readOnly' && !turns.at(-1).sandboxPolicy.writableRoots && requests.at(-1).params.developerInstructions.includes('Do not operate the built-in browser'));
      await codex.runTurn({ ...args, mode: 'full', sessionId: first.sessionId });
      t.ok('通常モードへ戻しても追加ルートを増やさない', turns.at(-1).sandboxPolicy.type === 'workspaceWrite' && !turns.at(-1).sandboxPolicy.writableRoots.includes(env.AGENT_BROWSER_SOCKET_DIR));
      await codex.runTurn({ ...args, mode: 'yolo', sessionId: first.sessionId });
      t.ok('YOLO に workspace の追加ルートを持ち込まない', !('sandbox_workspace_write.writable_roots' in requests.at(-1).params.config) && turns.at(-1).sandboxPolicy.type === 'dangerFullAccess');
      returnedSandbox = { type: 'dangerFullAccess' };
      await codex.runTurn({ ...args, mode: 'full', sessionId: first.sessionId });
      t.ok('YOLO から戻るターンもブラウザー用の追加ルートを作らない', turns.at(-1).sandboxPolicy.type === 'workspaceWrite' && !turns.at(-1).sandboxPolicy.writableRoots);
      t.ok('通常の Codex は共有 app-server を使いターン後も止めない', stopped === 0 && !(await readFile(process.env.FAKE_BROWSER_ENV_FILE).then(() => true, () => false)));
    } finally { Object.assign(nativeRpc, originalRpc); }

    process.env.AGENT_HOST_AGY_BIN = `"${process.execPath}" "${fake}"`;
    const agyFile = path.join(scratch, 'agy.json');
    const agy = new AgySession({ cwd: scratch, env: { ...env, FAKE_BROWSER_ENV_FILE: agyFile } });
    agy.start();
    for (let i = 0; i < 100; i++) { try { await readFile(agyFile); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    const agySeen = JSON.parse(await readFile(agyFile, 'utf8'));
    const agyProc = agy.proc;
    agy.kill();
    await new Promise(resolve => {
      if (!agyProc || agyProc.exitCode !== null || agyProc.signalCode !== null) resolve();
      else agyProc.once('close', resolve);
    });
    t.ok('Antigravity のシェルに会話の環境変数が届く', agySeen.config === env.AGENT_BROWSER_CONFIG && agySeen.session === env.AGENT_BROWSER_SESSION && agySeen.socketDir === env.AGENT_BROWSER_SOCKET_DIR && agySeen.namespace === '');

    let options;
    const restore = setClaudeSdkForTest({ executable: () => 'fake-claude', query: ({ options: received }) => {
      options = received;
      return { close() {}, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', num_turns: 1 }; } };
    } });
    try {
      await claude.runTurn({ prompt: 'hello', sessionId: null, cwd: scratch, mode: 'default', emit() {}, signal: new AbortController(), browserEnv: env, browserInstructions: 'browser guidance' });
      t.ok('Claude SDK の query に会話の環境変数と指示が届く', options?.env?.AGENT_BROWSER_CONFIG === env.AGENT_BROWSER_CONFIG && options?.env?.AGENT_BROWSER_SESSION === env.AGENT_BROWSER_SESSION && options?.env?.AGENT_BROWSER_SOCKET_DIR === env.AGENT_BROWSER_SOCKET_DIR && options?.env?.AGENT_BROWSER_NAMESPACE === '' && options?.systemPrompt?.append?.includes('browser guidance'));
    } finally { restore(); }
  } finally {
    if (codexBin === undefined) delete process.env.AGENT_HOST_CODEX_BIN; else process.env.AGENT_HOST_CODEX_BIN = codexBin;
    if (agyBin === undefined) delete process.env.AGENT_HOST_AGY_BIN; else process.env.AGENT_HOST_AGY_BIN = agyBin;
    if (fakeBrowserEnvFile === undefined) delete process.env.FAKE_BROWSER_ENV_FILE; else process.env.FAKE_BROWSER_ENV_FILE = fakeBrowserEnvFile;
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
