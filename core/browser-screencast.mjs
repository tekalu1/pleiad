// リモートの画面から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートでの表示」）。
// desktop 版だけが持つ機能。デスクトップの main プロセスで CDP を使い、画面の画像と入力を中継する。
// worker（core/server.mjs）と main（desktop/browser-screencast-bridge.cjs）の間を parentPort でつなぐ。

let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }
let frameListener = null; // (sessionId, frame) => void

export function parentPortScreencast(port, { timeoutMs = 10_000 } = {}) {
  port.on('message', event => {
    const data = event?.data ?? event;
    // Response to a command
    if (data?.type === 'browser-screencast' && pending.has(data.id)) {
      const { resolve, reject, timer } = pending.get(data.id);
      pending.delete(data.id); clearTimeout(timer);
      if (data.ok) resolve(data.result); else reject(new Error(data.error ?? 'screencast failed'));
      return;
    }
    // Screencast frame from desktop
    if (data?.type === 'browser-screencast-frame') {
      frameListener?.(data.sessionId, data.frame);
      return;
    }
    // Tab info update
    if (data?.type === 'browser-screencast-info') {
      frameListener?.(data.sessionId, { info: data.info });
      return;
    }
  });

  function send(action, args) {
    return new Promise((resolve, reject) => {
      const id = `sc${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('screencast timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ type: 'browser-screencast', id, action, ...args });
    });
  }

  return {
    /** Start screencast for a session. Returns { tabId } */
    start: (sessionId, options) => send('start', { sessionId, ...options }),
    /** Stop screencast */
    stop: (sessionId) => send('stop', { sessionId }),
    /** Dispatch input to the browser */
    input: (sessionId, input) => send('input', { sessionId, input }),
    /** Navigate */
    navigate: (sessionId, action, args) => send('navigate', { sessionId, action, ...(args || {}) }),
    /** Get current info */
    info: (sessionId) => send('info', { sessionId }),
    /** Ack a frame */
    ack: (sessionId, frameSessionId) => { port.postMessage({ type: 'browser-screencast-ack', sessionId, frameSessionId }); },
    /** Get stats */
    stats: (sessionId) => send('stats', { sessionId }),
    /** Set the listener for frames: (sessionId, frame) => void */
    onFrame(listener) { frameListener = listener; },
    /** Whether screencast is available (desktop version only, detected by parentPort existence) */
    get available() { return !!port; },
  };
}

/**
 * Fallback for non-desktop (npm start without Electron).
 * All operations are no-ops or throw.
 */
export function nullScreencast() {
  return {
    start: () => { throw new Error('screencast not available'); },
    stop: () => {},
    input: () => { throw new Error('screencast not available'); },
    navigate: () => { throw new Error('screencast not available'); },
    info: () => null,
    ack: () => {},
    stats: () => null,
    onFrame() {},
    get available() { return false; },
  };
}
