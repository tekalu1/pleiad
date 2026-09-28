// リモートの画面から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」、ADR 0041）。
// 会話の内蔵ブラウザーのタブに webContents.debugger で Page.startScreencast を回し、フレームを worker へ渡す。
// debugger はエージェントの CDP 中継（desktop/browser-relay.cjs）と同じものを共有する（どちらも付いていれば付け直さない）。
//   - フレームは変化があったときだけ Chromium が出す。次のフレームは ack の後なので、間引きは ack を遅らせて行う（worker が決める）
//   - 見ている間はビューポートを端末の表示の大きさにする（Emulation.setDeviceMetricsOverride）。端末で読める幅になり、
//     タブが窓に載っていない・窓が最小化されていても描かれる（窓に載せる必要はある。panel.pin が窓の外に 1px で載せる）
//   - 入力は Input.dispatch*。エージェントが操作中は断る（端末の「引き継ぐ」で接続を切ってから）
const { navigable } = require('./browser-panel.cjs');

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};
const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 端末の表示の大きさと画質を、送ってよい範囲に丸める */
function screencastSettings({ width, height, scale, quality } = {}) {
  const w = Math.round(clamp(width, 240, 1600, 390));
  const h = Math.round(clamp(height, 240, 2400, 700));
  const s = clamp(scale, 1, 2, 1);
  return { width: w, height: h, scale: s, quality: Math.round(clamp(quality, 20, 80, 50)), maxWidth: Math.round(w * s), maxHeight: Math.round(h * s) };
}

