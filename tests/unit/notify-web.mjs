// 通知の画面側（ADR 0086）: この PC の通知（切った種類・見ている会話・失敗）、見ている会話の知らせ（presence）、
// 設定 › 通知、スマホのアプリの帯と通知から開く会話、デスクトップ版の OS 通知の失敗の種類。ブラウザーは使わない（DOM の身代わり）。
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { N } from '../lib/dom-stub.mjs';
import { createCompletionNotifications } from '../../web/notifications.mjs';
import { createPresenceReporter, REFRESH_MS } from '../../web/presence.mjs';
import { setupNotifySettings, phoneState, lastSentText } from '../../web/notify-settings.mjs';
import { setupMobileNotify } from '../../web/mobile-notify.mjs';

const { createDesktopNotifications } = createRequire(import.meta.url)('../../desktop/notifications.cjs');

export const name = 'notify-web';
export const title = '通知の画面側: この PC の設定・見ている間は出さない・失敗・presence・設定 › 通知・スマホの帯と通知から開く会話';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function (t) {
  // ── この PC の通知 ──
  const shown = [];
  class Fake {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; shown.push(this); }
    close() {}
  }
  const host = { Notification: Fake, focus() {} };
  let pc = { done: true, reply: true, failed: true };
  let viewing = null;
  const alerts = createCompletionNotifications({ host, openSession: () => {}, settings: () => pc, isViewing: id => id === viewing });
  const ok = { type: 'completionReady', sessionId: 'a', completedAt: 10 };
  alerts.completed(ok, { title: '調査' });
  t.ok('完了は会話名つきで出る（既定）', shown.length === 1 && shown[0].title === '作業が完了しました' && shown[0].options.body === '調査');
  alerts.completed({ ...ok, completedAt: 20, outcome: 'error' }, { title: '調査' });
  t.ok('失敗は「作業が失敗しました」で出る', shown.length === 2 && shown[1].title === '作業が失敗しました' && shown[1].options.body === '調査');
  pc = { done: false, reply: true, failed: true };
  alerts.completed({ ...ok, completedAt: 30 }, { title: '調査' });
  t.ok('完了を切れば完了は出ない', shown.length === 2);
  alerts.completed({ ...ok, completedAt: 40, outcome: 'error' }, { title: '調査' });
  t.ok('完了を切っても失敗は出る', shown.length === 3);
  pc = { done: true, reply: false, failed: false };
  alerts.completed({ ...ok, completedAt: 50, outcome: 'error' });
  alerts.waiting({ type: 'permission', notifyReply: true, id: 'p1', sessionId: 'a', conversationTitle: '承認の会話' });
  t.ok('失敗と返事待ちを切れば出ない', shown.length === 3);
  pc = { done: true, reply: true, failed: true };
  alerts.waiting({ type: 'permission', notifyReply: true, id: 'p1', sessionId: 'a', conversationTitle: '承認の会話' });
  t.ok('切っている間に来た承認は、設定を戻しても後から出し直さない', shown.length === 3);
  viewing = 'a';
  alerts.completed({ ...ok, completedAt: 60 }, { title: '調査' });
  alerts.waiting({ type: 'permission', notifyReply: true, id: 'p2', sessionId: 'a' });
  alerts.completed({ ...ok, completedAt: 61, outcome: 'error' });
  t.ok('その会話を見ている間は、完了・返事待ち・失敗のどれも出ない', shown.length === 3);
  viewing = null;
  alerts.completed({ type: 'completionReady', sessionId: 'b', completedAt: 70 }, { title: '別の会話' });
  alerts.waiting({ type: 'permission', notifyReply: true, id: 'p3', sessionId: 'b', conversationTitle: '承認' });
  t.ok('別の会話の分は出る', shown.length === 5);

  // デスクトップ版の OS 通知（失敗の種類）
  const native = [];
  class NativeNotice {
    static isSupported() { return true; }
    constructor(o) { this.o = o; native.push(o); }
    on() {} show() {}
  }
  const notify = createDesktopNotifications({ Notification: NativeNotice, getWindow: () => null, icon: '' });
  t.ok('OS 通知: 失敗は completedAt で重複を抑えて出る', notify({ sessionId: 'a', kind: 'failed', completedAt: 5, title: '作業が失敗しました', body: 'x' }) === true
    && notify({ sessionId: 'a', kind: 'failed', completedAt: 5, title: '作業が失敗しました', body: 'x' }) === false
    && native[0].title === '作業が失敗しました');
  t.ok('OS 通知: 知らない種類・completedAt の無い失敗は受けない', notify({ sessionId: 'a', kind: 'weird', completedAt: 6, body: 'x' }) === false
    && notify({ sessionId: 'a', kind: 'failed', body: 'x' }) === false);
  t.ok('OS 通知: 見出しが無ければ失敗の既定の文', notify({ sessionId: 'z', kind: 'failed', completedAt: 1, body: 'x' }) === true && native.at(-1).title.length > 0 && native.at(-1).title !== native[0].body);

  // ── presence の知らせ ──
  let clock = 1000;
  const sent = [];
  let cur = null, vis = true;
  const rep = createPresenceReporter({ send: (v, s) => { sent.push([v, s]); }, current: () => cur, visible: () => vis, now: () => clock });
  t.ok('presence: 会話が無ければ見ていない（最初の 1 回だけ送る）', rep.report() === true && sent.at(-1)[0] === false && rep.report() === false);
  cur = 'pending-abc';
  t.ok('presence: 作成中の仮の id は会話として数えない', rep.report() === false);
  cur = 's1';
  t.ok('presence: 会話を開くと送る', rep.report() === true && sent.at(-1)[0] === true && sent.at(-1)[1] === 's1');
  t.ok('presence: 変わらなければ送らない', rep.report() === false);
  clock += REFRESH_MS - 1;
  t.ok('presence: 見ている間は 1 分たつまで送り直さない', rep.report() === false);
  clock += 2;
  t.ok('presence: 1 分たったら送り直す', rep.report() === true);
  vis = false;
  t.ok('presence: 画面が隠れたら見ていないと送る', rep.report() === true && sent.at(-1)[0] === false);
  clock += REFRESH_MS * 3;
  t.ok('presence: 見ていない間は更新を重ねない', rep.report() === false);
  vis = true; cur = 's2';
  rep.report();
  t.ok('presence: 別の会話に移れば送る', sent.at(-1)[1] === 's2');
  rep.report(true);
  t.ok('presence: つなぎ直したときは force で送り直す', sent.length >= 2 && sent.at(-1)[1] === 's2' && sent.at(-2)[1] === 's2');
  const failing = createPresenceReporter({ send: () => Promise.reject(new Error('not connected')), current: () => 's1', visible: () => true, now: () => clock });
  failing.report();
  await sleep(5);
  t.ok('presence: 送れなかったら次の機会に送り直す', failing.report() === true);

  // ── 設定 › 通知の部品 ──
  const now = Date.parse('2026-10-03T12:50:00+09:00');
  const todayLocal = new Date(now);
  const sameDayIso = new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate(), 1, 5).toISOString();
  t.ok('最後に送った時刻: 無ければ「まだ送っていません」', lastSentText(null, now) === 'まだ送っていません' && lastSentText('bad', now) === 'まだ送っていません');
  t.ok('最後に送った時刻: 今日なら時刻、前の日なら日付つき', /^最後に送った \d{1,2}:\d{2}$/.test(lastSentText(sameDayIso, now)) && /^最後に送った \d{1,2}\/\d{1,2}/.test(lastSentText('2026-10-01T03:00:00Z', now)));
  t.ok('スマホの状態: 登録済み・端末で入・止めていない → オン（切り替えられる）', JSON.stringify(phoneState({ notify: { registered: true, enabled: true, muted: false } })) === JSON.stringify({ on: true, switchable: true, hint: '' }));
  t.ok('スマホの状態: ホストで止めた → オフ（戻せる）', phoneState({ notify: { registered: true, enabled: true, muted: true } }).on === false && phoneState({ notify: { registered: true, enabled: true, muted: true } }).switchable === true);
  t.ok('スマホの状態: スマホ側でオフ → ここでは切り替えられず、理由を添える', (() => { const s = phoneState({ notify: { registered: true, enabled: false, muted: false } }); return !s.on && !s.switchable && s.hint === 'スマホ側でオフ'; })());
  t.ok('スマホの状態: 一度も登録していない → オフで理由なし', (() => { const s = phoneState({ notify: { registered: false } }); return !s.on && !s.switchable && s.hint === ''; })());

  // 画面そのもの（身代わりの DOM）
  const panel = new N('section');
  const tab = new N('button');
  const prevDoc = globalThis.document.getElementById;
  globalThis.document.getElementById = id => ({ notifyPanel: panel, notifyTab: tab })[id] ?? null;
  const calls = [];
  const server = {
    pc: { done: true, reply: false, failed: true },
    devices: [
      { id: 'd1', name: 'Pixel 8', platform: 'android', notify: { registered: true, enabled: true, muted: false, lastSentAt: sameDayIso } },
      { id: 'd2', name: 'Pixel Tablet', platform: 'android', notify: { registered: true, enabled: false, muted: false, lastSentAt: null } },
    ],
    relayConnected: true,
  };
  const received = [];
  const settings = setupNotifySettings({
    cmd: async (command, args) => {
      calls.push([command, args]);
      if (command === 'setNotifyPc') server.pc = { ...server.pc, ...args };
      if (command === 'setNotifyDevice') server.devices = server.devices.map(d => d.id === args.id ? { ...d, notify: { ...d.notify, muted: args.muted } } : d);
      return structuredClone(server);
    },
    page: () => {}, onPc: pc => received.push(pc),
  });
  await settings.refresh();
  const text = panel.shown;
  t.ok('設定 › 通知: この PC の 3 つとスマホの名前・最後に送った時刻が出る', ['この PC', '終わったとき', '返事が要るとき（承認・質問）', '失敗したとき', 'スマホ', 'Pixel 8', 'Pixel Tablet', 'まだ送っていません', 'スマホ側でオフ'].every(s => text.includes(s)), text);
  const switches = panel.querySelectorAll('.cx-sw');
  t.ok('設定 › 通知: スイッチは役割と名前を持ち、状態を aria-checked で持つ', switches.length === 5
    && switches.every(s => s.getAttribute('role') === 'switch' && s.getAttribute('aria-label'))
    && switches.map(s => s.getAttribute('aria-checked')).join() === 'true,false,true,true,false');
  t.ok('設定 › 通知: スマホ側でオフの端末のスイッチは押せない', switches[4].disabled === true && switches[3].disabled !== true);
  t.ok('設定 › 通知: この PC の設定が届いたら通知の判定側へ渡す', received.at(-1)?.reply === false);
  switches[1].onclick();
  await sleep(5);
  t.ok('設定 › 通知: 返事が要るときを入れると setNotifyPc { reply: true }', calls.at(-1)[0] === 'setNotifyPc' && calls.at(-1)[1].reply === true && received.at(-1).reply === true);
  panel.querySelectorAll('.cx-sw')[3].onclick();
  await sleep(5);
  t.ok('設定 › 通知: スマホのスイッチを切ると setNotifyDevice { muted: true }', calls.at(-1)[0] === 'setNotifyDevice' && calls.at(-1)[1].id === 'd1' && calls.at(-1)[1].muted === true);
  t.ok('設定 › 通知: 切ったスマホは「オフ」と出る', panel.shown.includes('オフ') && panel.querySelectorAll('.cx-sw')[3].getAttribute('aria-checked') === 'false');
  settings.event({ type: 'notifyStatus', status: { ...server, devices: [] } });
  t.ok('設定 › 通知: スマホが無ければ案内の一文（イベントで更新）', panel.shown.includes('ペアリングしたスマホはありません'));
  globalThis.document.getElementById = prevDoc;

  // ── スマホのアプリの帯と通知から開く会話 ──
  const opened = [];
  const bandEl = new N('div');
  bandEl.hidden = true;
  const listeners = {};
  let st = { enabled: false, dismissed: false };
  const events = { enabled: 0, dismissed: 0 };
  const shellHost = {
    plyRemote: { notify: { state: async () => st, enable: async () => { events.enabled++; st = { enabled: true }; }, dismiss: () => { events.dismissed++; } } },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: { href: 'http://127.0.0.1:41000/?token=abc&open=sess-9' },
    history: { replaceState: (_s, _t, url) => { shellHost.location.href = 'http://127.0.0.1:41000' + url; } },
  };
  const mobile = setupMobileNotify({ host: shellHost, band: bandEl, openSession: id => opened.push(id) });
  await mobile.completed(true);
  t.ok('帯: 履歴の再生（リプレイ）の完了では出さない', bandEl.hidden === true);
  await mobile.completed(false);
  t.ok('帯: 最初の作業が終わったとき、通知がオフなら「離れていても知らせますか？」を出す', bandEl.hidden === false && bandEl.shown.includes('離れていても知らせますか？') && bandEl.shown.includes('オンにする'));
  const buttons = bandEl.querySelectorAll('button');
  t.ok('帯: 「あとで」には名前がある', buttons.length === 2 && buttons[1].getAttribute('aria-label') === 'あとで');
  await buttons[0].onclick();
  t.ok('帯: 「オンにする」で殻に頼み、帯を閉じる', events.enabled === 1 && bandEl.hidden === true);
  await mobile.completed(false);
  t.ok('帯: すでにオンなら出さない', bandEl.hidden === true);
  st = { enabled: false, dismissed: false };
  await mobile.completed(false);
  bandEl.querySelectorAll('button')[1].onclick();
  t.ok('帯: 「あとで」で殻に覚えさせて閉じる', events.dismissed === 1 && bandEl.hidden === true);
  st = { enabled: false, dismissed: true };
  await mobile.completed(false);
  t.ok('帯: 閉じたことがあれば二度と出さない', bandEl.hidden === true);
  t.ok('通知から開く: URL の ?open= を 1 回だけ取り出して URL から消す', mobile.takeOpenRequest() === 'sess-9' && shellHost.location.href === 'http://127.0.0.1:41000/?token=abc' && mobile.takeOpenRequest() === null);
  listeners['plyremote:open']({ detail: { sessionId: 'sess-3' } });
  listeners['plyremote:open']({ detail: {} });
  t.ok('通知から開く: 開いている間は plyremote:open でその会話を開く', opened.join() === 'sess-3');
  const plain = setupMobileNotify({ host: { addEventListener() {} }, band: new N('div'), openSession: () => {} });
  await plain.completed(false);
  t.ok('スマホのアプリでなければ何もしない', plain.available === false && plain.takeOpenRequest() === null);
  void EventEmitter;
}
