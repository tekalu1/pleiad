// A browser-only CDP endpoint for one Pleiad conversation (ADR 0043).
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const DENIED = new Set(['Browser.close', 'Target.createBrowserContext', 'Target.disposeBrowserContext', 'Target.setRemoteLocations']);
const random = () => crypto.randomBytes(24).toString('hex');

function createBrowserRelay(panel, { onActivity = () => {}, navigation, WebSocketServerImpl = WebSocketServer } = {}) {
  const entries = new Map();
  const byKey = new Map();
  const wss = new WebSocketServerImpl({ noServer: true });
  const server = http.createServer((_req, response) => { response.writeHead(404); response.end(); });
  let address = null, listening = null;
  server.on('upgrade', (request, socket, head) => {
    const key = /^\/devtools\/browser\/([a-f0-9]{48})$/.exec(request.url || '')?.[1];
    const entry = byKey.get(key);
    if (!entry || entry.stopped || request.headers.host !== `127.0.0.1:${address?.port}` || request.socket.remoteAddress !== '127.0.0.1') {
      socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, ws => connect(entry, ws));
  });

  function tabs(entry) { return panel.tabsFor(entry.id); }
  async function target(tab) {
    const c = tab.webContents;
    if (c.isDestroyed()) return null;
    if (!c.debugger.isAttached()) c.debugger.attach('1.3');
    const tree = await c.debugger.sendCommand('Page.getFrameTree');
    return { tab, id: tree.frameTree.frame.id, type: 'page', title: c.getTitle(), url: c.getURL() || 'about:blank', attached: true, canAccessOpener: false, browserContextId: 'default' };
  }
  async function targets(entry) {
    const rows = await Promise.all(tabs(entry).map(tab => target(tab).catch(() => null)));
    return rows.filter(Boolean);
  }
  // エージェントが実際につないだときだけ、その会話にタブが無ければ作る。ターンの開始（endpoint）では作らない
  // （使わないターンや委譲した子の会話で空のタブが増えるため）。最初のコマンドより前に同期で作るので、getTargets は 1 枚を返す
  function ensureTab(entry) {
    if (!tabs(entry).length) panel.createFor(entry.id);
  }
  function connect(entry, ws) {
    entry.sockets.add(ws);
    ensureTab(entry);
    const attached = new Map(); // CDP session ID -> tab and debugger listener
    const known = new Map(); // tab ID -> frame ID
    let discovering = false, autoAttach = false;
    const send = value => { if (ws.readyState === 1) ws.send(JSON.stringify(value)); };
    async function attach(row, announce = true) {
      const existing = [...attached].find(([, record]) => record.tab.id === row.tab.id);
      if (existing) return existing[0];
      const sid = random();
      const c = row.tab.webContents;
      // debugger はリモートの端末の画面（desktop/browser-screencast.cjs）と共有する。そちらのフレームはエージェントへ流さない
      const record = { tab: row.tab, targetId: row.id, listener: null, screencast: false };
      const listener = (_event, method, params, innerSession) => {
        if (method === 'Page.screencastFrame' && !innerSession && !record.screencast) return;
        send({ method, params, sessionId: innerSession || sid });
      };
      record.listener = listener;
      c.debugger.on('message', listener);
      attached.set(sid, record);
      if (announce) send({ method: 'Target.attachedToTarget', params: { sessionId: sid, targetInfo: publicInfo(row), waitingForDebugger: false } });
      return sid;
    }
    function detach(sid) {
      const record = attached.get(sid);
      if (!record) return;
      // 窓が閉じて webContents が先に破棄されたタブ（終了・アップデート）は、debugger を読むだけで Electron が投げる
      const c = record.tab.webContents;
      if (!c.isDestroyed()) c.debugger.off('message', record.listener);
      attached.delete(sid);
      send({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: record.targetId } });
    }
    function forget(tabId) {
      for (const [sid, record] of attached) if (record.tab.id === tabId) detach(sid);
      const targetId = known.get(tabId);
      known.delete(tabId);
      if (discovering && targetId) send({ method: 'Target.targetDestroyed', params: { targetId } });
    }
    async function announce(tabId) {
      if (ws.readyState !== 1 || known.has(tabId) || !tabs(entry).some(row => row.id === tabId)) return;
      const row = await target(tabs(entry).find(row => row.id === tabId)).catch(() => null);
      if (!row || known.has(tabId)) return;
      known.set(tabId, row.id);
      if (discovering) send({ method: 'Target.targetCreated', params: { targetInfo: publicInfo(row) } });
      if (autoAttach) await attach(row);
    }
    const unsubscribe = panel.onTabsChanged?.((change, tab) => {
      if (tab.sessionId !== entry.id) return;
      if (change === 'destroyed') forget(tab.id);
      else if (change === 'created') queueMicrotask(() => { void announce(tab.id); });
    });
    // 会話の今のプロフィールが替わった（人のメニュー・エージェントの use_browser_profile。ADR 0078）。
    // 接続は保ったまま、前のプロフィールのタブはエージェントから外して（操作中のタブの接続も切る）、新しいプロフィールのタブ集合を見せる
    const unsubscribeProfile = panel.onProfileChanged?.(sessionId => {
      if (sessionId !== entry.id || ws.readyState !== 1) return;
      const now = new Set(tabs(entry).map(row => row.id));
      for (const tabId of new Set([...known.keys(), ...[...attached.values()].map(record => record.tab.id)])) if (!now.has(tabId)) forget(tabId);
      ensureTab(entry);
      for (const tabId of now) queueMicrotask(() => { void announce(tabId); });
    });
    const cleanup = () => {
      entry.sockets.delete(ws);
      unsubscribe?.();
      unsubscribeProfile?.();
      for (const sid of [...attached.keys()]) detach(sid);
    };
    ws.on('close', cleanup);
    ws.on('message', async raw => {
      if (entry.stopped) { ws.close(1008, 'stopped'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const { id, method, params = {}, sessionId: sid } = msg;
      if (!Number.isInteger(id) || typeof method !== 'string') return;
      try {
        if (DENIED.has(method)) throw new Error('browser command denied');
        let result = {};
        if (sid) {
          const record = attached.get(sid);
          if (!record || record.tab.webContents.isDestroyed() || !tabs(entry).some(t => t.id === record.tab.id)) throw new Error('session denied');
          if (method === 'Target.setAutoAttach') result = {};
          else {
            if (method.startsWith('Target.') || method.startsWith('Browser.')) throw new Error('browser command denied');
            if (method === 'Page.navigate' && !safeUrl(params.url)) throw new Error('navigation denied');
            if (method === 'Page.startScreencast') record.screencast = true;
            const sendCommand = () => record.tab.webContents.debugger.sendCommand(method, params);
            result = navigation ? await navigation.run({ ...record.tab, sessionId: entry.id }, method, params, sendCommand) : await sendCommand();
          }
          onActivity(entry.id, record.tab.id);
        } else {
          const rows = await targets(entry);
          for (const row of rows) known.set(row.tab.id, row.id);
          const find = () => {
            const row = rows.find(x => x.id === params.targetId);
            if (!row) throw new Error('target denied');
            return row;
          };
          switch (method) {
            case 'Browser.getVersion': result = { protocolVersion: '1.3', product: 'Chrome/144.0.0.0', revision: '@pleiad', userAgent: 'Chrome/144.0.0.0', jsVersion: '13.0.0.0' }; break;
            case 'Browser.setDownloadBehavior': result = {}; break;
            case 'Target.getBrowserContexts': result = { browserContextIds: [] }; break;
            case 'Target.getTargets': result = { targetInfos: rows.map(publicInfo) }; break;
            case 'Target.getTargetInfo': result = { targetInfo: publicInfo(params.targetId ? find() : rows[0]) }; break;
            case 'Target.setDiscoverTargets':
              discovering = !!params.discover;
              if (discovering) queueMicrotask(() => rows.forEach(row => send({ method: 'Target.targetCreated', params: { targetInfo: publicInfo(row) } })));
              break;
            case 'Target.setAutoAttach':
              autoAttach = !!params.autoAttach;
              if (autoAttach) queueMicrotask(() => rows.forEach(row => { void attach(row); }));
              break;
            case 'Target.attachToTarget': result = { sessionId: await attach(find()) }; break;
            case 'Target.createTarget': {
              if (!safeUrl(params.url || 'about:blank')) throw new Error('navigation denied');
              const tab = panel.createFor(entry.id);
              try {
                if (params.url && params.url !== 'about:blank') {
                  await target(tab);
                  const sendCommand = () => tab.webContents.debugger.sendCommand('Page.navigate', { url: params.url });
                  if (navigation) await navigation.run({ ...tab, sessionId: entry.id }, 'Page.navigate', { url: params.url }, sendCommand);
                  else await sendCommand();
                }
              } catch (error) { panel.closeFor(tab.id); throw error; }
              const row = await target(tab);
              result = { targetId: row.id };
              onActivity(entry.id, tab.id);
              break;
            }
            case 'Target.closeTarget': {
              const row = find();
              panel.closeFor(row.tab.id);
              result = { success: true };
              break;
            }
            case 'Target.activateTarget': panel.selectFor(find().tab.id); break;
            default: throw new Error('browser command denied');
          }
        }
        send({ id, result: result || {}, ...(sid ? { sessionId: sid } : {}) });
      } catch (error) { send({ id, error: { code: -32000, message: error.message }, ...(sid ? { sessionId: sid } : {}) }); }
    });
  }
  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(server.address()); });
    });
  }
  /** 待ち受けを始める（1 回だけ。同時に呼んでも 1 つ）。port が取れなければ別のポート */
  function ensureListening(port) {
    listening ??= listenOn(port).catch(error => { if (!port) throw error; return listenOn(0); }).then(value => { address = value; return value; }, error => { listening = null; throw error; });
    return listening;
  }
  // profile: サーバーが決めた会話の今のプロフィール（ターンの開始で渡る）。中継がタブを作る・絞る前に覚えさせる
  async function endpoint(sessionId, { profile } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
    if (profile) panel.setProfileFor?.(sessionId, profile);
    await ensureListening(0);
    let entry = entries.get(sessionId);
    if (!entry) { entry = { id: sessionId, key: random(), sockets: new Set(), stopped: false }; entries.set(sessionId, entry); byKey.set(entry.key, entry); }
    return `ws://127.0.0.1:${address.port}/devtools/browser/${entry.key}`;
  }
  /**
   * 付け直した main が、前の main の中継を同じポートと鍵で立て直す（無停止の更新。docs/zero-downtime-update/design.md §7.2）。
   * 呼ぶ前に、タブを開き直しておくこと（中継はタブが無い会話に空のタブを作るので、先に待ち受けると agent-browser の最初の getTargets が about:blank を見る）。
   * ポートが取れなければ別のポートで立てる。戻り値の moved が true なら、サーバーが持つ URL と設定ファイルの cdp を新しいポートへ直す。
   * 鍵は、24 バイトの 16 進の形で、まだ無い会話だけ足す（すでに endpoint で作った会話の鍵は替えない）
   */
  async function restore({ port = 0, entries: rows = [] } = {}) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.sessionId !== 'string' || !row.sessionId || row.sessionId.length > 200 || !/^[a-f0-9]{48}$/.test(String(row.key)) || entries.has(row.sessionId) || byKey.has(row.key)) continue;
      const entry = { id: row.sessionId, key: row.key, sockets: new Set(), stopped: false };
      entries.set(entry.id, entry); byKey.set(entry.key, entry);
    }
    const want = Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
    await ensureListening(want);
    return { port: address.port, moved: want !== 0 && address.port !== want };
  }
  /** 立っている中継の写し（{ port, entries: [{ sessionId, key }] }）。待ち受けが無い・会話が無ければ null。切り替えで替わったサーバーへ渡す（agent-browser-bridge.cjs） */
  function snapshot() {
    if (!address || !entries.size) return null;
    return { port: address.port, entries: [...entries.values()].map(entry => ({ sessionId: entry.id, key: entry.key })) };
  }
  function disconnect(sessionId, stop = false) {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entry.stopped = stop;
    navigation?.cancel(sessionId);
    for (const ws of entry.sockets) ws.close(1000, 'disconnected');
    onActivity(sessionId, null);
  }
  function resume(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || !entry.stopped) return;
    byKey.delete(entry.key);
    entry.key = random();
    byKey.set(entry.key, entry);
    entry.stopped = false;
  }
  function rebind(from, to) {
    const entry = entries.get(from);
    if (!entry || entries.has(to)) return;
    entries.delete(from); entry.id = to; entries.set(to, entry);
    navigation?.rebind(from, to);
    panel.rebindSession(from, to);
  }
  function close() { for (const id of entries.keys()) disconnect(id, true); wss.close(); server.close(); }
  return { endpoint, restore, snapshot, disconnect, resume, rebind, close };
}
function publicInfo(row) { if (!row) throw new Error('target denied'); const { tab, id, ...info } = row; return { targetId: id, ...info }; }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password || url.href === 'about:blank'; } catch { return false; } }
module.exports = { createBrowserRelay, safeUrl };
