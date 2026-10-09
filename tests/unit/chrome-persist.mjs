import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { startHolder } from '../lib/holder-harness.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay, PAUSED_MESSAGE } from '../../core/chrome/relay.mjs';
import { createChromeWindows, WINDOW_DIP } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';
import { openChromeLink } from '../../core/chrome/link.mjs';

export const name = 'chrome-persist';
export const title = '更新を越えるエージェントのブラウザー: 中継の端点（同じポート・同じ鍵）・隠した窓の持ち越し・引き継げなかった窓を CDP で閉じる・main が居ない間の待ち・更新で窓を閉じない（本物の保持役と接続の子・偽の Chrome と偽の OS の層。ADR 0167）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (cond, ms = 5000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) throw new Error(`timeout: ${what || cond.toString().slice(0, 80)}`);
    await sleep(10);
  }
};

/** エージェントの側（agent-browser の代わり） */
function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let next = 0;
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
    });
    ws.once('open', () => resolve({
      ws,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', code => done(code))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

export default async function (t) {
  const holder = await startHolder();
  const cleanups = [];
  const clearChildren = async () => {
    for (let i = 0; i < 30; i++) {
      const { client } = await holder.connect();
      const children = client.welcome?.children ?? [];
      if (!children.length) return;
      for (const child of children) {
        if (!child.alive) { client.release(child.id); continue; }
        await client.attach(child.id).catch(() => null);
        client.kill(child.id, { tree: true });
      }
      await sleep(150);
    }
    throw new Error('connection child did not go away');
  };
  /** server.mjs の起動と同じ順: 接続の子 → 中継の restore → 接続の adopt → 以後の変化を預ける → 層が使えれば readopt */
  const newServer = async (chrome, os, { timing, carryExtra, relayOptions } = {}) => {
    const { client } = await holder.connect();
    const link = await openChromeLink({ holder: client, runtimeRoot: holder.root, runtimeKey: 'persist' });
    const locate = { browser: 'chrome', userDataDir: chrome.userDataDir };
    const conn = createChromeConnection({ locate, os, link, pollMs: 20 });
    const logs = [];
    const relay = createChromeRelay({ connection: conn, os, locate, scope: createChromeWindows({ os, locate, log: line => logs.push(line), ...(timing ? { timing } : {}) }),
      authorize: async () => ({ allow: true }), deniedMessage: () => 'DENIED', log: line => logs.push(line), ...(carryExtra ? { carryExtra } : {}), ...(relayOptions ?? {}) });
    await relay.restore(link.welcome.carry, { staleSessions: link.welcome.sessions });
    const adopted = await conn.adopt();
    // 第 6 段の control（server.mjs と同じく、restore の後に作る。一時停止のまま引き継がれた会話の撮影を断つ）
    const captureLog = [];
    const control = createChromeControl({ relay, os, capture: { suspend: id => captureLog.push(`suspend:${id}`), resume: id => captureLog.push(`resume:${id}`), operate: (id, viewport) => captureLog.push(`operate:${id}:${viewport ? `${viewport.width}x${viewport.height}@${viewport.scale}` : 'off'}`) }, log: line => logs.push(line) });
    relay.onCarry(carry => link.setCarry(carry));
    await relay.rejoin();
    if (os.capabilities().supported) await relay.readopt();
    return { link, conn, relay, control, captureLog, logs, adopted };
  };
  /** サーバーの入れ替わりで出ていく側（server.mjs の stash と同じ順） */
  const leave = async s => {
    s.link.setCarry(s.relay.handOff());
    s.conn.handOff();
    await s.link.handOff();
  };
  const tabsIn = (chrome, windowId) => chrome.browser.targets().filter(x => x.type === 'page' && x.windowId === windowId);

  try {
    // ===== 1. 更新を越える: 同じポート・同じ鍵の端点・隠した窓は閉じない・窓は新しいサーバーの範囲に戻る =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-1');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const created = await ag.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      const carried = a.relay.snapshot();
      t.ok('窓を開くと隠した窓の印（token）が carry に載る', tabId && carried.windows.length === 1 && carried.windows[0].windows[0].windowId === windowId && /^fake:/.test(carried.windows[0].windows[0].token) && carried.port === a.relay.port, JSON.stringify(carried));
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      t.ok('更新で出ていくとき、エージェントの接続は 1012 で閉じる', await Promise.race([ag.closed, sleep(3000).then(() => 'timeout')]) === 1012);
      t.ok('更新で出ていくとき、隠した窓も窓のタブも閉じない', os.hwnds().some(h => h.agent && h.concealed && !h.closed) && tabsIn(chrome, windowId).length === 1 && os.calls('closeAgent').length === 0);

      const b = await newServer(chrome, os);
      t.ok('新しいサーバー: 接続の子から接続を引き継ぐ（確認なし）', b.adopted === true && b.conn.state().state === 'connected', JSON.stringify(b.conn.state()));
      t.ok('新しいサーバー: 端点は同じポート・同じ鍵（エージェントの接続先が更新を越えて同じ）', await b.relay.endpoint('conv-1') === url && b.relay.port === carried.port, `${await b.relay.endpoint('conv-1')} ${url}`);
      t.ok('新しいサーバー: 隠した窓の印を層が引き継ぎ、窓は閉じない', os.calls('adoptAgent').length >= 1 && os.hwnds().some(h => h.agent && h.concealed && !h.closed) && tabsIn(chrome, windowId).length === 1);
      const ag2 = await agent(url);
      await ag2.cmd('Target.setDiscoverTargets', { discover: true });
      await until(async () => (await ag2.cmd('Target.getTargets')).result.targetInfos.length === 1, 3000, 'restored tab in scope');
      const targets = (await ag2.cmd('Target.getTargets')).result.targetInfos;
      t.ok('つなぎ直したエージェントには、持ち越した窓のタブが見える（会話の範囲に戻っている）', targets.length === 1 && targets[0].targetId === tabId, JSON.stringify(targets));
      ag2.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 1a. 更新の後、エージェントがつながる前から、持ち越した窓のタブは会話の範囲に戻っている（Chrome は発見中の接続へ targetCreated を送り直さない）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-1a');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      // ターンの外（turnLive が false）: 上りがつながっていなければ、エージェントは「ターンの外では確認を出せない」と断られる
      const b = await newServer(chrome, os, { relayOptions: { turnLive: () => false } });
      await until(() => b.relay.view.tabs('conv-1a').length === 1, 3000, 'carried tab back in scope before any agent connects');
      t.ok('新しいサーバー: エージェントがつながる前に、持ち越した窓のタブが会話の範囲（映像の一覧）に戻っている', b.relay.view.sessions().includes('conv-1a') && b.relay.view.tabs('conv-1a')[0].targetId === tabId && b.relay.view.tabs('conv-1a')[0].windowId === windowId, JSON.stringify(b.relay.view.tabs('conv-1a')));
      const ag2 = await agent(url);
      const listed = await ag2.cmd('Target.getTargets');
      t.ok('ターンの外でつないだエージェントも、断られずに持ち越したタブが見える（Chrome とはつながっている）', listed.error === undefined && listed.result?.targetInfos.length === 1 && listed.result.targetInfos[0].targetId === tabId, JSON.stringify(listed));
      ag.close(); ag2.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 1b. 最大化のまま開いた最初の窓（chrome.exe の窓）: 大きさを決めて通常に戻っても隠した位置のまま。更新を越えて引き継げる =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      chrome.browser.launchMaximized(true);
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-1b'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const first = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === first)?.windowId;
      const hw = os.hwnds().find(h => h.windowId === windowId);
      t.ok('最大化で開いた最初の窓は、大きさを決めて通常に戻っても、隠した位置（画面の外）のまま', chrome.browser.windowBounds(windowId)?.windowState === 'normal' && hw?.concealed === true && hw.rect.left === 6000, JSON.stringify(hw));
      // 実物の Chrome は、最大化の窓への大きさの依頼では戻すだけで大きさを当てない。先に通常へ戻し、戻ってから大きさを送る
      const sets = chrome.calls.filter(c => c.method === 'Browser.setWindowBounds' && c.params.windowId === windowId).map(c => c.params.bounds);
      t.ok('最大化の窓は、先に通常へ戻して（windowState: normal だけ）から大きさを送る。大きさが WINDOW_DIP になる',
        sets.length === 2 && JSON.stringify(sets[0]) === JSON.stringify({ windowState: 'normal' }) && sets[1].width === WINDOW_DIP.width && sets[1].height === WINDOW_DIP.height && sets[1].windowState === undefined
          && chrome.browser.windowBounds(windowId)?.width === WINDOW_DIP.width && chrome.browser.windowBounds(windowId)?.height === WINDOW_DIP.height, JSON.stringify({ sets, bounds: chrome.browser.windowBounds(windowId) }));
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      const b = await newServer(chrome, os);
      t.ok('更新を越えた先でも、その最初の窓を引き継げる（引き継げない窓として閉じない）', !b.logs.some(line => line.includes('could not be taken over')) && tabsIn(chrome, windowId).length === 1
        && b.relay.snapshot().windows.length === 1 && os.hwnds().some(h => h.windowId === windowId && h.agent && h.concealed && !h.closed), JSON.stringify({ logs: b.logs, hwnds: os.hwnds() }));
      ag.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 1c. 最大化で開いた最初の窓が、隠し直した後に遅れて画面の中へ動いた（透明のまま）: 更新の先で引き継いで隠し直す（閉じない）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      chrome.browser.launchMaximized(true);
      const os = fakeChromeOs({ chrome });
      os.opts.restoreMoveMs = 150;   // 通常へ戻した後、窓が画面の中へ動くのが遅れる（隠し直した後に効く）
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-1c'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const first = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result?.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === first)?.windowId;
      const hwOf = () => os.hwnds().find(h => h.windowId === windowId);
      await until(() => hwOf()?.rect.left === 10, 3000, 'restored window moved onto a screen');
      t.ok('（前提）隠した窓が、遅れて画面の中へ動いた（スタイルは隠した姿・透明のまま）', hwOf().alpha === 0 && hwOf().ex.transparent && !hwOf().ex.appwindow, JSON.stringify(hwOf()));
      await until(() => a.link.alive && a.link.welcome, 2000);
      await leave(a);
      const b = await newServer(chrome, os);
      t.ok('画面の中で透明のままの窓も、更新の先で引き継ぐ（引き継げない窓として閉じない）', !b.logs.some(line => line.includes('could not be taken over')) && tabsIn(chrome, windowId).length === 1
        && b.relay.snapshot().windows.length === 1 && hwOf()?.agent && hwOf()?.concealed && !hwOf()?.closed, JSON.stringify({ logs: b.logs, hw: hwOf() }));
      t.ok('引き継いだ窓は、画面の外へ隠し直す', hwOf()?.rect.left === 6000 && os.calls('concealOnAdopt').length === 1, JSON.stringify(hwOf()));
      ag.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 2. 層が窓を引き継げなかったとき: 記録を捨て、その窓のタブを CDP で閉じる =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-2'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await leave(a);
      os.opts.adoptFails = true;
      const b = await newServer(chrome, os);
      await until(() => tabsIn(chrome, windowId).length === 0, 3000, 'tab of the lost window closed');
      t.ok('引き継げなかった窓: そのタブは CDP で閉じる（見えない窓を残さない）', tabsIn(chrome, windowId).length === 0 && b.relay.snapshot().windows.length === 0);
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 3. main が居ない間（層が pending）: 窓を開く依頼は待ち、戻ったら開く。戻らなければ「更新中」で失敗 =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os, { timing: { readyWaitMs: 5000 } });
      const ag = await agent(await a.relay.endpoint('conv-3'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      os.setPending(true);
      const pendingCreate = ag.cmd('Target.createTarget', { url: 'about:blank' });
      await sleep(150);
      const early = await Promise.race([pendingCreate.then(() => 'done'), sleep(100).then(() => 'waiting')]);
      os.setPending(false);
      const reply = await pendingCreate;
      t.ok('main が居ない間: 窓を開く依頼は待ち、層が戻ったら開く', early === 'waiting' && !!reply.result?.targetId, JSON.stringify(reply));
      ag.close();
      await a.relay.close(); await a.conn.close(); await a.link.quit();

      await clearChildren();
      const chrome2 = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome2.stop());
      const os2 = fakeChromeOs({ chrome: chrome2 });
      const c = await newServer(chrome2, os2, { timing: { readyWaitMs: 150 } });
      const ag2 = await agent(await c.relay.endpoint('conv-3b'));
      await ag2.cmd('Target.setDiscoverTargets', { discover: true });
      os2.setPending(true);
      const failed = await ag2.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('main が戻らないとき: 「更新中」で失敗し、窓は作らない', /updating/i.test(failed.error?.message ?? '') && chrome2.browser.targets().filter(x => x.type === 'page').length === 2, JSON.stringify(failed));
      ag2.close();
      await c.relay.close(); await c.conn.close(); await c.link.quit();
    }

    // ===== 4. main が居ない間に終わるときは、隠した窓のタブを CDP で閉じる =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-4'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      os.setPending(true);
      a.relay.close();
      await until(() => tabsIn(chrome, windowId).length === 0, 3000, 'tab closed by CDP');
      t.ok('層が居ないまま終わる: 隠した窓のタブを CDP で閉じる', tabsIn(chrome, windowId).length === 0);
      await a.conn.close(); await a.link.quit();
    }

    // ===== 4b. サーバーが居ない間に Chrome との接続が切れた: 子の預かり物は残り、次のサーバーが隠した窓を閉じる（誰にも戻せない窓を残さない）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-4b'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      await ag.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('前提: 隠した窓がある', os.hwnds().filter(h => h.agent && h.concealed && !h.closed).length === 1);
      await leave(a);
      chrome.dropConnections();   // 出ていった後、次のサーバーが来る前に、Chrome との接続が切れた
      await sleep(300);
      const b = await newServer(chrome, os);
      t.ok('新しいサーバー: 接続は切れたまま（拾えない）', b.adopted === false && b.conn.state().state !== 'connected', JSON.stringify(b.conn.state()));
      t.ok('新しいサーバー: 預かり物から端点を取り戻す（同じ会話の鍵）', b.relay.snapshot().entries.some(e => e.id === 'conv-4b'));
      t.ok('接続が無いまま層が戻ったら、引き継いだ隠した窓を閉じる（隠れたまま残らない）', os.hwnds().filter(h => h.agent && !h.closed).length === 0 && os.calls('closeAgent').length === 1, JSON.stringify(os.hwnds()));
      t.ok('閉じた窓は carry からも消える', b.relay.snapshot().windows.length === 0, JSON.stringify(b.relay.snapshot().windows));
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 5. 一時停止（引き継ぎ）のまま更新を越える: 一時停止は解けず、人が操作している窓へエージェントのコマンドが通らない（ADR 0154・0167）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-5');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await a.control.takeOver('conv-5');
      const pausedAt = a.relay.state('conv-5').paused?.at;
      const shown = () => os.hwnds().filter(h => h.agent && !h.concealed && !h.closed);
      t.ok('前提: 引き継ぐと窓は見える形になり、carry に一時停止の印（at）と見せている窓の印が載る',
        shown().length === 1 && Number.isFinite(pausedAt) && a.relay.snapshot().entries[0].paused?.at === pausedAt && a.relay.snapshot().windows[0].revealed === true, JSON.stringify(a.relay.snapshot()));
      // 出ていく前に carry の一時停止の印へ by を足す（第 7 段 C の by: 'device' が載っても持ち越す）
      const carry = a.relay.handOff();
      carry.entries[0].paused.by = 'device';
      a.link.setCarry(carry);
      a.conn.handOff();
      await a.link.handOff();
      const concealCalls = os.calls('conceal').length;
      const closeCalls = os.calls('closeAgent').length;

      const b = await newServer(chrome, os);
      const paused = b.relay.state('conv-5')?.paused;
      t.ok('新しいサーバー: 一時停止は解けない（始まりの時刻 at と by も同じ）', !!paused && paused.at === pausedAt && paused.by === 'device', JSON.stringify(paused));
      t.ok('新しいサーバー: control も一時停止と見る（状態・撮影を断つ・since）',
        b.control.state('conv-5').state === 'paused' && b.control.state('conv-5').since === pausedAt && b.control.captureBlocked('conv-5') && b.captureLog.includes('suspend:conv-5'), JSON.stringify([b.control.state('conv-5'), b.captureLog]));
      t.ok('新しいサーバー: 人が操作している窓は見える形のまま・隠さない・閉じない（層は revealed で引き継ぐ）',
        shown().length === 1 && os.calls('conceal').length === concealCalls && os.calls('closeAgent').length === closeCalls && tabsIn(chrome, windowId).length === 1
        && os.calls('adoptAgent').at(-1)?.revealed === true, JSON.stringify(os.calls('adoptAgent')));
      t.ok('新しいサーバー: 見せている窓の印も持ち越す（戻すまで popup も隠さない）', b.relay.scope.isRevealed('conv-5') === true);

      // エージェントがつなぎ直しても、コマンドは全部断られ、Chrome の窓へ届かない
      const pagesBefore = chrome.browser.targets().filter(x => x.type === 'page').length;
      const ag2 = await agent(url);
      const replies = [];
      replies.push(await ag2.cmd('Target.getTargets'));
      replies.push(await ag2.cmd('Target.setDiscoverTargets', { discover: true }));
      replies.push(await ag2.cmd('Target.createTarget', { url: 'about:blank' }));
      replies.push(await ag2.cmd('Target.attachToTarget', { targetId: tabId, flatten: true }));
      t.ok('更新の後、つなぎ直したエージェントのコマンドは全部 PAUSED で断られる（人の窓へ通らない）',
        replies.every(r => r.error?.message === PAUSED_MESSAGE) && tabsIn(chrome, windowId).length === 1 && chrome.browser.targets().filter(x => x.type === 'page').length === pagesBefore, JSON.stringify(replies));

      // 戻す: 窓は画面の外の見えない窓に戻り、一時停止が解け、エージェントのコマンドが通る
      await b.control.resume('conv-5');
      ag2.close();
      const ag3 = await agent(url);
      await ag3.cmd('Target.setDiscoverTargets', { discover: true });
      await until(async () => (await ag3.cmd('Target.getTargets')).result?.targetInfos?.length === 1, 3000, 'resumed tab in scope');
      t.ok('更新の後に「戻す」: 窓は隠れ、一時停止が解け、撮影も戻り、エージェントのコマンドが通る',
        b.control.state('conv-5').state !== 'paused' && shown().length === 0 && os.hwnds().some(h => h.agent && h.concealed && !h.closed) && b.captureLog.includes('resume:conv-5') && b.relay.scope.isRevealed('conv-5') === false);
      ag3.close();
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 7. 端末から引き継いでいる間に更新: by・映像の箱が載り、新しいサーバーでも端末の引き継ぎのまま。openForConversation は新しい待ち受けでも動く =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const url = await a.relay.endpoint('conv-7');
      const ag = await agent(url);
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const took = await a.control.takeOver('conv-7', { by: 'device', width: 390, height: 700, scale: 2 });
      t.ok('前提: 端末から引き継ぐと by: device・窓は見せない', took.state === 'paused' && took.by === 'device' && os.hwnds().filter(h => h.agent && !h.concealed && !h.closed).length === 0, JSON.stringify(took));
      const entry = a.relay.snapshot().entries.find(e => e.id === 'conv-7');
      t.ok('carry の一時停止の印に by と映像の箱が載る', entry?.paused?.by === 'device' && entry.paused.viewport?.width === 390 && entry.paused.viewport.scale === 2 && !a.relay.snapshot().windows.some(w => w.revealed), JSON.stringify(entry));
      await leave(a);
      ag.close();

      const b = await newServer(chrome, os);
      const state = b.control.state('conv-7');
      t.ok('新しいサーバー: 端末の引き継ぎのまま（by: device・since 同じ）で、映像は断たず、箱を映像に伝え直す',
        state.state === 'paused' && state.by === 'device' && state.since === entry.paused.at && !b.control.captureBlocked('conv-7')
        && !b.captureLog.includes('suspend:conv-7') && b.captureLog.includes('operate:conv-7:390x700@2'), JSON.stringify([state, b.captureLog]));
      const ag2 = await agent(url);
      const refused = await ag2.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('新しいサーバー: 端末が操作している間もエージェントのコマンドは PAUSED で断られる', refused.error?.message === PAUSED_MESSAGE, JSON.stringify(refused));
      ag2.close();
      await b.control.resume('conv-7');
      t.ok('端末の引き継ぎを戻すと、箱を戻して一時停止が解ける', b.control.state('conv-7').state !== 'paused' && b.captureLog.includes('operate:conv-7:off'), JSON.stringify([b.control.state('conv-7'), b.captureLog]));

      // openForConversation: 同じポート・同じ鍵の新しい待ち受けで、新しい会話の窓を開く
      const port = b.relay.snapshot().port;
      const opened = await b.relay.openForConversation('conv-8', 'http://127.0.0.1:1/');
      t.ok('新しい待ち受けでも openForConversation が窓を開く（同じポート）', typeof opened.targetId === 'string' && b.relay.snapshot().port === port && chrome.browser.targets().some(x => x.targetId === opened.targetId), JSON.stringify(opened));
      await leave(b);
      const c = await newServer(chrome, os);
      t.ok('開いた会話も次の更新で引き継がれる（窓の印・同じポート）', c.relay.snapshot().port === port && c.relay.snapshot().windows.some(w => w.id === 'conv-8'), JSON.stringify(c.relay.snapshot()));
      await c.relay.close(); await c.conn.close(); await c.link.quit();
    }

    // ===== 6. 見せている窓を層が引き継げなかったとき: 人の窓のタブは CDP で閉じない（記録だけ捨てる）=====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const a = await newServer(chrome, os);
      const ag = await agent(await a.relay.endpoint('conv-6'));
      await ag.cmd('Target.setDiscoverTargets', { discover: true });
      const tabId = (await ag.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      const windowId = chrome.browser.targets().find(x => x.targetId === tabId)?.windowId;
      await a.control.takeOver('conv-6');
      await leave(a);
      os.opts.adoptFails = true;
      const b = await newServer(chrome, os);
      await sleep(300);
      t.ok('見せている窓を引き継げなくても、人が操作中の窓のタブは閉じない。一時停止も解けない', tabsIn(chrome, windowId).length === 1 && !!b.relay.state('conv-6')?.paused, JSON.stringify(b.relay.state('conv-6')));
      await b.relay.close(); await b.conn.close(); await b.link.quit();
    }

    // ===== 8. 中継の外の預かり物（仮の id のプロフィール選択・ログイン待ちの鍵の材料）も、中継の持ち越しに載って戻る =====
    {
      await clearChildren();
      const chrome = await startFakeChrome({ permission: 'auto' });
      cleanups.push(() => chrome.stop());
      const os = fakeChromeOs({ chrome });
      const extra = { profiles: [{ id: 'turn-1', browser: 'chrome', dir: 'Profile 1' }], logins: [{ sessionId: 'child-1', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example' }] };
      const restored = [];
      const a = await newServer(chrome, os, { carryExtra: { snapshot: () => extra, restore: value => restored.push(value) } });
      a.relay.touch();
      await leave(a);
      const b = await newServer(chrome, os, { carryExtra: { snapshot: () => extra, restore: value => restored.push(value) } });
      t.ok('預かり物は、更新の後の新しいサーバーの restore に同じ形で戻る', restored.length === 1 && JSON.stringify(restored[0]) === JSON.stringify(extra), JSON.stringify(restored));
      // 大きすぎる預かり物は載せず、restore が投げても中継の復元（窓の印・端点）は続く
      const big = { profiles: [{ id: 'x'.repeat(300000), browser: 'chrome', dir: 'Default' }], logins: [] };
      const c = await newServer(chrome, os, { carryExtra: { snapshot: () => big, restore: () => {} } });
      const ag = await agent(await c.relay.endpoint('conv-9'));
      await ag.cmd('Target.createTarget', { url: 'about:blank' });
      c.relay.touch();
      await leave(c);
      const seen = [];
      const d = await newServer(chrome, os, { carryExtra: { snapshot: () => ({}), restore: value => { seen.push(value); } } });
      t.ok('大きすぎる預かり物は載せない（窓の印は残る）', seen.length === 0 && !!d.relay.state('conv-9'), JSON.stringify([seen.length, d.relay.state('conv-9')]));
      d.relay.touch();
      await leave(d);
      const e = await newServer(chrome, os, { carryExtra: { snapshot: () => ({ profiles: [{ id: 'turn-2', browser: 'chrome', dir: 'Default' }] }), restore: () => { throw new Error('boom'); } } });
      e.relay.touch();
      await leave(e);
      const f = await newServer(chrome, os, { carryExtra: { snapshot: () => ({}), restore: () => { throw new Error('boom'); } } });
      t.ok('restore が投げても、中継の復元は続き、ログに残す', !!f.relay.state('conv-9') && f.logs.some(line => /extra carry failed.*boom/.test(line)), JSON.stringify([f.relay.state('conv-9'), f.logs]));
      await f.relay.close(); await f.conn.close(); await f.link.quit();
      await b.relay.close(); await b.conn.close();
    }
  } finally {
    for (const fn of cleanups) { try { await fn(); } catch { /* 後片付け */ } }
    await clearChildren().catch(() => {});
    await holder.stop?.();
  }
}
