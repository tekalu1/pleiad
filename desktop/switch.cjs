// 新しい版のサーバーへの切り替え（無停止の更新 段階 1 の 1-6。docs/zero-downtime-update/plan.md 1-6、design.md §5.1・§6・§6.1・§8）。
// 更新で入れ替わった新しい main が、古い版のサーバー（S1）に付け直したときに始める。段階 1 は保持役を持たないので、
// 作業が 0 件になるまで切り替えを先送りし（§6.1、ADR 0137 の 9）、0 件になったら S1 を終わらせ、同じトークン・ポートで
// 新しい版のサーバー（S2）を起こして窓を読み直す。
//
// createSwitch は副作用を全部 effects で受ける状態機械（実時間・実プロセスなしでテストする。tests/unit/desktop-switch.mjs）。
// createSwitchEffects が main の部品（ServerLink・desktop/server-boot.cjs・desktop/runtime.cjs）から effects を組み、startSwitch が両方をつなぐ。
//
// 状態（snapshot().state）:
//   current       切り替えは要らない（S1 がこの版）
//   preparing     新しい版の実行場所（chooseServer が裏で組み始めたもの）を待つ・起こせるか（Job）を見る
//   checking      事前の確かめ（core/handover-check.mjs）
//   incompatible  合わない版。「あとで／中断して更新」を聞いている（ADR 0036 の形）。reason は INCOMPATIBLE_REASONS
//   held          「あとで」。S1 のまま動かし続け、勝手には切り替えない（interruptNow で中断して切り替える。次の起動でまた聞く）。
//                 reason が 'stoppers' のときは、止まるものだけが残ったときの「あとで」（止まるものが無くなる・作業が増えるまで自動では切り替えない）
//   waiting       作業が 0 件になるのを待っている（waiting: { count, items, stoppers }。since は待ち始めた時刻。blockedBy は update-lock が断った理由）
//   asking        作業は終わったが、切り替えで止まるものが残っている。「あとで／止めて切り替え」を聞いている（reason: 'stoppers'）
//   interrupting  「今すぐ中断して切り替える」: 全部を update で中断している（interrupt: { done, total }）
//   locking       update-lock を取っている
//   stopping      S1 の shutdown の終わり（プロセスの終了）を待っている
//   starting      S2 を起こしている
//   fallback      S2 が立たなかったので、前の版（S1 の版）で起こし直している
//   reloading     窓を読み直している
//   restarting    新しい版を実行場所で起こせない更新: S1 を止めて main を起動し直す（起動で今の utilityProcess に落ちる）
//   done          切り替え終わり（previous: true なら前の版で動いている。retry() でやり直せる。stopped は切り替えで止めたもの）
//   failed        S2 も前の版も起こせなかった
//   cancelled     main が終わる
//
// 待つ作業（switchBlockers）: running の count（ターン・承認待ち・走っているサブエージェント・委譲タスク）。外部の stdio MCP・送信予定・
// 上限の解除後の再開は数えない。**切り替えで止まるもの**（stoppers: `!` の行と、ターンの外に残っている裏の作業＝Codex の裏の端末など）は
// 作業が終わっても止まらず、サーバーが終わると止まる。待たず、黙って止めもしない: 作業が 0 件になったとき、止まるものが残っていれば
// 自動では切り替えず「あとで／止めて切り替え」を聞く（asking。利用者が承認した「Z」。docs/design-system.md「切り替えを待つ表示」）。
//
// 表示の口: onState(listener) が状態が変わるたびに snapshot を渡す（desktop/switch-screen.cjs が画面へ送る）。
// answer('now' | 'later') が asking・incompatible の答え、interruptNow() が「今すぐ中断して切り替える」（held からも効く）、
// retry() が前の版で動いているとき（done・previous）の切り替えのやり直し。
const path = require('node:path');

const POLL_MS = 2000;
/** S1 が shutdown を受けてから終わるまでの上限（plan.md 1-6 の 3） */
const STOP_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 30_000;
/** 事前の確かめで合わなかったときの理由。runtime・job・ipc は新しい版を実行場所で起こせないので、中断した後は main を起動し直す */
const INCOMPATIBLE_REASONS = ['schema', 'ipc', 'runtime', 'job', 'check'];
const RESTART_REASONS = new Set(['runtime', 'job', 'ipc']);
/** S1 を手放している間（onServerExit の「サーバーが終了しました」を出さない） */
const REPLACING = new Set(['stopping', 'starting', 'fallback', 'reloading', 'restarting']);
const LIVE_TASK = new Set(['queued', 'running', 'cancelling']);
/** 切り替えで止まるものの一覧に載せる字の長さの上限（`!` の行のコマンドなど） */
const LABEL_MAX = 200;
/** main との口の版（desktop/server-link.cjs の IPC_RANGE と同じ） */
const MAIN_IPC = [1, 1];

