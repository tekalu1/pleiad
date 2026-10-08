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
  const screen = { getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) };
  const pill = attachChromePill(worker, { electron: { BrowserWindow: class extends Window { constructor(options) { super(options); windows.push(this); } }, ipcMain, screen }, os,
    t: (_key, { agent }) => `あなたが操作中 · ${agent} に戻す`, tickMs: 10, snapshotMs: 10, busyMs: 80 });
  const state = (sessionId, value, by = 'pc', refs = [{ id: sessionId === 's' ? 'a' : 'b' }], agent = 'Claude', since = 100) =>
    worker.emit('message', { type: 'chrome-pill-state', sessionId, state: value, by, refs, agent, since });
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
  t.ok('押した引き継ぎの印（since）を付けて頼む', posted[0].since === 100, JSON.stringify(posted[0]));
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
  // ---- 押した会話だけを待たせる（全部の会話のピルを隠さない）。返事が無くても一定時間でまた押せる
  state('s', 'paused', 'pc', [{ id: 'a' }], 'Claude', 300); state('x', 'paused', 'pc', [{ id: 'b' }], 'Claude', 400);
  foreground = 'a'; notify({ kind: 'foreground', ref: { id: 'a' } });
  const before = posted.filter(message => message.type === 'chrome-pill-resume').length;
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('押した引き継ぎの since は、その時の便りの値', posted.at(-1).since === 300 && posted.filter(message => message.type === 'chrome-pill-resume').length === before + 1, JSON.stringify(posted.at(-1)));
  foreground = 'b'; notify({ kind: 'foreground', ref: { id: 'b' } });
  t.ok('返事を待つのは押した会話だけで、別の会話のピルは出る', w.visible && pill.snapshot().sessionId === 'x');
  foreground = 'a'; notify({ kind: 'foreground', ref: { id: 'a' } });
  t.ok('返事を待つ間、押した会話のピルは隠れたまま', !w.visible);
  await new Promise(resolve => setTimeout(resolve, 150));
  t.ok('サーバーが黙って捨てても、一定時間でピルがまた出る（押した会話が戻せなくならない）', w.visible && pill.snapshot().sessionId === 's');
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('出直したピルを押し直せる', posted.at(-1).type === 'chrome-pill-resume' && posted.at(-1).since === 300 && !w.visible);
  state('s', 'paused', 'pc', [{ id: 'a' }], 'Claude', 500);
  t.ok('次の引き継ぎ（since が替わった）の便りで待ちを解き、押したピルを使い回さず出し直す', w.visible && pill.snapshot().sessionId === 's');
  ipcMain.emit('ply:chrome-pill-resume', { sender: w.webContents }, 's');
  t.ok('次の引き継ぎには、その since を付けて頼む', posted.at(-1).since === 500, JSON.stringify(posted.at(-1)));
  state('s', 'idle'); state('x', 'idle');

  // ---- 最大化した窓は上端が画面の上にはみ出る（-8px）。そのモニターの上端より上には出さない
  rects.set('a', { x: -8, y: -8, width: 1936, height: 1096 });
  state('s', 'paused', 'pc', [{ id: 'a' }], 'Claude', 600);
  foreground = 'a'; notify({ kind: 'foreground', ref: { id: 'a' } });
  t.ok('最大化した窓でも、ピルの上端は画面の上端', w.visible && w.bounds.y === 0, JSON.stringify(w.bounds));
  state('s', 'idle'); rects.set('a', { x: 1800, y: 40, width: 900, height: 700 });

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
  // ---- 窓が閉じたあと ref が戻らない会話の状態の取り直しは、上限で諦める
  state('gone', 'paused', 'pc', []);
  await new Promise(resolve => setTimeout(resolve, 450));
  const asked = posted.filter(message => message.type === 'chrome-pill-snapshot').length;
  await new Promise(resolve => setTimeout(resolve, 100));
  t.ok('ref が戻らないまま取り直し続けない（上限で止める）', posted.filter(message => message.type === 'chrome-pill-snapshot').length === asked);
  state('gone', 'idle');
  worker.emit('exit');
  t.ok('サーバーが終わると隠す', !w.visible && pill.snapshot().sessions === 0);
  pill.close();
  t.ok('終了時に窓と IPC を片付ける', w.destroyed && ipcMain.listenerCount('ply:chrome-pill-resume') === 0);
}
