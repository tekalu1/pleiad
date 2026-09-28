// main プロセス（Electron）で、worker（core/server.mjs）からの screencast 指示を受けて
// desktop/browser-screencast.cjs を動かす橋。desktop/agent-browser-bridge.cjs と同じ役割。
const { createBrowserScreencast } = require('./browser-screencast.cjs');

function attachBrowserScreencastBridge(worker, panel) {
  const screencast = createBrowserScreencast(panel);
  const sessionListeners = new Map();

  worker.on('message', async message => {
    if (message?.type === 'browser-screencast-ack') {
      screencast.ack(message.sessionId, message.frameSessionId);
      return;
    }
    if (message?.type !== 'browser-screencast') return;
    
    const { id, action, sessionId, ...args } = message;
    
    try {
      let result;
      switch (action) {
        case 'start':
          result = await screencast.start(sessionId, args);
          // Clean up any existing listener for this session
          if (sessionListeners.has(sessionId)) {
            sessionListeners.get(sessionId)();
            sessionListeners.delete(sessionId);
          }
          // Set up frame listener for this session
          const cleanup = screencast.addListener(sessionId, frame => {
            if (frame === null) {
              worker.postMessage({ type: 'browser-screencast-frame', sessionId, frame: null });
            } else if (frame.info) {
              worker.postMessage({ type: 'browser-screencast-info', sessionId, info: frame.info });
            } else {
              worker.postMessage({ type: 'browser-screencast-frame', sessionId, frame });
            }
          });
          sessionListeners.set(sessionId, cleanup);
          break;
        case 'stop':
          if (sessionListeners.has(sessionId)) {
            sessionListeners.get(sessionId)();
            sessionListeners.delete(sessionId);
          }
          await screencast.stop(sessionId);
          result = {};
          break;
        case 'input':
          await screencast.dispatchInput(sessionId, args.input);
          result = {};
          break;
        case 'navigate':
          await screencast.navigate(sessionId, args.action || args.navAction, args);
          result = {};
          break;
        case 'info':
          result = screencast.info(sessionId);
          break;
        case 'stats':
          result = screencast.stats(sessionId);
          break;
        default:
          throw new Error('unknown action');
      }
      worker.postMessage({ type: 'browser-screencast', id, ok: true, result: result ?? {} });
    } catch (error) {
      worker.postMessage({ type: 'browser-screencast', id, ok: false, error: error.message });
    }
  });

  return {
    close() {
      for (const cleanup of sessionListeners.values()) {
        cleanup();
      }
      sessionListeners.clear();
      screencast.close();
    }
  };
}

module.exports = { attachBrowserScreencastBridge };
