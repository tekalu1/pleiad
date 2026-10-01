'use strict';
// core の parentPort のメッセージ（docs/computer-use.md「core と main」の computer-*）を受けて、撮影・入力・アプリの特定を行う。
// 操作は 1 本の列で直列に流し、操作ごとに上限時間を付ける。押したままのキー・ボタンは releaseAll で離す
// （Esc・computer-stop・computer-turn-ended・持ち主の変更・worker の終了・will-quit・番犬）。
const { ComputerError } = require('./errors.cjs');
const { loadWin32 } = require('./win32.cjs');
const { createInput } = require('./input.cjs');
const { createCapture } = require('./capture.cjs');
const { createApps } = require('./apps.cjs');
const { createDesktopState } = require('./desktop-state.cjs');
const { listDisplays, virtualBounds, containsPoint, signature } = require('./displays.cjs');

const OP_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const WATCHDOG_MS = 30_000;
const WATCHDOG_TICK_MS = 5_000;
const ASYNC_METHODS = new Set(['captureRect', 'fileDescription', 'shellOpen']);
const KEYBOARD = new Set(['text', 'key', 'keyDown', 'keyUp']);

/**
 * main のスレッドが Per-Monitor（V1 でも V2 でもよい。Electron の main は V1 = 実測 2026-10-01）でないときだけ、
 * 同期の呼び出しの間 PMv2 に切り替える。座標を物理画素にそろえるため
 */
function withPerMonitorDpi(win32) {
  if (win32.dpi.get().awareness === 'per-monitor') return win32;
  const wrapped = {};
  for (const [name, value] of Object.entries(win32)) {
    wrapped[name] = typeof value === 'function' && !ASYNC_METHODS.has(name)
      ? (...args) => { const restore = win32.dpi.enter(); try { return value(...args); } finally { restore(); } }
      : value;
  }
  return wrapped;
}

/**
 * @param {object} deps
 * @param {(message: object) => void} deps.post core へ送る
 * @param {object|null} deps.win32 win32.cjs の表（偽物でもよい）。null なら unsupported
 * @param {string} [deps.reason] win32 が null のときの理由（platform / native）
 * @param {{ suspend(): () => void }|null} [deps.escape] Esc の globalShortcut を外す（オーバーレイの suspendEscape）。戻す関数を返す
 */
