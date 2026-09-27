import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createCompletionNotifications } from '../../web/notifications.mjs';
import { createCompletionNotices, hasPendingChild } from '../../core/completion-notices.mjs';
const { createDesktopNotifications } = createRequire(import.meta.url)('../../desktop/notifications.cjs');
export const name = 'notifications';
export const title = '完了と返事待ちの通知・保留・重複抑止';
export default async function(t) {
  t.ok('子の実行中と結果配送中は保留し、抑止済みは待たない',
    ['queued', 'running', 'cancelling'].every(status => hasPendingChild([{ status, notification: 'none' }]))
    && ['pending', 'delivering'].every(notification => hasPendingChild([{ status: 'completed', notification }]))
    && hasPendingChild([{ status: 'completed', notification: 'none' }])
    && !hasPendingChild([{ status: 'cancelled', notification: 'suppressed' }]));
  const events = [];
  const busy = { turn: false, preparing: false, child: false, delivery: false, background: false, connected: true };
  const completions = createCompletionNotices({
    busy: () => busy.turn || busy.preparing || busy.child || busy.delivery || busy.background,
    send: event => { if (!busy.connected) return false; events.push(event); return true; },
  });
  busy.child = true;
  completions.finished('parent', 'ok', 10);
  t.ok('子が ACTIVE の間は依頼元の完了を通知しない', events.length === 0);
  busy.child = false; busy.delivery = true;
  completions.changed();
  t.ok('結果配送中も通知を保留する', events.length === 0);
  busy.delivery = false; busy.turn = true;
  completions.changed();
  t.ok('結果を受け取ったターン中は通知しない', events.length === 0);
  busy.turn = false;
  completions.finished('parent', 'ok', 20);
  completions.changed();
  t.ok('結果を受け取ったターンの終わりで最新の完了を一度だけ知らせる', events.length === 1 && events[0].completedAt === 20);
  busy.child = true;
  completions.finished('cancelled', 'ok', 30);
  busy.child = false;
  completions.changed(); completions.changed();
  t.ok('キャンセルで結果が届かなくても落ち着いた時に一度だけ知らせる', events.length === 2 && events[1].sessionId === 'cancelled');
  busy.child = true;
  completions.finished('preparing', 'ok', 35);
  busy.preparing = true; busy.child = false;
  completions.changed('preparing');
  t.ok('新しいターンの準備中に子が終わっても通知しない', events.length === 2);
  busy.preparing = false; busy.turn = true;
  completions.changed('preparing');
  busy.turn = false;
  completions.finished('preparing', 'ok', 36);
  t.ok('新しいターンの終わりに保留分をまとめて一度だけ知らせる', events.length === 3 && events[2].completedAt === 36);
  busy.background = true;
  completions.finished('background', 'ok', 40);
  busy.background = false;
  completions.changed('background'); completions.changed('background');
  t.ok('ターン外のバックグラウンド終了で一度だけ知らせる', events.length === 4 && events[3].completedAt === 40);
  busy.connected = false;
  completions.finished('offline', 'ok', 50);
  busy.connected = true;
  completions.changed();
  t.ok('画面が離れていた完了は接続後に知らせる', events.length === 5 && events[4].sessionId === 'offline');

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
  const end = { type: 'completionReady', sessionId: 'a', completedAt: 10 };
  alerts.requestPermission(); alerts.requestPermission();
  t.ok('通知許可はユーザー操作時に一度だけ要求', requests === 1);
  alerts.completed(end);
  t.ok('未許可なら通知しない', sent.length === 0);
  BrowserNotice.permission = 'granted';
  alerts.completed({ ...end, completedAt: 20 }, { title: '調査' });
  t.ok('落ち着いた完了は会話名付きで通知', sent.length === 1 && sent[0].options.body === '調査');
  sent[0].onclick();
  t.ok('クリックで通知を閉じ対象会話を開く', sent[0].closed && host.focused && opened.join() === 'a');
  alerts.completed({ ...end, completedAt: 20 });
  alerts.completed({ ...end, completedAt: 30 }, null, true);
  alerts.completed({ type: 'turnEnd', outcome: 'ok', sessionId: 'a', completedAt: 40 });
  t.ok('重複・履歴再生・通常の turnEnd は通知しない', sent.length === 1);
  alerts.completed({ ...end, sessionId: 'b', completedAt: 20 });
  alerts.completed({ ...end, completedAt: 60 });
  t.ok('他の会話と次の完了はそれぞれ通知', sent.length === 3);
  alerts.completed({ ...end, sessionId: 'd', completedAt: 70 }, { title: '子', delegation: { parentSessionId: 'a' } });
  t.ok('委譲された子の会話の完了は通知しない', sent.length === 3);
  const wait = { type: 'permission', kind: 'question', id: 'wait-1', sessionId: 'child', notifyReply: true, conversationTitle: '子の調査' };
  alerts.waiting(wait, null, true);
  alerts.waiting(wait);
  alerts.waiting(wait);
  t.ok('子の質問は再生せず初回だけ会話名付きで通知', sent.length === 4 && sent[3].options.body === '子の調査');
  sent[3].onclick();
  t.ok('返事待ち通知から子の会話を開く', opened.at(-1) === 'child');
  alerts.waiting({ ...wait, id: 'wait-2', kind: 'tool' });
  t.ok('次の承認は別の待ちとして通知', sent.length === 5);
  const native = [];
  const desktop = createCompletionNotifications({ host: { Notification: BrowserNotice, plyDesktop: {
    notifyCompletion: n => { native.push(n); return Promise.resolve(true); },
    onNotificationClick: fn => { click = fn; },
  } }, openSession: id => opened.push(id) });
  desktop.requestPermission(); desktop.completed(end); desktop.waiting(wait); click('native');
  t.ok('デスクトップ版はブラウザー許可を要求せず両通知をネイティブへ渡す', native.length === 2 && sent.length === 5 && requests === 1 && opened.at(-1) === 'native');
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
  t.ok('返事待ちは完了と別に通知する', notify(native[1]) && notices.length === 2);
  t.ok('同じ承認のネイティブ通知も一度だけ', !notify(native[1]) && notices.length === 2);
  notices[0].emit('click');
  t.ok('最小化を解除して正しい会話へ戻す', calls.join() === 'restore,show,focus,ply:notification-click:a');
  unsupported = true;
  t.ok('OS未対応は安全に無視', !notify({ ...native[0], completedAt: 30 }));
  unsupported = false; fail = true;
  t.ok('OSエラーは会話処理に伝播させない', !notify({ ...native[0], completedAt: 30 }));
  t.ok('不正な通知データは受け付けない', !notify({}) && !notify(null));
}