const errorText = error => (error ? String(error.message ?? error) : null);

/** 版とビルドで、S1 を S2 へ替えるか。ビルドが両方分かればビルドで、どちらかが分からなければ版で比べる */
function needsSwitch(server, target) {
  if (!server || !target) return false;
  if (server.build && target.build) return server.build !== target.build;
  return String(server.appVersion ?? '') !== String(target.appVersion ?? '');
}

const label = value => (value == null ? null : String(value).slice(0, LABEL_MAX));

/**
 * 切り替えを待たせる作業と、切り替えで止まるもの。work は core/server.mjs の runningWork。
 * count は running の count（待つ作業の数）。items は表示用の一覧（会話ごとではなく作業ごと）。
 * stoppers は `!` の行（shells）と、ターンの外に残っている裏の作業（background の tasks）。数えず、待たない（asking で聞く）
 */
function switchBlockers(work) {
  if (!work) return null;
  const items = [];
  const turnSessions = new Set();
  for (const turn of work.turns ?? []) {
    turnSessions.add(turn.sessionId);
    items.push({ kind: 'turn', sessionId: turn.sessionId ?? null, backend: turn.backend ?? null });
  }
  for (const p of work.permissions ?? []) if (!p.relay && !p.detached) items.push({ kind: 'permission', sessionId: p.sessionId ?? null, toolName: p.toolName ?? null });
  for (const a of work.subagents ?? []) if (a.status === 'running' || a.status == null) items.push({ kind: 'subagent', sessionId: a.sessionId ?? null, id: a.id, description: a.description ?? null });
  for (const r of work.tasks ?? []) if (LIVE_TASK.has(r.status) && !turnSessions.has(r.sessionId)) items.push({ kind: 'task', sessionId: r.sessionId ?? null, taskId: r.taskId ?? null });
  const shells = (work.shells ?? []).map(s => ({ kind: 'shell', sessionId: s.sessionId ?? null, runId: s.runId ?? null, command: s.command ?? null, label: label(s.command) }));
  const background = (work.background ?? []).flatMap(b => (b.tasks ?? []).map(x => ({ kind: 'background', sessionId: b.sessionId ?? null, backend: b.backend ?? null, id: x.id, label: label(x.label) })));
  return { count: Number(work.count) || 0, items, stoppers: [...shells, ...background] };
}

/** handover-check の出力を、この main と今のデータ置き場で使えるか判定する。{ ok: true } か { ok: false, reason, detail } */
function judgeCheck(check, { ipc = MAIN_IPC } = {}) {
  if (!check || check.error || check.check !== 1) return { ok: false, reason: 'check', detail: check?.error ?? 'no result' };
  const range = check.ipc;
  if (!Array.isArray(range) || range.length !== 2 || !(range[0] <= ipc[1] && range[1] >= ipc[0])) return { ok: false, reason: 'ipc', detail: `ipc ${JSON.stringify(range)}` };
  if (Number.isInteger(check.dataSchemaFound) && check.dataSchemaFound !== check.dataSchema) {
    return { ok: false, reason: 'schema', detail: `data schema ${check.dataSchemaFound} -> ${check.dataSchema}` };
  }
  return { ok: true };
}

