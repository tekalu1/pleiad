// 偽のモデル + 一時の CODEX_HOME で、本物の codex app-server が 1 ターン回ることを確かめる。
import { makeEnv, Rpc, handshake, spawnAppServer, killTree, log, sleep } from './lib.mjs';

const E = await makeEnv();
const child = spawnAppServer(E.env);
const rpc = new Rpc('c1', (s) => child.stdin.write(s));
child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => rpc.feed(d));
try {
  log('init', JSON.stringify(await handshake(rpc)).slice(0, 300));
  const ts = await rpc.request('thread/start', { cwd: E.work, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  log('thread/start', JSON.stringify(ts).slice(0, 400));
  const threadId = ts.result?.thread?.id;
  const tr = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: process.argv[2] ?? 'hello', text_elements: [] }] });
  log('turn/start', JSON.stringify(tr).slice(0, 300));
  await rpc.waitFor((n) => n.method === 'turn/completed', 30000, 'turn/completed');
  log('notifications:', rpc.summary());
  log('server requests:', rpc.serverRequests.map((m) => m.method).join(','));
  log('model requests:', E.mock.requests.length, 'stderr tail:', child.stderrBuf.slice(-300));
} finally {
  killTree(child); await sleep(500); await E.close();
}
