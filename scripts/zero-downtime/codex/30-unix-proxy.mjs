// 項目 2: --listen unix:// と `app-server proxy`（stdio ↔ 制御ソケット）。制御ソケットは WebSocket を話す。
// 接続（ここでは proxy のプロセス）を殺して別の接続から付け直したとき、ターン・承認がどうなるか。
import { makeEnv, Rpc, spawnAppServer, killTree, log, sleep, codexExe, INIT_PARAMS } from './lib.mjs';
import { wsClient } from './ws-min.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs'; import path from 'node:path';
const mode = process.argv[2] ?? 'proxy';   // proxy: codex の proxy 経由 / direct: node の net で直に
const E = await makeEnv();
const server = spawnAppServer(E.env, ['--listen', 'unix://']);
await sleep(4000);
const ctl = path.join(E.home, 'app-server-control');
const sock = path.join(ctl, 'app-server-control.sock');
log('sock exists =', fs.existsSync(sock));
const shorten = (o, n = 260) => JSON.stringify(o)?.slice(0, n);
async function connect(name, idBase = 0) {
  let rpc, ws, kill;
  if (mode === 'direct') {
    const s = net.connect(sock);
    ws = wsClient({ write: (b) => s.write(b), onMessage: (m) => rpc.feed(m + '\n'), onClose: (why) => log(`[${name}] ws closed`, why) });
    s.on('data', (d) => ws.feed(d)); kill = () => s.destroy();
    s.on('error', (e) => log(`[${name}] socket error`, e.message));
  } else {
    const p = spawn(codexExe(), ['app-server', 'proxy', '--sock', sock], { env: E.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    ws = wsClient({ write: (b) => p.stdin.write(b), onMessage: (m) => rpc.feed(m + '\n'), onClose: (why) => log(`[${name}] ws closed`, why) });
    p.stdout.on('data', (d) => ws.feed(d)); p.stderr.on('data', (d) => log(`[${name}] proxy stderr`, String(d).slice(0, 200)));
    kill = () => killTree(p);
  }
  rpc = new Rpc(name, (s) => ws.send(s.trim())); rpc.nextId = idBase; rpc.kill = kill;
  await Promise.race([ws.opened, sleep(8000).then(() => { throw new Error('ws handshake timeout'); })]);
  return rpc;
}
const init = async (r) => { const x = await r.request('initialize', INIT_PARAMS); r.notify('initialized'); return x; };
const text = (s) => [{ type: 'text', text: s, text_elements: [] }];
try {
  const A = await connect('A');
  log(`A (${mode}) initialize ->`, shorten(await init(A), 120));
  const ts = await A.request('thread/start', { cwd: E.work, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' });
  const threadId = ts.result.thread.id;
  await A.request('turn/start', { threadId, input: text('SHELL please') });
  const req = await A.waitFor((m) => m.id !== undefined && m.method, 15000, 'approval');
  log('A got approval request', shorten({ id: req.id, method: req.method }));
  A.kill(); await sleep(300);
  log('A connection killed (approval outstanding); server alive =', server.exitCode === null);
  await sleep(2500);
  const B = await connect('B', 1000);
  await init(B);
  log('B loaded ->', shorten((await B.request('thread/loaded/list', {})).result));
  const rs = await B.request('thread/resume', { threadId });
  log('B resume status ->', shorten(rs.result?.thread?.status));
  await sleep(2500);
  log('B replayed requests:', shorten(B.serverRequests.map((m) => ({ id: m.id, method: m.method }))));
  if (B.serverRequests[0]) { B.respond(B.serverRequests[0].id, { decision: 'accept' }); const d = await B.waitFor((n) => n.method === 'turn/completed', 15000, 'completed'); log('turn/completed after B answered:', !!d, d?.params?.turn?.status); }
  B.kill();
} finally {
  killTree(server); await sleep(800); await E.close();
}
