const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plyDesktop', {
  // 窓の上端を画面が描くので、OS ごとの違い（macOS は左に信号、ほかは右に閉じるボタン）を画面が知る
  platform: process.platform,
  setTitleBar: colors => ipcRenderer.send('ply:title-bar', colors),
  notifyCompletion: notice => ipcRenderer.invoke('ply:notify-completion', notice),
  onNotificationClick: listener => {
    const handler = (_event, sessionId) => listener(sessionId);
    ipcRenderer.on('ply:notification-click', handler);
    return () => ipcRenderer.removeListener('ply:notification-click', handler);
  },
  chooseFolder: () => ipcRenderer.invoke('ply:choose-folder'),
  // ほかのホストにつなぐ窓（desktop/remote-hosts.html）を開く。手元のアプリの機能なので、この窓（ローカル）にだけ出す
  openRemoteHosts: () => ipcRenderer.invoke('ply:open-remote-hosts'),
  // ホストの子の会話を、そのホストのリモートの窓で開く（承認の中継のカードの「子の会話を見る」）。この窓（ローカル）にだけ出す
  openRemoteSession: (hostId, sessionId) => ipcRenderer.invoke('ply:open-remote-session', hostId, sessionId),
  update: (action, value) => ipcRenderer.invoke('ply:update', action, value),
  // OS にサインインしたら起動する設定（desktop/login-item.cjs）。get は OS の登録を読み直した { supported, reason?, enabled, blocked }、set は登録して同じ形の状態を返す。この窓（ローカル）にだけ出す
  loginItem: {
    get: () => ipcRenderer.invoke('ply:login-item', 'get'),
    set: enabled => ipcRenderer.invoke('ply:login-item', 'set', enabled),
  },
  onUpdate: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('ply:update-state', handler);
    return () => ipcRenderer.removeListener('ply:update-state', handler);
  },
  // 切り替えを待つ表示（desktop/switch-screen.cjs、web/switch-notice.mjs）。無停止の更新で、新しい main が古い版のサーバーの画面へ状態を渡す。
  // 版 1 の口。口の形を変えるときは switch2 を足し、この switch は 1 版ぶん残す（古い版の画面が読む）。画面は読み込むとき hello で使う版を知らせ、
  // main は hello が来た画面にだけ表示を任せる。state は今の状態（読み込み直した画面が取る）、act は 'now' | 'later' | 'retry'（効いたか）
  switch: {
    version: 1,
    hello: () => ipcRenderer.send('ply:switch-hello', 1),
    state: () => ipcRenderer.invoke('ply:switch', 'state', 1),
    onState: listener => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on('ply:switch-state', handler);
      return () => ipcRenderer.removeListener('ply:switch-state', handler);
    },
    act: action => ipcRenderer.invoke('ply:switch', 'act', action),
  },
  // 内蔵ブラウザー（desktop/browser-panel.cjs、web/browser-panel.mjs）。この窓（ローカル）にだけ出す。
  // command は open・newTab・select・close・back・forward・reload・stop・devtools・external・detach・clearSiteData・freeze・unfreeze・context・state
  browser: {
    command: (action, args) => ipcRenderer.invoke('ply:browser', action, args),
    // 右パネルの本文の枠（CSS の px。窓の左上から）と、見せるかどうか
    layout: message => ipcRenderer.send('ply:browser-layout', message),
    onState: listener => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on('ply:browser-state', handler);
      return () => ipcRenderer.removeListener('ply:browser-state', handler);
    },
    // ページにフォーカスがあるときに押された開閉の近道（Ctrl+Shift+B。main の before-input-event が拾う）
    onShortcut: listener => {
      const handler = () => listener();
      ipcRenderer.on('ply:browser-shortcut', handler);
      return () => ipcRenderer.removeListener('ply:browser-shortcut', handler);
    },
  },
});
