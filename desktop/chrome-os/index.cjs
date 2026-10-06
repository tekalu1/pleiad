'use strict';
// Chrome への接続の OS の層（docs/inapp-browser.md「OS ごとの層」、ADR 0153・0154）を選び、core の parentPort の依頼につなぐ。
// 実装があるのは Windows（win32.cjs）だけ。ほかの OS・koffi を読めないときは「使えない」を返す層（どの口も null / false）。
// core は main の `chrome-os-ready { supported, reason, features }` を見て、エージェントのブラウザーを出すか決める。
const { createWin32ChromeOs } = require('./win32.cjs');

const FEATURES_NONE = Object.freeze({ dialog: false, raise: false, launch: false, conceal: false, watch: false, bounds: false });
const ACTIONS = new Set(['snapshotWindows', 'findPermissionDialog', 'raise', 'yieldForeground', 'foreground', 'close',
  'locateBrowser', 'launchWindow', 'findWindowByNonce', 'findWindowByBounds', 'hiddenSpot', 'conceal', 'reveal', 'release', 'closeAgent']);

/**
 * @param {{ platform?: string, win32?: object|null, reason?: string, log?: (line: string) => void }} options
 *   win32 は desktop/computer/win32.cjs の表。platform が win32 でなく、または win32 が null なら unsupported
 */
function createChromeOs({ platform = process.platform, win32 = null, reason = 'native', log = () => {}, ...deps } = {}) {
  if (platform === 'win32' && win32) return createWin32ChromeOs({ win32, log, ...deps });
  const why = platform === 'win32' ? reason : 'platform';
  return {
    capabilities: () => ({ supported: false, reason: why, features: FEATURES_NONE }),
    snapshotWindows: () => null,
    findPermissionDialog: () => null,
    raise: () => ({ ok: false, method: 'unsupported' }),
    yieldForeground: () => false,
    foreground: () => null,
    close: () => false,
    locateBrowser: () => null,
    launchWindow: () => ({ ok: false, reason: 'unsupported' }),
    findWindowByNonce: () => null,
    findWindowByBounds: () => null,
    hiddenSpot: () => null,
    conceal: () => false,
    reveal: () => false,
    release: () => false,
    closeAgent: () => false,
    reconceal: () => 0,
    closeAllAgents: () => 0,
  };
}

/** core（utilityProcess）の `chrome-os` の依頼を受けて口を呼び、`chrome-os-result` を返す。起動時と chrome-os-ready-request に chrome-os-ready を送る */
function attachChromeOs(worker, { chromeOs, log = () => {} }) {
  const post = message => { try { worker.postMessage(message); } catch (error) { log(`postMessage failed: ${error.message}`); } };
  const ready = () => { const c = chromeOs.capabilities(); post({ type: 'chrome-os-ready', supported: c.supported === true, ...(c.reason ? { reason: c.reason } : {}), features: c.features ?? FEATURES_NONE }); };
  worker.on('message', message => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'chrome-os-ready-request') { ready(); return; }
    if (message.type !== 'chrome-os') return;
    const { id, action, args } = message;
    if (!ACTIONS.has(action)) { post({ type: 'chrome-os-result', id, ok: false, error: `unknown action: ${String(action).slice(0, 40)}` }); return; }
    try {
      const a = args ?? {};
      let result;
      switch (action) {
        case 'findPermissionDialog': result = chromeOs.findPermissionDialog({ since: a.since, port: a.port }); break;
        case 'raise': result = chromeOs.raise(a.ref); break;
        case 'yieldForeground': result = chromeOs.yieldForeground(a.ref, { to: a.to }); break;
        case 'close': result = chromeOs.close(a.ref); break;
        case 'locateBrowser': result = chromeOs.locateBrowser({ product: a.product }); break;
        case 'launchWindow': result = chromeOs.launchWindow(a); break;
        case 'findWindowByNonce': result = chromeOs.findWindowByNonce(a.nonce); break;
        case 'findWindowByBounds': result = chromeOs.findWindowByBounds({ bounds: a.bounds, port: a.port, since: a.since, tolerance: a.tolerance }); break;
        case 'conceal': result = chromeOs.conceal(a.ref); break;
        case 'reveal': result = chromeOs.reveal(a.ref, { near: a.near }); break;
        case 'release': result = chromeOs.release(a.ref); break;
        case 'closeAgent': result = chromeOs.closeAgent(a.ref); break;
        default: result = chromeOs[action](); break;
      }
      post({ type: 'chrome-os-result', id, ok: true, result });
    } catch (error) {
      log(`${action} failed: ${error.message}`);
      post({ type: 'chrome-os-result', id, ok: false, error: String(error.message ?? error) });
    }
  });
  ready();
}

module.exports = { createChromeOs, attachChromeOs };
