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
  onUpdate: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('ply:update-state', handler);
    return () => ipcRenderer.removeListener('ply:update-state', handler);
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