/**
 * 切り替えの状態機械。
 *   server   S1 の { appVersion, build }（ready から）
 *   target   この版の { appVersion, build }、またはそれを返す関数（Promise でもよい）
 *   effects  {
 *     prepare()            → { ok: true, runtime, mode } / { ok: false, reason: 'runtime'|'job', detail }
 *     check(runtime)       → handover-check の出力
 *     ask({ reason, waiting }) → 'now' | 'later'（合わない版・止まるものが残ったときの「あとで／中断して更新」）。
 *                          画面が答える（answer）ときは null・undefined を返す（ダイアログを出さない）
 *     running()            → runningWork
 *     abortAll(onProgress) 全部を update で中断し、count が 0 になるまで待つ（main.cjs の abortAll。見るたびに onProgress(work)）
 *     lock() / unlock()    update-lock（{ ok, reason }）/ update-unlock
 *     stopOld()            S1 に shutdown を送り、プロセスが終わるのを待つ → { ok } / { ok: false, error }
 *     reattachOld()        S1 が終わらなかったとき付け直す → boolean
 *     startNew(runtime, mode) / startPrevious(runtime, mode) → S2 の ready（失敗は例外）
 *     reload(ready)        窓を読み直す
 *     restart()            main を起動し直す（RESTART_REASONS の中断の後）
 *     fallback(error)      前の版で動いていることを知らせる
 *     failed(error)        どちらも起こせなかった
 *     delay(ms)
 *   }
 */
