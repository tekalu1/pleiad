import { WebSocket } from 'ws';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { startHolder } from '../lib/holder-harness.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
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
  const newServer = async (chrome, os, { timing } = {}) => {
    const { client } = await holder.connect();
    const link = await openChromeLink({ holder: client, runtimeRoot: holder.root, runtimeKey: 'persist' });
    const locate = { browser: 'chrome', userDataDir: chrome.userDataDir };
    const conn = createChromeConnection({ locate, os, link, pollMs: 20 });
    const logs = [];
    const relay = createChromeRelay({ connection: conn, os, locate, scope: createChromeWindows({ os, locate, log: line => logs.push(line), ...(timing ? { timing } : {}) }),
      authorize: async () => ({ allow: true }), deniedMessage: () => 'DENIED', log: line => logs.push(line) });
    await relay.restore(link.welcome.carry, { staleSessions: link.welcome.sessions });
    const adopted = await conn.adopt();
    relay.onCarry(carry => link.setCarry(carry));
    if (os.capabilities().supported) await relay.readopt();
    return { link, conn, relay, logs, adopted };
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
  } finally {
    for (const fn of cleanups) { try { await fn(); } catch { /* 後片付け */ } }
    await clearChildren().catch(() => {});
    await holder.stop?.();
  }
}
