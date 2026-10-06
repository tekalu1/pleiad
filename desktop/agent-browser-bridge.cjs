const { createBrowserRelay } = require('./browser-relay.cjs');
const { createBrowserNavigation } = require('./browser-navigation.cjs');

// worker（core/agent-browser.mjs の parentPortBrowser）との口のうち、無停止の更新（handover: AGENT_HOST_HANDOVER=on の名前付きパイプの経路。docs/zero-downtime-update/design.md §7.2）の分:
//   main -> worker: browser-state-report { tabs, relay? }（タブの写し。変わったときに 1 秒ほどまとめて。relay は後述の送り直しのときだけ）・
//                   browser-restore-request（付け直した main が起動で 1 回）・agent-browser-endpoint-moved { port }（同じポートが取れず別のポートで中継を立て直した）
//   worker -> main: browser-restore { tabs, relay: { port, entries: [{ sessionId, key }] } | null }（サーバーが持つ前の main の写し）
// 受けたら、タブを先に開き直してから、同じポート・鍵で中継を立て直す（中継はタブが無いと空のタブを作る）。
// 切り替え（desktop/switch.cjs）で新しいサーバー（S2）に替わったときは、S2 は写しも中継の URL も持たずに空から始まり、報告は中身が変わらないと送らない。
// そこで、つなぎ直したサーバーが送る ready（つながるたびに届く）で、写しと中継の URL（{ port, entries }）を 1 回送り直す。
// browser-restore-request で開き直さないのは、タブと中継は main のもので残っており（S2 の答えは空）、S2 に要るのは写しを持たせることだけだから。
function attachAgentBrowserBridge(worker, panel, { handover = false, reportMs = 1000, restoreWaitMs = 5000 } = {}) {
  const idleTimers = new Map();
  const pending = new Map();
  let enabled = false, serial = 0;
  const navigation = createBrowserNavigation({ enabled: () => enabled, authorize: async ({ sessionId, tabId, url, webContents, signal }) => {
    let account;
    // Only a known display cookie, never authentication tokens or guessed identities.
    if (new URL(url).hostname === 'github.com') {
      const cookies = await webContents.session.cookies.get({ url: 'https://github.com/' }).catch(() => []);
      if (cookies.some(cookie => cookie.name === 'logged_in' && cookie.value === 'yes')) account = cookies.find(cookie => cookie.name === 'dotcom_user')?.value;
    }
    if (signal.aborted) return { allow: false };
    return new Promise(resolve => {
      const id = `navigation-${++serial}`;
      const cancel = () => { pending.delete(id); worker.postMessage({ type: 'agent-browser-authorize-cancel', id }); resolve({ allow: false }); };
      pending.set(id, answer => { signal.removeEventListener('abort', cancel); resolve(answer); });
      signal.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ type: 'agent-browser-authorize', id, sessionId, url, account });
    });
  } });
  panel.setNavigationGuard(navigation);
  const relay = createBrowserRelay(panel, { navigation, onActivity(sessionId, tabId) {
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
    panel.setAgent(sessionId, tabId);
    if (tabId) idleTimers.set(sessionId, setTimeout(() => { idleTimers.delete(sessionId); panel.setAgent(sessionId, null); }, 3500));
  } });
  // 写しの報告（handover のときだけ）。付け直しの答え（browser-restore）が届くまでは報告しない（空の状態でサーバーの写しを上書きしない）
  let reportsOn = false, restored = false, lastReport = '', reportTimer = null, restoreTimer = null;
  const report = () => {
    reportTimer = null;
    if (!handover || !reportsOn) return;
    let state;
    try { state = panel.exportState?.(); } catch { return; }
    const key = state && JSON.stringify(state);
    if (!key || key === lastReport) return;
    lastReport = key;
    worker.postMessage({ type: 'browser-state-report', ...state });
  };
  // つなぎ直したサーバーへ、写しと中継の URL を送り直す（上の注記）。復元が済む前の ready は、復元の流れが報告を始めるので何もしない
  const resend = () => {
    if (!handover || !reportsOn) return;
    clearTimeout(reportTimer); reportTimer = null;
    let state;
    try { state = panel.exportState?.(); } catch { return; }
    if (!state) return;
    lastReport = JSON.stringify(state);
    const relayState = relay.snapshot?.();
    worker.postMessage({ type: 'browser-state-report', ...state, ...(relayState ? { relay: relayState } : {}) });
  };
  const scheduleReport = () => { if (handover && reportsOn && !reportTimer) reportTimer = setTimeout(report, reportMs); };
  const offState = handover ? panel.onStateChanged?.(scheduleReport) : null;
  async function restore(message) {
    if (!restored) {
      restored = true;
      try { panel.restoreState?.({ tabs: message.tabs }); } catch { /* 開き直せない分は戻さない */ }
    }
    reportsOn = true;
    if (message.relay) {
      try {
        const result = await relay.restore(message.relay);
        if (result.moved) worker.postMessage({ type: 'agent-browser-endpoint-moved', port: result.port });
      } catch { /* 立てられなければ、次の endpoint の依頼で普通に立つ */ }
    }
    scheduleReport();
  }
  worker.on('message', async message => {
    if (message?.type === 'browser-restore') { await restore(message); return; }
    if (message?.type === 'ready') { resend(); return; }
    if (message?.type === 'agent-browser-turn-ended') { navigation.cancel(message.sessionId); return; }
    if (message?.type === 'browser-load-policy') { panel.setLoadPolicy?.({ confirm: message.confirm === true, origins: message.origins }); return; }
    if (message?.type === 'agent-browser-prefs') {
      enabled = message.enabled === true;
      return;
    }
    if (message?.type === 'agent-browser-authorize') { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message); return; }
    if (message?.type === 'agent-browser-rebind') { relay.rebind(message.from, message.to); return; }
    if (message?.type !== 'agent-browser-endpoint') return;
    try {
      if (message.unlock) relay.resume(message.sessionId); // A new human send unlocks a previous Stop.
      const url = await relay.endpoint(message.sessionId);
      worker.postMessage({ type: 'agent-browser-endpoint', id: message.id, ok: true, url });
    } catch (error) {
      worker.postMessage({ type: 'agent-browser-endpoint', id: message.id, ok: false, error: error.message });
    }
  });
  worker.postMessage({ type: 'browser-load-policy-request' });
  worker.postMessage({ type: 'agent-browser-prefs-request' });
  if (handover) {
    // 答えが無い（古いサーバー）ときも、待ちの後に報告は始める
    worker.postMessage({ type: 'browser-restore-request' });
    restoreTimer = setTimeout(() => { reportsOn = true; scheduleReport(); }, restoreWaitMs);
    restoreTimer.unref?.();
  }
  return {
    stop(sessionId) { relay.disconnect(sessionId, true); },
    takeOver(sessionId) { relay.disconnect(sessionId); },
    close() {
      // 終わる前に最後の写しを渡す（更新のための終了では、サーバーが次の main に渡す）
      clearTimeout(restoreTimer); clearTimeout(reportTimer);
      report();
      offState?.();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      relay.close();
      for (const resolve of pending.values()) resolve({ allow: false });
      pending.clear();
    },
  };
}
module.exports = { attachAgentBrowserBridge };
