// Kept outside the window lifecycle so duplicate renderer deliveries stay silent.
// 見出しは画面（web/notifications.mjs）が今の言語で作って渡す。無いときだけ main の言語の既定の文
const { t } = require('./i18n.cjs');
function createDesktopNotifications({ Notification, getWindow, icon }) {
  const seen = new Map(), live = new Set();
  return notice => {
    if (!notice || typeof notice.sessionId !== 'string' || !notice.sessionId || notice.sessionId.length > 500
        || !Number.isFinite(notice.completedAt) || typeof notice.body !== 'string') return false;
    if (notice.completedAt <= (seen.get(notice.sessionId) ?? 0) || !Notification.isSupported()) return false;
    try {
      const title = typeof notice.title === 'string' && notice.title.trim() ? notice.title.slice(0, 200) : t('notifications.completed');
      const notification = new Notification({ title, body: notice.body.slice(0, 200), icon });
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
