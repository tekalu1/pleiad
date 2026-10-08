'use strict';
// The handover control is an Electron window above Chrome, never content inside a page.
const path = require('node:path');

const PILL_WIDTH = 360;
const PILL_HEIGHT = 56;

function createChromePill({ electron, os, post, t, tickMs = 120, snapshotMs = 1000,
  page = path.join(__dirname, 'chrome-pill.html'), preload = path.join(__dirname, 'chrome-pill-preload.cjs'),
  log = () => {} }) {
  const { BrowserWindow, ipcMain } = electron;
  const states = new Map();
  const pendingRefs = new Set();
  let win = null, loaded = false, current = null, front = null, busy = false, closed = false, lastLabel = null;
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
  function refresh() {
    if (closed || busy || !front) { hide(); return; }
    const active = [...states.values()].find(state => state.refs.some(ref => ref.id === front));
    const bounds = active && os.bounds(active.refs.find(ref => ref.id === front));
    if (!bounds || bounds.width < 80 || bounds.height < PILL_HEIGHT) { hide(); return; }
    const width = Math.min(PILL_WIDTH, Math.max(80, Math.floor(bounds.width - 24)));
    const place = { x: Math.round(bounds.x + (bounds.width - width) / 2), y: Math.round(bounds.y), width, height: PILL_HEIGHT };
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
      if (states.has(message.sessionId)) { busy = false; refresh(); }
      return true;
    }
    if (closed || message?.type !== 'chrome-pill-state' || typeof message.sessionId !== 'string') return false;
    if (message.state !== 'paused' || message.error) busy = false;
    if (message.state === 'paused' && message.by === 'pc' && Array.isArray(message.refs) && message.refs.length) {
      const refs = message.refs.filter(ref => typeof ref?.id === 'string');
      states.set(message.sessionId, { sessionId: message.sessionId, agent: String(message.agent || 'Claude'), refs });
      if (refs.some(ref => os.bounds(ref))) pendingRefs.delete(message.sessionId);
      else pendingRefs.add(message.sessionId);
    } else {
      states.delete(message.sessionId);
      if (message.state === 'paused' && message.by === 'pc') pendingRefs.add(message.sessionId);
      else pendingRefs.delete(message.sessionId);
    }
    if (pendingRefs.size && !snapshotTimer) {
      snapshotTimer = setInterval(() => { try { post({ type: 'chrome-pill-snapshot' }); } catch { /* 接続が無い間は次を待つ */ } }, snapshotMs);
      snapshotTimer.unref?.();
    } else if (!pendingRefs.size && snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
    rewatch();
    return true;
  }
  function onResume(event, sessionId) {
    if (closed || event.sender !== win?.webContents || busy || current?.sessionId !== sessionId ||
        !states.has(sessionId) || !front || !current.refs.some(ref => ref.id === front)) return;
    busy = true;
    hide();
    try { if (post({ type: 'chrome-pill-resume', sessionId }) === false) throw new Error('server disconnected'); }
    catch (error) { busy = false; log(`chrome pill resume failed: ${error.message}`); refresh(); }
  }
  ipcMain.on('ply:chrome-pill-resume', onResume);
  function hideAll() { states.clear(); pendingRefs.clear(); clearInterval(snapshotTimer); snapshotTimer = null; busy = false; rewatch(); }
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
