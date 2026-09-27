const { createBrowserRelay } = require('./browser-relay.cjs');

function attachAgentBrowserBridge(worker, panel) {
  const idleTimers = new Map();
  const relay = createBrowserRelay(panel, { onActivity(sessionId, tabId) {
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
    panel.setAgent(sessionId, tabId);
    if (tabId) idleTimers.set(sessionId, setTimeout(() => { idleTimers.delete(sessionId); panel.setAgent(sessionId, null); }, 3500));
  } });
  worker.on('message', async message => {
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
  return {
    stop(sessionId) { relay.disconnect(sessionId, true); },
    takeOver(sessionId) { relay.disconnect(sessionId); },
    close() { for (const timer of idleTimers.values()) clearTimeout(timer); relay.close(); },
  };
}
module.exports = { attachAgentBrowserBridge };
