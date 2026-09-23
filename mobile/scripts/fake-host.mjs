// A local relay + a fake-backend Pleiad host, for testing the Android device side without the production relay and
// without an LLM. Used by the Kotlin interop test (remote-core InteropTest) and for manual smoke tests on a phone /
// emulator via `adb reverse` (the phone's 127.0.0.1:<relay port> then reaches this relay, and loopback relays may be
// plain http, docs/remote.md §3.3).
//
//   node mobile/scripts/fake-host.mjs [--relay-port 8787] [--auto-approve] [--data <dir>]
//   node mobile/scripts/fake-host.mjs --relay https://relay.example --secret-file <file with RELAY_ENROLL_SECRET>
//     (an existing relay instead of a local one; the secret is read from the file and never printed)
//
// Prints one JSON object per line on stdout:
//   {"event":"ready","relayUrl":"http://127.0.0.1:8787","hostUrl":"http://127.0.0.1:<p>/?token=…","hostId":"…"}
//   {"event":"offer","payload":"pleiad://pair?…"}             after start and after each "offer" command
//   {"event":"request","id":"…","code":"123456","name":"…","platform":"android"}
//   {"event":"approved","id":"…"} / {"event":"revoked","id":"…"} / {"event":"devices","devices":[…]} / {"event":"error",…}
// Commands on stdin (one per line): offer | approve <id> | deny <id> | devices | revoke <deviceId> | revoke-all | login | disable | quit
// login = log the fake backend in on the host (remote windows ask to log in on the host's PC).
// quit always disables remote on the host first (so a shared relay forgets it).
//
// The host URL contains the host's UI token: this is a throwaway host with a temporary data dir.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createRelay } = await import(new URL('file:' + path.join(ROOT, 'relay', 'server.mjs').replaceAll('\\', '/')).href);
const { startServer } = await import(new URL('file:' + path.join(ROOT, 'tests', 'lib', 'server.mjs').replaceAll('\\', '/')).href);
const { open } = await import(new URL('file:' + path.join(ROOT, 'tests', 'lib', 'ws-client.mjs').replaceAll('\\', '/')).href);

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const autoApprove = args.includes('--auto-approve');
const relayPort = Number(arg('--relay-port', '0'));
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');

const external = arg('--relay');
const secret = external ? (await fs.readFile(arg('--secret-file'), 'utf8')).trim() : crypto.randomBytes(32).toString('base64url');
const scratch = arg('--data') ?? await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-fake-host-'));
let relay = null;
let relayUrl = external;
if (!external) {
  relay = createRelay({ enrollSecret: secret, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(relayPort, '127.0.0.1');
  relayUrl = `http://127.0.0.1:${addr.port}`;
}
const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'host'), timeoutMs: 60_000 });
const c = await open({ port: server.port, token: server.token, onEvent: ev => {
  if (ev.type === 'remotePairing' && ev.phase === 'request') {
    const r = ev.request;
    out({ event: 'request', id: r.id, code: r.code, name: r.name, platform: r.platform });
    if (autoApprove) c.cmd('remotePairingApprove', { id: r.id }).then(() => out({ event: 'approved', id: r.id }), e => out({ event: 'error', error: e.message }));
  }
} });

let from = c.mark();
await c.cmd('setRemoteSettings', { relayUrl, enrollSecret: secret, enabled: true, hostName: 'fake-host' });
await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 20_000 });
const st = await c.cmd('remoteStatus');
out({ event: 'ready', relayUrl, hostUrl: `http://127.0.0.1:${server.port}/?token=${server.token}`, hostId: st.hostId });

async function offer() {
  const o = await c.cmd('remotePairingStart');
  out({ event: 'offer', payload: o.payload });
}
await offer();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await c.cmd('setRemoteSettings', { enabled: false }); out({ event: 'disabled' }); } catch {}
  try { await server.stop(); } catch {}
  try { await relay?.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  const [command, id] = line.trim().split(/\s+/);
  try {
    if (command === 'offer') await offer();
    else if (command === 'approve') { await c.cmd('remotePairingApprove', { id }); out({ event: 'approved', id }); }
    else if (command === 'deny') { await c.cmd('remotePairingDeny', { id }); out({ event: 'denied', id }); }
    else if (command === 'devices') out({ event: 'devices', devices: (await c.cmd('remoteStatus')).devices });
    else if (command === 'revoke') { await c.cmd('remoteRevoke', { id }); out({ event: 'revoked', id }); }
    else if (command === 'revoke-all') {
      for (const d of (await c.cmd('remoteStatus')).devices) { await c.cmd('remoteRevoke', { id: d.id }); out({ event: 'revoked', id: d.id }); }
    } else if (command === 'quit') await stop();
    else if (command) out({ event: 'error', error: `unknown command ${command}` });
  } catch (e) {
    out({ event: 'error', error: e.message });
  }
});
rl.on('close', () => { if (!process.stdin.isTTY) stop(); });
