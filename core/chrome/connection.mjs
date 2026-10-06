// PC の Chrome への CDP 接続 1 本の持ち主（docs/inapp-browser.md「Chrome への接続」、ADR 0148・0153）。
//
// 会話をまたいで 1 本を使い回す（許可の確認は接続ごとに出るため、切ってつなぎ直さない）。状態は 5 つ:
//   off         何もしていない（起動直後・「切る」・「やめる」・接続が切れた後）
//   setup  (A)  Chrome のトグル（chrome://inspect/#remote-debugging）がオフ。DevToolsActivePort が無い（reason null）・書かれたポートにつながらない
//               （reason unreachable。Chrome が起動していないときも。ファイルは Chrome を閉じても残る）。1 秒ごとに読み直し、時間では打ち切らない
//   permission (B)  Chrome に「リモート デバッグを許可しますか？」が出ている。待ちは無期限。Chrome の約 5 分の打ち切りは、Pleiad が確認を閉じてつなぎ直して覆う
//   denied (C)  利用者が「キャンセル」を押した（打ち切りでは入らない）
//   connected (D)  つながった。ws が閉じたら off＋理由。自動ではつなぎ直さない（つなぐたびに確認が出るため）
// ほかに、OS の層が使えない（Windows 以外・Electron が無い）ときの unsupported。
//
// OS の値（窓のハンドルなど）は持たない。窓の操作は os（core/chrome/os.mjs の口）だけを呼ぶ。
// 第 2 段で上りへ送る CDP は Browser.getVersion だけ（Target.* は送らない。利用者のタブの URL・題を受け取らない）。
// ログには状態・round・raise の method だけを出す（窓の題や Chrome の値は出さない）。
import { WebSocket as NodeWebSocket } from 'ws';
import net from 'node:net';
import { readActivePort } from './locate.mjs';
import { createCdp } from './cdp.mjs';

export class ChromeConnectionError extends Error {
  /** @param {'unsupported'|'declined'|'disconnected'|'closed'|'aborted'|'protocol'} code */
  constructor(code, message) { super(message ?? code); this.name = 'ChromeConnectionError'; this.code = code; }
}

const DEFAULTS = {
  pollMs: 1000,
  /** 確認を出してから、Pleiad が閉じて出し直すまで。Chrome の打ち切り（約 5 分）より前 */
  reissueMs: 270_000,
  /** 印の無い失敗が、確認を出してからこの時間より前ならキャンセル、以降なら Chrome の打ち切り */
  cancelBeforeMs: 290_000,
  dialogWaitMs: 3000,
  dialogPollMs: 200,
  yieldWatchMs: 1000,
  selfCloseGuardMs: 3000,
  probeMs: 1000,
};

const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) };

/** 127.0.0.1 のポートにつながるか（古い DevToolsActivePort を見分ける） */
export function probeLoopbackPort(port, timeoutMs = DEFAULTS.probeMs) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * @param {object} deps
 * @param {{ browser: string, userDataDir: string }|null} deps.locate  Chrome の User Data（null・空なら unsupported / platform）
 * @param os  core/chrome/os.mjs の口（偽物でもよい）
 */
