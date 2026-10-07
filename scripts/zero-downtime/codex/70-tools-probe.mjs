// 段階 3 の 3-0 の下調べ: 偽のモデルに渡る tools の名前（サブエージェント・端末のツールがあるか）。LLM は呼ばない。
import { makeEnv, Rpc, handshake, log, sleep, spawnAppServer, killTree } from './lib.mjs';

const E = await makeEnv();
const child = spawnAppServer(E.env);
const rpc = new Rpc('A', (s) => child.stdin.write(s));
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => rpc.feed(d));
try {
  await handshake(rpc);
  const ts = await rpc.request('thread/start', { cwd: E.work, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const threadId = ts.result.thread.id;
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] });
  await rpc.waitFor((n) => n.method === 'turn/completed', 15000, 'completed');
  const req = E.mock.requests.find((r) => r.url.includes('/responses'));
  const flat = (req?.body?.tools ?? []).flatMap((t) => t.type === 'namespace' ? (t.tools ?? []).map((x) => `${t.name}.${x.name}`) : [t.name ?? t.type]);
  log('tools:', flat.join(', '));
  const spawnTool = (req?.body?.tools ?? []).flatMap((t) => t.type === 'namespace' ? t.tools : [t]).find((t) => /spawn_agent/.test(t.name ?? ''));
  log('spawn_agent schema:', JSON.stringify(spawnTool?.parameters)?.slice(0, 1500));
  const exec = (req?.body?.tools ?? []).find((t) => /exec_command/.test(t.name ?? ''));
  log('exec_command schema:', JSON.stringify(exec)?.slice(0, 900));
} finally { killTree(child); await sleep(800); await E.close(); }
