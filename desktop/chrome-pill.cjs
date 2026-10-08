'use strict';
// The handover control is an Electron window above Chrome, never content inside a page.
const path = require('node:path');

const PILL_WIDTH = 360;
const PILL_HEIGHT = 56;

/** 押した「戻す」の返事を待つ上限（ミリ秒）。サーバーが黙って捨てても、この後はまた押せる */
const BUSY_MS = 4000;
/** 窓の ref が引けないまま状態を取り直す回数の上限（窓が閉じたあとも 1 秒ごとに聞き続けない） */
const SNAPSHOT_TRIES = 30;

function createChromePill({ electron, os, post, t, tickMs = 120, snapshotMs = 1000, busyMs = BUSY_MS,
  page = path.join(__dirname, 'chrome-pill.html'), preload = path.join(__dirname, 'chrome-pill-preload.cjs'),
  log = () => {} }) {
  const { BrowserWindow, ipcMain } = electron;
  const states = new Map();
  const pendingRefs = new Map();   // 会話の id -> 状態を取り直した回数
  const busy = new Map();          // 押した会話の id -> { since, timer }（返事を待つ間、その会話のピルだけを隠す）
  let win = null, loaded = false, current = null, front = null, closed = false, lastLabel = null;
  let unwatch = () => {};
  let positionTimer = null, snapshotTimer = null;

  function hide() {
    current = null;
    if (win && !win.isDestroyed()) win.hide();
  }
  function makeWindow() {
    if (win && !win.isDestroyed()) return win;
    loaded = false;
    lastLabel = null;
    const w = new BrowserWindow({ width: PILL_WIDTH, height: PILL_HEIGHT, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    win = w;
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setContentProtection(true);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', event => event.preventDefault());
    w.webContents.once('did-finish-load', () => { loaded = true; refresh(); });
    w.webContents.on('render-process-gone', () => { if (win === w) { win = null; loaded = false; current = null; } w.destroy(); });
    w.on('closed', () => { if (win === w) { win = null; loaded = false; current = null; } });
    w.loadFile(page).catch(error => log(`chrome pill load failed: ${error.message}`));
    return w;
  }
  function release(sessionId) {
    const entry = busy.get(sessionId);
    if (!entry) return false;
    clearTimeout(entry.timer); busy.delete(sessionId);
    return true;
  }
  function refresh() {
    if (closed || !front) { hide(); return; }
    const active = [...states.values()].find(state => !busy.has(state.sessionId) && state.refs.some(ref => ref.id === front));
    const bounds = active && os.bounds(active.refs.find(ref => ref.id === front));
    if (!bounds || bounds.width < 80 || bounds.height < PILL_HEIGHT) { hide(); return; }
    const width = Math.min(PILL_WIDTH, Math.max(80, Math.floor(bounds.width - 24)));
    // 最大化した窓は見えない枠の分だけ画面の上にはみ出る（上端が -8px など）。そのモニターの上端より上には出さない
    const area = electron.screen?.getDisplayMatching?.({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })?.bounds;
    const top = area ? Math.max(Math.round(bounds.y), area.y) : Math.round(bounds.y);
    const place = { x: Math.round(bounds.x + (bounds.width - width) / 2), y: top, width, height: PILL_HEIGHT };
    const w = makeWindow();
    if (w.isDestroyed()) return;
    const old = w.getBounds();
    if (old.x !== place.x || old.y !== place.y || old.width !== place.width || old.height !== place.height) w.setBounds(place);
    if (!loaded) return;
    const label = t('chromePill.resume', { agent: active.agent });
    if (current?.sessionId !== active.sessionId || lastLabel !== label) {
      w.webContents.send('ply:chrome-pill', { label, sessionId: active.sessionId, enter: !w.isVisible() });
      lastLabel = label;
    }
    current = active;
    if (!w.isVisible()) w.showInactive();
  }
  function rewatch() {
    unwatch(); unwatch = () => {};
    clearInterval(positionTimer); positionTimer = null;
    front = null;
    const refs = [...states.values()].flatMap(state => state.refs);
    if (!refs.length) { hide(); return; }
    unwatch = os.watch({ refs }, event => {
      if (event.kind !== 'foreground') return;
      front = event.ref?.id ?? null;
      refresh();
    });
    positionTimer = setInterval(refresh, tickMs);
    positionTimer.unref?.();
  }
  function handleMessage(message) {
    if (message?.type === 'chrome-pill-resume-failed' && typeof message.sessionId === 'string') {
      if (release(message.sessionId) && states.has(message.sessionId)) refresh();
      return true;
    }
    if (closed || message?.type !== 'chrome-pill-state' || typeof message.sessionId !== 'string') return false;
    // 戻す返事を待っている間でも、paused でなくなった・戻せなかった・次の引き継ぎ（since が替わった）なら待ちを解く
    const waiting = busy.get(message.sessionId);
    if (waiting && (message.state !== 'paused' || message.error || message.since !== waiting.since)) release(message.sessionId);
    if (message.state === 'paused' && message.by === 'pc' && Array.isArray(message.refs) && message.refs.length) {
      const refs = message.refs.filter(ref => typeof ref?.id === 'string');
      states.set(message.sessionId, { sessionId: message.sessionId, agent: String(message.agent || 'Claude'), since: message.since ?? null, refs });
      if (refs.some(ref => os.bounds(ref))) pendingRefs.delete(message.sessionId);
      else if (!pendingRefs.has(message.sessionId)) pendingRefs.set(message.sessionId, 0);
    } else {
      states.delete(message.sessionId);
      if (message.state === 'paused' && message.by === 'pc') { if (!pendingRefs.has(message.sessionId)) pendingRefs.set(message.sessionId, 0); }
      else pendingRefs.delete(message.sessionId);
    }
    if (pendingRefs.size && !snapshotTimer) {
      snapshotTimer = setInterval(() => {
        // 上限まで聞いても ref が戻らない会話は諦める（窓が閉じたあとも聞き続けない）
        for (const [id, tries] of [...pendingRefs]) { if (tries + 1 >= SNAPSHOT_TRIES) pendingRefs.delete(id); else pendingRefs.set(id, tries + 1); }
        if (!pendingRefs.size) { clearInterval(snapshotTimer); snapshotTimer = null; return; }
        try { post({ type: 'chrome-pill-snapshot' }); } catch { /* 接続が無い間は次を待つ */ }
      }, snapshotMs);
      snapshotTimer.unref?.();
    } else if (!pendingRefs.size && snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
    rewatch();
    return true;
  }
  function onResume(event, sessionId) {
    if (closed || event.sender !== win?.webContents || busy.has(sessionId) || current?.sessionId !== sessionId ||
        !states.has(sessionId) || !front || !current.refs.some(ref => ref.id === front)) return;
    // 押した引き継ぎの印（since）を付けて頼む。サーバーは今の引き継ぎと同じときだけ戻す（次の引き継ぎを、前に押したピルで戻さない）
    const since = states.get(sessionId).since;
    const timer = setTimeout(() => { if (release(sessionId)) refresh(); }, busyMs);
    timer.unref?.();
    busy.set(sessionId, { since, timer });
    hide();
    try { if (post({ type: 'chrome-pill-resume', sessionId, since }) === false) throw new Error('server disconnected'); }
    catch (error) { release(sessionId); log(`chrome pill resume failed: ${error.message}`); refresh(); }
  }
  ipcMain.on('ply:chrome-pill-resume', onResume);
  function hideAll() { states.clear(); pendingRefs.clear(); clearInterval(snapshotTimer); snapshotTimer = null; for (const id of [...busy.keys()]) release(id); rewatch(); }
  function close() {
    if (closed) return;
    hideAll(); closed = true;
    ipcMain.removeListener('ply:chrome-pill-resume', onResume);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }
  return { handleMessage, hideAll, close, snapshot: () => ({ sessions: states.size, front, visible: Boolean(win && !win.isDestroyed() && win.isVisible()), sessionId: current?.sessionId ?? null }) };
}

function attachChromePill(worker, options) {
  const pill = createChromePill({ ...options, post: message => worker.postMessage(message) });
  worker.on('message', message => pill.handleMessage(message));
  worker.on('exit', () => pill.hideAll());
  return pill;
}

module.exports = { createChromePill, attachChromePill };
