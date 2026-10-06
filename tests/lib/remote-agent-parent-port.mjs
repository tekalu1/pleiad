// 端末のローカルのサーバー（core/server.mjs）を、Electron の main の身代わりを付けて起こす入口（docs/remote.md §4.5 の端末側の試験用）。
// 本物の main（desktop/remote-agent-bridge.cjs）と同じ橋の中身（core/remote/agent-service.mjs）を、本物の端末の部品
// （core/remote/device.mjs。ペアリング済みのホストの資格情報）につないで動かす。中継・ホストは別に立ててある本物。
//
// 環境変数:
//   FAKE_REMOTE_DEVICE_DIR   端末の置き場（hosts.json・secrets.json。テストが createRemoteDevice でペアリングしてから起こす）
//   FAKE_REMOTE_DEVICE_NAME  端末の名前（ホストの端末一覧に出るものはペアリング時に決まる。ここは HELLO の名前）
// ホストの一覧（agentUse）の変更は、本物の窓の IPC の代わりに hosts.json を見て拾う（テストが createDeviceStore の updateHost で書く）。
import fs from 'node:fs';
import path from 'node:path';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { createRemoteAgentService } from '../../core/remote/agent-service.mjs';

const dir = process.env.FAKE_REMOTE_DEVICE_DIR;
if (!dir) throw new Error('FAKE_REMOTE_DEVICE_DIR is required');
const listeners = [];
const toWorker = message => { for (const fn of listeners) fn({ data: message }); };
const device = createRemoteDevice({
  dir, app: 'test', name: process.env.FAKE_REMOTE_DEVICE_NAME || 'laptop-test', platform: 'desktop',
  proxyOptions: { backoff: { minMs: 100, maxMs: 400, stableMs: 500 }, connectTimeoutMs: 5000 },
});
const service = createRemoteAgentService({ getDevice: async () => device, post: toWorker, log: line => console.log(`  [remote-agent] ${line}`) });
process.parentPort = {
  postMessage(message) {
    if (message?.type === 'remote-agent') return service.handle(message);
    // 内蔵ブラウザーの口（main の身代わり）。答えないと、ターンごとに 10 秒の待ちが入る（tests/lib/parent-port-server.mjs と同じ）
    if (message?.type === 'agent-browser-endpoint') {
      const url = `ws://127.0.0.1:1/devtools/browser/${Buffer.from(String(message.sessionId)).toString('hex').padEnd(48, '0').slice(0, 48)}`;
      queueMicrotask(() => toWorker({ type: 'agent-browser-endpoint', id: message.id, ok: true, url }));
    }
  },
  on(type, fn) { if (type === 'message') listeners.push(fn); },
};
// hosts.json の agentUse が変わったら、窓のスイッチと同じに線を張り直す
const hostsFile = path.join(dir, 'hosts.json');
let last = '';
const watch = setInterval(() => {
  let now = '';
  try { now = JSON.stringify((JSON.parse(fs.readFileSync(hostsFile, 'utf8')).hosts ?? []).map(h => [h.hostId, h.agentUse === true, h.label ?? ''])); } catch { return; }
  if (now !== last) { const first = last === ''; last = now; if (!first) service.refresh(); }
}, 150);
watch.unref();
process.on('exit', () => { service.close(); });
await import('../../core/server.mjs');