function createSwitch({ server, target, effects, pollMs = POLL_MS, log = () => {}, now = () => Date.now() }) {
  let snap = { state: 'idle', server, target: typeof target === 'function' ? null : target, waiting: null, reason: null, blockedBy: null, error: null, previous: false,
    since: null, interrupt: null, interruptFailed: false, stopped: [], at: null };
  const listeners = new Set();
  let interruptRequested = false;
  // 止まるものだけが残ったときに「あとで」を選んだ（止まるものが無くなる・作業が増えるまで、もう聞かない）
  let stoppersLater = false;
  let cancelled = false;
  let poke = null;
  let release = null;
  let pendingAnswer = null;
  let running = null;

  const emit = patch => {
    snap = { ...snap, ...patch };
    for (const listener of [...listeners]) {
      try { listener(snap); } catch (error) { log(`state listener threw: ${errorText(error)}`); }
    }
  };
  // 数秒おきに見る。interruptNow・cancel で待たずに戻る
  const pause = () => new Promise(resolve => {
    poke = resolve;
    Promise.resolve(effects.delay(pollMs)).then(resolve, resolve);
  }).finally(() => { poke = null; });
  /** 画面かダイアログの答えを待つ（effects.ask が答えを返さなければ answer() だけを待つ） */
  const askUser = info => new Promise(resolve => {
    pendingAnswer = resolve;
    Promise.resolve(effects.ask?.(info)).then(answer => { if (answer) resolve(answer); }, () => resolve('later'));
  }).finally(() => { pendingAnswer = null; });

  /** 待ちの表示。待ち始めた時刻（since）は、待ちでない状態から入ったときに決める（ロックが取れず待ちに戻ったときは変えない） */
  const waiting = blockers => emit({ state: 'waiting', reason: null, waiting: blockers,
    since: ['waiting', 'locking', 'interrupting'].includes(snap.state) && snap.since ? snap.since : now() });

  /** 作業が 0 件（止まるものが無いか、止めてよいとき）で update-lock を取れたら true。main が終わるなら false */
  async function waitIdle() {
    for (;;) {
      if (cancelled) return false;
      if (interruptRequested) {
        const total = snap.waiting?.count ?? 0;
        emit({ state: 'interrupting', interrupt: { done: 0, total }, interruptFailed: false });
        try {
          await effects.abortAll(progress => {
            const left = switchBlockers(progress)?.count ?? 0;
            const done = Math.min(total, Math.max(snap.interrupt?.done ?? 0, total - left));
            if (done !== snap.interrupt?.done) emit({ interrupt: { done, total } });
          });
        } catch (error) {
          // 止まらない作業があった（30 秒）。中断はやめて待ちに戻る（もう一度押せる）
          interruptRequested = false;
          log(`interrupting failed: ${errorText(error)}`);
          emit({ state: 'waiting', error: errorText(error), interruptFailed: true, interrupt: null });
          await pause();
          continue;
        }
      }
      const work = await effects.running().catch(() => null);
      if (cancelled) return false;
      const blockers = switchBlockers(work);
      if (!work || blockers.count > 0) {
        stoppersLater = false;
        waiting(blockers ?? snap.waiting);
        await pause();
        continue;
      }
      if (blockers.stoppers.length > 0 && !interruptRequested) {
        // 作業は終わったが、`!` の行・裏の端末などが残っている。サーバーが終わると止まるので、黙って切り替えず聞く
        if (!stoppersLater) {
          emit({ state: 'asking', reason: 'stoppers', waiting: blockers, since: null });
          const answer = await askUser({ reason: 'stoppers', waiting: blockers });
          if (cancelled) return false;
          if (answer === 'now') interruptRequested = true; else stoppersLater = true;
          continue;
        }
        // 「あとで」: 自動では切り替えない。止まるものが無くなる・作業が増える・「止めて切り替え」まで見続ける
        emit({ state: 'held', reason: 'stoppers', waiting: blockers });
        await pause();
        continue;
      }
      emit({ state: 'locking', waiting: blockers, interrupt: null, reason: snap.reason === 'stoppers' ? null : snap.reason });
      const lock = await effects.lock().catch(error => ({ ok: false, reason: errorText(error) }));
      if (cancelled) { if (lock?.ok) effects.unlock(); return false; }
      if (!lock?.ok) {
        // 短い処理の最中（切り替え・送信待ちの配送など）。待ちに戻る
        emit({ state: 'waiting', blockedBy: lock?.reason ?? null });
        await pause();
        continue;
      }
      // 数えてからロックを取るまでの間に始まった作業・止まるものを、もう一度数える。ロックの後は新しい作業が始まらない
      const again = await effects.running().catch(() => null);
      const still = switchBlockers(again);
      if (!again || still.count > 0) {
        effects.unlock();
        waiting(still ?? blockers);
        await pause();
        continue;
      }
      if (still.stoppers.length > 0 && !interruptRequested && !stoppersLater) { effects.unlock(); continue; }
      emit({ blockedBy: null, error: null, stopped: still.stoppers });
      return true;
    }
  }

  async function run() {
    const goal = typeof target === 'function' ? await target() : target;
    emit({ target: goal ?? null });
    if (!needsSwitch(snap.server, goal)) { emit({ state: 'current' }); return snap; }
    log(`the running server is ${snap.server.appVersion || '?'} (${snap.server.build || '?'}), this version is ${goal.appVersion || '?'} (${goal.build || '?'}): switching when the work is done`);
    emit({ state: 'preparing' });
    let plan = await Promise.resolve(effects.prepare()).catch(error => ({ ok: false, reason: 'runtime', detail: errorText(error) }));
    if (plan?.ok) {
      emit({ state: 'checking' });
      const check = await Promise.resolve(effects.check(plan.runtime)).catch(error => ({ error: errorText(error) }));
      plan = { ...plan, ...judgeCheck(check) };
    }
    if (cancelled) return cancel();
    let restart = false;
    if (!plan?.ok) {
      const reason = INCOMPATIBLE_REASONS.includes(plan?.reason) ? plan.reason : 'check';
      log(`the new version cannot take over while work is running (${reason}${plan?.detail ? `: ${plan.detail}` : ''})`);
      const work = await effects.running().catch(() => null);
      emit({ state: 'incompatible', reason, error: plan?.detail ?? null, waiting: switchBlockers(work) });
      const answer = await askUser({ reason, waiting: switchBlockers(work) });
      if (cancelled) return cancel();
      if (answer !== 'now' && !interruptRequested) {
        emit({ state: 'held' });
        await new Promise(resolve => { release = resolve; });
        release = null;
        if (cancelled) return cancel();
      }
      interruptRequested = true;
      restart = RESTART_REASONS.has(reason);
    }

    for (;;) {
      if (!await waitIdle()) return cancel();
      emit({ state: 'stopping', waiting: null });
      const stopped = await Promise.resolve(effects.stopOld()).catch(error => ({ ok: false, error: errorText(error) }));
      if (stopped?.ok) break;
      log(`the old server did not stop: ${stopped?.error ?? '?'}`);
      // S1 が居残った（終わらなかった）なら付け直して待ちからやり直す。居なくなっていれば起こす側へ進む
      if (await Promise.resolve(effects.reattachOld()).catch(() => false)) {
        effects.unlock();
        emit({ state: 'waiting', error: stopped?.error ?? null });
        continue;
      }
      break;
    }

    if (restart) {
      emit({ state: 'restarting' });
      await effects.restart();
      return snap;
    }
    emit({ state: 'starting' });
    let ready = null;
    let failure = null;
    try { ready = await effects.startNew(plan.runtime, plan.mode); }
    catch (error) { failure = error; }
    let previous = false;
    if (!ready) {
      log(`the new server did not start: ${errorText(failure)}; starting the previous version again`);
      emit({ state: 'fallback', error: errorText(failure) });
      try { ready = await effects.startPrevious(plan.runtime, plan.mode); previous = true; }
      catch (error) {
        log(`the previous version did not start either: ${errorText(error)}`);
        emit({ state: 'failed', error: errorText(error) });
        await Promise.resolve(effects.failed(failure ?? error)).catch(() => {});
        return snap;
      }
    }
    emit({ state: 'reloading', previous });
    try { await effects.reload(ready); }
    catch (error) { log(`reloading the window failed: ${errorText(error)}`); }
    emit({ state: 'done', previous, server: { appVersion: ready.appVersion ?? null, build: ready.build ?? null }, waiting: null, at: now() });
    if (previous) await Promise.resolve(effects.fallback(failure)).catch(() => {});
    return snap;
  }

  function cancel() {
    emit({ state: 'cancelled' });
    return snap;
  }

  return {
    run() { running ??= run(); return running; },
    snapshot: () => snap,
    onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** 「今すぐ中断して切り替える」（asking の「止めて切り替え」・incompatible の「中断して切り替え」を含む）。待ち・あとで・聞いているときだけ効く */
    interruptNow() {
      if (!['waiting', 'locking', 'held', 'incompatible', 'asking', 'interrupting'].includes(snap.state)) return false;
      interruptRequested = true;
      poke?.();
      release?.();
      pendingAnswer?.('now');
      return true;
    },
    /** asking・incompatible の答え（画面の「あとで」「止めて切り替え」「中断して切り替え」）。聞いていなければ false */
    answer(value) {
      if (value === 'now') return this.interruptNow();
      if (value !== 'later' || !pendingAnswer) return false;
      pendingAnswer('later');
      return true;
    },
    /** 前の版で動いているとき（切り替えに失敗した）、切り替えをやり直す。作業が残っていれば、また待つ */
    retry() {
      if (snap.state !== 'done' || !snap.previous) return false;
      interruptRequested = false;
      stoppersLater = false;
      emit({ state: 'idle', previous: false, error: null, reason: null, waiting: null, blockedBy: null, since: null, interrupt: null, interruptFailed: false, stopped: [], at: null });
      running = run();
      running.catch(error => log(`switching failed: ${errorText(error)}`));
      return true;
    },
    /** main が終わる。待ちをやめる（S1 を手放している途中なら止めない） */
    cancel() {
      cancelled = true;
      poke?.();
      release?.();
      pendingAnswer?.('later');
    },
    /** S1 を手放している間か（main.cjs の onServerExit が「サーバーが終了しました」を出さない） */
    get replacing() { return REPLACING.has(snap.state); },
  };
}

