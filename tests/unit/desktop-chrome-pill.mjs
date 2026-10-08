import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachChromePill } = require('../../desktop/chrome-pill.cjs');

export const name = 'desktop-chrome-pill';
export const title = 'Chrome 引き継ぎのピル: 表示条件・位置・クリック・窓と接続の終了（偽の Electron）';

class Window {
  constructor(options) {
    this.options = options;
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.visible = false; this.destroyed = false; this.messages = [];
    this.events = new EventEmitter();
    this.webContents = new EventEmitter();
    this.webContents.send = (channel, message) => this.messages.push({ channel, message });
    this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
  }
  on(name, fn) { this.events.on(name, fn); }
  loadFile(file) { this.file = file; queueMicrotask(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
  setAlwaysOnTop(_flag, level) { this.topLevel = level; }
  setContentProtection(value) { this.protected = value; }
  setBounds(value) { this.bounds = value; }
  getBounds() { return this.bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.visible = false; this.events.emit('closed'); }
}

export default async function (t) {
  const windows = [];
  const ipcMain = new EventEmitter();
  const worker = new EventEmitter();
  const posted = [];
  worker.postMessage = message => posted.push(message);
  const rects = new Map([['a', { x: 1800, y: 40, width: 900, height: 700 }], ['b', { x: 60, y: 90, width: 800, height: 600 }]]);
  let foreground = null, notify = null;
  const os = {
    watch({ refs }, fn) {
      notify = fn;
      fn({ kind: 'foreground', ref: refs.find(ref => ref.id === foreground) ?? null });
      return () => { if (notify === fn) notify = null; };
    },
    bounds: ref => rects.get(ref.id) ?? null,
  };
  const pill = attachChromePill(worker, { electron: { BrowserWindow: class extends Window { constructor(options) { super(options); windows.push(this); } }, ipcMain }, os,
    t: (_key, { agent }) => `あなたが操作中 · ${agent} に戻す`, tickMs: 10, snapshotMs: 10 });
  const state = (sessionId, value, by = 'pc', refs = [{ id: sessionId === 's' ? 'a' : 'b' }], agent = 'Claude') =>
    worker.emit('message', { type: 'chrome-pill-state', sessionId, state: value, by, refs, agent });
  state('s', 'running');
  state('s', 'paused', 'device');
  t.ok('実行中と端末への引き継ぎでは窓を作らない', windows.length === 0);
  state('s', 'paused', 'pc', [{ id: 'a' }], 'Codex');
  t.ok('PC への引き継ぎでも Chrome が前面でなければ出さない', windows.length === 0);
  foreground = 'a'; notify({ kind: 'foreground', ref: { id: 'a' } });
  await Promise.resolve();
  const w = windows[0];
  t.ok('前面の Chrome の上端にピルを出す', w.visible && w.bounds.x === 2070 && w.bounds.y === 40, JSON.stringify(w?.bounds));
  t.ok('別の窓にし、撮影から外し、フォーカスを取らずクリックを受ける', w.options.focusable === false && w.options.alwaysOnTop === true && w.protected === true && w.topLevel === 'screen-saver' && w.file.endsWith('chrome-pill.html'));
  t.ok('agent 名を文言に使い、初回の出現を描画側へ知らせる', w.messages.at(-1)?.message.label === 'あなたが操作中 · Codex に戻す' && w.messages.at(-1)?.message.enter === true);
  rects.set('a', { x: -1140, y: 140, width: 700, height: 600 });
  await new Promise(resolve => setTimeout(resolve, 30));
  t.ok('窓の移動と大きさの変更に追従する', w.bounds.x === -970 && w.bounds.y === 140 && w.bounds.width === 360, JSON.stringify(w.bounds));
  foreground = null; notify({ kind: 'foreground', ref: null });
  t.ok('別のアプリが前面なら隠す', !w.visible);
  foreground = 'a'; notify({ kind: 'foreground', ref: { id: 'a' } });
  t.ok('Chrome に戻ると再び出現する', w.visible && w.messages.at(-1)?.message.enter === true);
  ipcMain.emit('ply:chrome-pill-resume', { sender: {} }, 's');
  t.ok('別の webContents からの押下は無視する', posted.length === 0);
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('押すと同じ会話の resume を頼み、直ちにピルを隠す', posted.length === 1 && posted[0].type === 'chrome-pill-resume' && posted[0].sessionId === 's' && !w.visible);
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('二重押下は送らない', posted.length === 1);
  worker.emit('message', { type: 'chrome-pill-resume-failed', sessionId: 's' });
  t.ok('再開が例外で失敗したらピルを再表示する', w.visible);
  const send = worker.postMessage;
  worker.postMessage = () => false;
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('サーバーへの送信が届かなければ隠したままにしない', w.visible && posted.length === 1);
  worker.postMessage = send;
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('失敗後に押し直せる', posted.filter(message => message.type === 'chrome-pill-resume').length === 2);
  worker.emit('message', { type: 'chrome-pill-state', sessionId: 's', state: 'paused', by: 'pc', refs: [{ id: 'a' }], agent: 'Codex', error: 'conceal-failed' });
  t.ok('窓を隠せず paused のままなら再び押せる', w.visible);
  state('s', 'idle');
  t.ok('戻した後も隠れている', !w.visible && pill.snapshot().sessions === 0);
  state('s', 'paused'); foreground = 'a'; notify({ kind: 'foreground', ref: { id: 'a' } });
  rects.delete('a');
  await new Promise(resolve => setTimeout(resolve, 30));
  t.ok('Chrome の窓が閉じたらピルを消す', !w.visible);
  state('s', 'idle');
  t.ok('Chrome の接続が閉じて paused が解けたら記録を捨てる', pill.snapshot().sessions === 0);
  state('x', 'paused', 'pc', [{ id: 'b' }]); foreground = 'b'; notify({ kind: 'foreground', ref: { id: 'b' } });
  t.ok('別の会話の引き継ぎにも合わせる', pill.snapshot().sessionId === 'x');
  state('pending', 'paused', 'pc', []);
  await new Promise(resolve => setTimeout(resolve, 25));
  t.ok('main の更新後に ref が戻るまで状態を取り直す', posted.some(message => message.type === 'chrome-pill-snapshot'));
  state('pending', 'idle');
  worker.emit('exit');
  t.ok('サーバーが終わると隠す', !w.visible && pill.snapshot().sessions === 0);
  pill.close();
  t.ok('終了時に窓と IPC を片付ける', w.destroyed && ipcMain.listenerCount('ply:chrome-pill-resume') === 0);
}
