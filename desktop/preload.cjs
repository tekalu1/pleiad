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
  update: (action, value) => ipcRenderer.invoke('ply:update', action, value),
  onUpdate: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('ply:update-state', handler);
    return () => ipcRenderer.removeListener('ply:update-state', handler);
  },
});