// ---- 副作用

/** 組んだ実行場所で core/handover-check.mjs を走らせ、出力の JSON を返す */
function runHandoverCheck({ nodeExe, appDir, dataDir, env = process.env, execFile = require('node:child_process').execFile, timeoutMs = CHECK_TIMEOUT_MS }) {
  const childEnv = { ...env, AGENT_HOST_DATA: dataDir };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    execFile(nodeExe, [path.join(appDir, 'core', 'handover-check.mjs')], { cwd: appDir, env: childEnv, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`handover-check failed: ${error.message}${stderr ? `\n${String(stderr).slice(-500)}` : ''}`));
      const line = String(stdout).trim().split(/\r?\n/).pop();
      try { resolve(JSON.parse(line)); } catch { reject(new Error('handover-check printed no JSON')); }
    });
  });
}

/** 次に届く ready を待つ（S2 はつながった直後に ready を送る。つなぐ前に付ける） */
function waitForReady(link, timeoutMs) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const onMessage = message => { if (message?.type === 'ready') { done(); resolve(message); } };
    const timer = setTimeout(() => { done(); reject(Object.assign(new Error('the new server sent no ready'), { code: 'timeout' })); }, timeoutMs);
    const done = () => { clearTimeout(timer); link.off('message', onMessage); };
    cancel = done;
    link.on('message', onMessage);
  });
  promise.catch(() => {});
  return { promise, cancel: () => cancel() };
}

