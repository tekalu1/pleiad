// Navigation confirmation belongs to agent control, never to ordinary human browsing.
const { t } = require('./i18n.cjs');
function originOf(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.origin : null; } catch { return null; } }
function createBrowserNavigation({ authorize, enabled = () => false }) {
  const states = new Map();
  const state = tab => {
    if (!states.has(tab.id)) states.set(tab.id, { tab, active: false, sending: 0, granted: new Set(), pending: new Set(), controller: new AbortController(), error: null });
    return states.get(tab.id);
  };
  const denial = () => new Error(t('browser.navigationDenied'));
  function human(tab, force = false) {
    const s = state(tab);
    if (s.sending && !force) return;
    s.active = false; s.controller.abort(); s.controller = new AbortController(); s.granted.clear(); s.error = null;
  }
  async function check(tab, url) {
    const s = state(tab), origin = originOf(url);
    if (!origin || !enabled() || origin === originOf(tab.webContents.getURL()) || s.granted.has(origin)) return;
    const signal = s.controller.signal;
    const answer = await authorize({ sessionId: tab.sessionId, url, webContents: tab.webContents, signal });
    if (!answer?.allow || signal.aborted || tab.webContents.isDestroyed()) throw new Error(answer?.message || denial().message);
    s.granted.add(origin);
  }
  function block(tab, url, resume) {
    const s = state(tab), origin = originOf(url);
    if (!s.active || !enabled() || !origin || origin === originOf(tab.webContents.getURL()) || s.granted.has(origin)) return false;
    const work = check(tab, url).then(async () => {
      if (s.controller.signal.aborted || !s.active) throw denial();
      await resume();
    }).catch(error => { s.error = error; }).finally(() => s.pending.delete(work));
    s.pending.add(work);
    return true;
  }
  async function settled(tab) {
    const s = state(tab);
    while (s.pending.size) await Promise.all([...s.pending]);
    if (s.error) { const error = s.error; s.error = null; throw error; }
  }
  function watch(tab) {
    const s = state(tab), c = tab.webContents;
    const guard = (event, legacyUrl, _inPage, legacyMain) => {
      const url = event.url || legacyUrl;
      const main = event.isMainFrame ?? legacyMain ?? true;
      const resume = () => {
        if (main) return c.loadURL(url);
        if (!event.frame) throw denial();
        return event.frame.executeJavaScript(`location.href=${JSON.stringify(url)}`);
      };
      if (block(tab, url, resume)) event.preventDefault();
    };
    c.on('will-frame-navigate', guard); c.on('will-redirect', guard);
    c.on('before-input-event', () => human(tab)); c.on('before-mouse-event', () => human(tab));
    c.on('did-navigate', (_event, url) => { const origin = originOf(url); s.granted = new Set([...s.granted].filter(value => value === origin)); });
    c.once('destroyed', () => { s.controller.abort(); states.delete(tab.id); });
  }
  return {
    watch, human,
    inherit(from, tab, url) { const source = state(from), next = state(tab); next.active = source.active; if (source.granted.has(originOf(url))) next.granted.add(originOf(url)); },
    popup(tab, url, resume) { return block(tab, url, resume); },
    async run(tab, method, params, send) {
      const s = state(tab);
      const operates = /^(Input\.|Runtime\.(evaluate|callFunctionOn)$|Page\.(navigate|reload|navigateToHistoryEntry)$)/.test(method);
      if (operates) s.active = true;
      if (method === 'Page.navigate') await check(tab, params.url);
      let result, error;
      s.sending++;
      try { result = await send(); } catch (e) { error = e; } finally { s.sending--; }
      // Events caused by a click/evaluation may be delivered after its CDP response.
      await new Promise(resolve => setImmediate(resolve));
      const resumed = s.pending.size > 0;
      await settled(tab);
      if (error && !resumed) throw error;
      if (resumed && result?.errorText) { const { errorText, ...rest } = result; return rest; }
      return result || {};
    },
    cancel(sessionId) {
      for (const s of states.values()) if (s.tab.sessionId === sessionId) {
        s.controller.abort(); s.controller = new AbortController(); s.active = false; s.granted.clear();
      }
    },
    rebind(from, to) { for (const s of states.values()) if (s.tab.sessionId === from) s.tab.sessionId = to; },
  };
}
module.exports = { createBrowserNavigation, originOf };
