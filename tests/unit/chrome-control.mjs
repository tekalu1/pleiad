import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay, PAUSED_MESSAGE } from '../../core/chrome/relay.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';

export const name = 'chrome-control';
export const title = 'エージェントの Chrome の窓の止める・引き継ぐ・戻す（ADR 0148・0154）: 状態機械・一時停止中の断り・映像を断る・止めて人の送信で解く・窓を見える形に戻して前に出す／画面の外へ戻す・窓が閉じられた／Chrome が閉じた・押した位置（偽の OS の層と偽の Chrome）';

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
    const raw = [];
    let next = 0;
    ws.on('message', data => {
      raw.push(data.toString());
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
    });
    ws.once('open', () => resolve({
      ws, raw,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}
const refused = url => agent(url).then(client => { client.close(); return false; }, () => true);

const TIMING = { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200, boundsWaitMs: 100 };

async function rig({ authorize } = {}) {
  const chrome = await startFakeChrome({ permission: 'auto' });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const logs = [];
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const scope = createChromeWindows({ os: os_, locate, log: line => logs.push(line), timing: TIMING });
  const relay = createChromeRelay({ connection: conn, os: os_, locate, scope, log: line => logs.push(line), ...(authorize ? { authorize } : {}) });
  let clock = 1_000_000;
  const records = [];
  // 映像の撮影を断る口（core/chrome/screencast.mjs の代わり）。suspend した時に OS の層の reveal がいくつ呼ばれていたかも残す（先に断つ）
  const captureLog = [];
  const capture = { suspend: id => captureLog.push({ op: 'suspend', id, reveals: os_.calls('reveal').length, lookups: os_.calls('appWindow').length + os_.calls('foreground').length }), resume: id => captureLog.push({ op: 'resume', id }) };
  const control = createChromeControl({ relay, os: os_, now: () => clock, record: async row => { records.push(row); }, capture, log: line => logs.push(line) });
  const events = [];
  control.onChange(state => events.push(state));
  const taps = [];
  control.onTap(tap => taps.push(tap));
  const live = [];
  return {
    chrome, conn, relay, control, logs, os: os_, scope, fake: chrome.browser, events, taps, records, captureLog,
    advance: ms => { clock += ms; },
    async agent(sessionId, options = {}) {
      const a = await agent(await relay.endpoint(sessionId, options));
      live.push(a);
      return a;
    },
    async stop() { for (const a of live) { try { a.close(); } catch { /* 閉じていてもよい */ } } control.close(); relay.close(); await conn.close(); await chrome.stop(); },
  };
}

const hwndOf = (r, windowId) => r.os.hwnds().find(h => h.windowId === windowId);
const tabInfo = (r, targetId) => r.fake.targets().find(x => x.targetId === targetId);
const concealedOk = h => h?.concealed === true && h.alpha === 0 && h.ex.toolwindow && h.ex.layered && h.ex.transparent && !h.ex.appwindow;
const visibleOk = h => h && h.concealed === false && h.alpha === 255 && !h.ex.toolwindow && !h.ex.transparent && h.ex.appwindow;
const last = r => r.events.at(-1)?.state;

export default async function (t) {
  // ===== 1. 状態機械: running / idle / stopped。止めると再接続を断ち、次の人の送信（unlock）で解ける =====
  {
    const r = await rig();
    try {
      t.ok('会話がまだ中継に無ければ idle（便りは出さない）', r.control.state('none').state === 'idle' && r.events.length === 0);
      const a = await r.agent('one');
      t.ok('端点を渡すとターンの間（running）', r.control.state('one').state === 'running' && last(r) === 'running', JSON.stringify(r.events));
      r.relay.endTurn('one');
      t.ok('ターンが終わると idle（待機中）', r.control.state('one').state === 'idle' && last(r) === 'idle');
      const url = await r.relay.endpoint('one');
      t.ok('次のターンでまた running', r.control.state('one').state === 'running' && last(r) === 'running');
      t.ok('同じ状態は重ねて配らない', r.events.map(e => e.state).join() === 'running,idle,running', r.events.map(e => e.state).join());

      const stopped = await r.control.stop('one');
      t.ok('止める → stopped（接続を閉じる。1000 stopped）', stopped.state === 'stopped' && last(r) === 'stopped' && (await a.closed).code === 1000);
      t.ok('止めている間は再接続を断る', await refused(url));
      const key2 = await r.relay.endpoint('one');
      t.ok('ターンの開始だけでは解けない（人の送信でないとき）', key2 === url && r.control.state('one').state === 'stopped' && await refused(url));
      const b = await agent(await r.relay.endpoint('one', { unlock: true }));
      t.ok('人の送信で始まったターン（unlock）で鍵を作り直して解ける → running', r.control.state('one').state === 'running' && !(await b.cmd('Browser.getVersion')).error);
      t.ok('古い鍵は使えない', await refused(url));
      b.close();
    } finally { await r.stop(); }
  }

  // ===== 2. 引き継ぐ: エージェントの接続を切り、窓を見える形に戻して前に出す → つなぎ直されたコマンドも全部断る → 戻す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const windowId = tabInfo(r, tabId).windowId;
      const hw = () => hwndOf(r, windowId);
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      await a.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 80, button: 'left', clickCount: 1 }, sid);
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }, sid);
      t.ok('エージェントが押した位置（mousePressed の座標だけ）を onTap で配る', r.taps.length === 1 && r.taps[0].sessionId === 'one' && r.taps[0].x === 120 && r.taps[0].y === 80 && r.taps[0].windowId === windowId, JSON.stringify(r.taps));
      t.ok('引き継ぐ前は窓は隠れている・映像は断らない', concealedOk(hw()) && r.control.captureBlocked('one') === false);

      const took = await r.control.takeOver('one');
      t.ok('引き継ぐ → paused（since は始まりの時刻）', took.state === 'paused' && took.since === 1_000_000 && last(r) === 'paused', JSON.stringify(took));
      t.ok('窓を見える形に戻した（画面の中・透明度 255・タスクバーに出る・マウスを受ける）', visibleOk(hw()), JSON.stringify(hw()));
      const reveal = r.os.calls('reveal').at(-1), raise = r.os.calls('raise').at(-1);
      t.ok('押された直後の前面（Pleiad の窓）のある画面の中へ戻す', reveal?.ref === hw().id && reveal.near === 'pleiad-window', JSON.stringify(reveal));
      t.ok('窓を前に出す（raise）。reveal の後', raise?.ref === hw().id && r.os.getForeground() === hw().id && r.os.log.indexOf(reveal) < r.os.log.indexOf(raise));
      t.ok('映像・撮影を断る（captureBlocked）', r.control.captureBlocked('one') === true);
      t.ok('撮影を断つ口（suspend）を 1 回、窓を見える形に戻す前に呼ぶ（同期で効かせる）', r.captureLog.length === 1 && r.captureLog[0].op === 'suspend' && r.captureLog[0].id === 'one' && r.captureLog[0].reveals === 0, JSON.stringify(r.captureLog));

      const closedWith = await a.closed;
      t.ok('引き継ぐと、エージェントのブラウザーとタブの接続を切る（1000 paused。Chrome からの通知を流し続けない）', closedWith.code === 1000 && closedWith.reason === 'paused', JSON.stringify(closedWith));
      t.ok('上りのエージェントのセッションを外す（エージェントが付けた Fetch・Network もセッションごと外れる）', r.chrome.calls.some(c => c.method === 'Target.detachFromTarget' && c.params.sessionId === sid));
      const callsBefore = r.chrome.calls.length;
      const fresh = await agent(await r.relay.endpoint('one'));
      const refusals = await Promise.all([fresh.cmd('Browser.getVersion'), fresh.cmd('Target.getTargets'), fresh.cmd('Runtime.evaluate', { expression: '1' }, sid), fresh.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, sid), fresh.cmd('Page.bringToFront', {}, sid), fresh.cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false }), fresh.cmd('Target.createTarget', { url: 'about:blank' })]);
      t.ok('つなぎ直した接続（agent-browser の次のコマンド）のコマンドは全部断る（hand_to_user を呼んで戻るのを待つ。日本語と英語）', refusals.every(m => m.error?.message === PAUSED_MESSAGE) && /hand_to_user/.test(PAUSED_MESSAGE) && /paused/.test(PAUSED_MESSAGE) && /一時停止/.test(PAUSED_MESSAGE), JSON.stringify(refusals.map(m => m.error?.message)));
      t.ok('つなぎ直しは受ける（接続は切らない）', fresh.ws.readyState === 1);
      t.ok('断ったコマンドは Chrome へ届かない（押した位置の便りも出ない・窓も増えない）', r.taps.length === 1 && r.chrome.calls.slice(callsBefore).every(c => c.method !== 'Target.createTarget' && c.method !== 'Runtime.evaluate'));
      fresh.close();
      t.ok('二重に引き継いでも窓は 1 回だけ戻す', (await r.control.takeOver('one')).state === 'paused' && r.os.calls('reveal').length === 1);

      r.advance(72_000);
      const back = await r.control.resume('one');
      t.ok('戻す → 窓を画面の外の見えない窓に戻す', concealedOk(hw()), JSON.stringify(hw()));
      t.ok('戻したら resume を 1 回（suspend と対）', r.captureLog.map(x => x.op).join() === 'suspend,resume' && r.captureLog[1].id === 'one', JSON.stringify(r.captureLog));
      t.ok('一時停止が解ける（ターンの間なので running）。映像の断りも解ける', back.state === 'running' && last(r) === 'running' && r.control.captureBlocked('one') === false, JSON.stringify(back));
      t.ok('人が前面に置いていた窓が前面のままにならない（Pleiad の窓へ返す）', r.os.getForeground() === 'pleiad-window', r.os.getForeground());
      t.ok('会話に残す行の秒数は引き継いでいた時間（72 秒）', r.records.length === 1 && r.records[0].sessionId === 'one' && r.records[0].seconds === 72, JSON.stringify(r.records));
      const a2 = await r.agent('one');   // 戻した後は agent-browser がつなぎ直す
      const sid2 = (await a2.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result?.sessionId;
      t.ok('戻した後は、つなぎ直した接続のコマンドが通る', !(await a2.cmd('Browser.getVersion')).error && !!sid2 && !(await a2.cmd('Runtime.evaluate', { expression: '1' }, sid2)).error);
      t.ok('戻すを重ねても行は増えない', (await r.control.resume('one')).state === 'running' && r.records.length === 1);
      t.ok('状態の便りの並び', r.events.map(e => e.state).join() === 'running,paused,running', r.events.map(e => e.state).join());
    } finally { await r.stop(); }
  }

  // ===== 3. 窓が無いとき・窓が複数のとき =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const none = await r.control.takeOver('nobody').then(() => null, error => error);
      t.ok('会話が中継に無ければ NO_WINDOW', none?.code === 'NO_WINDOW');
      const a = await r.agent('one');
      const early = await r.control.takeOver('one').then(() => null, error => error);
      t.ok('窓がまだ無い会話は NO_WINDOW。撮影も断たず、エージェントの接続も切らない（一時停止にしない）', r.captureLog.length === 0 && a.ws.readyState === 1, JSON.stringify(r.captureLog));
      t.ok('窓がまだ無い会話は NO_WINDOW。一時停止も残さない', early?.code === 'NO_WINDOW' && r.control.state('one').state === 'running' && !(await a.cmd('Browser.getVersion')).error && r.control.captureBlocked('one') === false, JSON.stringify(early?.code));
      const one = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const two = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const w1 = tabInfo(r, one.result.targetId).windowId, w2 = tabInfo(r, two.result.targetId).windowId;
      const sid1 = (await a.cmd('Target.attachToTarget', { targetId: one.result.targetId, flatten: true })).result.sessionId;
      const sid2 = (await a.cmd('Target.attachToTarget', { targetId: two.result.targetId, flatten: true })).result.sessionId;
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid1);
      await a.cmd('Runtime.evaluate', { expression: '1' }, sid2);   // 最後に操作したのは 2 つ目のタブ
      await r.control.takeOver('one');
      t.ok('会話の窓を全部見える形に戻す', visibleOk(hwndOf(r, w1)) && visibleOk(hwndOf(r, w2)));
      t.ok('前に出すのはエージェントが最後に操作したタブの窓（最初の窓ではない）', r.os.getForeground() === hwndOf(r, w2).id && r.os.getForeground() !== hwndOf(r, w1).id, `${r.os.getForeground()} / ${hwndOf(r, w2).id}`);
      await r.control.resume('one');
      t.ok('戻すと全部隠れる', concealedOk(hwndOf(r, w1)) && concealedOk(hwndOf(r, w2)));
    } finally { await r.stop(); }
  }

  // ===== 4. 隠す層が使えない（窓の ref が無い）→ 引き継げない =====
  {
    const r = await rig();
    try {
      r.os.opts.hideNonce = true; r.os.opts.hideBounds = true;
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      const failed = await r.control.takeOver('one').then(() => null, error => error);
      t.ok('窓を見つけられていなければ（隠していない）引き継げない。一時停止を残さない', failed?.code === 'NO_WINDOW' && !(await a.cmd('Browser.getVersion')).error && r.control.captureBlocked('one') === false);
    } finally { await r.stop(); }
  }

  // ===== 5. 引き継いでいる間に窓を × で閉じられた → paused のまま。戻すで解け、次に使うとき黙って開き直す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const windowId = tabInfo(r, created.result.targetId).windowId;
      await r.control.takeOver('one');
      r.fake.closeWindow(windowId);
      await until(() => r.scope.windows('one').length === 0);
      const b = await r.agent('one');
      t.ok('窓を閉じられても paused のまま（つなぎ直したエージェントのコマンドは断る）', r.control.state('one').state === 'paused' && (await b.cmd('Browser.getVersion')).error?.message === PAUSED_MESSAGE);
      const back = await r.control.resume('one');
      t.ok('戻すで解ける（隠す窓は無い）。会話の行も残る', back.state === 'running' && r.records.length === 1);
      const again = await b.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('次に使うときに黙って開き直し、その窓も隠す', !again.error && concealedOk(hwndOf(r, tabInfo(r, again.result.targetId)?.windowId)));
    } finally { await r.stop(); }
  }

  // ===== 6. 引き継いでいる間の popup は動かさず、戻すときに探して隠す =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      r.fake.setPage('https://open.example/', { title: 'Opener', elements: [{ role: 'link', name: 'popup', open: { url: 'https://open.example/popup', popup: true } }] });
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'https://open.example/' });
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      await r.control.takeOver('one');
      r.fake.windowOpen(created.result.targetId, 'https://open.example/popup', { popup: true });   // 人が開いたページが window.open した
      const popup = await until(() => r.fake.targets().some(x => x.url === 'https://open.example/popup'))
        ? r.fake.targets().find(x => x.url === 'https://open.example/popup') : null;
      await sleep(80);
      t.ok('引き継いでいる間は、新しい窓を画面の外へ動かさない（人の窓を奪わない）', !!popup && r.fake.windowBounds(popup.windowId).left < 1000, JSON.stringify(popup && r.fake.windowBounds(popup.windowId)));
      await r.control.resume('one');
      t.ok('戻すときに探して隠す', concealedOk(hwndOf(r, popup.windowId)), JSON.stringify(hwndOf(r, popup.windowId)));
    } finally { await r.stop(); }
  }

  // ===== 7. 引き継いでいる間に止める → 窓を戻してから止める =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const hw = () => hwndOf(r, tabInfo(r, created.result.targetId).windowId);
      await r.control.takeOver('one');
      const stopped = await r.control.stop('one');
      t.ok('止めたら resume で対にする', r.captureLog.map(x => x.op).join() === 'suspend,resume', JSON.stringify(r.captureLog));
      t.ok('止める → 窓は隠れて、stopped', stopped.state === 'stopped' && concealedOk(hw()) && r.control.captureBlocked('one') === false && (await a.closed).code === 1000);
    } finally { await r.stop(); }
  }

  // ===== 8. Chrome が閉じた → 一時停止も解く =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.control.takeOver('one');
      for (const h of r.os.hwnds()) r.os.killWindow(h.id);
      await r.chrome.restart();
      await a.closed;
      t.ok('Chrome が閉じたら paused を解く', await until(() => r.control.state('one').state !== 'paused') && r.control.captureBlocked('one') === false, JSON.stringify(r.control.state('one')));
      t.ok('窓の「見える形」の印も捨てる（つなぎ直した後の popup を隠せる）', r.scope.isRevealed('one') === false);
      t.ok('Chrome が閉じて paused が解けたら resume で対にする', r.captureLog.map(x => x.op).join() === 'suspend,resume', JSON.stringify(r.captureLog));
      const b = await r.agent('one');
      t.ok('つなぎ直せばコマンドが通る', !(await b.cmd('Browser.getVersion')).error);
    } finally { await r.stop(); }
  }

  // ===== 8b. 引き継ぎ中に会話を消す・id が替わる → 撮影の断りの対が崩れない =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('new:abc');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.control.takeOver('new:abc');
      r.relay.rebind('new:abc', 'real');
      t.ok('id が替わっても paused は新しい id に付き、新しい id へ suspend を出し直す', r.control.state('real').state === 'paused' && r.captureLog.some(x => x.op === 'suspend' && x.id === 'real'), JSON.stringify(r.captureLog));
      t.ok('古い id の分は resume で片付く', r.captureLog.some(x => x.op === 'resume' && x.id === 'new:abc'), JSON.stringify(r.captureLog));
      t.ok('古い id にも待機中（idle）の便りを配る（古い id で配った引き継ぎのピルを片付けさせる）', r.events.some(e => e.sessionId === 'new:abc' && e.state === 'idle') && r.control.state('new:abc').state === 'idle', JSON.stringify(r.events));
      r.relay.forget('real');
      const open = new Set();
      for (const x of r.captureLog) { if (x.op === 'suspend') open.add(x.id); else open.delete(x.id); }
      t.ok('会話を消したら、断ったままの会話は残らない（suspend と resume が対になる）', open.size === 0 && r.captureLog.at(-1).op === 'resume', JSON.stringify(r.captureLog));
    } finally { await r.stop(); }
  }

  // ===== 9. 操作は順に流す（同時に引き継ぐ・戻すが窓を二重に動かさない） =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      const [x, y] = await Promise.all([r.control.takeOver('one'), r.control.takeOver('one')]);
      t.ok('同時に 2 回引き継いでも、窓を戻すのは 1 回', x.state === 'paused' && y.state === 'paused' && r.os.calls('reveal').length === 1);
      await Promise.all([r.control.resume('one'), r.control.resume('one')]);
      t.ok('同時に 2 回戻しても、行は 1 つ', r.records.length === 1 && r.control.state('one').state === 'running');
    } finally { await r.stop(); }
  }

  // ===== 10. 再接続した画面へ配る今の状態（snapshot）=====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      await r.agent('two');
      r.relay.endTurn('two');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.control.takeOver('one');
      t.ok('待機中でない会話だけ（paused と running）', r.control.snapshot().map(s => `${s.sessionId}:${s.state}`).sort().join() === 'one:paused', JSON.stringify(r.control.snapshot()));
    } finally { await r.stop(); }
  }

  // ===== 11. 一時停止の間、Chrome からの通知がエージェントへ流れず、エージェントの横取りが人のページを固めない =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      await a.cmd('Network.enable', {}, sid);
      await a.cmd('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sid);   // agent-browser が付ける横取り（エージェントは答えないので、残ると人の移動が止まる）
      const sent = a.raw.length;
      await r.control.takeOver('one');
      await sleep(100);   // 上りの「外す」が Chrome（偽物）へ届くのを待つ（人の操作は偽の Chrome へ直に入るので、実際の時間の順に合わせる）
      const move = r.fake.navigateUser(tabId, 'https://human.example/login');   // 人がログインのページへ移る
      const finished = await Promise.race([Promise.resolve(move).then(() => true), sleep(1500).then(() => false)]);
      t.ok('人の移動が固まらない（エージェントの Fetch の横取りは、セッションごと外れている）', finished && r.fake.pausedCount() === 0, `finished=${finished} paused=${r.fake.pausedCount()}`);
      t.ok('エージェントへは何も届かない（通知を捨てる。接続ごと切れている）', a.raw.length === sent && a.ws.readyState !== 1, `${a.raw.length - sent} frames`);
      const fresh = await agent(await r.relay.endpoint('one'));
      await r.fake.navigateUser(tabId, 'https://human.example/otp');
      await sleep(150);
      t.ok('つなぎ直した接続にも何も届かない（断りの返事だけ）', fresh.raw.length === 0);
      const refused = await fresh.cmd('Target.setDiscoverTargets', { discover: true });
      t.ok('つなぎ直した接続が通知を求めても断る（発見の登録も付かない）', refused.error?.message === PAUSED_MESSAGE && fresh.raw.length === 1);
      const attaches = () => r.chrome.calls.filter(c => c.method === 'Target.attachToTarget' && c.params.flatten === true).length;
      const before = attaches();
      r.fake.openUserTab('https://human.example/new', 'new', tabInfo(r, tabId).windowId);   // 人がエージェントの窓にタブを開いた
      await sleep(200);
      t.ok('一時停止中に人が開いたタブは、エージェントへ知らせない', fresh.raw.length === 1);
      void before;
      fresh.close();
    } finally { await r.stop(); }
  }

  // ===== 12. 一時停止の間の人の移動を、サイトの利用の確認にかけない =====
  {
    const asked = [];
    const r = await rig({ authorize: async request => { asked.push(request.url); return { allow: false, message: 'DENIED-BY-TEST' }; } });
    try {
      r.relay.setConfirm(true);
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const agentMove = await a.cmd('Page.navigate', { url: 'https://agent.example/' }, sid);
      t.ok('（比べ）エージェントの移動は確認にかかり、断られる', asked.length === 1 && agentMove.error?.message === 'DENIED-BY-TEST', JSON.stringify(agentMove.error));
      await r.control.takeOver('one');
      await r.fake.navigateUser(tabId, 'https://auth.example/login');
      await sleep(100);
      t.ok('一時停止中の人の移動（外部の認証サイトへ）は確認にかけない・白紙に戻さない', asked.length === 1 && tabInfo(r, tabId).url === 'https://auth.example/login', `${asked.join()} / ${tabInfo(r, tabId)?.url}`);
      r.fake.windowOpen(tabId, 'https://auth.example/popup');   // 人のページが開いたログインのポップアップ
      await sleep(250);
      const popup = r.fake.targets().find(x => x.url === 'https://auth.example/popup');
      t.ok('一時停止中に人のページが開いたタブ・ポップアップは確認にかけない・閉じない', asked.length === 1 && !!popup, `${asked.join()}`);
      await r.control.resume('one');
      const b = await r.agent('one');
      const sidAgain = (await b.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const after = await b.cmd('Page.navigate', { url: 'https://agent2.example/' }, sidAgain);
      t.ok('戻したあとのエージェントの移動は、また確認にかかる', asked.length === 2 && after.error?.message === 'DENIED-BY-TEST', `${asked.join()}`);
    } finally { await r.stop(); }
  }

  // ===== 13. 確認の待ちの後ろに並んだコマンドが、一時停止の後に届かない =====
  {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const asked = [];
    const r = await rig({ authorize: async request => { asked.push(request.url); if (request.url.includes('popup.example')) await wait; return { allow: true }; } });
    try {
      r.relay.setConfirm(true);
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      await a.cmd('Page.navigate', { url: 'https://open.example/' }, sid);
      r.fake.windowOpen(tabId, 'https://popup.example/popup');   // ポップアップの確認が答えを待つ（そのタブへのコマンドは待たされる）
      await until(() => asked.some(url => url.includes('popup.example')));
      const popup = r.fake.targets().find(x => x.openerId === tabId);
      const sidPopup = (await a.cmd('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).result.sessionId;
      void a.cmd('Runtime.evaluate', { expression: 'window.__queued = 1' }, sidPopup);   // 待たされる
      await sleep(100);
      const evals = () => r.chrome.calls.filter(c => c.method === 'Runtime.evaluate' && c.params.expression === 'window.__queued = 1').length;
      t.ok('（前提）確認の待ちの間、後ろに並んだコマンドは Chrome へ送られない', evals() === 0);
      await r.control.takeOver('one');
      release();
      await sleep(250);
      t.ok('待ちが解けても、一時停止の後にコマンドは Chrome へ届かない（送る直前にもう一度見る）', evals() === 0, `${evals()} calls`);
    } finally { await r.stop(); }
  }

  // ===== 14. 隠すのに失敗したら、一時停止を解かない（paused のまま、失敗を状態で返す） =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const hw = () => hwndOf(r, tabInfo(r, created.result.targetId).windowId);
      await r.control.takeOver('one');
      r.os.opts.concealFails = true;
      const failed = await r.control.resume('one');
      t.ok('隠せなかったら paused のまま、理由 conceal-failed を状態に載せる', failed.state === 'paused' && failed.error === 'conceal-failed' && r.control.state('one').error === 'conceal-failed', JSON.stringify(failed));
      t.ok('状態の便りで画面へ返す', r.events.at(-1).state === 'paused' && r.events.at(-1).error === 'conceal-failed');
      t.ok('窓は見えたまま・映像は断ったまま・会話の行は残さない', visibleOk(hw()) && r.control.captureBlocked('one') === true && r.records.length === 0 && r.captureLog.map(x => x.op).join() === 'suspend');
      const b = await r.agent('one');
      t.ok('エージェントのコマンドも断ったまま', (await b.cmd('Browser.getVersion')).error?.message === PAUSED_MESSAGE);
      const stop = await r.control.stop('one');
      t.ok('止めるも、隠せないうちは止めない（paused のまま）', stop.state === 'paused' && stop.error === 'conceal-failed');
      r.os.opts.concealFails = false;
      const ok = await r.control.resume('one');
      t.ok('もう一度「戻す」で隠せれば解ける。error も消える', ok.state === 'running' && ok.error === null && concealedOk(hw()) && r.records.length === 1 && r.captureLog.map(x => x.op).join() === 'suspend,resume', JSON.stringify(ok));
    } finally { await r.stop(); }
  }

  // ===== 15. リモートの端末から引き継ぐ: 窓を戻す画面は、その時の前面でなく Pleiad の窓のある画面。先に一時停止してから引く =====
  {
    const r = await rig();
    try {
      r.os.setForeground('someone-elses-app');   // リモートから押したので、PC の前面は別のアプリ
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      const lookupsBefore = r.os.calls('appWindow').length + r.os.calls('foreground').length;
      await r.control.takeOver('one');
      const reveal = r.os.calls('reveal').at(-1);
      t.ok('窓を戻す画面（near）は Pleiad の窓。その時の前面ではない', reveal?.near === 'pleiad-window', JSON.stringify(reveal));
      t.ok('窓は PC で前に出る（リモートからでも PC の前面を取る）', r.os.getForeground() !== 'someone-elses-app');
      t.ok('一時停止（接続を切る・撮影を断つ）が先で、窓の手がかりを引くのはそのあと', r.captureLog[0].op === 'suspend' && r.captureLog[0].lookups === lookupsBefore, JSON.stringify(r.captureLog[0]));
    } finally { await r.stop(); }
    const r2 = await rig();
    try {
      r2.os.opts.noAppWindow = true;
      r2.os.setForeground('someone-elses-app');
      const b = await r2.agent('one');
      await b.cmd('Target.createTarget', { url: 'about:blank' });
      await r2.control.takeOver('one');
      t.ok('Pleiad の窓が引けなければ、その時の前面で代える', r2.os.calls('reveal').at(-1)?.near === 'someone-elses-app');
    } finally { await r2.stop(); }
  }

  // ===== 16. 引き継ぐときに、エージェントのセッションが始めた走っているスクリプトを止める（実機: 始めたのと同じセッションからだけ効く） =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const one = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const two = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const sid1 = (await a.cmd('Target.attachToTarget', { targetId: one.result.targetId, flatten: true })).result.sessionId;
      const sid2 = (await a.cmd('Target.attachToTarget', { targetId: two.result.targetId, flatten: true })).result.sessionId;
      await r.control.takeOver('one');
      await until(() => r.chrome.calls.filter(c => c.method === 'Runtime.terminateExecution').length === 2);
      const calls = r.chrome.calls.filter(c => c.method === 'Runtime.terminateExecution');
      t.ok('エージェントの各セッションへ Runtime.terminateExecution を送る（始めたのと同じセッションからだけ効く）', JSON.stringify(calls.map(c => c.sessionId).sort()) === JSON.stringify([sid1, sid2].sort()), JSON.stringify(calls.map(c => c.sessionId)));
      const order = sid => ({ terminate: r.chrome.calls.findIndex(c => c.method === 'Runtime.terminateExecution' && c.sessionId === sid), detach: r.chrome.calls.findIndex(c => c.method === 'Target.detachFromTarget' && c.params.sessionId === sid) });
      t.ok('セッションを外す前に送る', [sid1, sid2].every(sid => order(sid).terminate >= 0 && order(sid).terminate < order(sid).detach), JSON.stringify([order(sid1), order(sid2)]));
    } finally { await r.stop(); }
  }

  // ===== 17. 引き継いでいる間に人がタブを引き離して作った窓も、戻すときに隠す。タブの無くなった窓の記録は捨てる =====
  {
    const r = await rig();
    try {
      r.os.setForeground('pleiad-window');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const oldWindow = tabInfo(r, tabId).windowId;
      await r.control.takeOver('one');
      const newWindow = r.fake.detachTab(tabId);   // 人がタブを引き離して新しい窓にした
      r.os.killWindow(hwndOf(r, oldWindow).id);
      const back = await r.control.resume('one');
      t.ok('戻す: 新しい窓も隠れる（人が作った窓を見えたまま残さない）', back.state === 'running' && concealedOk(hwndOf(r, newWindow)), JSON.stringify(hwndOf(r, newWindow)));
      t.ok('元の窓（もう無い）の記録は捨て、新しい窓が会話の窓になる', JSON.stringify(r.scope.windows('one').map(w => w.windowId)) === JSON.stringify([newWindow]), JSON.stringify(r.scope.windows('one')));
    } finally { await r.stop(); }
  }
}
