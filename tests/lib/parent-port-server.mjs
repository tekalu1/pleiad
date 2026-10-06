// core/server.mjs を、Electron の utilityProcess の身代わり（process.parentPort）を置いて起こす入口。
// main への便り（agent-browser-*・chrome-os*）は FAKE_PARENT_PORT_LOG に 1 行ずつ JSON で残す。
// endpoint の依頼には、会話ごとに決まった偽の URL で答える。
// Chrome の OS の層（chrome-os）は偽の main として答える: FAKE_CHROME_OS=unsupported なら使えない OS、それ以外は使える層
// （確認の窓は見つけない・前に出すは成功・閉じるは何もしない。窓の動きは tests/unit/chrome-connection.mjs が偽の Chrome で確かめる）。
import fs from 'node:fs';

const log = process.env.FAKE_PARENT_PORT_LOG;
const chromeOsSupported = process.env.FAKE_CHROME_OS !== 'unsupported';
const listeners = [];
const reply = message => queueMicrotask(() => { for (const fn of listeners) fn({ data: message }); });
process.parentPort = {
  postMessage(message) {
    const type = message?.type ?? '';
    if (type === 'chrome-os-ready-request') {
      reply({ type: 'chrome-os-ready', supported: chromeOsSupported, ...(chromeOsSupported ? {} : { reason: 'platform' }),
        features: { dialog: chromeOsSupported, raise: chromeOsSupported, launch: false, watch: false, bounds: false } });
      return;
    }
    if (type === 'chrome-os') {
      if (log) fs.appendFileSync(log, `${JSON.stringify(message)}\n`);
      const results = { snapshotWindows: [], findPermissionDialog: null, raise: { ok: true, method: 'direct' }, yieldForeground: false, foreground: null, close: false };
      reply({ type: 'chrome-os-result', id: message.id, ok: true, result: results[message.action] ?? null });
      return;
    }
    if (!type.startsWith('agent-browser-')) return;
    if (log) fs.appendFileSync(log, `${JSON.stringify(message)}\n`);
    if (type !== 'agent-browser-endpoint') return;
    const url = `ws://127.0.0.1:1/devtools/browser/${Buffer.from(String(message.sessionId)).toString('hex').padEnd(48, '0').slice(0, 48)}`;
    reply({ type: 'agent-browser-endpoint', id: message.id, ok: true, url });
  },
  on(type, fn) { if (type === 'message') listeners.push(fn); },
};
await import('../../core/server.mjs');
