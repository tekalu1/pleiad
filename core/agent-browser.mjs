import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function parentPortBrowser(port, { timeoutMs = 10_000 } = {}) {
  if (!port) return null;
  const pending = new Map();
  const configIds = new Map();
  let next = 0;
  port.on('message', event => {
    const message = event?.data ?? event;
    if (message?.type !== 'agent-browser-endpoint') return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.url);
    else item.reject(new Error(message.error || 'browser unavailable'));
  });
  return {
    endpoint(sessionId, { unlock = false } = {}) { return new Promise((resolve, reject) => {
      const id = `ab${++next}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('browser relay timeout')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ type: 'agent-browser-endpoint', id, sessionId, unlock });
    }); },
    rebind(from, to) {
      configIds.set(to, configIds.get(from) ?? from);
      port.postMessage({ type: 'agent-browser-rebind', from, to });
    },
    configSessionId(sessionId) { return configIds.get(sessionId) ?? sessionId; },
  };
}

export async function browserEnvironment({ bridge, dataDir, sessionId, unlock = false }) {
  if (!bridge || !sessionId) return null;
  const url = await bridge.endpoint(sessionId, { unlock });
  // Keep the shell config path and agent-browser namespace stable after a new thread gets its native ID.
  const configSessionId = bridge.configSessionId?.(sessionId) ?? sessionId;
  const dir = path.join(dataDir, 'agent-browser', crypto.createHash('sha256').update(configSessionId).digest('hex'));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'agent-browser.json');
  await fs.writeFile(file, JSON.stringify({ cdp: url }), { mode: 0o600 });
  return { AGENT_BROWSER_CONFIG: file, AGENT_BROWSER_SESSION: configSessionId };
}

export function browserInstruction(env, locale, translate) {
  return env ? translate(locale, 'browser.instructions') : null;
}
