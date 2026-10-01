// オーバーレイの窓（desktop/computer-overlay.html。アプリに同梱の file:）の preload。
// main（desktop/computer-overlay.cjs）からの描画の指示を受けるだけで、送り返すものは無い。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plyOverlay', {
  onMessage: listener => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('ply:computer-overlay', handler);
    return () => ipcRenderer.removeListener('ply:computer-overlay', handler);
  },
});
