const { createBrowserRelay } = require('./browser-relay.cjs');
const { createBrowserNavigation } = require('./browser-navigation.cjs');

// worker（core/agent-browser.mjs の parentPortBrowser）との口。プロフィール（ADR 0077）の分:
//   worker -> main: agent-browser-prefs { enabled, profiles: [id], defaultProfile }・agent-browser-profile { sessionId, profile, agent }（エージェントが切り替えた）・
//                   agent-browser-endpoint { …, profile }・browser-profile-resolve の応答 { id, profile }
//   main -> worker: browser-profile-resolve { id, sessionId }（まだ覚えていない会話の今のプロフィールを引く）
function attachAgentBrowserBridge(worker, panel, { timeoutMs = 5000 } = {}) {
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
  worker.on('message', async message => {
    if (message?.type === 'agent-browser-turn-ended') { navigation.cancel(message.sessionId); return; }
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
  worker.postMessage({ type: 'agent-browser-prefs-request' });
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
