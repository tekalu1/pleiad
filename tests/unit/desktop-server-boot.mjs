// main がサーバーを見つける・起こす・付け直す（無停止の更新 1-4。desktop/server-boot.cjs と core/server-log.mjs・core/orphan-guard.mjs。
// docs/zero-downtime-update/plan.md 1-4）。
//   - 見つける: main-link.json が無い・指すパイプが無い・秘密が違う・口の版の範囲が合わない・握手に答えない・生きている
//   - 起こす: 古い main-link.json を掴まない（起こしたプロセスの pid のものだけ）・途中で終わる（ログの末尾・トークンを伏せる）・先に居たサーバーへ付け直す・時間切れ・起動口の失敗
//   - 選ぶ（chooseServer）: Job が抜け道を許さない・実行場所を組めない → 今の utilityProcess、居れば起こさない、起こすなら env・ログの置き場
//   - サーバーの env・ログ（回す・トークンを伏せる）・孤児にならない見張り
//   - 本物: core/server.mjs を detached・stdio なしで起こし、パイプでつなぎ、main を切ってもサーバーが居て、付け直すと同じトークン・ポート、終了で片付く
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createMainLink, mainLinkPipeName, LINK_FILE } from '../../core/main-link.mjs';
import { createOrphanGuard, ORPHAN_IDLE_MS, UPDATE_IDLE_MS } from '../../core/orphan-guard.mjs';
import { createLogSink, redactLine, redirectOutput } from '../../core/server-log.mjs';
import { isRuntimeInUse } from '../../core/runtime-use.mjs';
import { testDataDir, testDataOwned } from '../lib/test-env.mjs';

const require = createRequire(import.meta.url);
const boot = require('../../desktop/server-boot.cjs');
const { createServerLink } = require('../../desktop/server-link.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'desktop-server-boot';
export const title = 'サーバーを見つける・起こす・付け直す（Job の分岐・ログ・孤児の見張り・別プロセスのサーバーを main を切っても残して付け直す）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tempDir = () => fs.mkdtempSync(path.join(testDataOwned ? testDataDir : os.tmpdir(), 'pleiad-server-boot-'));
// Windows で終了直後の DB が掴まれていたら、worker 自身の置き場は worker 終了後の掃除に任せる。
const rm = dir => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (error) { if (!testDataOwned || error.code !== 'EPERM') throw error; }
};
const settled = promise => promise.then(value => ({ value }), error => ({ error }));

async function waitFor(check, ms = 10_000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(20);
  }
}

const writeLinkFile = (dir, fields) => fs.writeFileSync(path.join(dir, LINK_FILE), JSON.stringify({ version: 1, pid: 1, pipe: mainLinkPipeName(`${dir}-none`), ipc: [1, 1], appVersion: '0', secret: 'x'.repeat(64), ...fields }));

/** 同じプロセスの中でサーバー側の口を立てる（パイプは本物） */
async function startLink(options = {}) {
  const dataDir = tempDir();
  const link = createMainLink({ dataDir, appVersion: '9.9.9', ...options });
  await link.listen();
  return { link, dataDir, async stop() { await link.close(); rm(dataDir); } };
}

function watchLink(client) {
  const seen = { messages: [], exits: [] };
  client.on('message', message => seen.messages.push(message));
  client.on('exit', code => seen.exits.push(code));
  return seen;
}

