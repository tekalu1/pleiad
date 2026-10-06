// 2d のデスクトップのハーネスの入口（electron で起こす）。desktop/main.cjs を、環境変数で決めた resources の app から読み込み、
// ログを H_LOG へ書き、H_SIGNAL の指示ファイル（leave・quit）で終わらせる。
const path = require('node:path');
const fs = require('node:fs');
const { app, dialog } = require('electron');

const APP = process.env.H_APP;
const LOG = process.env.H_LOG;
const SIGNAL = process.env.H_SIGNAL;
const NAME = process.env.H_NAME || 'main';
app.setPath('userData', process.env.H_USERDATA);

const write = (kind, text) => { try { fs.appendFileSync(LOG, `${Date.now()} ${NAME} ${kind} ${text}\n`); } catch { /* ログだけ */ } };
const fmt = args => args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { write(level, fmt(args)); orig(...args); };
}
process.on('uncaughtException', error => write('uncaught', String(error?.stack ?? error)));

// main <-> サーバーのパイプの包みを控える（leave を送る・メッセージの種類を数える）
const sl = require(path.join(APP, 'desktop', 'server-link.cjs'));
const createServerLink = sl.createServerLink;
sl.createServerLink = (...args) => {
  const link = createServerLink(...args);
  global.__link = link;
  link.on('message', message => { if (message?.type === 'ready') write('ready', JSON.stringify({ port: message.port, pid: message.pid, runtimeKey: message.runtimeKey, handover: message.handover ?? null })); });
  link.on('exit', code => write('link-exit', String(code)));
  return link;
};

// 窓の読み込み（URL。トークンはローカルの一時の値）と、ダイアログ
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => write('load', window.webContents.getURL()));
});
dialog.showMessageBox = async (...args) => {
  const options = args.find(a => a && typeof a === 'object' && 'message' in a) ?? {};
  write('dialog', JSON.stringify({ title: options.title, message: options.message, buttons: options.buttons }));
  return { response: 0 };
};

setInterval(() => {
  for (const name of ['leave', 'quit']) {
    const file = path.join(SIGNAL, name);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    write('signal', name);
    if (name === 'quit') { app.quit(); return; }
    // 更新の代わり: main-leaving を送ってからつながりだけ切り、サーバーは残して終わる（installUpdate の順）
    const link = global.__link;
    link?.postMessage({ type: 'main-leaving', reason: 'update' });
    setTimeout(() => { link?.leave?.('update'); app.exit(0); }, 400);
    return;
  }
}, 100);

require(path.join(APP, 'desktop', 'main.cjs'));
write('boot', `required ${APP}`);
