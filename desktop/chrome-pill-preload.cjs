const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plyChromePill', {
  onLabel: listener => ipcRenderer.on('ply:chrome-pill', (_event, message) => listener(message)),
  resume: sessionId => ipcRenderer.send('ply:chrome-pill-resume', sessionId),
});
