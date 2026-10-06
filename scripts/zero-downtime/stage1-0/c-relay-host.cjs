// 1-0 c: 内蔵ブラウザーの中継（desktop/browser-relay.cjs）だけを Electron の中で動かす試験用の main。
// 本物の panel（desktop/browser-panel.cjs）の代わりに、非表示の BrowserWindow をタブにする最小の panel を渡す。
// 中継は本物のコード（c-agent-browser-reconnect.mjs が ZD_RELAY_SRC に作る、待ち受けのポートと鍵を環境変数で決められるようにした写し）。
// 環境変数: ZD_USERDATA（userData の置き場）・ZD_OUT（状態の JSON の書き先）・ZD_RELAY_SRC・ZD_RELAY_PORT・ZD_RELAY_KEY・ZD_TAB_URL（先にこの URL のタブを開いておく）
// stdin に `close` が来たら、中継を閉じて終わる（優しい停止）。強制終了は外から行う。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setPath('userData', process.env.ZD_USERDATA);
app.setPath('sessionData', path.join(process.env.ZD_USERDATA, 'session'));
app.on('window-all-closed', () => {});

const SESSION = 'zd-session';
const tabs = [];
const listeners = new Set();
let nextId = 1;
const panel = {
  tabsFor: id => tabs.filter(t => t.sessionId === id),
  createFor(id) {
    const win = new BrowserWindow({ show: false, width: 800, height: 600 });
    const tab = { id: `t${nextId++}`, sessionId: id, webContents: win.webContents, win };
    win.loadURL('about:blank').catch(() => {});   // 本物の panel も作った直後に about:blank を読む。未読込のままだと Page.getFrameTree が返らない
    tabs.push(tab);
    for (const l of listeners) l('created', tab);
    return tab;
  },
  closeFor(tabId) {
    const i = tabs.findIndex(t => t.id === tabId);
    if (i < 0) return;
    const [tab] = tabs.splice(i, 1);
    for (const l of listeners) l('destroyed', tab);
    if (!tab.win.isDestroyed()) tab.win.destroy();
  },
  selectFor() {},
  onTabsChanged(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  rebindSession() {},
  setAgent() {},
};

app.whenReady().then(async () => {
  const { createBrowserRelay } = require(process.env.ZD_RELAY_SRC);
  const relay = createBrowserRelay(panel);
  if (process.env.ZD_TAB_URL) {
    // 新しい main がタブを URL で開き直した状態（design.md §7.2）を再現する
    const tab = panel.createFor(SESSION);
    await tab.webContents.loadURL(process.env.ZD_TAB_URL);
  }
  const url = await relay.endpoint(SESSION);
  fs.writeFileSync(process.env.ZD_OUT, JSON.stringify({ pid: process.pid, url, tabs: tabs.length }));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    if (!/close/.test(d)) return;
    relay.close();
    setTimeout(() => app.exit(0), 200);
  });
});