/**
 * main の部品から effects を組む。
 *   link      S1 につながっている ServerLink（S2 にも同じ包みでつなぐ。'message' の登録が残る）
 *   ready     S1 の ready（port・token・runtimeKey。S2 は同じトークン・ポートで起こす。design.md §8）
 *   prepared  この版の実行場所（chooseServer の prepared）
 *   request / runningWork / abortAll  main.cjs の workerRequest・runningWork・abortAll
 *   ask / reload / restart / fallback / failed  main の窓とダイアログ（main.cjs が渡す）
 *   rearm     同じ包みにつなぎ直した後に呼ぶ（main.cjs が once('exit') の見張りを付け直す）
 */
function createSwitchEffects({ link, ready, prepared, dataDir, resourcesPath, execPath, systemLocale = '', cwd, env = process.env,
  request, runningWork, abortAll, ask, reload, restart, fallback, failed, rearm = () => {}, log = () => {},
  boot = require('./server-boot.cjs'), job = () => require('./job.cjs'), runtimeLib = () => require('./runtime.cjs'), check = runHandoverCheck,
  alive = pid => boot.isAlive(pid), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
  stopTimeoutMs = STOP_TIMEOUT_MS, readyTimeoutMs = boot.START_TIMEOUT_MS }) {
  const oldPid = () => link.pid ?? ready.pid ?? null;

  async function start(runtime, mode) {
    const env2 = boot.serverEnv({ baseEnv: env, agentBrowserDir: runtime.agentBrowserDir, root: runtime.root, key: runtime.key, logFile: boot.serverLogFile(runtime.root),
      port: ready.port, token: ready.token, systemLocale, execPath, resourcesPath, stableCliEnv: runtimeLib().stableCliEnv({ execPath, resourcesPath }) });
    let launched = null;
    const next = waitForReady(link, readyTimeoutMs);
    try {
      await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(runtime.root), log,
        launch: async () => (launched = await boot.launchServer({ mode, nodeExe: runtime.nodeExe, args: [path.join(runtime.appDir, 'core', 'server.mjs')], cwd, env: env2 })) });
      rearm();
      const started = await next.promise;
      // 切り替えをやり直すとき（前の版で動いている）の古いサーバーは、今起こしたもの
      Object.assign(ready, { port: started.port, token: started.token, pid: started.pid, runtimeKey: started.runtimeKey });
      return started;
    } catch (error) {
      next.cancel();
      // 立ちかけたサーバーがデータ置き場を持ったままだと、前の版で起こし直せない。自分が起こしたものだけを止める
      if (launched?.pid && alive(launched.pid)) {
        link.leave?.('switch-failed');
        try { process.kill(launched.pid); } catch { /* もう居ない */ }
      }
      throw error;
    }
  }

  return {
    delay: sleep,
    async prepare() {
      const decision = job().decideLaunch(job().inspectJob());
      if (decision.mode === 'unsupported') return { ok: false, reason: 'job', detail: decision.reason };
      const runtime = await prepared;
      if (!runtime) return { ok: false, reason: 'runtime', detail: 'the runtime location could not be prepared' };
      return { ok: true, runtime, mode: decision.mode };
    },
    check: runtime => check({ nodeExe: runtime.nodeExe, appDir: runtime.appDir, dataDir, env }),
    ask,
    running: () => runningWork(),
    abortAll: onProgress => abortAll('update', onProgress),
    lock: () => request('update-lock'),
    unlock: () => { link.postMessage({ type: 'update-unlock' }); },
    async stopOld() {
      const pid = oldPid();
      link.postMessage({ type: 'shutdown' });
      const until = now() + stopTimeoutMs;
      while (pid && alive(pid)) {
        if (now() >= until) return { ok: false, error: `the old server (pid ${pid}) did not stop in ${Math.round(stopTimeoutMs / 1000)}s` };
        await sleep(100);
      }
      return { ok: true };
    },
    async reattachOld() {
      if (!alive(oldPid())) return false;
      if (link.connected) return true;
      const attached = await boot.reattachServer({ link, dataDir, log });
      if (attached) rearm();
      return attached;
    },
    startNew: (runtime, mode) => start(runtime, mode),
    async startPrevious(runtime, mode) {
      const previous = ready.runtimeKey ? await runtimeLib().locate({ root: runtime.root, key: ready.runtimeKey }) : null;
      if (!previous) throw new Error(`the previous version is not in the runtime location (${ready.runtimeKey ?? 'unknown'})`);
      return start(previous, mode);
    },
    reload,
    restart,
    fallback,
    failed,
  };
}