/** 端末からの入力を CDP のコマンドの列にする。座標はページの CSS px（端末が表示の倍率から変換済み）。知らない入力は空 */
function inputCommands(input, { width = 1600, height = 2400 } = {}) {
  if (!input || typeof input !== 'object') return [];
  const x = clamp(input.x, 0, width, 0), y = clamp(input.y, 0, height, 0);
  switch (input.type) {
    case 'tap': return [
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }],
    ];
    case 'scroll': {
      const deltaX = clamp(input.dx, -4000, 4000, 0), deltaY = clamp(input.dy, -4000, 4000, 0);
      if (!deltaX && !deltaY) return [];
      return [['Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }]];
    }
    case 'text': {
      if (typeof input.text !== 'string' || !input.text || input.text.length > 2000) return [];
      return [['Input.insertText', { text: input.text }]];
    }
    case 'key': {
      const key = KEYS[input.key];
      if (!key) return [];
      const base = { key: input.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
      return [
        ['Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) }],
        ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
      ];
    }
    default: return [];
  }
}

/**
 * @param panel desktop/browser-panel.cjs の戻り値（tabsFor・createFor・contentsOf・agentFor・pin・human・onTabsChanged・onAgentChanged）
 * @param post  worker へ送る（{ type: 'browser-screencast-frame' | 'browser-screencast-state' | 'browser-screencast-ended', sessionId, ... }）
 * @param agentControl エージェントの接続を止める・引き継ぐ（desktop/agent-browser-bridge.cjs の stop / takeOver）
 */
function createBrowserScreencast(panel, { post = () => {}, agentControl = () => {} } = {}) {
  const sessions = new Map();   // sessionId -> { tabId, contents, settings, cleanup[] }

  function state(sessionId) {
    const entry = sessions.get(sessionId);
    const c = entry?.contents;
    if (!c || c.isDestroyed()) return null;
    const url = c.getURL();
    return {
      // PC のファイル（可視化の写し）の在り処は端末へ出さない
      tabId: entry.tabId, url: url === 'about:blank' ? '' : /^file:/i.test(url) ? 'file:///' : url, title: c.getTitle(), loading: c.isLoading(),
      canGoBack: c.navigationHistory.canGoBack(), canGoForward: c.navigationHistory.canGoForward(),
      agent: !!panel.agentFor(sessionId),
    };
  }
  let stateTimer = new Map();
  function pushState(sessionId) {
    // 読み込みの途中は細かく届くので、まとめて送る
    if (stateTimer.has(sessionId)) return;
    stateTimer.set(sessionId, setTimeout(() => {
      stateTimer.delete(sessionId);
      const value = state(sessionId);
      if (value) post({ type: 'browser-screencast-state', sessionId, state: value });
    }, 50));
  }

  function pickTab(sessionId, url) {
    if (url) return panel.createFor(sessionId, url);
    const tabs = panel.tabsFor(sessionId);
    const agentTab = panel.agentFor(sessionId)?.tabId;
    return tabs.find(tab => tab.id === agentTab) ?? tabs[0] ?? panel.createFor(sessionId, 'about:blank');
  }

  async function begin(entry) {
    const { contents: c, settings } = entry;
    // 窓がほかの窓に覆われている・最小化されている間も描かせる（既定では隠れたページとして描かれない）
    c.setBackgroundThrottling?.(false);
    if (!c.debugger.isAttached()) c.debugger.attach('1.3');
    await c.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: settings.width, height: settings.height, deviceScaleFactor: settings.scale, mobile: false });
    await c.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: settings.quality, maxWidth: settings.maxWidth, maxHeight: settings.maxHeight, everyNthFrame: 1 });
  }

  function release(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    sessions.delete(sessionId);
    clearTimeout(stateTimer.get(sessionId)); stateTimer.delete(sessionId);
    for (const off of entry.cleanup) { try { off(); } catch {} }
    panel.pin(entry.tabId, false);
    return entry;
  }
  function end(sessionId, reason) {
    if (!release(sessionId)) return;
    post({ type: 'browser-screencast-ended', sessionId, reason });
  }

  async function start(sessionId, { url, fileUrl, ...options } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session');
    const target = fileUrl && /^file:/i.test(fileUrl) ? fileUrl : url;
    if (url && !fileUrl && (!navigable(url) || url === 'about:blank')) throw new Error('invalid-url');
    const settings = screencastSettings(options);
    const existing = sessions.get(sessionId);
    // 開く URL が無く、同じ会話を見ているなら、同じタブのまま大きさと画質だけを変える
    if (existing && !target) {
      existing.settings = settings;
      await existing.contents.debugger.sendCommand('Page.stopScreencast').catch(() => {});
      await begin(existing);
      pushState(sessionId);
      return { tabId: existing.tabId, state: state(sessionId) };
    }
    if (existing) await stop(sessionId);
    const tab = pickTab(sessionId, target);
    const c = tab.webContents;
    if (!c || c.isDestroyed()) throw new Error('tab destroyed');
    const entry = { tabId: tab.id, contents: c, settings, cleanup: [] };
    sessions.set(sessionId, entry);
    panel.pin(tab.id, true);
    const onMessage = (_event, method, params, childSession) => {
      if (method !== 'Page.screencastFrame' || childSession || sessions.get(sessionId) !== entry) return;
      const m = params.metadata ?? {};
      post({ type: 'browser-screencast-frame', sessionId, frame: {
        id: params.sessionId, data: params.data,
        metadata: { deviceWidth: m.deviceWidth, deviceHeight: m.deviceHeight, pageScaleFactor: m.pageScaleFactor, offsetTop: m.offsetTop, scrollOffsetX: m.scrollOffsetX, scrollOffsetY: m.scrollOffsetY },
      } });
    };
    // DevTools を開くと debugger が外れる。そこで終わりにする
    const onDetach = () => end(sessionId, 'detached');
    c.debugger.on('message', onMessage);
    c.debugger.on('detach', onDetach);
    const update = () => pushState(sessionId);
    const events = ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'];
    for (const name of events) c.on(name, update);
    // 別の文書へ移ると（描く側が替わると）画面の送信が止まることがある。移るたびにかけ直す
    const restart = () => {
      if (sessions.get(sessionId) !== entry || c.isDestroyed()) return;
      c.debugger.sendCommand('Page.stopScreencast').catch(() => {}).then(() => begin(entry)).catch(() => {});
    };
    c.on('did-navigate', restart);
    entry.cleanup.push(() => {
      c.debugger.off('message', onMessage); c.debugger.off('detach', onDetach);
      for (const name of events) c.off(name, update);
      c.off('did-navigate', restart);
      if (!c.isDestroyed()) c.setBackgroundThrottling?.(true);
      if (!c.isDestroyed() && c.debugger.isAttached()) {
        c.debugger.sendCommand('Page.stopScreencast').catch(() => {});
        c.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    });
    entry.cleanup.push(panel.onTabsChanged((change, changed) => { if (change === 'destroyed' && changed.id === tab.id) end(sessionId, 'closed'); }));
    entry.cleanup.push(panel.onAgentChanged(changedSession => { if (changedSession === sessionId) update(); }));
    try { await begin(entry); }
    catch (error) { release(sessionId); throw error; }
    return { tabId: tab.id, state: state(sessionId) };
  }

  async function stop(sessionId) { release(sessionId); }

  function ack(sessionId, frameId) {
    const c = sessions.get(sessionId)?.contents;
    if (!c || c.isDestroyed() || !Number.isInteger(frameId)) return;
    c.debugger.sendCommand('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {});
  }

  async function input(sessionId, value) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.contents.isDestroyed()) throw new Error('not-watching');
    if (panel.agentFor(sessionId)) throw new Error('agent-active');
    const commands = inputCommands(value, entry.settings);
    if (!commands.length) throw new Error('invalid-input');
    // 人がページへ入力したらエージェントの操作を解除する（docs/inapp-browser.md「サイトの利用の確認」）
    panel.human(entry.tabId);
    for (const [method, params] of commands) await entry.contents.debugger.sendCommand(method, params);
  }

  async function navigate(sessionId, action, url) {
    const entry = sessions.get(sessionId);
    const c = entry?.contents;
    if (!c || c.isDestroyed()) throw new Error('not-watching');
    if (panel.agentFor(sessionId)) throw new Error('agent-active');
    panel.human(entry.tabId);
    switch (action) {
      case 'back': if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); break;
      case 'forward': if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); break;
      case 'reload': c.reload(); break;
      case 'stop': c.stop(); break;
      case 'open':
        if (typeof url !== 'string' || !navigable(url) || url === 'about:blank') throw new Error('invalid-url');
        c.loadURL(new URL(url).href).catch(() => {});   // 失敗は Chromium のエラーページが出る
        break;
      default: throw new Error('unknown action');
    }
  }

  function agent(sessionId, action) {
    if (action !== 'stop' && action !== 'takeOver') throw new Error('unknown action');
    agentControl(action, sessionId);
    pushState(sessionId);
  }

  function close() { for (const id of [...sessions.keys()]) release(id); }

  return { start, stop, ack, input, navigate, agent, state, close, watching: () => [...sessions.keys()] };
}

module.exports = { createBrowserScreencast, inputCommands, screencastSettings, KEYS };