function createComputerService({ post, win32: rawWin32 = null, reason = 'native', nativeImage = null, escape = null, sleep, listStartApps,
  selfPid, selfExe, now = Date.now, log = () => {}, timeouts = {} }) {
  const opTimeout = timeouts.op ?? OP_TIMEOUT_MS;
  const launchTimeout = timeouts.launch ?? LAUNCH_TIMEOUT_MS;
  const watchdogMs = timeouts.watchdog ?? WATCHDOG_MS;
  const supported = !!rawWin32;
  const win32 = supported ? withPerMonitorDpi(rawWin32) : null;
  let displays = [];
  let displaysVersion = 1;
  let armedOwner = null;
  let lastCallOwner = null;
  const stopped = new Set();
  let active = null;
  let tail = Promise.resolve();
  let lastSeen = now();
  let watchdogFired = false;
  let watchdogTimer = null;
  let selfElevated = false;

  let input, capture, apps, desktop;
  if (supported) {
    input = createInput({ win32, sleep, escape, virtualBounds: () => virtualBounds(displays) });
    capture = createCapture({ win32, nativeImage });
    apps = createApps({ win32, selfPid, selfExe, listStartApps, ...(sleep ? { sleep } : {}) });
    desktop = createDesktopState({ win32 });
    try { selfElevated = !!win32.selfElevated(); } catch { /* 昇格していない扱い */ }
  }

  let primed = false; // 最初の列挙は版を進めない
  function refreshDisplays(bump = false) {
    if (!supported) return false;
    const next = listDisplays(win32);
    const changed = primed && signature(next) !== signature(displays);
    displays = next;
    primed = true;
    if (changed || bump) { displaysVersion++; post({ type: 'computer-displays-changed', displays, displaysVersion }); }
    return changed;
  }

  function releaseAll() {
    if (!supported) return [];
    try { return input.releaseAll(); } catch (error) { log(`releaseAll failed: ${error.message}`); return []; }
  }

  const ensureUnlocked = () => {
    if (desktop.check().locked) throw new ComputerError('locked', 'the screen is locked or showing a secure desktop');
  };

  /** 入力の前に毎回: 昇格したアプリには届かない（uipi）、Pleiad 自身の窓にはキーを送らない（self）。離す動作は止めない */
  function gate(action) {
    if (action.type === 'keyUp' || action.type === 'up') return;
    let target;
    if (KEYBOARD.has(action.type)) {
      target = apps.inspectForeground();
      if (target?.self) throw new ComputerError('self', 'the foreground window belongs to Pleiad');
    } else {
      const point = action.type === 'drag' ? action.from : action.x !== undefined ? action : win32.cursor();
      target = apps.inspectAt(point.x, point.y);
    }
    if (target?.elevated && !selfElevated) throw new ComputerError('uipi', 'the target app runs with administrator rights and cannot receive input');
  }

  async function runInput(args, owner, signal) {
    if (stopped.has(owner)) throw new ComputerError('stopped', 'stopped by the user');
    ensureUnlocked();
    refreshDisplays();
    const actions = args?.actions;
    input.validate(actions, { inDisplay: (x, y) => containsPoint(displays, x, y) });
    let done = 0;
    try {
      for (const action of actions) {
        if (stopped.has(owner)) throw new ComputerError('stopped', 'stopped by the user');
        gate(action);
        await input.perform(action, signal);
        done++;
      }
    } catch (error) {
      releaseAll(); // 途中で止まったときは、押したままにしない
      error.done = done;
      throw error;
    }
    return { done, cursor: win32.cursor() };
  }

  async function runOp(op, args, owner, signal) {
    switch (op) {
      case 'displays': refreshDisplays(); return { displays, displaysVersion };
      case 'screenshot': ensureUnlocked(); refreshDisplays(); return capture.screenshot(args ?? {}, { displays, displaysVersion });
      case 'appAt':
        if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y)) throw new ComputerError('failed', 'x and y are required');
        return { app: await apps.appAt(args.x, args.y) };
      case 'foreground': return { app: await apps.foreground() };
      case 'findApp': return { apps: await apps.findApp(args?.name) };
      case 'input': return runInput(args, owner, signal);
      case 'cursor': return win32.cursor();
      case 'launch': return apps.launch(args?.app);
      default: throw new ComputerError('failed', `unknown op: ${op}`);
    }
  }

  async function execute({ id, owner, op, args }) {
    const controller = new AbortController();
    const limit = op === 'launch' ? launchTimeout : opTimeout;
    active = { owner, controller };
    let timer;
    try {
      const data = await Promise.race([
        runOp(op, args, owner, controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ComputerError('timeout', `${op} timed out`)); }, limit); }),
      ]);
      post({ type: 'computer-result', id, ok: true, data });
    } catch (error) {
      if (error.code === 'timeout' && op === 'input') releaseAll();
      const known = error instanceof ComputerError;
      if (!known) log(`${op} failed: ${error.stack ?? error}`);
      post({ type: 'computer-result', id, ok: false, error: { code: known ? error.code : 'failed', message: String(error.message ?? error), ...(error.done !== undefined ? { done: error.done } : {}) } });
    } finally {
      clearTimeout(timer);
      if (active?.controller === controller) active = null;
    }
  }

  function handleCall(message) {
    if (!supported) { post({ type: 'computer-result', id: message.id, ok: false, error: { code: 'unsupported', message: `computer use is not supported (${reason})` } }); return; }
    if (message.owner !== undefined && message.owner !== lastCallOwner) {
      if (lastCallOwner !== null && message.owner !== armedOwner) releaseAll(); // 持ち主が替わった
      lastCallOwner = message.owner;
    }
    if (message.op === 'releaseAll') { post({ type: 'computer-result', id: message.id, ok: true, data: { released: releaseAll() } }); return; }
    tail = tail.then(() => execute(message), () => execute(message)); // 1 本の列。execute は投げない
  }

  /** Esc・会話の止める: 止めた印（渡された持ち主と今の持ち主）を付け、走っている入力を打ち切り、押したままを離す。返り値は止めた持ち主 */
  function stop(owner) {
    const stoppedOwner = owner ?? armedOwner ?? lastCallOwner ?? null;
    for (const o of [stoppedOwner, armedOwner]) if (o) stopped.add(o);
    active?.controller.abort();
    releaseAll();
    return stoppedOwner;
  }

  function handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    lastSeen = now();
    watchdogFired = false;
    switch (message.type) {
      case 'computer-ready-request':
        releaseAll(); stopped.clear(); armedOwner = null; lastCallOwner = null; // core が作り直された
        refreshDisplays();
        post({ type: 'computer-ready', supported, ...(supported ? {} : { reason }), displays: supported ? displays : [], displaysVersion });
        break;
      case 'computer-call': handleCall(message); break;
      case 'computer-arm':
        if ((message.owner ?? null) !== armedOwner) releaseAll(); // 前の持ち主の押したままを離す
        armedOwner = message.owner ?? null;
        stopped.clear(); // 止めた印は次の arm まで
        break;
      case 'computer-stop': stop(message.owner ?? undefined); break;
      case 'computer-turn-ended':
        releaseAll();
        stopped.delete(message.owner);
        if (armedOwner === message.owner) armedOwner = null;
        break;
      default: break; // computer-heartbeat・computer-overlay は印を更新するだけ
    }
  }

  /** 番犬: 持ち主がいるのに core から何も来ない（core が落ちた）ときは押したままを離す */
  function watchdogTick() {
    if (!armedOwner || watchdogFired || now() - lastSeen <= watchdogMs) return;
    watchdogFired = true;
    log('watchdog: no message from core, releasing input');
    releaseAll();
  }

  function startWatchdog() {
    if (watchdogTimer || !supported) return;
    watchdogTimer = setInterval(watchdogTick, timeouts.watchdogTick ?? WATCHDOG_TICK_MS);
    watchdogTimer.unref?.();
  }

  return {
    handleMessage,
    /** screen の display-added / display-removed / display-metrics-changed */
    onDisplaysChanged() { if (supported) refreshDisplays(true); },
    releaseAll,
    /**
     * Esc を拾ったとき（オーバーレイの onEscape）: 止めて離す。owner を渡せばその持ち主を止める（無ければ今の持ち主）。
     * notify を false にすると computer-escape は送らない（オーバーレイが、ピルの後始末の後に自分で送る）
     */
    escape({ owner, notify = true } = {}) {
      const stoppedOwner = stop(owner);
      if (notify && stoppedOwner) post({ type: 'computer-escape', owner: stoppedOwner });
      return { owner: stoppedOwner };
    },
    notifyEscape(owner) { if (owner) post({ type: 'computer-escape', owner }); },
    armedOwner: () => armedOwner,
    startWatchdog,
    watchdogTick,
    dispose() { clearInterval(watchdogTimer); watchdogTimer = null; releaseAll(); },
    get supported() { return supported; },
  };
}

