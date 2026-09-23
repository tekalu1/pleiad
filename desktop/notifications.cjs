// Kept outside the window lifecycle so duplicate renderer deliveries stay silent.
function createDesktopNotifications({ Notification, getWindow, icon }) {
  const seen = new Map(), live = new Set();
  return notice => {
    if (!notice || typeof notice.sessionId !== 'string' || !notice.sessionId || notice.sessionId.length > 500
        || !Number.isFinite(notice.completedAt) || typeof notice.body !== 'string') return false;
    if (notice.completedAt <= (seen.get(notice.sessionId) ?? 0) || !Notification.isSupported()) return false;
    try {
      const notification = new Notification({ title: '作業が完了しました', body: notice.body.slice(0, 200), icon });
      notification.on('click', () => {
        const window = getWindow();
        if (!window || window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
        window.webContents.send('ply:notification-click', notice.sessionId);
      });
      const release = () => live.delete(notification);
      notification.on('close', release);
      notification.on('failed', release);
      live.add(notification);
      notification.show();
      seen.set(notice.sessionId, notice.completedAt);
      return true;
    } catch { return false; }
  };
}
module.exports = { createDesktopNotifications };
