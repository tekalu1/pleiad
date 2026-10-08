// Chrome の操作待ち（core/chrome/handoff.mjs）と、引き継ぐ・戻す（core/chrome/control.mjs）の通し（第 7 段 C）。偽の Chrome・偽の OS の層・偽の askPermission。
// サーバーと同じく、台帳を先に作って中継へ渡し、control を後から useControl で差し込む。カードのボタンは ops（browser.chromeTakeOver・chromeResume）を呼ぶ。
//   - カードの「Chrome で操作する」→ 引き継ぐ → カードが「あなたが操作中」（by: pc）。「Claude に戻す」→ 戻す → カードが決着し、待っていた hand_to_user が resumed を受ける
//   - 人がパネルから先に引き継いでいたら、hand_to_user は「お願い」を出さずに「あなたが操作中」から待つ（端末から引き継いでいれば by: device）
//   - ターンが終わっていたら、戻したときに「続けてください」がちょうど 1 回
import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';
import { createChromeHandoffs } from '../../core/chrome/handoff.mjs';
import { browserOps } from '../../core/ops/browser.mjs';

export const name = 'chrome-handoff-flow';
export const title = 'Chrome の操作待ちと引き継ぐ・戻すの通し（第 7 段 C）: カードの「Chrome で操作する」→ 引き継ぐ・「Claude に戻す」→ 決着・先に引き継いでいたら操作中から・ターンの外なら「続けてください」が 1 回（偽の Chrome・偽の OS の層）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => { const msg = JSON.parse(data.toString()); if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
    ws.once('open', () => resolve({
      ws,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

/** askPermission の身代わり（tests/unit/chrome-handoff.mjs と同じ順で onOpen・onSettle を呼ぶ） */
function fakeAsk() {
  const cards = [];
  const ask = opts => new Promise(resolve => {
    const card = { id: `perm-${cards.length + 1}`, opts, updates: [], answer: null };
    const settle = answer => {
      if (card.answer) return;
      card.answer = answer;
      opts.onSettle?.(answer);
      resolve(answer);
    };
    card.settle = settle;
    cards.push(card);
    opts.onOpen?.({ id: card.id, ids: [card.id], update: patch => card.updates.push(patch), settle });
    opts.signal?.addEventListener?.('abort', () => settle({ allow: false, messageKey: 'aborted' }), { once: true });
  });
  return { ask, cards };
}

const TIMING = { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200, boundsWaitMs: 100 };
const opOf = id => browserOps.find(o => o.id === id);

async function rig() {
  const chrome = await startFakeChrome({ permission: 'auto' });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const asked = fakeAsk();
  const env = { live: true, busy: false, sent: [] };
  // core/server.mjs と同じ順: 台帳 → 中継（台帳を受け取る）→ control → useControl
  const handoffs = createChromeHandoffs({
    askPermission: asked.ask, connection: conn,
    sessionBusy: () => env.busy, turnLive: () => env.live,
    continueTurn: async (sessionId, args) => { env.sent.push({ sessionId, ...args }); },
  });
  const scope = createChromeWindows({ os: os_, locate, timing: TIMING });
  const relay = createChromeRelay({ connection: conn, os: os_, locate, scope, handoff: handoffs });
  const control = createChromeControl({ relay, os: os_ });
  handoffs.useControl(control);
  // カードのボタンが呼ぶ ops（WS の chromeTakeOver・chromeResume と同じ handler）
  const ctx = { locale: 'ja', chrome: { status: () => conn.state() }, chromeControl: control };
  const press = {
    takeOver: (sessionId, extra = {}) => opOf('browser.chromeTakeOver').handler(ctx, { sessionId, ...extra }),
    resume: sessionId => opOf('browser.chromeResume').handler(ctx, { sessionId }),
  };
  const live = [];
  return {
    ...asked, chrome, os: os_, conn, relay, control, handoffs, env, press,
    async agent(sessionId) { const a = await agent(await relay.endpoint(sessionId)); live.push(a); return a; },
    /** 会話の窓にタブを 1 つ作る（エージェントの操作） */
    async tab(sessionId) {
      const a = await this.agent(sessionId);
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      await until(() => relay.view.current(sessionId) === created.result.targetId);
      return created.result.targetId;
    },
    endTurn(sessionId) { env.live = false; relay.endTurn(sessionId); handoffs.turnChanged(sessionId, false); },
    async stop() { for (const a of live) { try { a.close(); } catch { /* 閉じていてもよい */ } } handoffs.close(); control.close(); relay.close(); await conn.close(); await chrome.stop(); },
  };
}

const lastUpdate = card => card?.updates.at(-1) ?? {};
const tick = () => new Promise(resolve => setImmediate(resolve));

export default async function (t) {
  // ===== 1. カードの「Chrome で操作する」→「Claude に戻す」（ターンの中で hand_to_user が待っている） =====
  {
    const r = await rig();
    try {
      await r.conn.connect();
      t.ok('前提: Chrome につながっている', await until(() => r.conn.state().state === 'connected'));
      await r.tab('one');
      r.os.setForeground('pleiad-window');
      const h = r.handoffs.ask('one', { reason: 'login', message: 'ログインしてください' });
      t.ok('hand_to_user → 「お願い」のカードが 1 枚（asked）', !!h && r.cards.length === 1 && r.cards[0].opts.browserHandoff.state === 'asked' && r.cards[0].opts.browserHandoff.reason === 'login');
      const waiting = r.handoffs.wait('one');

      const took = await r.press.takeOver('one');
      t.ok('カードの「Chrome で操作する」（chromeTakeOver）→ paused（by: pc）', took.state === 'paused' && took.by === 'pc', JSON.stringify(took));
      t.ok('カードが「あなたが操作中」（by: pc）に替わる', lastUpdate(r.cards[0]).state === 'operating' && lastUpdate(r.cards[0]).by === 'pc', JSON.stringify(r.cards[0].updates));
      t.ok('窓は PC の画面に見せる（reveal）', r.os.calls('reveal').length === 1);
      t.ok('まだ決着しない（hand_to_user は待ち続ける）', r.cards[0].answer === null && r.handoffs.current('one')?.state === 'operating');

      const back = await r.press.resume('one');
      t.ok('カードの「Claude に戻す」（chromeResume）→ 一時停止が解ける', back.state === 'running', JSON.stringify(back));
      const result = await waiting;
      t.ok('戻すとカードが決着し（resumed）、待っていた hand_to_user が受ける', r.cards[0].answer?.allow === true && r.cards[0].answer.response.kind === 'resumed' && result.kind === 'resumed', JSON.stringify(result));
      t.ok('待っている人がいたので「続けてください」は送らない', r.env.sent.length === 0 && result.continued === false);
      t.ok('依頼は閉じる（次の hand_to_user は新しいカード）', r.handoffs.current('one') === null);
    } finally { await r.stop(); }
  }

  // ===== 2. 人がパネルから先に引き継いでいた → 「お願い」を出さずに「あなたが操作中」から待つ =====
  {
    const r = await rig();
    try {
      await r.conn.connect();
      await until(() => r.conn.state().state === 'connected');
      await r.tab('one');
      await r.press.takeOver('one');   // 右パネルの状態の一行の「引き継ぐ」
      const h = r.handoffs.ask('one', { reason: 'captcha' });
      t.ok('hand_to_user のカードは「お願い（asked）」を経ずに「あなたが操作中」（by: pc）から', !!h && r.cards.length === 1 && r.cards[0].updates[0]?.state === 'operating' && r.cards[0].updates[0].by === 'pc'
        && !r.cards[0].updates.some(u => u.state === 'asked'), JSON.stringify(r.cards[0].updates));
      t.ok('押し直さなくてよい（もう paused。reveal も重ねない）', r.control.state('one').state === 'paused' && r.os.calls('reveal').length === 1);
      t.ok('2 回目の hand_to_user も同じカード（増やさない）', r.handoffs.ask('one', { reason: 'captcha' }) === h && r.cards.length === 1);
      const waiting = r.handoffs.wait('one');
      await tick();
      t.ok('待つ（決着しない）', r.cards[0].answer === null);
      await r.press.resume('one');
      const result = await waiting;
      t.ok('戻すと決着する（resumed）', result.kind === 'resumed' && r.cards[0].answer?.response.kind === 'resumed' && r.env.sent.length === 0);

      // 端末から先に引き継いでいた（by: device）
      const took = await r.press.takeOver('one', { by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('端末から引き継ぐ（by: device。窓は見せない）', took.by === 'device' && r.os.calls('reveal').length === 1, JSON.stringify(took));
      r.handoffs.ask('one', { reason: 'payment' });
      t.ok('カードは「端末で操作中」（by: device）から', r.cards.length === 2 && r.cards[1].updates[0]?.state === 'operating' && r.cards[1].updates[0].by === 'device', JSON.stringify(r.cards[1].updates));
      const waiting2 = r.handoffs.wait('one');
      await r.press.resume('one');
      t.ok('端末の「Claude に戻す」でも決着する', (await waiting2).kind === 'resumed');
    } finally { await r.stop(); }
  }

  // ===== 3. ターンが終わっていた → 戻したときに「続けてください」がちょうど 1 回 =====
  {
    const r = await rig();
    try {
      await r.conn.connect();
      await until(() => r.conn.state().state === 'connected');
      await r.tab('one');
      r.handoffs.ask('one', { reason: 'two_factor' });
      // hand_to_user の待ちが区切りで返り、そのままターンが終わった（カードは残る）
      t.ok('区切りで waiting を返してもカードは残る', (await r.handoffs.wait('one', { sliceMs: 20 })).kind === 'waiting' && r.cards[0].answer === null);
      r.endTurn('one');
      t.ok('ターンの外になったことがカードに届く（「Claude に戻して続ける」）', r.cards[0].updates.some(u => u.turnLive === false));
      await r.press.takeOver('one', { by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('端末から「この端末で操作する」→ カードが「この端末で操作中」', lastUpdate(r.cards[0]).state === 'operating' && lastUpdate(r.cards[0]).by === 'device', JSON.stringify(r.cards[0].updates));
      await r.press.resume('one');
      await until(() => r.env.sent.length > 0);
      t.ok('戻すと「続けてください」を 1 回送る（kind: resumed・決まった messageId）', r.env.sent.length === 1 && r.env.sent[0].sessionId === 'one' && r.env.sent[0].kind === 'resumed' && typeof r.env.sent[0].messageId === 'string', JSON.stringify(r.env.sent));
      t.ok('カードの答えに continued が立つ', r.cards[0].answer?.allow === true && r.cards[0].answer.response.continued === true);
      // 戻すを重ねる・もう一度引き継いで戻す（依頼は閉じている）
      await r.press.resume('one');
      await r.press.takeOver('one');
      await r.press.resume('one');
      await sleep(50);
      t.ok('戻すを重ねても・依頼の無い引き継ぎを戻しても、もう送らない（ちょうど 1 回）', r.env.sent.length === 1 && r.cards.length === 1, JSON.stringify(r.env.sent));
    } finally { await r.stop(); }
  }

  // ===== 4. 差し込みの順: control を後から差し込む前の変化は見ない・差し替えると前の聞き手を外す =====
  {
    const r = await rig();
    try {
      await r.conn.connect();
      await until(() => r.conn.state().state === 'connected');
      await r.tab('one');
      r.handoffs.useControl(null);   // 外す
      r.handoffs.ask('one', { reason: 'other' });
      await r.press.takeOver('one');
      t.ok('control を外している間は、引き継いでもカードは「お願い」のまま', !r.cards[0].updates.some(u => u.state === 'operating'), JSON.stringify(r.cards[0].updates));
      await r.press.resume('one');
      r.handoffs.useControl(r.control);
      await r.press.takeOver('one');
      t.ok('差し込み直すと、次の引き継ぎから「あなたが操作中」になる', lastUpdate(r.cards[0]).state === 'operating');
      await r.press.resume('one');
      t.ok('戻すと決着する', r.cards[0].answer?.response?.kind === 'resumed');
    } finally { await r.stop(); }
  }
}
