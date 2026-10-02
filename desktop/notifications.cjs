// Kept outside the window lifecycle so duplicate renderer deliveries stay silent.
// 見出しは画面（web/notifications.mjs）が今の言語で作って渡す。無いときだけ main の言語の既定の文
const { t } = require('./i18n.cjs');
function createDesktopNotifications({ Notification, getWindow, icon }) {
  const seen = new Map(), seenReplies = new Set(), live = new Set();
  return notice => {
    const reply = notice?.kind === 'reply';
    // 種類: 完了（kind なし）・返事待ち（reply）・失敗（failed。完了と同じく completedAt で重複を抑える）
    if (!notice || typeof notice.sessionId !== 'string' || !notice.sessionId || notice.sessionId.length > 500
        || typeof notice.body !== 'string' || (notice.kind && !reply && notice.kind !== 'failed')
        || (reply ? typeof notice.noticeId !== 'string' || !notice.noticeId || notice.noticeId.length > 500
          : !Number.isFinite(notice.completedAt))) return false;
    if ((reply ? seenReplies.has(notice.noticeId) : notice.completedAt <= (seen.get(notice.sessionId) ?? 0))
        || !Notification.isSupported()) return false;
    try {
      const title = typeof notice.title === 'string' && notice.title.trim() ? notice.title.slice(0, 200)
        : reply ? t('notifications.waitingReply') : notice.kind === 'failed' ? t('notifications.failed') : t('notifications.completed');
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
      if (reply) seenReplies.add(notice.noticeId);
      else seen.set(notice.sessionId, notice.completedAt);
      return true;
    } catch { return false; }
  };
}
module.exports = { createDesktopNotifications };
