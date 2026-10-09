// サーバーが落ちたときの起こし直し（無停止の更新 段階 2 の 2e。desktop/server-restart.cjs、docs/zero-downtime-update/plan.md 2e）。
// main.cjs が呼ぶかどうか（切り替え中・main-leaving の後・off は呼ばない）は desktop-boot.mjs。ここは起こす部品そのもの:
//   - 起こす版（落ちたサーバーの runtimeKey の版が実行場所に残っていればそれ・無ければこの main の版）と、同じトークン・ポートの env
//   - 起こせなかったとき（Job が許さない・実行場所が無い・起動の失敗・ready が来ない）は { ok: false, reason: 'failed' }。立ちかけたプロセスは止める
//   - 続けて落ちる（windowMs の間に maxCrashes 回）なら起こさない・間が空けば数え直す・同時に 2 つは走らせない
//   - 起こした後の afterRestart の口（2b 以降の付け直し）
//   - 本物: 別プロセスのサーバーを強制終了し、同じトークン・ポートで起こし直して同じ包みでつなぎ直す
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createServerRestarter, MAX_CRASHES, CRASH_WINDOW_MS } = require('../../desktop/server-restart.cjs');
const boot = require('../../desktop/server-boot.cjs');
const { createServerLink } = require('../../desktop/server-link.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'desktop-server-restart';
export const title = 'サーバーが落ちたときの起こし直し: 同じ版・同じトークン・ポートで起こす・起こせなければ失敗・続けて落ちたらやめる・本物のサーバーを強制終了して起こし直す';

const LAST = { type: 'ready', port: 7430, token: 'last-token', runtimeKey: 'old-key', pid: 111 };
const THIS = { key: 'this-key', root: 'R', appDir: path.join('R', 'app', 'this-key'), nodeExe: path.join('R', 'node', 'n', 'pleiad-node.exe'), agentBrowserDir: path.join('R', 'agent-browser', 'this-key') };
const OLD = { ...THIS, key: 'old-key', appDir: path.join('R', 'app', 'old-key'), reused: true };

/** 偽の部品。startAndConnect は launch を呼び、起こしたプロセスの ready を waitForReady へ流す */
function fake({ job = { mode: 'detached', reason: 'test' }, located = OLD, prepared = THIS, startError = null, ready = { type: 'ready', port: 7430, token: 'last-token', pid: 222 }, readyError = null, alive = false, afterRestart = undefined, ...rest } = {}) {
  const calls = { launched: [], killed: [], left: [], waited: 0, located: [], logs: [], started: 0 };
  const link = Object.assign(new EventEmitter(), { leave: reason => calls.left.push(reason) });
  const bootFake = {
    ...boot,
    serverEnv: options => { calls.envOptions = options; return { fake: 'env', AGENT_HOST_PORT: String(options.port), AGENT_HOST_TOKEN: options.token }; },
    serverLogFile: root => path.join(root, 'logs', 'server.log'),
    startAndConnect: async options => {
      calls.started++;
      if (startError) throw startError;
      await options.launch();
    },
    launchServer: async options => { calls.launched.push(options); return { pid: 222 }; },
  };
  const restarter = createServerRestarter({
    link, getReady: () => LAST, prepared: Promise.resolve(prepared), root: 'R', dataDir: 'D', resourcesPath: 'C:\\inst\\resources', execPath: 'C:\\inst\\Ply.exe', systemLocale: 'ja-JP', cwd: 'C:\\home', env: { Path: 'x' },
    log: line => calls.logs.push(line), boot: bootFake,
    job: () => ({ inspectJob: () => ({}), decideLaunch: () => job }),
    runtimeLib: () => ({ locate: async options => { calls.located.push(options); return located; }, stableCliEnv: () => ({ PLEIAD_CLI_EXEC: 'C:\\inst\\Ply.exe' }) }),
    waitForReady: () => { calls.waited++; const promise = readyError ? Promise.reject(readyError) : Promise.resolve(ready); promise.catch(() => {}); return { promise, cancel: () => { calls.cancelled = true; } }; },
    alive: () => alive, afterRestart, ...rest,
  });
  return { restarter, calls, link };
}

export default async function (t) {
  // ---- 起こす版・env
  {
    const { restarter, calls } = fake();
    const result = await restarter.restart();
    const launched = calls.launched[0];
    t.ok('起こし直し: 落ちたサーバーの版（runtimeKey）が実行場所に残っていれば、その版の pleiad-node.exe で core\\server.mjs を起こす', result.ok === true && calls.located[0].key === 'old-key' && calls.located[0].root === 'R'
      && launched.nodeExe === OLD.nodeExe && launched.args.join() === path.join(OLD.appDir, 'core', 'server.mjs') && launched.mode === 'detached' && launched.cwd === 'C:\\home');
    t.ok('起こし直し: 同じトークン・ポートを env に渡す（画面の URL が変わらない）', calls.envOptions.token === 'last-token' && calls.envOptions.port === 7430 && launched.env.AGENT_HOST_TOKEN === 'last-token' && launched.env.AGENT_HOST_PORT === '7430');
    t.ok('起こし直し: 戻り値は起こしたサーバーの ready', result.ready.pid === 222 && result.ready.token === 'last-token');
  }
  {
    const { restarter, calls } = fake({ located: null });
    const result = await restarter.restart();
    t.ok('起こし直し: 落ちた版が実行場所に無ければ、この main の版（prepared）で起こす', result.ok === true && calls.launched[0].nodeExe === THIS.nodeExe && calls.envOptions.key === 'this-key');
  }
  {
    const { restarter, calls } = fake({ located: null });
    const result = await restarter.restart();
    t.ok('起こし直し: 起こした pid・版を記録に残す', result.ok && calls.logs.some(line => /restarting the server \(this version/.test(line)) && calls.logs.some(line => /the server is back \(pid 222/.test(line)));
  }

  // ---- 起こせないとき
  {
    const { restarter, calls } = fake({ job: { mode: 'unsupported', reason: 'job forbids it' } });
    const result = await restarter.restart();
    t.ok('起こせない: Job が抜け道を許さなければ起こさず失敗（理由を記録）', result.ok === false && result.reason === 'failed' && calls.started === 0 && calls.logs.some(line => /job forbids it/.test(line)));
  }
  {
    const { restarter, calls } = fake({ located: null, prepared: null });
    const result = await restarter.restart();
    t.ok('起こせない: 実行場所が無ければ失敗', result.ok === false && result.reason === 'failed' && calls.started === 0);
  }
  {
    const { restarter, calls } = fake({ startError: Object.assign(new Error('the server exited during startup'), { code: 'exited' }) });
    const result = await restarter.restart();
    t.ok('起こせない: 起動の途中で終わったら失敗（呼び出し側が致命的なダイアログにする）', result.ok === false && result.reason === 'failed' && /exited during startup/.test(result.error.message) && calls.cancelled === true);
  }
  {
    const { restarter, calls } = fake({ readyError: Object.assign(new Error('no ready'), { code: 'timeout' }), alive: true });
    const killed = [];
    const original = process.kill;
    process.kill = pid => { killed.push(pid); };
    let result;
    try { result = await restarter.restart(); } finally { process.kill = original; }
    t.ok('起こせない: つながっても ready が来なければ失敗し、自分が起こした（立ちかけた）プロセスだけを止める', result.ok === false && killed.join() === '222' && calls.left.join() === 'restart-failed');
  }

  // ---- 続けて落ちる
  {
    let time = 1_000_000;
    const { restarter, calls } = fake({ now: () => time });
    const results = [];
    for (let i = 0; i < MAX_CRASHES; i++) { results.push(await restarter.restart()); time += 5_000; }
    t.ok(`続けて落ちる: ${CRASH_WINDOW_MS / 1000} 秒に ${MAX_CRASHES} 回目の落ちは起こさず、loop で断る`, results.slice(0, MAX_CRASHES - 1).every(r => r.ok) && results[MAX_CRASHES - 1].ok === false && results[MAX_CRASHES - 1].reason === 'loop' && calls.started === MAX_CRASHES - 1);
    t.ok('続けて落ちる: 断った理由を記録に残す', calls.logs.some(line => /stopped 3 times within 60s/.test(line)));
    time += CRASH_WINDOW_MS;
    const later = await restarter.restart();
    t.ok('続けて落ちる: 窓の間が空いて古い落ちが外れれば、また起こす', later.ok === true);
  }
  {
    let time = 0;
    const { restarter } = fake({ now: () => time });
    const outcomes = [];
    for (let i = 0; i < 6; i++) { outcomes.push((await restarter.restart()).ok); time += CRASH_WINDOW_MS / 2 + 1; }
    t.ok('続けて落ちる: 窓をまたいで 1 分に 2 回までなら起こし続ける（半分の間隔の落ちは、窓に 2 回しか入らない）', outcomes.every(Boolean));
  }
  {
    const { restarter } = fake({ maxCrashes: 1 });
    t.ok('続けて落ちる: 回数は引数で変えられる（1 回目から断る）', (await restarter.restart()).reason === 'loop');
  }

  // ---- 同時に 2 つは走らせない
  {
    const { restarter, calls } = fake();
    const [a, b] = await Promise.all([restarter.restart(), restarter.restart()]);
    t.ok('同時: 起こし直しの最中の 2 回目は同じ結果を待つ（2 つ起こさない）', a === b && calls.started === 1 && calls.launched.length === 1);
  }

  // ---- 付け直しの口
  {
    const seen = [];
    const { restarter } = fake({ afterRestart: ready => { seen.push(ready.pid); } });
    await restarter.restart();
    t.ok('付け直しの口: 起こした後に afterRestart(ready) を呼ぶ（2b 以降。保持役に載ったターンの付け直し）', seen.join() === '222');
  }
  {
    const { restarter, calls } = fake({ afterRestart: async () => { throw new Error('adopt failed'); } });
    const result = await restarter.restart();
    t.ok('付け直しの口: afterRestart が失敗しても、起こし直しは成功のまま（失敗は記録）', result.ok === true && calls.logs.some(line => /after restart failed: adopt failed/.test(line)));
  }
  {
    const { restarter } = fake();
    t.ok('付け直しの口: 既定は何もしない', (await restarter.restart()).ok === true);
  }

  // ---- 本物: 別プロセスのサーバーを強制終了し、同じトークン・ポートで起こし直す
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-restart-data-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-restart-root-'));
    fs.writeFileSync(path.join(dataDir, 'prefs.json'), JSON.stringify({ memoryLearnPaused: true }));
    const baseEnv = { ...process.env, AGENT_HOST_DATA: dataDir, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_ANTHROPIC_API: 'off', AGENT_HOST_ROUTING_USAGE: 'off', AGENT_HOST_OPENROUTER_API: 'http://127.0.0.1:9',
      AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off', AGENT_HOST_LOCALE: 'ja' };
    delete baseEnv.AGENT_HOST_TOKEN;
    const pids = [];
    const link = createServerLink({ appVersion: '0.0.1' });
    const messages = [];
    const exits = [];
    link.on('message', m => messages.push(m));
    link.on('exit', () => exits.push(link.exitReason));
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (check, ms, label) => {
      for (const end = Date.now() + ms; Date.now() < end;) { const value = check(); if (value) return value; await sleep(50); }
      throw new Error(`timeout: ${label}`);
    };
    try {
      const env1 = boot.serverEnv({ baseEnv, root, key: 'test-1.0.0', logFile: boot.serverLogFile(root), port: 0 });
      const first = await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(root), timeoutMs: 60_000,
        launch: () => boot.launchServer({ mode: 'detached', nodeExe: process.execPath, args: [path.join(ROOT, 'core', 'server.mjs')], cwd: ROOT, env: env1 }) });
      pids.push(first.pid);
      const ready1 = await waitFor(() => messages.find(m => m.type === 'ready'), 15_000, 'ready');

      // 強制終了（クラッシュの代わり。bye は送られない）
      process.kill(first.pid, 'SIGKILL');
      await waitFor(() => exits.length === 1, 10_000, 'link exit');
      await waitFor(() => !boot.isAlive(first.pid), 10_000, 'server gone');
      t.ok('本物: サーバーを強制終了すると、つながりは bye なしで切れ（closing でも replaced でもない）、付け直せない', exits[0] !== 'closing' && exits[0] !== 'replaced'
        && await boot.reattachServer({ link, dataDir, attempts: 1 }) === false);

      const restarter = createServerRestarter({ link, getReady: () => messages.filter(m => m.type === 'ready').at(-1), prepared: Promise.resolve({ root, key: 'test-1.0.0', appDir: ROOT, nodeExe: process.execPath, agentBrowserDir: null }),
        root, dataDir, resourcesPath: ROOT, execPath: process.execPath, cwd: ROOT, env: baseEnv,
        job: () => ({ inspectJob: () => ({}), decideLaunch: () => ({ mode: 'detached', reason: 'test' }) }),
        runtimeLib: () => ({ locate: async () => null, stableCliEnv: () => ({}) }) });
      const result = await restarter.restart();
      if (result.ready?.pid) pids.push(result.ready.pid);
      t.ok('本物: 起こし直すと同じトークン・同じポートで立ち、別のプロセス（古い control.json・main-link.json は新しいものに替わる）', result.ok === true && result.ready.token === ready1.token && result.ready.port === ready1.port
        && result.ready.pid !== first.pid && boot.readControl(dataDir)?.pid === result.ready.pid, JSON.stringify({ ...result, ready: undefined, error: result.error?.message }));
      t.ok('本物: 同じ包みがつながり直り、running が往復する（message の登録はそのまま）', link.connected === true && link.pid === result.ready.pid && await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 10_000);
        const on = m => { if (m.type === 'running') { clearTimeout(timer); link.off('message', on); resolve(m.work?.count === 0); } };
        link.on('message', on); link.postMessage({ type: 'running' });
      }));
      link.kill();
      await waitFor(() => !boot.isAlive(result.ready.pid), 15_000, 'server exit');
      t.ok('本物: 起こし直したサーバーも終わらせる握手で終わる', !boot.isAlive(result.ready.pid));
    } finally {
      for (const pid of pids) if (boot.isAlive(pid)) { try { process.kill(pid); } catch { /* 済み */ } }
      await sleep(300);
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