export default async function (t) {
  // ---- 見つける: attachRunning
  {
    const dir = tempDir();
    const none = await boot.attachRunning({ link: createServerLink({ appVersion: '1' }), dataDir: dir });
    t.ok('見つける: main-link.json が無ければ居ない', none.attached === false && /no main-link/.test(none.reason));

    writeLinkFile(dir, {});
    const stale = await boot.attachRunning({ link: createServerLink({ appVersion: '1' }), dataDir: dir });
    t.ok('見つける: 指すパイプが無ければ古い main-link.json として扱う（起こす側へ）', stale.attached === false && /stale/.test(stale.reason), stale.reason);
    rm(dir);

    const live = await startLink();
    const client = createServerLink({ appVersion: '1.2.3' });
    const seen = watchLink(client);
    const attached = await boot.attachRunning({ link: client, dataDir: live.dataDir });
    t.ok('見つける: 生きていれば付け直す（pid・版・口の版が分かる）', attached.attached === true && attached.pid === process.pid && attached.welcome.appVersion === '9.9.9' && attached.welcome.ipc === 1);
    t.ok('見つける: 付けたつながりで main のメッセージが送れる', client.postMessage({ type: 'running' }) === true);
    t.ok('見つける: 生きているかの確かめ（probeRunning）は握手しない（居るサーバーの口を奪わない）', await boot.probeRunning({ dataDir: live.dataDir }) === true && seen.exits.length === 0 && live.link.isConnected());
    client.leave();
    await live.stop();

    const wrongSecret = await startLink();
    writeLinkFile(wrongSecret.dataDir, { pipe: wrongSecret.link.pipe, secret: 'y'.repeat(64) });
    const wrong = await boot.attachRunning({ link: createServerLink({ appVersion: '1' }), dataDir: wrongSecret.dataDir });
    t.ok('見つける: 秘密が違えば（サーバーは何も返さず切る）古いものとして扱う', wrong.attached === false && /stale/.test(wrong.reason), wrong.reason);
    await wrongSecret.stop();

    const incompatible = await startLink({ ipc: [5, 6] });
    const rejected = await settled(boot.attachRunning({ link: createServerLink({ appVersion: '1' }), dataDir: incompatible.dataDir }));
    t.ok('見つける: 口の版の範囲が合わなければ ipc の ServerBootError（サーバーの版・pid つき。別のサーバーは起こさない）', rejected.error?.code === 'ipc' && rejected.error.server?.appVersion === '9.9.9' && rejected.error.server?.pid === process.pid, String(rejected.error));
    t.ok('見つける: ipc の失敗は、居るサーバーの版を含む文になる', boot.describeBootError(rejected.error, (key, params) => `${key}:${params?.version}`) === 'server.linkRejected:9.9.9');
    await incompatible.stop();

    // 握手に答えないもの（パイプは開いているが応答しない）
    const dir2 = tempDir();
    const silentPipe = mainLinkPipeName(`${dir2}-silent`);
    const silentSockets = [];
    const silent = net.createServer(socket => { silentSockets.push(socket); socket.on('error', () => {}); });
    await new Promise(resolve => silent.listen(silentPipe, resolve));
    writeLinkFile(dir2, { pipe: silentPipe });
    const hung = await settled(boot.attachRunning({ link: createServerLink({ appVersion: '1', helloTimeoutMs: 150 }), dataDir: dir2 }));
    t.ok('見つける: 握手に答えなければ unresponsive（起こさずに、そのまま失敗にする）', hung.error?.code === 'unresponsive' && /no welcome/.test(hung.error.message), String(hung.error));
    for (const socket of silentSockets) socket.destroy();
    silent.close();
    rm(dir2);
  }

  // ---- 起こす: startAndConnect
  {
    const base = { sleep: ms => sleep(Math.min(ms, 5)), pollMs: 5 };
    // 古い main-link.json（別の pid）が残っている。起こしたプロセスの pid のものが現れるまで掴まない
    const env1 = await startLink();
    await env1.link.close();
    writeLinkFile(env1.dataDir, { pid: 4_000_001 });
    let polls = 0;
    const client = createServerLink({ appVersion: '1' });
    const started = await boot.startAndConnect({ ...base, link: client, dataDir: env1.dataDir, logFile: path.join(env1.dataDir, 'none.log'),
      launch: async () => ({ pid: process.pid }),
      sleep: async ms => { if (++polls === 3) await env1.link.listen(); await sleep(Math.min(ms, 5)); } });
    t.ok('起こす: 古い main-link.json（別の pid）を掴まず、起こしたプロセスの pid のものが現れたらつなぐ', started.attached === false && started.pid === process.pid && polls >= 3, JSON.stringify({ polls, started: started.pid }));
    client.leave();
    await env1.stop();

    // 起こしたプロセスが途中で終わる: ログの末尾（トークンは伏せる）
    const dir = tempDir();
    const logFile = path.join(dir, 'logs', 'server.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `old line\nagent-host  http://localhost:7420/?token=SECRETVALUE123\nError: データ置き場を別のプロセスが持っています\n`);
    const exited = await settled(boot.startAndConnect({ ...base, link: createServerLink({ appVersion: '1' }), dataDir: dir, logFile, lateAttachMs: 30, launch: async () => ({ pid: 4_000_002 }), alive: () => false }));
    t.ok('起こす: 途中で終わったら exited で、ログの末尾が付く', exited.error?.code === 'exited' && exited.error.detail.includes('データ置き場を別のプロセスが持っています'), String(exited.error?.detail));
    t.ok('起こす: ログの末尾のトークンは伏せる', !exited.error.detail.includes('SECRETVALUE123') && exited.error.detail.includes('token=[redacted]'));
    t.ok('起こす: exited は startFailed の文になる', boot.describeBootError(exited.error, (key, params) => `${key}:${params.detail.length > 0}`) === 'server.startFailed:true');

    // 起こしたプロセスは終わったが、先に居たサーバー（前の main が起こしたもの）が起動を終えた → 付け直す
    const late = await startLink();
    await late.link.close();
    let lateAttached;
    const lateClient = createServerLink({ appVersion: '1' });
    let n = 0;
    lateAttached = await boot.startAndConnect({ ...base, link: lateClient, dataDir: late.dataDir, logFile, lateAttachMs: 3000, launch: async () => ({ pid: 4_000_003 }), alive: () => false,
      sleep: async ms => { if (++n === 2) await late.link.listen(); await sleep(Math.min(ms, 5)); } });
    t.ok('起こす: 起こしたプロセスがデータ置き場のロックで終わっても、先に居たサーバーが立てば付け直す', lateAttached.attached === true && lateAttached.pid === process.pid);
    lateClient.leave();
    await late.stop();

    // 時間切れ
    let clock = 0;
    const timeout = await settled(boot.startAndConnect({ ...base, link: createServerLink({ appVersion: '1' }), dataDir: dir, logFile, timeoutMs: 1000, launch: async () => ({ pid: 4_000_004 }), alive: () => true,
      now: () => clock, sleep: async ms => { clock += ms * 50; } }));
    t.ok('起こす: 上限までに main-link.json が現れなければ timeout（居続けるサーバーはそのまま）', timeout.error?.code === 'timeout' && timeout.error.detail.includes('データ置き場'), String(timeout.error));
    const launchFailed = await settled(boot.startAndConnect({ ...base, link: createServerLink({ appVersion: '1' }), dataDir: dir, logFile, launch: async () => { throw Object.assign(new Error('spawn pleiad-node.exe ENOENT'), { code: 'ENOENT' }); } }));
    t.ok('起こす: 起動口が失敗したら launch（理由つき）', launchFailed.error?.code === 'launch' && /ENOENT/.test(launchFailed.error.detail) && boot.describeBootError(launchFailed.error, (key, p) => `${key}:${p.detail}`).startsWith('server.launchFailed:spawn'));
    rm(dir);
  }

  // ---- 起こす: launchServer（Node の detached 起動）の引数
  {
    const calls = [];
    const fake = { once(type, fn) { if (type === 'spawn') queueMicrotask(fn); }, on() {}, unref() { calls.push('unref'); }, pid: 4242 };
    const result = await boot.launchServer({ mode: 'detached', nodeExe: 'C:\\run\\pleiad-node.exe', args: ['C:\\run\\app\\core\\server.mjs'], cwd: 'C:\\home', env: { A: '1' }, spawnProcess: (exe, args, options) => { calls.push({ exe, args, options }); return fake; } });
    const call = calls[0];
    t.ok('起動口: detached・stdio なし・windowsHide・cwd・env で、unref する', result.pid === 4242 && call.options.detached === true && call.options.stdio === 'ignore' && call.options.windowsHide === true && call.options.cwd === 'C:\\home' && call.options.env.A === '1' && calls[1] === 'unref');
    const refused = await settled(boot.launchServer({ mode: 'detached', nodeExe: 'x', args: [], env: {}, spawnProcess: () => ({ once(type, fn) { if (type === 'error') queueMicrotask(() => fn(new Error('spawn x ENOENT'))); }, on() {}, unref() {} }) }));
    t.ok('起動口: 起こせなければ error をそのまま返す', /ENOENT/.test(refused.error?.message));
    let breakawayArgs = null;
    const br = await boot.launchServer({ mode: 'breakaway', nodeExe: 'N', args: ['S'], cwd: 'H', env: { B: '2' }, spawnProcess: () => { throw new Error('must not spawn'); }, breakaway: options => { breakawayArgs = options; return { pid: 77 }; } });
    t.ok('起動口: breakaway は CreateProcessW の経路へ（Node の spawn は使わない）', br.pid === 77 && breakawayArgs.exe === 'N' && breakawayArgs.args[0] === 'S' && breakawayArgs.cwd === 'H' && breakawayArgs.env.B === '2');
  }

  // ---- サーバーの env
  {
    const env = boot.serverEnv({ baseEnv: { Path: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' }, agentBrowserDir: 'C:\\rt\\agent-browser\\k', root: 'C:\\rt', key: 'k', logFile: 'C:\\rt\\logs\\server.log', port: 7421, systemLocale: 'ja-JP',
      stableCliEnv: { PLEIAD_CLI_EXEC: 'C:\\Ply.exe', PLEIAD_CLI_SCRIPT: 'C:\\r\\app\\bin\\pleiad.mjs', PLEIAD_CLI_ELECTRON: '1' } });
    t.ok('env: ELECTRON_RUN_AS_NODE を外す（素の Node で、会話のシェルへ漏らさない）', !('ELECTRON_RUN_AS_NODE' in env) && env.KEEP === 'yes');
    t.ok('env: PATH は元の Path のキーのまま先頭に agent-browser を足す（別名の PATH を足さない）', env.Path.startsWith('C:\\rt\\agent-browser\\k') && env.Path.endsWith('C:\\Windows') && !('PATH' in env));
    t.ok('env: 無停止の更新・待ち受け・ポート・言語・ログ・実行場所・外の AI に貼る起動口', env.AGENT_HOST_HANDOVER === 'on' && env.AGENT_HOST_BIND === '127.0.0.1' && env.AGENT_HOST_PORT === '7421' && env.AGENT_HOST_SYSTEM_LOCALE === 'ja-JP'
      && env.AGENT_HOST_SERVER_LOG === 'C:\\rt\\logs\\server.log' && env.AGENT_HOST_RUNTIME_ROOT === 'C:\\rt' && env.AGENT_HOST_RUNTIME_KEY === 'k' && env.PLEIAD_CLI_ELECTRON === '1');
    t.ok('env: トークンは渡さなければ付けない（サーバーが決める）', !('AGENT_HOST_TOKEN' in env));
    const handed = boot.serverEnv({ baseEnv: { AGENT_HOST_TOKEN: 'stale' }, root: 'r', key: 'k', logFile: 'l', port: 0, token: 'handed-over' });
    t.ok('env: 前のサーバーのトークンを引き継ぐときは渡す・ポート 0 は 0（サーバーが決める）', handed.AGENT_HOST_TOKEN === 'handed-over' && handed.AGENT_HOST_PORT === '0');
    t.ok('env: PATH が無くても PATH に足す', boot.serverEnv({ baseEnv: {}, agentBrowserDir: 'D', root: 'r', key: 'k', logFile: 'l' }).PATH === `D${path.delimiter}`);
  }

  // ---- ログ
  {
    const dir = tempDir();
    const file = path.join(dir, 'logs', 'server.log');
    const sink = createLogSink({ file, maxBytes: 200 });
    sink.write('agent-host  http://localhost:7420/?token=abcdef0123456789\n');
    t.ok('ログ: トークンを伏せて書く（置き場の logs\\ も作る）', fs.readFileSync(file, 'utf8') === 'agent-host  http://localhost:7420/?token=[redacted]\n' && redactLine('a token=x b token=y') === 'a token=[redacted] b token=[redacted]');
    sink.write('x'.repeat(150) + '\n');
    sink.write('after rotation\n');
    t.ok('ログ: 上限を超えたら、それまでを .old へ回して新しく始める（1 世代）', fs.readFileSync(`${file}.old`, 'utf8').includes('token=[redacted]') && fs.readFileSync(file, 'utf8') === `${'x'.repeat(150)}\nafter rotation\n`);
    for (let i = 0; i < 10; i++) sink.write('y'.repeat(150) + '\n');
    t.ok('ログ: 何度回しても .old は 1 つだけ', fs.readdirSync(path.dirname(file)).sort().join() === 'server.log,server.log.old');
    sink.close();
    const tail = boot.readLogTail(file, { chars: 40 });
    t.ok('ログの末尾: 指定の文字数だけ・無いファイルは空', tail.length <= 40 && tail.endsWith('y') && boot.readLogTail(path.join(dir, 'none.log')) === '');
    fs.writeFileSync(path.join(dir, 'jp.log'), 'あ'.repeat(100));
    t.ok('ログの末尾: 日本語の途中で切れても読める', boot.readLogTail(path.join(dir, 'jp.log'), { chars: 7 }) === 'あ'.repeat(7));
    // 書けない場所でも投げない
    const broken = createLogSink({ file: path.join(dir, 'logs', 'server.log', 'nested.log') });
    let threw = false;
    try { broken.write('x'); broken.write('y'); } catch { threw = true; }
    t.ok('ログ: 書けない場所でも投げない（サーバーを止めない）', !threw);

    // 標準出力・標準エラー・捕まらなかった例外
    const events = [];
    const fakeProc = { pid: 7, stdout: { write: () => 'orig-out' }, stderr: { write: () => 'orig-err' }, on: (type, fn) => events.push([type, fn]), exit: code => { fakeProc.exited = code; } };
    const f2 = path.join(dir, 'redirect.log');
    redirectOutput({ file: f2, proc: fakeProc, now: () => new Date(0) });
    let cbCalled = 0;
    const r1 = fakeProc.stdout.write('hello ?token=zzz\n', () => cbCalled++);
    const r2 = fakeProc.stderr.write(Buffer.from('エラー\n'), 'utf8', () => cbCalled++);
    events.find(([type]) => type === 'uncaughtException')[1](new Error('boom'));
    const written = fs.readFileSync(f2, 'utf8');
    t.ok('出力の向け先: 始まりの行・stdout・stderr（Buffer・日本語）・コールバックを呼び true を返す', written.startsWith('--- server start 1970-01-01T00:00:00.000Z pid 7\n') && written.includes('hello ?token=[redacted]\n') && written.includes('エラー\n') && cbCalled === 2 && r1 === true && r2 === true);
    t.ok('出力の向け先: 捕まらなかった例外はスタックを書いて異常終了する', written.includes('uncaughtException: Error: boom') && fakeProc.exited === 1);
    rm(dir);
  }

  // ---- 孤児の見張り
  {
    let now = 0;
    let busy = false;
    const expired = [];
    let ticker = null;
    const guard = createOrphanGuard({ isBusy: () => busy, onExpire: info => expired.push(info), now: () => now, setTimer: fn => { ticker = fn; return { unref() {} }; }, clearTimer: () => { ticker = null; } });
    const tick = async (ms = 5000) => { now += ms; await guard.check(); };
    t.ok('見張り: つながっている間は何もしない', (await tick(UPDATE_IDLE_MS * 2), expired.length === 0 && ticker === null));
    guard.disconnected();
    t.ok('見張り: 切れると見張りが始まる', ticker !== null && guard.away === true);
    await tick(0);
    await tick(ORPHAN_IDLE_MS - 1);
    t.ok('見張り: main-leaving 無しで 3 分に届くまでは終わらない', expired.length === 0);
    await tick(1);
    t.ok('見張り: 作業が 0 件のまま 3 分で終わる（reason: lost）', expired.length === 1 && expired[0].reason === 'lost' && ticker === null);
    // 作業があれば終わらない・作業が終わった時から数え直す
    guard.connected();
    guard.disconnected();
    busy = true;
    await tick(0);
    await tick(ORPHAN_IDLE_MS * 3);
    t.ok('見張り: 作業が続いている間は終わらない', expired.length === 1);
    busy = false;
    await tick(0);
    await tick(ORPHAN_IDLE_MS - 1);
    t.ok('見張り: 作業が終わった時刻から数え直す', expired.length === 1);
    await tick(1);
    t.ok('見張り: 数え直した 3 分で終わる', expired.length === 2);
    // main-leaving（更新）は 30 分
    guard.connected();
    guard.leaving('update');
    guard.disconnected();
    await tick(0);
    await tick(ORPHAN_IDLE_MS * 2);
    t.ok('見張り: main-leaving（update）の後は 3 分では終わらない', expired.length === 2);
    await tick(UPDATE_IDLE_MS - ORPHAN_IDLE_MS * 2 - 1);
    t.ok('見張り: main-leaving（update）の後は 30 分に届くまで終わらない', expired.length === 2);
    await tick(1);
    t.ok('見張り: 30 分で終わる（reason: update）', expired.length === 3 && expired[2].reason === 'update');
    // main-leaving の後に取りやめた（main はつながったまま。更新の失敗）: 次の切断は main-leaving の無い切断と同じ 3 分
    guard.connected();
    guard.leaving('update');
    guard.leavingCancelled();
    guard.disconnected();
    await tick(0);
    await tick(ORPHAN_IDLE_MS);
    t.ok('見張り: main-leaving を取りやめた後の切断は、30 分でなく 3 分（reason: lost）', expired.length === 4 && expired[3].reason === 'lost');
    // つながり直せば見張りをやめ、main-leaving も忘れる
    guard.leaving('update');
    guard.disconnected();
    await tick(0);
    guard.connected();
    t.ok('見張り: 付け直せば見張りをやめる', ticker === null && guard.away === false);
    guard.disconnected();
    await tick(0);
    await tick(ORPHAN_IDLE_MS);
    t.ok('見張り: 付け直した後の切断は、前の main-leaving を引き継がず 3 分', expired.length === 5 && expired[4].reason === 'lost');
    // 起こした main が最初につながる前に落ちた場合（最初から切れている）も同じ
    t.ok('見張り: 上限の既定は 3 分と 30 分', ORPHAN_IDLE_MS === 180_000 && UPDATE_IDLE_MS === 1_800_000);
    const failing = createOrphanGuard({ isBusy: () => { throw new Error('probe failed'); }, onExpire: () => expired.push('x'), now: () => now, setTimer: () => ({ unref() {} }), clearTimer() {} });
    failing.disconnected();
    await failing.check();
    t.ok('見張り: 作業の確かめが失敗しても落ちない（終わらせない）', !expired.includes('x'));
  }

  // ---- 選ぶ: chooseServer（偽の実行場所・Job・起動口）
  {
    const calls = { inspect: 0, prepare: 0, launched: [] };
    const root = path.join(os.tmpdir(), 'pleiad-fake-runtime');
    const runtime = { key: '1.0.0-abc', root, appDir: path.join(root, 'app', '1.0.0-abc'), nodeExe: path.join(root, 'node', 'n', 'pleiad-node.exe'), agentBrowserDir: path.join(root, 'agent-browser', '1.0.0-abc') };
    const common = {
      resourcesPath: 'C:\\inst\\resources', execPath: 'C:\\inst\\Ply.exe', appVersion: '1.0.0', systemLocale: 'ja-JP', port: 7430, env: { Path: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' },
      resolveRoot: () => ({ root }), stableCliEnv: () => ({ PLEIAD_CLI_EXEC: 'C:\\inst\\Ply.exe' }),
      prepareRuntime: async options => { calls.prepare++; calls.prepareOptions = options; return { ...runtime }; },
    };
    const dir = tempDir();

    const noRoom = await boot.chooseServer({ ...common, dataDir: dir, probe: async () => false, inspectJob: () => { calls.inspect++; return { inJob: true, flags: 0x2000 }; }, decideLaunch: info => require('../../desktop/job.cjs').decideLaunch(info, { platform: 'win32' }) });
    t.ok('選ぶ: Job が抜け道を許さなければ null（今の utilityProcess に落とす）。実行場所は組まない', noRoom === null && calls.prepare === 0 && calls.inspect === 1);
    const noRuntime = await boot.chooseServer({ ...common, dataDir: dir, probe: async () => false, inspectJob: () => ({ inJob: false }), decideLaunch: () => ({ mode: 'detached', reason: 'r' }), prepareRuntime: async () => null });
    t.ok('選ぶ: 実行場所を組めなければ null', noRuntime === null);

    calls.prepare = 0; calls.inspect = 0;
    const running = await startLink();
    const attachedChoice = await boot.chooseServer({ ...common, dataDir: running.dataDir, inspectJob: () => { calls.inspect++; return {}; } });
    t.ok('選ぶ: サーバーが居れば Job を調べず・起こさず付け直す。この版の実行場所は裏で組む', attachedChoice !== null && calls.inspect === 0 && calls.prepare === 1 && attachedChoice.logFile === boot.serverLogFile(root));
    const attachedResult = await attachedChoice.connect();
    t.ok('選ぶ: connect() で居るサーバーに付く（起こさない）', attachedResult.attached === true && attachedResult.pid === process.pid && calls.launched.length === 0);
    attachedChoice.link.leave();
    await running.stop();

    // 居ると見えたサーバーが、つなぐ前に居なくなった（起こす手立てが無い）
    const goneChoice = await boot.chooseServer({ ...common, dataDir: tempDir(), probe: async () => true });
    const gone = await settled(goneChoice.connect());
    t.ok('選ぶ: 居るはずのサーバーが居なければ gone（組んだ実行場所が無いので起こせない）', gone.error?.code === 'gone');

    // 居なければ起こす。起こす側の引数と env
    const target = await startLink();
    await target.link.close();
    const startChoice = await boot.chooseServer({ ...common, dataDir: target.dataDir, token: 'handed-token', cwd: 'C:\\home', probe: async () => false, inspectJob: () => ({ inJob: false }), decideLaunch: () => ({ mode: 'detached', reason: 'not in a job' }),
      launch: async options => { calls.launched.push(options); await target.link.listen(); return { pid: process.pid }; } });
    const startResult = await startChoice.connect();
    const launched = calls.launched[0];
    t.ok('選ぶ: 居なければ実行場所の pleiad-node.exe で core\\server.mjs を起こす（モード・cwd つき）', startResult.attached === false && launched.mode === 'detached' && launched.nodeExe === runtime.nodeExe && launched.args.join() === path.join(runtime.appDir, 'core', 'server.mjs') && launched.cwd === 'C:\\home');
    t.ok('選ぶ: 起こす env に、ELECTRON_RUN_AS_NODE が無く、ポート・トークン・ログ・実行場所・agent-browser の PATH が入る',
      !('ELECTRON_RUN_AS_NODE' in launched.env) && launched.env.AGENT_HOST_PORT === '7430' && launched.env.AGENT_HOST_TOKEN === 'handed-token' && launched.env.AGENT_HOST_SERVER_LOG === path.join(root, 'logs', 'server.log')
      && launched.env.AGENT_HOST_RUNTIME_KEY === runtime.key && launched.env.Path.startsWith(runtime.agentBrowserDir) && launched.env.PLEIAD_CLI_EXEC === 'C:\\inst\\Ply.exe' && launched.env.AGENT_HOST_SYSTEM_LOCALE === 'ja-JP');
    t.ok('選ぶ: 実行場所の組み立てに、配布物の resources と実行ファイルを渡す', calls.prepareOptions.resourcesPath === 'C:\\inst\\resources' && calls.prepareOptions.execPath === 'C:\\inst\\Ply.exe');
    startChoice.link.leave();
    await target.stop();
    rm(dir);

    // つなぎ直し
    const again = await startLink();
    const reLink = createServerLink({ appVersion: '1' });
    const reSeen = watchLink(reLink);
    await boot.attachRunning({ link: reLink, dataDir: again.dataDir });
    reLink.leave();
    await waitFor(() => reSeen.exits.length === 1, 3000, 'exit');
    t.ok('つなぎ直し: つながりだけが切れても、サーバーが居れば同じ包みで付け直せる', await boot.reattachServer({ link: reLink, dataDir: again.dataDir, delayMs: 5 }) === true && reLink.connected === true);
    reLink.leave();
    await waitFor(() => reSeen.exits.length === 2, 3000, 'exit 2');
    await again.stop();
    t.ok('つなぎ直し: サーバーが居なければ数回試して false（呼び出し側が「サーバーが終了しました」にする）', await boot.reattachServer({ link: reLink, dataDir: again.dataDir, attempts: 2, delayMs: 5 }) === false);
  }

  // ---- 本物: 別プロセスのサーバー（core/server.mjs）を起こし、main を切っても残し、付け直す
  {
    const dataDir = tempDir();
    const root = tempDir();
    const logFile = boot.serverLogFile(root);
    fs.writeFileSync(path.join(dataDir, 'prefs.json'), JSON.stringify({ memoryLearnPaused: true }));
    const baseEnv = { ...process.env, AGENT_HOST_DATA: dataDir, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_ANTHROPIC_API: 'off', AGENT_HOST_ROUTING_USAGE: 'off', AGENT_HOST_OPENROUTER_API: 'http://127.0.0.1:9',
      AGENT_HOST_CEREBRAS_API: 'http://127.0.0.1:9', AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off', AGENT_HOST_LOCALE: 'ja' };
    delete baseEnv.AGENT_HOST_TOKEN;
    let pid = null;
    try {
      const env = boot.serverEnv({ baseEnv, root, key: 'test-1.0.0', logFile, port: 0 });
      const link = createServerLink({ appVersion: '0.0.1' });
      const seen = watchLink(link);
      const first = await boot.startAndConnect({ link, dataDir, logFile, timeoutMs: 60_000,
        launch: () => boot.launchServer({ mode: 'detached', nodeExe: process.execPath, args: [path.join(ROOT, 'core', 'server.mjs')], cwd: ROOT, env }) });
      pid = first.pid;
      const ready = await waitFor(() => seen.messages.find(m => m.type === 'ready'), 15_000, 'ready');
      t.ok('本物: detached・stdio なしで起こしたサーバーにパイプでつながり、ready（ポート・トークン）が届く', first.attached === false && pid !== process.pid && Number.isInteger(ready.port) && ready.port > 0 && ready.token.length >= 16);
      t.ok('本物: 使用中の印（run\\<版>-<pid>.lock.db）をサーバーが持つ', await isRuntimeInUse({ root, key: 'test-1.0.0' }) === true);
      const log = await waitFor(() => { try { const text = fs.readFileSync(logFile, 'utf8'); return text.includes('agent-host  http') ? text : null; } catch { return null; } }, 10_000, 'server.log');
      t.ok('本物: 標準出力が logs\\server.log に出て（stdio は無い）、画面の URL のトークンは伏せてある', log.startsWith('--- server start') && !log.includes(ready.token) && log.includes('token=[redacted]'));

      // main が居なくなる（サーバーは残る）
      link.leave('test');
      await waitFor(() => seen.exits.length === 1, 5000, 'exit');
      await sleep(1500);
      t.ok('本物: main がつながりを切ってもサーバーは生き残り、control.json・main-link.json も残る', boot.isAlive(pid) && fs.existsSync(path.join(dataDir, 'control.json')) && fs.existsSync(path.join(dataDir, LINK_FILE)));

      // 次の main が付け直す: 同じトークン・ポート
      const next = createServerLink({ appVersion: '0.0.2' });
      const nextSeen = watchLink(next);
      const attached = await boot.attachRunning({ link: next, dataDir });
      const readyAgain = await waitFor(() => nextSeen.messages.find(m => m.type === 'ready'), 5000, 'ready 2');
      t.ok('本物: 次の main は起こさずに付け直せ、同じ pid・同じトークン・同じポートの ready が届く', attached.attached === true && attached.pid === pid && readyAgain.token === ready.token && readyAgain.port === ready.port);
      const running = await new Promise(resolve => { next.on('message', m => { if (m.type === 'running') resolve(m); }); next.postMessage({ type: 'running' }); });
      t.ok('本物: 付け直したつながりで running が往復する', running.work?.count === 0);
      t.ok('本物: 付け直した後のサーバーはまだ 1 つ（同じ pid）', boot.isAlive(pid) && boot.readControl(dataDir).pid === pid);

      // 終わらせる握手
      next.kill();
      await waitFor(() => !boot.isAlive(pid), 15_000, 'server exit');
      t.ok('本物: 終わらせる握手（shutdown）でサーバーが終わり、control.json・main-link.json が消える', !fs.existsSync(path.join(dataDir, 'control.json')) && !fs.existsSync(path.join(dataDir, LINK_FILE)));
      t.ok('本物: 終わった後、使用中の印は外れている', await isRuntimeInUse({ root, key: 'test-1.0.0' }) === false);
    } finally {
      if (pid && boot.isAlive(pid)) { try { process.kill(pid); } catch { /* 済み */ } await sleep(300); }
      rm(dataDir);
      rm(root);
    }
  }
}
