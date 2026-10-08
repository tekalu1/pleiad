import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeScreencast, chromeScreencastSettings } from '../../core/chrome/screencast.mjs';
import { createScreencastHub, screencastCommand } from '../../core/browser-screencast.mjs';

export const name = 'chrome-screencast';
export const title = 'Chrome の窓の映像: 今のタブへの付け外し・ack の間引き・見る人がいなくなったら止めて focus emulation を外す（ターンの分は残す）・タブが替わったら付け替える・撮影を断つ間は流さない・見るだけ（ADR 0148 第 5 段）';

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
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

async function rig() {
  const chrome = await startFakeChrome({ permission: 'auto' });
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const relay = createChromeRelay({ connection: conn, os: os_, locate: { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true } });
  return { chrome, conn, relay, fake: chrome.browser, async stop() { relay.close(); await conn.close(); await chrome.stop(); } };
}

export default async function (t) {
  // ---- 設定の丸め ----
  {
    const s = chromeScreencastSettings({ width: 480, height: 320, scale: 2, quality: 55 });
    t.ok('設定: 表示の大きさ × 倍率が最大のフレームの大きさ（上限 1920）', s.maxWidth === 960 && s.maxHeight === 640 && s.quality === 55, JSON.stringify(s));
    const big = chromeScreencastSettings({ width: 5000, height: 10, scale: 9, quality: 999 });
    t.ok('設定: 大きすぎる・小さすぎる値は範囲に丸める', big.maxWidth === 1920 && big.maxHeight === 200 && big.quality === 80, JSON.stringify(big));
  }

  const r = await rig();
  let a1 = null;
  try {
    const { relay, fake } = r;
    const url = await relay.endpoint('s1');   // ターンの始まり（focus emulation をターンの間は保つ）
    a1 = await agent(url);
    const first = (await a1.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
    const sid1 = (await a1.cmd('Target.attachToTarget', { targetId: first, flatten: true })).result.sessionId;
    await a1.cmd('Runtime.evaluate', { expression: '1' }, sid1);
    const windowOf = targetId => fake.targets().find(x => x.targetId === targetId)?.windowId;
    const sessionsOf = targetId => fake.sessions().filter(s => s.targetId === targetId);
    await until(() => fake.focusEmulated(first));

    t.ok('relay.view: 窓のある会話・今のタブ・タブの一覧（URL・題は載せない）', JSON.stringify(relay.view.sessions()) === '["s1"]' && relay.view.current('s1') === first
      && JSON.stringify(relay.view.tabs('s1')) === JSON.stringify([{ targetId: first, windowId: windowOf(first) }]) && relay.view.summary('s1').operating === true);
    t.ok('relay.view: 窓の無い会話は空', relay.view.summary('nobody').tabs === 0 && relay.view.current('nobody') === null && relay.view.tabs('nobody').length === 0);

    const bridge = createChromeScreencast({ host: relay.view });
    const hub = createScreencastHub({ bridge, source: 'chrome' });
    const messages = [];
    const client = { send: message => messages.push(message) };

    // ---- 窓の無い会話は見られない ----
    {
      const refused = await hub.watch(client, 'nobody', { width: 400, height: 300 }).then(() => null, error => error.message);
      t.ok('窓の無い会話を見始めると no-window で断る（セッションは付けない）', refused === 'no-window' && hub.sessions().length === 0, String(refused));
    }

    // ---- 見始める: 今のタブに自分のセッション + focus emulation + screencast ----
    const before = sessionsOf(first).length;
    const watched = await hub.watch(client, 's1', { width: 480, height: 320, scale: 2, quality: 'auto' });
    t.ok('見始めると、今のタブに中継自身のセッションを付けて screencast を始める（引数は表示の大きさ × 倍率・画質）',
      watched.tabId === first && fake.screencasting(first) && fake.screencastParams(first)?.maxWidth === 960 && fake.screencastParams(first)?.maxHeight === 640 && fake.screencastParams(first)?.quality === 55,
      JSON.stringify([watched, fake.screencastParams(first)]));
    const view = fake.sessions().find(s => s.targetId === first && s.screencast);
    t.ok('映像のセッションは、エージェントのセッションとも、focus emulation を持つ中継のセッションとも別（映像のセッションは focus emulation を触らない）',
      sessionsOf(first).length === before + 1 && !!view && view.id !== sid1 && !view.fe && sessionsOf(first).filter(s => s.fe).length === 1 && fake.focusEmulated(first));
    t.ok('state: 操作中の印・タブ数・撮影を断っていない。URL・題は載せない', JSON.stringify(watched.state) === JSON.stringify({ tabId: first, agent: true, suspended: false, tabs: 1 }), JSON.stringify(watched.state));

    // ---- フレームと ack の間引き ----
    const t0 = Date.now();
    const frameId = fake.screencastFrame(first);
    await until(() => messages.some(m => m.type === 'frame'));
    const frame = messages.find(m => m.type === 'frame');
    t.ok('フレームは source: chrome の screencast メッセージで端末へ（metadata に大きさ）', frame?.kind === 'screencast' && frame.source === 'chrome' && frame.sessionId === 's1' && frame.data === 'QUJD' && frame.metadata.deviceWidth === 1100, JSON.stringify(frame));
    await sleep(300);
    const acks = () => r.chrome.calls.filter(c => c.method === 'Page.screencastFrameAck' && c.params.sessionId === frameId);
    t.ok('端末が受け取る（ack）まで、Chrome へ ack しない', acks().length === 0);
    hub.received(client, 's1', frame.seq);
    await until(() => acks().length === 1);
    const ack = acks()[0];
    t.ok('受け取った後、前のフレームから最小の間隔（200 ms）が過ぎてから、映像のセッションで Chrome へ ack する', ack?.sessionId !== undefined && ack.sessionId === view.id && Date.now() - t0 >= 190, `${Date.now() - t0}ms`);
    // 端末が遅いとき: 受け取りを待つ（ackTimeout まで ack しない）
    const slow = fake.screencastFrame(first);
    await until(() => messages.filter(m => m.type === 'frame').length === 2);
    await sleep(400);
    t.ok('端末の ack が無ければ、間隔が過ぎても Chrome へ ack しない（遅い回線で頻度が下がる）', !r.chrome.calls.some(c => c.method === 'Page.screencastFrameAck' && c.params.sessionId === slow));
    hub.received(client, 's1', messages.filter(m => m.type === 'frame')[1].seq);
    await until(() => r.chrome.calls.some(c => c.method === 'Page.screencastFrameAck' && c.params.sessionId === slow));

    // ---- 今のタブが替わったら付け替える ----
    const second = (await a1.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
    t.ok('エージェントが新しいタブを開くと、映像はそのタブへ付け替わる（前のタブの screencast と映像のセッションは外れる）',
      await until(() => fake.screencasting(second) && !fake.screencasting(first)) && !sessionsOf(first).some(s => s.id === view.id), JSON.stringify(fake.sessions()));
    t.ok('付け替わった state に新しいタブ・タブ数が載る', messages.some(m => m.type === 'state' && m.state.tabId === second && m.state.tabs === 2));
    const sid2 = (await a1.cmd('Target.attachToTarget', { targetId: second, flatten: true })).result.sessionId;
    await a1.cmd('Runtime.evaluate', { expression: '1' }, sid1);
    t.ok('エージェントが前のタブにコマンドを送ると、映像はそこへ戻る（今のタブ = 最後にコマンドを送ったタブ）', await until(() => fake.screencasting(first) && !fake.screencasting(second)));
    const frameAfter = fake.screencastFrame(first);
    t.ok('付け替えた先でフレームが流れる', frameAfter !== null && await until(() => messages.filter(m => m.type === 'frame').length === 3));
    void sid2;

    // ---- 撮影を断つ（第 6 段の「あなたが操作中」）----
    {
      const frames = messages.filter(m => m.type === 'frame').length;
      await bridge.suspend('s1');
      t.ok('suspend: screencast を止めて映像のセッションを外す（フレームを撮らない）。ターンの間は focus emulation は残る（エージェントの操作は続く）',
        !fake.screencasting(first) && !fake.sessions().some(s => s.targetId === first && s.id === view.id) && fake.screencastFrame(first) === null && fake.focusEmulated(first));
      t.ok('suspend: 見ている端末へ state.suspended を送る', await until(() => messages.some(m => m.type === 'state' && m.state.suspended === true)));
      t.ok('suspend 中はフレームを流さない', messages.filter(m => m.type === 'frame').length === frames);
      await bridge.resume('s1');
      t.ok('resume: screencast を始め直し、state.suspended を戻す', await until(() => fake.screencasting(first)) && await until(() => messages.filter(m => m.type === 'state').at(-1)?.state.suspended === false));
      const other = windowOf(second);
      await bridge.suspend('s1', other);
      t.ok('窓を指して断つと、今のタブがその窓でなければ止めない', fake.screencasting(first));
      await bridge.suspend('s1', windowOf(first));
      t.ok('窓を指して断つと、今のタブがその窓なら止める', await until(() => !fake.screencasting(first)));
      await bridge.resume('s1', windowOf(first)); await bridge.resume('s1', other);
      t.ok('窓ごとの断りを戻すと始め直す', await until(() => fake.screencasting(first)) && !bridge.isSuspended('s1', windowOf(first)));
    }

    // ---- 操作中の印 ----
    {
      const states = messages.length;
      relay.endTurn('s1');
      t.ok('ターンが終わると、state の操作中（agent）が false になる', await until(() => messages.slice(states).some(m => m.type === 'state' && m.state.agent === false)));
      await sleep(100);
      t.ok('ターンが終わっても、映像を見ている間は focus emulation も screencast も残る（ターンの分を外しても映像の分は外れない）', fake.focusEmulated(first) && fake.screencasting(first));
      await bridge.suspend('s1');
      t.ok('ターンが無ければ、撮影を断つと focus emulation も外れる（隠れた窓のページは描かれない）', await until(() => !fake.focusEmulated(first) && !fake.screencasting(first)));
      await bridge.resume('s1');
      t.ok('撮影を戻すと、focus emulation と screencast を付け直す', await until(() => fake.focusEmulated(first) && fake.screencasting(first)));
    }

    // ---- focus emulation の理由: ターン + 映像 ----
    {
      // ターンが終わった: 映像だけが focus emulation を保つ
      t.ok('ターンの外では、映像を見ている間だけ focus emulation が付いている', await until(() => fake.focusEmulated(first)));
      await hub.unwatch(client, 's1');
      t.ok('見る人がいなくなると、screencast を止めて映像のセッションを外す（ターンも無いので focus emulation も外れる）',
        await until(() => !fake.screencasting(first) && !fake.focusEmulated(first)) && !fake.sessions().some(s => s.id === view.id), JSON.stringify(fake.sessions()));
      t.ok('見る人がいなくなった会話は、ハブも手放す', hub.sessions().length === 0 && bridge.watching().length === 0);
      // ターンの間に見て、やめる: ターンの分は残る
      await relay.endpoint('s1');
      await until(() => fake.focusEmulated(first));
      await hub.watch(client, 's1', { width: 400, height: 300 });
      await hub.unwatch(client, 's1');
      await sleep(100);
      t.ok('ターンの間に見てやめても、ターンの分の focus emulation は残る（理由を数える）', fake.focusEmulated(first) && !fake.screencasting(first));
      relay.endTurn('s1');
      t.ok('ターンが終わると、どちらの理由も無いので外れる', await until(() => !fake.focusEmulated(first)));
    }

    // ---- 見るだけ: 入力・移動・URL を断る。ホストの画面（local）でも見られる ----
    {
      const host = { hub, bridge };
      const run = (command, args, local = true) => screencastCommand({ command, args: { sessionId: 's1', source: 'chrome', ...args }, local, hub: null, bridge: null, chrome: host, client, snapshotFile: async () => null });
      t.ok('ホストの画面（local）からも Chrome の窓の映像を見始められる', (await run('browserScreencast', { width: 400, height: 300 }, true)).ok === true);
      t.ok('入力・移動・エージェントの操作は view-only で断る（見るだけ）', (await run('browserScreencastInput', { input: { type: 'tap', x: 1, y: 1 } })).code === 'view-only'
        && (await run('browserScreencastNav', { action: 'reload' })).code === 'view-only' && (await run('browserScreencastAgent', { action: 'stop' })).code === 'view-only');
      t.ok('url・可視化を開く指定も断る', (await run('browserScreencast', { url: 'https://example.com/' })).code === 'view-only' && (await run('browserScreencast', { visualization: { id: 'x' } })).code === 'view-only');
      const nobody = await screencastCommand({ command: 'browserScreencast', args: { sessionId: 'nobody', source: 'chrome' }, local: true, chrome: host, client });
      t.ok('窓の無い会話は code: no-window', nobody.ok === false && nobody.code === 'no-window', JSON.stringify(nobody));
      t.ok('Chrome の窓の映像が無いホスト（chrome が null）では unavailable', (await screencastCommand({ command: 'browserScreencast', args: { sessionId: 's1', source: 'chrome' }, local: true, chrome: null, client })).code === 'unavailable');
      t.ok('source なしは今までどおり、ホストの画面では内蔵ブラウザーの映像を断る（remote-only）', (await screencastCommand({ command: 'browserScreencast', args: { sessionId: 's1' }, local: true, hub: null, bridge: null, chrome: host, client })).code === 'remote-only');
      t.ok('停止も ack も source で選ぶ', (await run('browserScreencastStop', {})).ok === true && (await run('browserScreencastAck', { seq: 1 })).ok === true);
      await sleep(50);
    }

    // ---- 窓が閉じられた: ended ----
    {
      await hub.watch(client, 's1', { width: 400, height: 300 });
      const n = messages.length;
      fake.closeWindow(windowOf(first)); fake.closeWindow(windowOf(second));
      t.ok('窓のタブがすべて無くなると、ended(closed) を端末へ送ってハブも手放す', await until(() => messages.slice(n).some(m => m.type === 'ended' && m.reason === 'closed' && m.source === 'chrome')) && hub.sessions().length === 0);
    }

    // ---- Chrome が閉じた（接続が切れた）: ended ----
    {
      await relay.endpoint('s1');
      const third = (await a1.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await hub.watch(client, 's1', { width: 400, height: 300 });
      t.ok('窓を開き直せば、また見られる', fake.screencasting(third) || await until(() => fake.screencasting(third)));
      const n = messages.length;
      await r.chrome.turnOff();
      t.ok('Chrome との接続が切れると、ended(closed) を端末へ送る', await until(() => messages.slice(n).some(m => m.type === 'ended' && m.reason === 'closed')));
    }
    bridge.close();
  } finally {
    a1?.close();
    await r.stop();
  }
}