export function createChromeConnection({ locate, os, WebSocketImpl = NodeWebSocket, clock = realClock, probePort = probeLoopbackPort, log = () => {}, ...overrides }) {
  const opt = { ...DEFAULTS, ...overrides };
  const home = locate?.userDataDir ? locate : null;
  const listeners = new Set();
  const waiters = new Set();
  let status = { state: 'off', reason: null, dialog: false, product: null };
  let lastEmitted = null;
  let current = null;        // 進行中の試行（setup・permission・denied の間）
  let connected = null;      // { cdp, port }
  let userStarted = false;   // 設定の「つなぐ」から始めた試行か（待つ人がいなくなっても止めない）
  let bEntry = { raised: false };   // B に入ってから確認を前に出したか
  let seq = 0;
  let closedForGood = false;

  const sleep = ms => new Promise(resolve => clock.setTimeout(resolve, ms));
  /** 待たずに走らせる続き。想定外の例外は処理されない拒否にせず、ログに 1 行だけ出す（Chrome の値は出さない） */
  const run = promise => { promise.catch(error => log(`chrome: internal error: ${error?.message ?? error}`)); };
  const caps = () => os.capabilities();

  /** 公開する状態。OS の層が使えないときは unsupported で固定 */
  function state() {
    if (!home) return { state: 'unsupported', reason: 'platform', dialog: false, product: null };
    const c = caps();
    if (!c.supported && c.reason !== 'pending') return { state: 'unsupported', reason: c.reason ?? 'platform', dialog: false, product: null };
    return { ...status };
  }
  function emit() {
    if (closedForGood) return;
    const next = state();
    const key = JSON.stringify(next);
    if (key === lastEmitted) return;
    lastEmitted = key;
    for (const fn of [...listeners]) { try { fn(next); } catch { /* 聞き手の失敗は接続を壊さない */ } }
  }
  function setStatus(patch) {
    const next = { ...status, ...patch };
    if (next.state !== 'connected') next.product = null;
    const changed = next.state !== status.state || next.reason !== status.reason || next.dialog !== status.dialog;
    status = next;
    if (changed) log(`chrome: state=${next.state}${next.reason ? ` reason=${next.reason}` : ''}${next.state === 'permission' ? ` dialog=${next.dialog}` : ''}`);
    emit();
  }
  const rejectWaiters = error => { const list = [...waiters]; waiters.clear(); for (const w of list) w.reject(error); };

  async function isSupported() {
    if (!home) return false;
    return (await os.ready()).supported === true;
  }

  // ---- 試行 ----------------------------------------------------------------------------------
  const stale = (att, rnd) => closedForGood || att.stopped || current !== att || (rnd !== undefined && att.cur !== rnd);
  const clearTimer = (obj, key) => { if (obj[key]) { clock.clearTimeout(obj[key]); obj[key] = null; } };
  const clearRound = rnd => { for (const key of ['reissueTimer', 'guardTimer', 'yieldTimer']) clearTimer(rnd, key); rnd.finding = false; };

  async function begin() {
    if (closedForGood || current) return;
    if (!await isSupported()) { rejectWaiters(new ChromeConnectionError('unsupported')); emit(); return; }
    if (closedForGood || current || connected) return;
    if (!waiters.size && !userStarted) return;   // 待つ人が、試行が始まる前に外れた
    const att ={ id: ++seq, stopped: false, cur: null, round: 0, pollTimer: null };
    current = att;
    await tryPort(att);
  }

  /** ポートが生きているか。生きていれば upgrade を投げる（B）、そうでなければ A で 1 秒ごとに読み直す */
  async function tryPort(att) {
    const info = await readActivePort(home.userDataDir);
    if (stale(att)) return;
    if (!info || !await probePort(info.port)) {
      if (stale(att)) return;
      if (att.cur) { await sweep(att.cur); att.cur = null; if (stale(att)) return; }
      // ファイルはあるのにつながらない（unreachable）: Chrome が起動していないか、トグルがオフ（どちらでもファイルは残る）。ファイルが無い（null）: トグルを一度もオンにしていない
      setStatus({ state: 'setup', reason: info ? 'unreachable' : null, dialog: false });
      clearTimer(att, 'pollTimer');
      att.pollTimer = clock.setTimeout(() => { att.pollTimer = null; if (!stale(att)) run(tryPort(att)); }, opt.pollMs);
      return;
    }
    await startUpgrade(att, info);
  }

  async function startUpgrade(att, info) {
    if (status.state !== 'permission') { att.round = 0; bEntry = { raised: false }; }
    // 確認の窓の見つけ方の比べ元と、出し直しで前面を返す先は、upgrade を投げる直前に写す
    const [snap, fg] = await Promise.all([os.snapshotWindows(), os.foreground()]);
    if (stale(att)) return;
    const rnd = { n: att.round, snap: snap ?? [], prevFg: fg, ws: null, dialog: null, opened: false, selfClose: false, upgradeAt: clock.now(), port: info.port,
      reissueTimer: null, guardTimer: null, yieldTimer: null, finding: false };
    att.cur = rnd;
    const ws = new WebSocketImpl(`ws://127.0.0.1:${info.port}${info.path}`, { perMessageDeflate: false });
    rnd.ws = ws;
    setStatus({ state: 'permission', reason: null, dialog: att.round === 0 ? false : status.dialog });
    ws.on('open', () => { run(onOpen(att, rnd)); });
    // 確認を閉じた・「キャンセル」を押したとき、Chrome は HTTP 403 で断る（実機で確認。2026-10-06）。ほかの応答は想定外（protocol）
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      try { res.resume(); } catch { /* 読み捨て */ }
      try { ws.terminate(); } catch { /* 同上 */ }
      run(onFail(att, rnd, { protocol: status !== 403 }));
    });
    ws.on('error', () => {});
    ws.on('close', () => { run(onFail(att, rnd, {})); });
    rnd.reissueTimer = clock.setTimeout(() => { rnd.reissueTimer = null; run(reissue(att, rnd)); }, opt.reissueMs);
    run(findDialog(att, rnd));
  }

  /** upgrade の後 3 秒まで、新しく出た確認の窓を探す */
  async function findDialog(att, rnd) {
    rnd.finding = true;
    const deadline = clock.now() + opt.dialogWaitMs;
    while (!stale(att, rnd) && rnd.finding) {
      const ref = await os.findPermissionDialog({ since: rnd.snap });
      if (stale(att, rnd) || !rnd.finding) return;
      if (ref) { rnd.finding = false; await onDialogFound(att, rnd, ref); return; }
      if (clock.now() >= deadline) { rnd.finding = false; if (att.round === 0) setStatus({ dialog: false }); return; }
      await sleep(opt.dialogPollMs);
    }
  }

  async function onDialogFound(att, rnd, ref) {
    rnd.dialog = ref;
    setStatus({ dialog: true });
    // 前に出すのは、B に入って最初に見つけた 1 回だけ（出し直した確認は前に出さない）
    if (!bEntry.raised) {
      bEntry.raised = true;
      const result = await os.raise(ref);
      log(`chrome: raise method=${result?.method ?? 'failed'}`);
      return;
    }
    if (rnd.n >= 1) await watchYield(att, rnd, ref);
  }

  /** 出し直した確認が前面を取ったら、直前の前面（ブラウザーの窓でなければ）へ返す */
  async function watchYield(att, rnd, ref) {
    const prev = rnd.prevFg;
    if (!prev || prev.browser || prev.id === ref.id) return;
    const until = clock.now() + opt.yieldWatchMs;
    while (!stale(att, rnd)) {
      const fg = await os.foreground();
      if (stale(att, rnd)) return;
      if (fg?.id === ref.id) {
        const ok = await os.yieldForeground(ref, { to: prev });
        log(`chrome: yield ok=${ok === true}`);
        return;
      }
      if (clock.now() >= until) return;
      await sleep(opt.dialogPollMs);
    }
  }

  /** この round が出した確認を閉じる。見つけていなければ探して閉じる（ws だけ閉じると確認が Chrome に残るため） */
  async function sweep(rnd) {
    let ref = rnd.dialog;
    if (!ref) { try { ref = await os.findPermissionDialog({ since: rnd.snap }); } catch { ref = null; } }
    if (ref) { try { await os.close(ref); } catch { /* 閉じられなければ残るだけ */ } }
    return Boolean(ref);
  }

  /** 約 5 分で Chrome が打ち切る前に、Pleiad が古い確認を閉じる。ws の失敗（約 10〜20 ms）を受けたら、すぐつなぎ直す */
  async function reissue(att, rnd) {
    if (stale(att, rnd) || rnd.opened) return;
    rnd.selfClose = true;
    rnd.prevFg = (await os.foreground()) ?? rnd.prevFg;
    if (stale(att, rnd) || rnd.opened) return;
    const closed = rnd.dialog ? await os.close(rnd.dialog) : false;
    if (stale(att, rnd) || rnd.opened) return;
    if (!closed) {
      // 確認の窓を見つけていない（見つけても閉じられなかった）。探して閉じ、ダメなら ws を自分で閉じる（確認は残るので、失敗の後に掃除する）
      const found = await sweep(rnd);
      if (stale(att, rnd) || rnd.opened) return;
      if (!found) { try { rnd.ws?.terminate(); } catch { /* 閉じていてもよい */ } }
    }
    // 窓を閉じても ws が失敗しないときの保険
    rnd.guardTimer = clock.setTimeout(() => { rnd.guardTimer = null; try { rnd.ws?.terminate(); } catch { /* 同上 */ } }, opt.selfCloseGuardMs);
  }

  async function onFail(att, rnd, { protocol = false }) {
    if (stale(att, rnd) || rnd.opened || rnd.failed) return;
    rnd.failed = true;
    clearRound(rnd);
    const elapsed = clock.now() - rnd.upgradeAt;
    if (protocol) { await sweep(rnd); finishAttempt(att, 'protocol', new ChromeConnectionError('protocol')); return; }
    // 失敗の直後に DevToolsActivePort を読み直す（トグルを戻した・Chrome の終了。確認の「[設定] でオフにする」はトグルを切らないので、ここではキャンセルと同じに見える）
    const info = await readActivePort(home.userDataDir);
    const alive = info ? await probePort(info.port) : false;
    if (stale(att, rnd)) return;
    if (!alive) { await sweep(rnd); if (stale(att, rnd)) return; att.cur = null; await tryPort(att); return; }
    if (rnd.selfClose) { att.round += 1; await startUpgrade(att, info); return; }
    if (elapsed < opt.cancelBeforeMs) { setStatus({ state: 'denied', reason: 'cancel', dialog: false }); att.cur = null; return; }
    // Chrome が先に打ち切った。残った確認を閉じて出し直す
    await sweep(rnd);
    if (stale(att, rnd)) return;
    att.round += 1;
    await startUpgrade(att, info);
  }

  async function onOpen(att, rnd) {
    if (stale(att, rnd) || rnd.failed) { try { rnd.ws?.terminate(); } catch { /* 同上 */ } return; }
    rnd.opened = true;
    clearRound(rnd);
    const cdp = createCdp(rnd.ws);
    let product = null;
    try { product = (await cdp.send('Browser.getVersion')).product ?? null; }
    catch { cdp.close(); if (!stale(att)) finishAttempt(att, 'protocol', new ChromeConnectionError('protocol')); return; }
    if (stale(att, rnd)) { cdp.close(); return; }
    current = null; att.cur = null; userStarted = false;
    clearTimer(att, 'pollTimer');
    connected = { cdp, port: rnd.port };
    setStatus({ state: 'connected', reason: null, dialog: false, product });
    const list = [...waiters]; waiters.clear();
    for (const w of list) w.resolve(cdp);
    cdp.onClose(() => { run(onConnectedClosed(cdp, rnd.port)); });
  }

  async function onConnectedClosed(cdp, port) {
    if (closedForGood || connected?.cdp !== cdp) return;   // 自分で切った
    connected = null;
    const info = await readActivePort(home.userDataDir);
    const alive = info && info.port === port ? await probePort(port) : false;
    setStatus({ state: 'off', reason: alive ? 'revoked' : 'chrome-closed', dialog: false });
  }

  /** 試行を終える（待っている人へ error を返し、確認を閉じ、off へ） */
  function finishAttempt(att, reason, error) {
    if (current !== att) return;
    att.stopped = true;
    current = null; userStarted = false;
    clearTimer(att, 'pollTimer');
    const rnd = att.cur; att.cur = null;
    if (rnd) { clearRound(rnd); sweep(rnd).catch(() => {}).finally(() => { try { rnd.ws?.terminate(); } catch { /* 同上 */ } }); }
    setStatus({ state: 'off', reason, dialog: false });
    rejectWaiters(error);
  }

  // ---- 公開 ----------------------------------------------------------------------------------
  return {
    state,
    info: () => ({ round: current?.round ?? 0 }),
    onChange(fn) { listeners.add(fn); const off = os.onReady?.(() => emit()); return () => { listeners.delete(fn); off?.(); }; },

    /**
     * つながった cdp を返す。何人が待っても試行は 1 本。期限は持たない。abort はその人だけを外す
     * （ほかに待つ人がいなくて、設定の「つなぐ」から始めた試行でもなければ、試行も止める）
     */
    async demand({ signal } = {}) {
      if (closedForGood) throw new ChromeConnectionError('closed');
      if (!await isSupported()) throw new ChromeConnectionError('unsupported');
      if (connected && !connected.cdp.closed) return connected.cdp;
      if (signal?.aborted) throw new ChromeConnectionError('aborted');
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.add(waiter);
        signal?.addEventListener('abort', () => {
          if (!waiters.delete(waiter)) return;
          reject(new ChromeConnectionError('aborted'));
          if (!waiters.size && !userStarted && current) finishAttempt(current, null, new ChromeConnectionError('aborted'));
        }, { once: true });
        run(begin());
      });
    },

    /** 設定の「つなぐ」。denied のときは「もう一度」 */
    async connect() {
      if (closedForGood) return;
      if (!await isSupported()) { emit(); return; }
      if (connected) return;
      userStarted = true;
      if (!current) { await begin(); return; }
      if (status.state === 'denied') await this.retry();
    },
    /** C の「もう一度」: B（トグルがオフなら A）からやり直す */
    async retry() {
      const att = current;
      if (!att || status.state !== 'denied') return;
      att.cur = null;
      await tryPort(att);
    },
    /** 「やめる」: 試行を止め、待っている人へ declined を返す。確認が出ていれば閉じる */
    giveUp() { if (current) finishAttempt(current, 'declined', new ChromeConnectionError('declined')); },
    /** 「切る」と「やめる」。つながっていれば切り、試行中なら止める */
    disconnect() {
      if (connected) {
        const c = connected; connected = null;
        c.cdp.close();
        setStatus({ state: 'off', reason: 'disconnected', dialog: false });
        return;
      }
      this.giveUp();
    },
    /** 「ダイアログを前に出す」 */
    async raiseDialog() {
      const att = current;
      const rnd = att?.cur;
      if (!rnd || status.state !== 'permission') return { ok: false, method: 'none' };
      let ref = rnd.dialog;
      if (!ref) { ref = await os.findPermissionDialog({ since: rnd.snap }); if (ref) { rnd.dialog = ref; setStatus({ dialog: true }); } }
      if (!ref) return { ok: false, method: 'none' };
      const result = await os.raise(ref);
      log(`chrome: raise method=${result?.method ?? 'failed'}`);
      return result;
    },
    /** Pleiad の終了。確認が出ていれば閉じる（Chrome に確認を残さない） */
    async close() {
      if (closedForGood) return;
      const att = current;
      const c = connected; connected = null;
      closedForGood = true;
      if (c) c.cdp.close();
      if (att) {
        att.stopped = true; current = null;
        clearTimer(att, 'pollTimer');
        const rnd = att.cur; att.cur = null;
        if (rnd) { clearRound(rnd); await sweep(rnd).catch(() => {}); try { rnd.ws?.terminate(); } catch { /* 同上 */ } }
      }
      rejectWaiters(new ChromeConnectionError('closed'));
      listeners.clear();
    },
  };
}
