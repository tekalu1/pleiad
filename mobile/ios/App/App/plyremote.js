// ホストの main frame 用の口。アプリがオリジン・受信関数名・端末情報を埋める（ADR 0174）。
(() => {
  const ORIGIN = __PLY_ORIGIN__;
  if (window.top !== window || window.opener || window.origin !== ORIGIN || window.plyRemote) return;
  const handlers = window.webkit && window.webkit.messageHandlers;
  const bridge = handlers && handlers.plyRemoteBridge;
  if (!bridge) return;
  const info = __PLY_INFO__;
  const listeners = new Set();
  let last = null;
  const receive = (text) => {
    let m; try { m = JSON.parse(text); } catch (_) { return; }
    if (m && m.type === 'status') { last = m.status; for (const fn of listeners) { try { fn(last); } catch (_) {} } }
  };
  Object.defineProperty(window, __PLY_RECEIVER__, { value: receive, writable: false, configurable: false, enumerable: false });
  const post = (type, extra) => bridge.postMessage(JSON.stringify(Object.assign({ type }, extra || {})));
  const api = Object.freeze({
    hostId: info.hostId, hostName: info.hostName, relay: info.relay, device: info.device, shell: 'mobile',
    status: () => Promise.resolve(last),
    onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    retry: () => { post('retry'); return Promise.resolve(); },
    backToHosts: () => post('back'),
    closeWindow: () => post('back'),
    setTheme: (dark, colors) => post('theme', { dark: dark === true, top: String((colors && colors.top) || ''), bottom: String((colors && colors.bottom) || '') }),
  });
  Object.defineProperty(window, 'plyRemote', { value: api, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(window, 'backToHosts', { value: api.backToHosts, writable: false, configurable: false, enumerable: false });
  post('hello');
})();
