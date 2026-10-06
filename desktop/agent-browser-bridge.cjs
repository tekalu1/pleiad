const { createBrowserRelay } = require('./browser-relay.cjs');
const { createBrowserNavigation } = require('./browser-navigation.cjs');

// worker（core/agent-browser.mjs の parentPortBrowser）との口。プロフィール（ADR 0078）の分:
//   worker -> main: agent-browser-prefs { enabled, profiles: [id], defaultProfile }・agent-browser-profile { sessionId, profile, agent }（エージェントが切り替えた）・
//                   agent-browser-endpoint { …, profile }・browser-profile-resolve の応答 { id, profile }
//   main -> worker: browser-profile-resolve { id, sessionId }（まだ覚えていない会話の今のプロフィールを引く）
// 無停止の更新（handover: AGENT_HOST_HANDOVER=on の名前付きパイプの経路。docs/zero-downtime-update/design.md §7.2）:
//   main -> worker: browser-state-report { tabs, profiles }（タブの写し。変わったときに 1 秒ほどまとめて）・browser-restore-request（付け直した main が起動で 1 回）・
//                   agent-browser-endpoint-moved { port }（同じポートが取れず別のポートで中継を立て直した）
//   worker -> main: browser-restore { tabs, profiles, relay: { port, entries: [{ sessionId, key }] } | null }（サーバーが持つ前の main の写し）
// 受けたら、タブを先に開き直してから、同じポート・鍵で中継を立て直す（中継はタブが無いと空のタブを作る）。
function attachAgentBrowserBridge(worker, panel, { timeoutMs = 5000, handover = false, reportMs = 1000, restoreWaitMs = 5000 } = {}) {
  const idleTimers = new Map();
  const pending = new Map();
  const resolving = new Map();
  let enabled = false, serial = 0;
  const navigation = createBrowserNavigation({ enabled: () => enabled, authorize: async ({ sessionId, tabId, url, webContents, signal }) => {
    let account;
    // Only a known display cookie, never authentication tokens or guessed identities.
    if (new URL(url).hostname === 'github.com') {
      const cookies = await webContents.session.cookies.get({ url: 'https://github.com/' }).catch(() => []);
      if (cookies.some(cookie => cookie.name === 'logged_in' && cookie.value === 'yes')) account = cookies.find(cookie => cookie.name === 'dotcom_user')?.value;
    }
    if (signal.aborted) return { allow: false };
    // どのプロフィールで使うか（確認のカードに添え、「このサイトは常に」をプロフィールごとに覚える）。ポップアップの窓は会話の今のプロフィール
    const profile = panel.profileOfTab?.(tabId) ?? panel.profileFor?.(sessionId) ?? null;
    return new Promise(resolve => {
      const id = `navigation-${++serial}`;
      const cancel = () => { pending.delete(id); worker.postMessage({ type: 'agent-browser-authorize-cancel', id }); resolve({ allow: false }); };
      pending.set(id, answer => { signal.removeEventListener('abort', cancel); resolve(answer); });
      signal.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ type: 'agent-browser-authorize', id, sessionId, url, account, ...(profile ? { profile } : {}) });
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
  const scheduleReport = () => { if (handover && reportsOn && !reportTimer) reportTimer = setTimeout(report, reportMs); };
  const offState = handover ? panel.onStateChanged?.(scheduleReport) : null;
  async function restore(message) {
    if (!restored) {
      restored = true;
      try { panel.restoreState?.({ tabs: message.tabs, profiles: message.profiles }); } catch { /* 開き直せない分は戻さない */ }
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
    if (message?.type === 'agent-browser-turn-ended') { navigation.cancel(message.sessionId); return; }
    if (message?.type === 'browser-load-policy') { panel.setLoadPolicy?.({ confirm: message.confirm === true, origins: message.origins }); return; }
    if (message?.type === 'agent-browser-prefs') {
      enabled = message.enabled === true;
      if (Array.isArray(message.profiles)) panel.setProfiles?.({ ids: message.profiles, defaultProfile: message.defaultProfile });
      return;
    }
    if (message?.type === 'agent-browser-authorize') { const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message); return; }
    if (message?.type === 'agent-browser-rebind') { relay.rebind(message.from, message.to); return; }
    // 会話の今のプロフィールが替わった。agent があればエージェントが切り替えた（画面へ知らせる）
    if (message?.type === 'agent-browser-profile') { panel.setProfileFor?.(message.sessionId, message.profile, { agent: message.agent ?? null }); return; }
    if (message?.type === 'browser-profile-resolve') { const done = resolving.get(message.id); resolving.delete(message.id); done?.(message.profile ?? null); return; }
    if (message?.type !== 'agent-browser-endpoint') return;
    try {
      if (message.unlock) relay.resume(message.sessionId); // A new human send unlocks a previous Stop.
      const url = await relay.endpoint(message.sessionId, { profile: message.profile });
      worker.postMessage({ type: 'agent-browser-endpoint', id: message.id, ok: true, url });
    } catch (error) {
      worker.postMessage({ type: 'agent-browser-endpoint', id: message.id, ok: false, error: error.message });
    }
  });
  worker.postMessage({ type: 'browser-load-policy-request' });
  worker.postMessage({ type: 'agent-browser-prefs-request' });
  if (handover) {
    // プロフィールの設定（prefs）が届いた後に開き直す。答えが無い（古いサーバー）ときも、報告は始める
    worker.postMessage({ type: 'browser-restore-request' });
    restoreTimer = setTimeout(() => { reportsOn = true; scheduleReport(); }, restoreWaitMs);
    restoreTimer.unref?.();
  }
  return {
    stop(sessionId) { relay.disconnect(sessionId, true); },
    takeOver(sessionId) { relay.disconnect(sessionId); },
    /** 会話の今のプロフィールをサーバーに引く。答えが無ければ null（呼び出し側が既定にする） */
    resolveProfile(sessionId) {
      return new Promise(resolve => {
        const id = `profile-${++serial}`;
        const timer = setTimeout(() => { resolving.delete(id); resolve(null); }, timeoutMs);
        resolving.set(id, profile => { clearTimeout(timer); resolve(profile); });
        worker.postMessage({ type: 'browser-profile-resolve', id, sessionId: sessionId ?? null });
      });
    },
    close() {
      // 終わる前に最後の写しを渡す（更新のための終了では、サーバーが次の main に渡す）
      clearTimeout(restoreTimer); clearTimeout(reportTimer);
      report();
      offState?.();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      relay.close();
      for (const resolve of pending.values()) resolve({ allow: false });
      pending.clear();
      for (const done of resolving.values()) done(null);
      resolving.clear();
    },
  };
}
module.exports = { attachAgentBrowserBridge };
