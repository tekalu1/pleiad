// サーバーが落ちたときの起こし直し（無停止の更新 段階 2 の 2e。docs/zero-downtime-update/plan.md 2e）。
// AGENT_HOST_HANDOVER=on の main が、サーバーの切断を main-leaving なし・切り替え中でもなく見て、居なければ（desktop/server-boot.cjs の
// reattachServer が false）呼ぶ。同じ版のサーバーを同じトークン・ポートで起こし、同じ包み（ServerLink）でつなぎ直す。
// 窓の読み直し・見張りの付け直し・ダイアログは呼び出し側（main.cjs）。ここは「起こせたか」だけを返す。
//
// 起こす版: 落ちたサーバーの ready の runtimeKey の版（実行場所に残っていれば）。無ければ（掃除された・印が無い）この main の版（chooseServer の prepared）。
// 短い間に何度も落ちる（windowMs の間に maxCrashes 回）ときは起こし直さない（起動の直後に落ち続けるサーバーを回し続けない）。
// 起こした後に呼ぶ afterRestart(ready) が、保持役に載ったターンの付け直しの口（2b 以降。サーバー自身が起動で付け直す形なら要らない）。今は何もしない。
const path = require('node:path');

const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

const errorText = error => String(error?.message ?? error);

/**
 * 引数:
 *   link        main とサーバーの包み（つながりが切れた後。同じ包みでつなぎ直す。'message' の登録は残る）
 *   getReady    落ちたサーバーの最後の ready（port・token・runtimeKey）を返す関数
 *   prepared    この main の版の実行場所（chooseServer の prepared。runtimeKey の版が無いときに使う）
 *   root        実行場所の置き場（runtimeKey の版を locate する）
 * 戻り値 { restart() }。restart() は { ok: true, ready } / { ok: false, reason: 'loop' | 'failed', error? }。同時に 2 つは走らせない
 */
function createServerRestarter({ link, getReady, prepared, root, dataDir, resourcesPath, execPath, systemLocale = '', cwd, env = process.env, log = () => {}, afterRestart = null,
  maxCrashes = MAX_CRASHES, windowMs = CRASH_WINDOW_MS, readyTimeoutMs, now = () => Date.now(),
  boot = require('./server-boot.cjs'), job = () => require('./job.cjs'), runtimeLib = () => require('./runtime.cjs'),
  waitForReady = (target, timeoutMs) => require('./switch.cjs').waitForReady(target, timeoutMs), alive = pid => boot.isAlive(pid) }) {
  let crashes = [];
  let running = null;

  async function run() {
    const last = getReady() ?? {};
    const decision = job().decideLaunch(job().inspectJob());
    if (decision.mode === 'unsupported') throw new Error(`the server cannot be started: ${decision.reason}`);
    const same = last.runtimeKey && root ? await runtimeLib().locate({ root, key: last.runtimeKey }).catch(() => null) : null;
    const runtime = same ?? await prepared;
    if (!runtime) throw new Error('the runtime location is not available');
    log(`restarting the server (${same ? `version ${last.runtimeKey}` : 'this version'}, port ${last.port ?? '?'})`);
    const env2 = boot.serverEnv({ baseEnv: env, agentBrowserDir: runtime.agentBrowserDir, root: runtime.root, key: runtime.key, logFile: boot.serverLogFile(runtime.root),
      port: last.port, token: last.token, systemLocale, execPath, resourcesPath, stableCliEnv: runtimeLib().stableCliEnv({ execPath, resourcesPath }) });
    let launched = null;
    const next = waitForReady(link, readyTimeoutMs ?? boot.START_TIMEOUT_MS);
    try {
      await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(runtime.root), log,
        launch: async () => (launched = await boot.launchServer({ mode: decision.mode, nodeExe: runtime.nodeExe, args: [path.join(runtime.appDir, 'core', 'server.mjs')], cwd, env: env2 })) });
      return await next.promise;
    } catch (error) {
      next.cancel();
      // 立ちかけたサーバーがデータ置き場を持ったままだと、次の試みが起こせない。自分が起こしたものだけを止める
      if (launched?.pid && alive(launched.pid)) {
        link.leave?.('restart-failed');
        try { process.kill(launched.pid); } catch { /* もう居ない */ }
      }
      throw error;
    }
  }

  async function restart() {
    const at = now();
    crashes = crashes.filter(time => at - time < windowMs);
    crashes.push(at);
    if (crashes.length >= maxCrashes) {
      log(`the server stopped ${crashes.length} times within ${Math.round(windowMs / 1000)}s: not restarting it`);
      return { ok: false, reason: 'loop' };
    }
    try {
      const ready = await run();
      log(`the server is back (pid ${ready.pid ?? '?'}, port ${ready.port})`);
      await Promise.resolve(afterRestart?.(ready)).catch(error => log(`after restart failed: ${errorText(error)}`));
      return { ok: true, ready };
    } catch (error) {
      log(`the server could not be restarted: ${errorText(error)}`);
      return { ok: false, reason: 'failed', error };
    }
  }

  return { restart: () => (running ??= restart().finally(() => { running = null; })) };
}

module.exports = { createServerRestarter, MAX_CRASHES, CRASH_WINDOW_MS };
