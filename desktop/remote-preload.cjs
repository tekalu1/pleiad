// リモートの窓の preload（docs/remote.md §7.2・§7.3）。ホストが配る画面に渡すのは次の 2 つだけ。
//   plyRemote:  リモートの窓であることとホストの名前。画面は有無で html に .remote を付け、帯のバッジを描く
//   plyDesktop: 窓の枠・帯の色・完了通知だけ。chooseFolder（手元の OS のダイアログ）と update（手元のアプリの更新）は出さない。
//               画面はブリッジの有無で分けているので、フォルダーはホストのフォルダーを辿る面、更新は「ホストで行います」になる
// sandbox の preload は別のファイルを require できないので、引数の読み方は desktop/remote-windows.cjs の decodeRemoteArg と同じものをここに書く。
const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = '--ply-remote=';
let info = null;
try {
  const arg = process.argv.find(a => typeof a === 'string' && a.startsWith(PREFIX));
  const v = arg ? JSON.parse(decodeURIComponent(arg.slice(PREFIX.length))) : null;
  if (v && /^[a-z2-7]{26}$/.test(v.hostId)) info = v;
} catch { info = null; }

if (info) {
  const text = v => (typeof v === 'string' ? v.slice(0, 200) : '');
  contextBridge.exposeInMainWorld('plyRemote', {
    hostId: info.hostId, hostName: text(info.hostName), relay: text(info.relay), device: text(info.device), shell: 'desktop',
    status: () => ipcRenderer.invoke('ply:remote-status'),
    onStatus: listener => {
      const handler = (_event, status) => listener(status);
      ipcRenderer.on('ply:remote-status-changed', handler);
      return () => ipcRenderer.removeListener('ply:remote-status-changed', handler);
    },
    retry: () => ipcRenderer.invoke('ply:remote-retry'),
    closeWindow: () => ipcRenderer.send('ply:remote-close'),
  });
  contextBridge.exposeInMainWorld('plyDesktop', {
    platform: process.platform,
    setTitleBar: colors => ipcRenderer.send('ply:remote-title-bar', colors),
    notifyCompletion: notice => ipcRenderer.invoke('ply:remote-notify-completion', notice),
    onNotificationClick: listener => {
      const handler = (_event, sessionId) => listener(sessionId);
      ipcRenderer.on('ply:notification-click', handler);
      return () => ipcRenderer.removeListener('ply:notification-click', handler);
    },
  });
}
