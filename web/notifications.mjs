// Live completions only: replayed history must never produce desktop alerts.
export function createCompletionNotifications({ host = window, openSession }) {
  const seen = new Map();
  let requested = false;
  host.plyDesktop?.onNotificationClick?.(id => { void openSession(id); });
  return {
    requestPermission() {
      if (host.plyDesktop || requested || host.Notification?.permission !== 'default') return;
      requested = true;
      try { Promise.resolve(host.Notification.requestPermission()).catch(() => {}); } catch {}
    },
    completed(event, session, replay = false) {
      if (replay || event.type !== 'turnEnd' || event.outcome !== 'ok' || event.requeued
          || !event.sessionId || !Number.isFinite(event.completedAt)) return;
      if (event.completedAt <= (seen.get(event.sessionId) ?? 0)) return;
      seen.set(event.sessionId, event.completedAt);
      const notice = { sessionId: event.sessionId, completedAt: event.completedAt,
        title: '作業が完了しました', body: String(session?.title || 'Pleiad の会話').slice(0, 200) };
      try {
        if (host.plyDesktop?.notifyCompletion) {
          Promise.resolve(host.plyDesktop.notifyCompletion(notice)).catch(() => {});
        } else if (host.Notification?.permission === 'granted') {
          const notification = new host.Notification(notice.title, { body: notice.body, tag: `ply:${event.sessionId}` });
          notification.onclick = () => { notification.close(); host.focus(); void openSession(event.sessionId); };
        }
      } catch { /* Unsupported OS / denied permission must not affect the conversation. */ }
    },
  };
}
