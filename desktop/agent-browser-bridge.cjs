const { createBrowserRelay } = require('./browser-relay.cjs');
const { createBrowserNavigation } = require('./browser-navigation.cjs');

function attachAgentBrowserBridge(worker, panel) {
  const idleTimers = new Map();
  const pending = new Map();
  let enabled = false, serial = 0;
  const navigation = createBrowserNavigation({ enabled: () => enabled, authorize: async ({ sessionId, url, webContents, signal }) => {
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
  worker.on('message', async message => {
    if (message?.type === 'agent-browser-turn-ended') { navigation.cancel(message.sessionId); return; }
    if (message?.type === 'browser-load-policy') { panel.setLoadPolicy?.({ confirm: message.confirm === true, origins: message.origins }); return; }
    if (message?.type === 'agent-browser-prefs') { enabled = message.enabled === true; return; }
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
  return {
    stop(sessionId) { relay.disconnect(sessionId, true); },
    takeOver(sessionId) { relay.disconnect(sessionId); },
    close() { for (const timer of idleTimers.values()) clearTimeout(timer); relay.close(); for (const resolve of pending.values()) resolve({ allow: false }); pending.clear(); },
  };
}
module.exports = { attachAgentBrowserBridge };
