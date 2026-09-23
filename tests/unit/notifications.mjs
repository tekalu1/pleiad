import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createCompletionNotifications } from '../../web/notifications.mjs';
const { createDesktopNotifications } = createRequire(import.meta.url)('../../desktop/notifications.cjs');
export const name = 'notifications';
export const title = '完了通知・重複抑止・通知から会話を開く';
export default async function(t) {
  const sent = [], opened = [];
  let requests = 0, click;
  class BrowserNotice {
    static permission = 'default';
    static requestPermission() { requests++; return Promise.resolve('denied'); }
    constructor(title, options) { this.title = title; this.options = options; sent.push(this); }
    close() { this.closed = true; }
  }
  const host = { Notification: BrowserNotice, focus() { this.focused = true; } };
  const alerts = createCompletionNotifications({ host, openSession: id => opened.push(id) });
  const end = { type: 'turnEnd', outcome: 'ok', sessionId: 'a', completedAt: 10 };
  alerts.requestPermission(); alerts.requestPermission();
  t.ok('通知許可はユーザー操作時に一度だけ要求', requests === 1);
  alerts.completed(end);
  t.ok('未許可なら通知しない', sent.length === 0);
  BrowserNotice.permission = 'granted';
  alerts.completed({ ...end, completedAt: 20 }, { title: '調査' });
  t.ok('正常完了は会話名付きで通知', sent.length === 1 && sent[0].options.body === '調査');
  sent[0].onclick();
  t.ok('クリックで通知を閉じ対象会話を開く', sent[0].closed && host.focused && opened.join() === 'a');
  alerts.completed({ ...end, completedAt: 20 });
  alerts.completed({ ...end, completedAt: 30 }, null, true);
  for (const outcome of ['error', 'aborted', 'requeue', undefined]) alerts.completed({ ...end, completedAt: 40, outcome });
  alerts.completed({ ...end, completedAt: 50, requeued: true });
  t.ok('重複・履歴・失敗・中断・再キューは通知しない', sent.length === 1);
  alerts.completed({ ...end, sessionId: 'b', completedAt: 20 });
  alerts.completed({ ...end, completedAt: 60 });
  t.ok('他の会話と次の完了はそれぞれ通知', sent.length === 3);
  alerts.completed({ ...end, sessionId: 'c', completedAt: 70, delegated: true });
  alerts.completed({ ...end, sessionId: 'd', completedAt: 70 }, { title: '子', delegation: { parentSessionId: 'a' } });
  t.ok('委譲された子の会話の完了は通知しない', sent.length === 3);
  const native = [];
  const desktop = createCompletionNotifications({ host: { Notification: BrowserNotice, plyDesktop: {
    notifyCompletion: n => { native.push(n); return Promise.resolve(true); },
    onNotificationClick: fn => { click = fn; },
  } }, openSession: id => opened.push(id) });
  desktop.requestPermission(); desktop.completed(end); click('native');
  t.ok('デスクトップ版はブラウザー許可を要求せずネイティブ通知だけを使う', native.length === 1 && sent.length === 3 && requests === 1 && opened.at(-1) === 'native');
  let unsupported = false, fail = false;
  const notices = [], calls = [];
  class NativeNotice extends EventEmitter {
    static isSupported() { return !unsupported; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() { if (fail) throw Error('unavailable'); this.shown = true; }
  }
  const notify = createDesktopNotifications({ Notification: NativeNotice, icon: 'icon.png', getWindow: () => ({
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus'),
    webContents: { send: (...args) => calls.push(args.join(':')) },
  }) });
  t.ok('OS通知を発行できる', notify(native[0]) && notices[0].shown);
  t.ok('ネイティブ側も重複を抑止', !notify(native[0]) && notices.length === 1);
  notices[0].emit('click');
  t.ok('最小化を解除して正しい会話へ戻す', calls.join() === 'restore,show,focus,ply:notification-click:a');
  unsupported = true;
  t.ok('OS未対応は安全に無視', !notify({ ...native[0], completedAt: 30 }));
  unsupported = false; fail = true;
  t.ok('OSエラーは会話処理に伝播させない', !notify({ ...native[0], completedAt: 30 }));
  t.ok('不正な通知データは受け付けない', !notify({}) && !notify(null));
}
