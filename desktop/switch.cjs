// 新しい版のサーバーへの切り替え（無停止の更新 段階 1 の 1-6。docs/zero-downtime-update/plan.md 1-6、design.md §5.1・§6・§6.1・§8）。
// 更新で入れ替わった新しい main が、古い版のサーバー（S1）に付け直したときに始める。段階 1 は保持役を持たないので、
// 作業が 0 件になるまで切り替えを先送りし（§6.1、ADR 0151 の 9）、0 件になったら S1 を終わらせ、同じトークン・ポートで
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
//   handing       引き継ぎ（段階 2 の 2d）: S2 を --handover で起こし、S1 に handover を頼んで、S1 が保持役のターンを渡して終わり、S2 が付け直すまで
//   stopping      S1 の shutdown の終わり（プロセスの終了）を待っている
//   starting      S2 を起こしている
//   fallback      S2 が立たなかったので、前の版（S1 の版）で起こし直している
//   reloading     窓を読み直している
//   restarting    新しい版を実行場所で起こせない更新: S1 を止めて main を起動し直す（起動で今の utilityProcess に落ちる）
//   done          切り替え終わり（previous: true なら前の版で動いている。retry() でやり直せる。stopped は切り替えで止めたもの）
//   failed        S2 も前の版も起こせなかった
//   cancelled     main が終わる
//
// 引き継ぎ（段階 2 の 2d。core/handover.mjs）: S1 が保持役に載ったターン（running の held）を新しいサーバーへ渡せるとき、そのターンは待たない
// （作業の最中でも切り替える）。待つのは、載っていないターン・準備中のターンなど running の handover.blocking だけ。新しい版が handover-check で
// 引き継ぎの形（handover・holder の範囲）を持っていて、S1 の running にも handover があるときだけ。無ければ今までの先送り（update-lock → shutdown → S2）。
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
const REPLACING = new Set(['handing', 'stopping', 'starting', 'fallback', 'reloading', 'restarting']);
const LIVE_TASK = new Set(['queued', 'running', 'cancelling']);
/** 切り替えで止まるものの一覧に載せる字の長さの上限（`!` の行のコマンドなど） */
const LABEL_MAX = 200;
/** main との口の版（desktop/server-link.cjs の IPC_RANGE と同じ） */
const MAIN_IPC = [1, 1];
/** S1 に handover を頼んでから答えが来るまでの上限（S1 の待ち: 短い処理 8 秒・処理中の呼び出し 5 秒、手を離す・DB を書く分を足す） */
const HANDOVER_REQUEST_MS = 40_000;
/** S2 がモジュールを読み込んでロックを待つところまで進むのを待つ上限（Defender の遅い最初の読みを見込む） */
const PRELOAD_TIMEOUT_MS = 5_000;
/** 引き継ぎを断られた（S1 が忙しい・引き継げない作業が残っている）あとの待ちの間隔。続けて断られたら延ばす（S1 が新しい作業を送信待ちに回す時間を減らす） */
const DECLINE_BACKOFF_MS = [2_000, 4_000, 10_000];

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
function switchBlockers(work, { handover = false } = {}) {
  if (!work) return null;
  const items = [];
  const turnSessions = new Set();
  // handover: 保持役に載ったターン（held）とその承認待ち・サブエージェントは、新しいサーバーへ渡すので待たない
  const skip = x => handover && x.held === true;
  for (const turn of work.turns ?? []) {
    turnSessions.add(turn.sessionId);
    if (!skip(turn)) items.push({ kind: 'turn', sessionId: turn.sessionId ?? null, backend: turn.backend ?? null });
  }
  for (const p of work.permissions ?? []) if (!p.relay && !p.detached && !skip(p)) items.push({ kind: 'permission', sessionId: p.sessionId ?? null, toolName: p.toolName ?? null });
  for (const a of work.subagents ?? []) if ((a.status === 'running' || a.status == null) && !skip(a)) items.push({ kind: 'subagent', sessionId: a.sessionId ?? null, id: a.id, description: a.description ?? null });
  for (const r of work.tasks ?? []) if (LIVE_TASK.has(r.status) && !turnSessions.has(r.sessionId)) items.push({ kind: 'task', sessionId: r.sessionId ?? null, taskId: r.taskId ?? null });
  const shells = (work.shells ?? []).map(s => ({ kind: 'shell', sessionId: s.sessionId ?? null, runId: s.runId ?? null, command: s.command ?? null, label: label(s.command) }));
  const background = (work.background ?? []).flatMap(b => (b.tasks ?? []).map(x => ({ kind: 'background', sessionId: b.sessionId ?? null, backend: b.backend ?? null, id: x.id, label: label(x.label) })));
  // handover のときの count は、サーバーが数えた待つ作業（blocking）。items と同じ数になるはずだが、数えの違いがあれば items の側を信じず blocking に従う
  const count = handover ? Number(work.handover?.blocking) || 0 : Number(work.count) || 0;
  return { count, items, stoppers: [...shells, ...background], ...(handover ? { handover: { held: Number(work.handover?.held) || 0 } } : {}) };
}

