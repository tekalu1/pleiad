// ほかのホストにつなぐ窓（desktop/remote-hosts.html。アプリに同梱の file:）の preload。
// ペアリングと窓を開く操作はこの窓からだけ受ける（desktop/remote-windows.cjs が送り元を確かめる）。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('plyHosts', {
  init: () => ipcRenderer.invoke('ply:hosts-init'),
  list: () => ipcRenderer.invoke('ply:hosts-list'),
  pair: payload => ipcRenderer.invoke('ply:hosts-pair', payload),
  cancelPair: () => ipcRenderer.invoke('ply:hosts-pair-cancel'),
  open: hostId => ipcRenderer.invoke('ply:hosts-open', hostId),
  rename: (hostId, label) => ipcRenderer.invoke('ply:hosts-rename', hostId, label),
  remove: hostId => ipcRenderer.invoke('ply:hosts-remove', hostId),
  onCode: listener => {
    const handler = (_event, code) => listener(code);
    ipcRenderer.on('ply:hosts-code', handler);
    return () => ipcRenderer.removeListener('ply:hosts-code', handler);
  },
  onChange: listener => {
    const handler = (_event, hosts) => listener(hosts);
    ipcRenderer.on('ply:hosts-changed', handler);
    return () => ipcRenderer.removeListener('ply:hosts-changed', handler);
  },
});