/**
 * 「あとで／中断して更新」のダイアログ（ADR 0036 の形）。画面が切り替えの表示を持たないとき（この機能を持たない版の画面。
 * desktop/switch-screen.cjs）の effects.ask になる。合わない版（reason は INCOMPATIBLE_REASONS）と、作業が終わって止まるものだけが
 * 残ったとき（reason: 'stoppers'。「あとで／止めて切り替え」）。t は desktop/i18n.cjs の t
 */
function incompatibleDialog({ dialog, getWindow, t }) {
  const reasons = { schema: () => t('switch.reasonSchema'), ipc: () => t('switch.reasonIpc'), runtime: () => t('switch.reasonRuntime'), job: () => t('switch.reasonJob'), check: () => t('switch.reasonCheck') };
  return async ({ reason, waiting }) => {
    if (reason === 'stoppers') {
      const message = [t('switch.stoppersMessage', { count: waiting?.stoppers?.length ?? 0 }), t('switch.stoppersLater')].join('\n\n');
      const options = { type: 'info', title: t('switch.stoppersTitle'), message, buttons: [t('switch.later'), t('switch.stopAndSwitch')], defaultId: 0, cancelId: 0, noLink: true };
      const window = getWindow();
      const { response } = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
      return response === 1 ? 'now' : 'later';
    }
    const busy = (waiting?.count ?? 0) > 0;
    const message = [(reasons[reason] ?? reasons.check)(), busy ? t('switch.incompatibleWork', { count: waiting.count }) : null, t('switch.incompatibleLater')].filter(Boolean).join('\n\n');
    const options = { type: 'info', title: t('switch.incompatibleTitle'), message, buttons: [t('switch.later'), busy ? t('switch.interruptAndUpdate') : t('switch.updateNow')], defaultId: 0, cancelId: 0, noLink: true };
    const window = getWindow();
    const { response } = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    return response === 1 ? 'now' : 'later';
  };
}

/** 状態の移り変わりを 1 行ずつログに残す（待ちの中身は変わったときだけ） */
function logStates(control, log) {
  let last = '';
  return control.onState(s => {
    const waiting = ['waiting', 'asking', 'held'].includes(s.state) && s.waiting ? ` ${s.waiting.count}: ${[...s.waiting.items, ...s.waiting.stoppers].map(item => `${item.kind}:${item.sessionId ?? '-'}`).join(', ')}` : '';
    const line = `${s.state}${waiting}${s.blockedBy ? ` (blocked: ${s.blockedBy})` : ''}${s.reason ? ` (${s.reason})` : ''}${s.error ? ` — ${s.error}` : ''}`;
    if (line !== last && s.state !== 'idle') log(line);
    last = line;
  });
}

/**
 * 付け直したサーバーが古い版なら切り替えを始める。戻り値は createSwitch の制御（run は始まっている）。
 *   linked         chooseServer の戻り値（link・prepared）
 *   ready          S1 の ready
 *   resourcesPath  この版の resources\（app\manifest.json の版とビルドが切り替えの先）
 * ほかは createSwitchEffects の引数
 */
function startSwitch({ linked, ready, resourcesPath, log = () => {}, readManifest = dir => require('./runtime-manifest.cjs').readManifest(dir), ...rest }) {
  const { shortBuildHash } = require('./runtime-manifest.cjs');
  const server = { appVersion: ready.appVersion ?? linked.link.serverInfo?.appVersion ?? '', build: ready.build ?? null };
  const target = async () => {
    try {
      const manifest = await readManifest(path.join(resourcesPath, 'app'));
      return { appVersion: manifest.appVersion, build: shortBuildHash(manifest.buildHash) };
    } catch (error) {
      log(`the manifest of this version could not be read (${errorText(error)}): not switching`);
      return null;
    }
  };
  const effects = createSwitchEffects({ link: linked.link, ready, prepared: linked.prepared, resourcesPath, log, ...rest });
  const control = createSwitch({ server, target, effects, log });
  logStates(control, log);
  control.run().catch(error => log(`switching failed: ${errorText(error)}`));
  return control;
}

module.exports = {
  POLL_MS, STOP_TIMEOUT_MS, INCOMPATIBLE_REASONS, RESTART_REASONS, MAIN_IPC,
  needsSwitch, switchBlockers, judgeCheck, createSwitch, runHandoverCheck, waitForReady, createSwitchEffects, incompatibleDialog, startSwitch,
};
