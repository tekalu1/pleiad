// ws:// の認証（capability-token）。トークン無しの接続は通るか、トークン有りは通るか。
import { makeEnv, Rpc, spawnAppServer, killTree, log, sleep, INIT_PARAMS } from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path';
const E = await makeEnv();
const tokenFile = path.join(E.home, 'ws-token');
fs.writeFileSync(tokenFile, 'probe-capability-token-0123456789');
const run = async (extra) => {
  const child = spawnAppServer(E.env, ['--listen', 'ws://127.0.0.1:0', ...extra]);
  let port = null; child.stderr.on('data', (d) => { const m = /listening on: ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) port = Number(m[1]); });
  for (let i = 0; i < 100 && !port; i++) await sleep(100);
  const attempt = async (label, opts) => {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
      const rpc = new Rpc('x', (s) => ws.send(s.trim())); ws.onmessage = (e) => rpc.feed(String(e.data) + '\n');
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('rejected at handshake')); setTimeout(() => rej(new Error('timeout')), 5000); });
      const r = await rpc.request('initialize', INIT_PARAMS, 5000); ws.close();
      log(`  ${label}: connected; initialize ${r.result ? 'ok' : JSON.stringify(r)}`);
    } catch (e) { log(`  ${label}: ${e.message}`); }
  };
  log('server flags:', extra.join(' ').replace(E.home, '<CODEX_HOME>') || '(none)');
  await attempt('no token', undefined);
  await attempt('with bearer token', { headers: { Authorization: 'Bearer probe-capability-token-0123456789' } });
  await attempt('with wrong token', { headers: { Authorization: 'Bearer nope' } });
  killTree(child); await sleep(600);
};
try { await run([]); await run(['--ws-auth', 'capability-token', '--ws-token-file', tokenFile]); } finally { await sleep(500); await E.close(); }
