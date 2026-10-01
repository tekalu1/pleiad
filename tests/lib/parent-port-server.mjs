// core/server.mjs を、Electron の utilityProcess の身代わり（process.parentPort）を置いて起こす入口。
// main への便り（agent-browser-*）は FAKE_PARENT_PORT_LOG に 1 行ずつ JSON で残す。
// endpoint の依頼には、会話ごとに決まった偽の URL で答える。
import fs from 'node:fs';

const log = process.env.FAKE_PARENT_PORT_LOG;
const listeners = [];
process.parentPort = {
  postMessage(message) {
    if (!message?.type?.startsWith('agent-browser-')) return;
    if (log) fs.appendFileSync(log, `${JSON.stringify(message)}\n`);
    if (message.type !== 'agent-browser-endpoint') return;
    const url = `ws://127.0.0.1:1/devtools/browser/${Buffer.from(String(message.sessionId)).toString('hex').padEnd(48, '0').slice(0, 48)}`;
    queueMicrotask(() => { for (const fn of listeners) fn({ data: { type: 'agent-browser-endpoint', id: message.id, ok: true, url } }); });
  },
  on(type, fn) { if (type === 'message') listeners.push(fn); },
};
await import('../../core/server.mjs');