const inRange = (value, range) => Array.isArray(range) && range.length === 2 && Number.isInteger(value) && range[0] <= value && value <= range[1];

/**
 * 引き継ぎ（保持役に載ったターンを待たずに渡す）で切り替えるか。新しい版が引き継ぎの形と保持役の規約を持っていて（handover-check の handover・holder）、
 * S1 の running が handover を載せていて（版が範囲に入る）、保持役のターンがあるなら S1 の保持役の世代が新しい版の範囲に入るとき
 */
function handoverMode(work, plan) {
  const mine = work?.handover;
  if (!mine || !plan?.handover) return false;
  if (!inRange(mine.v, plan.handover)) return false;
  return !(mine.held > 0 && mine.holder != null && !inRange(mine.holder, plan.holder));
}

/** handover-check の出力を、この main と今のデータ置き場で使えるか判定する。{ ok: true } か { ok: false, reason, detail } */
function judgeCheck(check, { ipc = MAIN_IPC } = {}) {
  if (!check || check.error || check.check !== 1) return { ok: false, reason: 'check', detail: check?.error ?? 'no result' };
  const range = check.ipc;
  if (!Array.isArray(range) || range.length !== 2 || !(range[0] <= ipc[1] && range[1] >= ipc[0])) return { ok: false, reason: 'ipc', detail: `ipc ${JSON.stringify(range)}` };
  if (Number.isInteger(check.dataSchemaFound) && check.dataSchemaFound !== check.dataSchema) {
    return { ok: false, reason: 'schema', detail: `data schema ${check.dataSchemaFound} -> ${check.dataSchema}` };
  }
  // 引き継ぎの形（無い版は今までの先送り）
  return { ok: true, handover: Array.isArray(check.handover) ? check.handover : null, holder: Array.isArray(check.holder) ? check.holder : null };
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
 *     handover(runtime, mode) 引き継ぎ（S2 を --handover で起こし、S1 に handover を頼む）。{ ready, timing }（S2 が付け直して ready を送った）/
 *                          { declined: true, reason, detail }（S1 が断った。S1 は元のまま・S2 は止めた）/ { stay: error }（S2 を起こせなかった。S1 は元のまま）/
 *                          { failed: error }（S1 は渡して終わったのに S2 が立たなかった。前の版で起こし直す）
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
    since: null, interrupt: null, interruptFailed: false, stopped: [], handover: null, at: null };
  const listeners = new Set();
  let interruptRequested = false;
  // 止まるものだけが残ったときに「あとで」を選んだ（止まるものが無くなる・作業が増えるまで、もう聞かない）
  let stoppersLater = false;
  let cancelled = false;
  let poke = null;
  let release = null;
  let pendingAnswer = null;
  let running = null;
  // 引き継ぎ（保持役に載ったターンを待たずに渡す）で切り替えられる版か（事前の確かめの結果）と、続けて断られた回数
  let handoverPlan = null;
  let declines = 0;

  const emit = patch => {
    snap = { ...snap, ...patch };
    for (const listener of [...listeners]) {
      try { listener(snap); } catch (error) { log(`state listener threw: ${errorText(error)}`); }
    }
  };
  // 数秒おきに見る。interruptNow・cancel で待たずに戻る
  const pause = (ms = pollMs) => new Promise(resolve => {
    poke = resolve;
    Promise.resolve(effects.delay(ms)).then(resolve, resolve);
  }).finally(() => { poke = null; });
  /** 画面かダイアログの答えを待つ（effects.ask が答えを返さなければ answer() だけを待つ） */
  const askUser = info => new Promise(resolve => {
    pendingAnswer = resolve;
    Promise.resolve(effects.ask?.(info)).then(answer => { if (answer) resolve(answer); }, () => resolve('later'));
  }).finally(() => { pendingAnswer = null; });

  /** 待ちの表示。待ち始めた時刻（since）は、待ちでない状態から入ったときに決める（ロックが取れず待ちに戻ったときは変えない） */
  const waiting = blockers => emit({ state: 'waiting', reason: null, waiting: blockers,
    since: ['waiting', 'locking', 'interrupting'].includes(snap.state) && snap.since ? snap.since : now() });

  /**
   * 作業が 0 件（止まるものが無いか、止めてよいとき）になったら、切り替え方を返す。main が終わるなら false。
   *   'handover'  保持役に載ったターンは待たない（引き継ぎ）。update-lock は取らない（サーバーが自分で新しい作業を送信待ちに回して引き継ぐ）
   *   'legacy'    update-lock を取れた（今までの先送り。S1 を終わらせて S2 を起こす）
   */
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
      const viaHandover = !interruptRequested && handoverMode(work, handoverPlan);
      const blockers = switchBlockers(work, { handover: viaHandover });
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
      if (viaHandover) {
        emit({ blockedBy: null, error: null, stopped: blockers.stoppers, waiting: blockers, interrupt: null });
        return 'handover';
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
      return 'legacy';
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
    handoverPlan = plan?.ok ? plan : null;
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

    let handed = null;   // 引き継ぎの結果（{ ready, timing } か { failed }）
    let stay = null;
    for (;;) {
      const how = await waitIdle();
      if (!how) return cancel();
      if (how === 'handover') {
        emit({ state: 'handing', waiting: null });
        const out = await Promise.resolve(effects.handover(plan.runtime, plan.mode)).catch(error => ({ failed: error }));
        if (out?.declined) {
          // S1 が断った（忙しい・引き継げない作業が残っている）。S1 は元のまま。続けて断られたら間を延ばす
          declines += 1;
          log(`the handover was declined (${out.reason ?? '?'}${out.detail ? `: ${out.detail}` : ''}); waiting`);
          emit({ state: 'waiting', blockedBy: out.reason ?? 'handover', error: null });
          await pause(DECLINE_BACKOFF_MS[Math.min(declines, DECLINE_BACKOFF_MS.length) - 1]);
          continue;
        }
        declines = 0;
        if (out?.stay) stay = out.stay; else handed = out ?? { failed: new Error('no result') };
        break;
      }
      declines = 0;
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
    if (stay) {
      // 新しいサーバーを起こせなかった。S1 は何も渡していないので、そのまま動かし続ける（retry で準備からやり直せる）
      log(`the new server could not be started; the running one stays: ${errorText(stay)}`);
      emit({ state: 'done', previous: true, error: errorText(stay), waiting: null, at: now() });
      await Promise.resolve(effects.fallback(stay)).catch(() => {});
      return snap;
    }
    let ready = null;
    let failure = null;
    if (handed) {
      ready = handed.ready ?? null;
      failure = handed.failed ?? null;
      if (handed.timing) { emit({ handover: handed.timing }); log(`handed over: ${JSON.stringify(handed.timing)}`); }
    } else {
      emit({ state: 'starting' });
      try { ready = await effects.startNew(plan.runtime, plan.mode); }
      catch (error) { failure = error; }
    }
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
      declines = 0;
      emit({ state: 'idle', previous: false, error: null, reason: null, waiting: null, blockedBy: null, since: null, interrupt: null, interruptFailed: false, stopped: [], handover: null, at: null });
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
  stopTimeoutMs = STOP_TIMEOUT_MS, readyTimeoutMs = boot.START_TIMEOUT_MS, handoverRequestMs = HANDOVER_REQUEST_MS, preloadTimeoutMs = PRELOAD_TIMEOUT_MS,
  exists = file => require('node:fs').existsSync(file) }) {
  const oldPid = () => link.pid ?? ready.pid ?? null;
  // S1 が保持役のターンを渡して終わった（以後に起こすサーバーは、データ置き場の持ち主が居なくなるのを待ち、札を読んで付け直す。--handover）
  let handedOver = false;

  async function start(runtime, mode) {
    const env2 = boot.serverEnv({ baseEnv: env, agentBrowserDir: runtime.agentBrowserDir, root: runtime.root, key: runtime.key, logFile: boot.serverLogFile(runtime.root),
      port: ready.port, token: ready.token, systemLocale, execPath, resourcesPath, stableCliEnv: runtimeLib().stableCliEnv({ execPath, resourcesPath }) });
    let launched = null;
    const next = waitForReady(link, readyTimeoutMs);
    try {
      await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(runtime.root), log,
        launch: async () => (launched = await boot.launchServer({ mode, nodeExe: runtime.nodeExe, args: [path.join(runtime.appDir, 'core', 'server.mjs'), ...(handedOver ? ['--handover'] : [])], cwd, env: env2 })) });
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

  /** 引き継ぎ: S2 を --handover で起こし（モジュールを読んでデータ置き場のロックを待つ）、S1 に handover を頼み、S1 が終わったら S2 につなぐ */
  async function handover(runtime, mode) {
    const startedAt = now();
    const env2 = boot.serverEnv({ baseEnv: env, agentBrowserDir: runtime.agentBrowserDir, root: runtime.root, key: runtime.key, logFile: boot.serverLogFile(runtime.root),
      port: ready.port, token: ready.token, systemLocale, execPath, resourcesPath, stableCliEnv: runtimeLib().stableCliEnv({ execPath, resourcesPath }) });
    let launched = null;
    try {
      launched = await boot.launchServer({ mode, nodeExe: runtime.nodeExe, args: [path.join(runtime.appDir, 'core', 'server.mjs'), '--handover'], cwd, env: env2 });
    } catch (error) { return { stay: error }; }
    const stopLaunched = () => { if (launched?.pid && alive(launched.pid)) { try { process.kill(launched.pid); } catch { /* もう居ない */ } } };
    // S2 がモジュールを読み込んでデータ置き場のロックを待つところまで進むのを待つ（使用中の印ができる。core/server.mjs）。上限を過ぎても頼む（S2 は遅れて追いつく）
    const mark = path.join(runtime.root, 'run', `${runtime.key}-${launched.pid}.lock.db`);
    const loadedBy = now() + preloadTimeoutMs;
    while (!exists(mark) && alive(launched.pid) && now() < loadedBy) await sleep(20);
    const oldProcess = oldPid();
    let reply = await request('handover', {}, { timeoutMs: handoverRequestMs }).catch(error => ({ ok: false, reason: 'request', detail: errorText(error) }));
    // 答えが来なかったが、S1 がもう居ないなら渡して終わったあと（答えが届かなかっただけ）。S2 につなぐ
    if (!reply?.ok && reply?.reason === 'request' && oldProcess && !alive(oldProcess)) reply = { ok: true, handed: [], aborted: [], droppedCalls: 0 };
    if (!reply?.ok) {
      // S1 は元のまま。待たせていた S2 は止める（次に頼むときに起こし直す）
      stopLaunched();
      return { declined: true, reason: reply?.reason ?? 'declined', detail: reply?.detail ?? null };
    }
    handedOver = true;
    // S1 はロックを放して終わる。プロセスが居なくなるのを待つ（S2 はロックが取れたら先へ進む。S1 の終わりを待たなくても進むので、上限を過ぎても進む）
    const until = now() + stopTimeoutMs;
    while (oldProcess && alive(oldProcess) && now() < until) await sleep(50);
    if (oldProcess && alive(oldProcess)) log(`the old server (pid ${oldProcess}) is still running ${Math.round(stopTimeoutMs / 1000)}s after handing over`);
    const next = waitForReady(link, readyTimeoutMs);
    try {
      await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(runtime.root), log, launch: async () => launched });
      rearm();
      const started = await next.promise;
      Object.assign(ready, { port: started.port, token: started.token, pid: started.pid, runtimeKey: started.runtimeKey });
      const timing = { ms: now() - startedAt, old: reply.ms ?? null, handed: reply.handed ?? [], aborted: reply.aborted ?? [], droppedCalls: reply.droppedCalls ?? 0,
        // S1 がロックを放してから S2 が ready を送るまで（S1 の at と S2 の ready の handover.at は、同じ PC の時計）
        gapMs: Number.isFinite(reply.at) && Number.isFinite(started.handover?.at) ? started.handover.at - reply.at : null, adopted: started.handover?.adopted ?? null, lockWaitedMs: started.handover?.lockWaitedMs ?? null };
      return { ready: started, timing };
    } catch (error) {
      next.cancel();
      stopLaunched();
      return { failed: error };
    }
  }

  return {
    delay: sleep,
    handover,
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
  POLL_MS, STOP_TIMEOUT_MS, HANDOVER_REQUEST_MS, DECLINE_BACKOFF_MS, INCOMPATIBLE_REASONS, RESTART_REASONS, MAIN_IPC,
  needsSwitch, switchBlockers, handoverMode, judgeCheck, createSwitch, runHandoverCheck, waitForReady, createSwitchEffects, incompatibleDialog, startSwitch,
};