/**
 * desktop/main.cjs から 1 行でつなぐ。Windows 以外・koffi を読めないときは `computer-ready { supported: false, reason }` を返す。
 * @param worker utilityProcess（core）
 * @param {{ electron?: { screen?, nativeImage? }, app?, escape?, log?, win32? }} [options]
 */
function attachComputerService(worker, { electron = {}, app = null, escape = null, log = () => {}, win32: injected = null, ...rest } = {}) {
  let win32 = injected, reason = 'native';
  if (!win32) {
    try { win32 = loadWin32(); } catch (error) { reason = error.reason ?? 'native'; log(`computer use unavailable: ${error.message}`); }
  }
  const service = createComputerService({ post: message => { try { worker.postMessage(message); } catch (error) { log(`postMessage failed: ${error.message}`); } },
    win32, reason, nativeImage: electron.nativeImage ?? null, escape, log, ...rest });
  worker.on('message', message => { if (typeof message?.type === 'string' && message.type.startsWith('computer-')) service.handleMessage(message); });
  const screenEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
  for (const event of screenEvents) electron.screen?.on(event, service.onDisplaysChanged);
  worker.once?.('exit', () => service.releaseAll());
  app?.on?.('will-quit', () => service.dispose());
  service.startWatchdog();
  return Object.assign(service, {
    detach() { for (const event of screenEvents) electron.screen?.removeListener?.(event, service.onDisplaysChanged); service.dispose(); },
  });
}

module.exports = { attachComputerService, createComputerService, withPerMonitorDpi, OP_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, WATCHDOG_MS };
