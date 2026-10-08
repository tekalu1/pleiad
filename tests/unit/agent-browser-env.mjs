import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserEnvironment, chromeRelayBrowser, browserInstruction, browserSocketDirectory } from '../../core/agent-browser.mjs';
import { rpc as nativeRpc } from '../../core/backends/codex-rpc.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { AgySession } from '../../core/backends/antigravity-cli.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';

export const name = 'agent-browser-env';
export const title = '会話別の設定ファイル・環境変数・指示（Chrome の中継の形）';

export default async function (t) {
  // Chrome の中継の形の偽物（実物は core/chrome/relay.mjs。chromeRelayBrowser が包む）
  let endpointUrl = 'ws://127.0.0.1:1234/devtools/browser/key';
  const rebinds = [];
  const bridge = chromeRelayBrowser({ endpoint: async () => endpointUrl, rebind: (from, to) => rebinds.push([from, to]), endTurn() {} });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pleiad-browser-test-'));
  const socketDirs = new Set();
  try {
    const env = await browserEnvironment({ bridge, dataDir: dir, sessionId: 'conversation-1' });
    socketDirs.add(env.AGENT_BROWSER_SOCKET_DIR);
    const config = JSON.parse(await readFile(env.AGENT_BROWSER_CONFIG, 'utf8'));
    t.ok('会話別の設定ファイルと環境変数', /^ply-[a-f0-9]{24}$/.test(env.AGENT_BROWSER_SESSION) && Object.keys(config).join() === 'cdp' && config.cdp.includes('/key') && env.AGENT_BROWSER_PIN_TAB === '1');
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
    t.ok('rebind は中継へ渡す', JSON.stringify(rebinds) === JSON.stringify([['conversation-1', 'native-thread-1']]));
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
