// Live completions only: replayed history must never produce desktop alerts.
import { t } from './i18n.mjs';
import { savedTitle } from './saved-text.mjs';
import { approvalApps, approvalNotice } from './computer-use.mjs';

export function createCompletionNotifications({ host = window, openSession }) {
  const seen = new Map();
  const seenReplies = new Set();
  let requested = false;
  host.plyDesktop?.onNotificationClick?.(id => { void openSession(id); });
  const show = notice => {
    try {
      if (host.plyDesktop?.notifyCompletion) {
        Promise.resolve(host.plyDesktop.notifyCompletion(notice)).catch(() => {});
      } else if (host.Notification?.permission === 'granted') {
        const notification = new host.Notification(notice.title, { body: notice.body,
          tag: notice.kind === 'reply' ? `ply:reply:${notice.noticeId}` : `ply:${notice.sessionId}` });
        notification.onclick = () => { notification.close(); host.focus(); void openSession(notice.sessionId); };
      }
    } catch { /* Unsupported OS / denied permission must not affect the conversation. */ }
  };
  const body = title => String(title ? savedTitle(title) : t('notify.untitled')).slice(0, 200);
  return {
    requestPermission() {
      if (host.plyDesktop || requested || host.Notification?.permission !== 'default') return;
      requested = true;
      try { Promise.resolve(host.Notification.requestPermission()).catch(() => {}); } catch {}
    },
    completed(event, session, replay = false) {
      if (replay || event.type !== 'completionReady'
          || !event.sessionId || !Number.isFinite(event.completedAt)) return;
      if (session?.delegation) return;
      if (event.completedAt <= (seen.get(event.sessionId) ?? 0)) return;
      seen.set(event.sessionId, event.completedAt);
      const notice = { sessionId: event.sessionId, completedAt: event.completedAt,
        title: t('notify.completed'), body: body(session?.title) };
      show(notice);
    },
    waiting(event, session, replay = false) {
      if (replay || event.type !== 'permission' || !event.notifyReply || !event.id || !event.sessionId
          || seenReplies.has(event.id)) return;
      seenReplies.add(event.id);
      // コンピューターの操作のアプリの承認は、誰が何の許可を待っているかを見出しに出す（本文は会話の題）
      const computer = event.computerApp ? approvalApps(event.computerApp) : null;
      show({ kind: 'reply', noticeId: event.id, sessionId: event.sessionId,
        title: computer ? approvalNotice(computer) : t('notify.waitingReply'), body: body(session?.title || event.conversationTitle) });
    },
  };
}
