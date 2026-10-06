// 項目 4（Codex）: Pleiad が渡す HTTP MCP（core/mcp-bridge.mjs と同じ骨格）が 1〜3 秒つながらないとき、
// ツールが失敗で済むか、MCP ごと外されるか。ポートを閉じて、同じポートで開き直す。
//   node 50-mcp-outage.mjs
import { makeEnv, Rpc, handshake, spawnAppServer, killTree, log, sleep } from './lib.mjs';
import { createMcpBridge } from '../../../core/mcp-bridge.mjs';
import http from 'node:http';

const E = await makeEnv();
let calls = 0;
const seen = [];   // MCP 側が受けた JSON-RPC の method
const bridge = createMcpBridge({
  path: '/mcp', serverName: 'probe',
  tools: () => [{ name: 'ping', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }],
  call: async (_b, name) => { calls++; if (globalThis.__slow) await sleep(globalThis.__slow); return `pong-${calls}`; },
});
let srv, port = 0;
const sockets = new Set();
function openServer() {
  return new Promise((resolve) => {
    srv = http.createServer((req, res) => {
      let peek = ''; req.on('data', (d) => { if (peek.length < 300) peek += d; }); req.on('end', () => { try { seen.push(JSON.parse(peek).method); } catch { seen.push('?'); } });
      bridge.handle(req, res);
    });
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    srv.listen(port, '127.0.0.1', () => { port = srv.address().port; resolve(); });
  });
}
const closeServer = async () => { srv.closeAllConnections?.(); for (const s of sockets) s.destroy(); await new Promise((r) => srv.close(r)); };
await openServer();
const origin = `http://127.0.0.1:${port}`;
const opened = bridge.open({ origin, locale: 'en' });
log('mcp bridge', opened.url.replace(String(port), '<port>'));

const child = spawnAppServer(E.env);
const rpc = new Rpc('c', (s) => child.stdin.write(s));
child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => rpc.feed(d));
const text = (s) => [{ type: 'text', text: s, text_elements: [] }];
const shorten = (o, n = 300) => JSON.stringify(o)?.slice(0, n);
const mcpItems = () => rpc.notifications.filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').map((n) => ({ status: n.params.item.status, error: n.params.item.error?.message?.slice(0, 160) ?? null, result: n.params.item.result?.content?.[0]?.text ?? null }));
async function turn(label, prompt, waitMs = 30000) {
  const from = rpc.notifications.length;
  const t = await rpc.request('turn/start', { threadId, input: text(prompt) });
  const done = await rpc.waitFor((n) => n.method === 'turn/completed' && rpc.notifications.indexOf(n) >= from, waitMs, label);
  const mc = rpc.notifications.slice(from).filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').map((n) => ({ status: n.params.item.status, error: n.params.item.error?.message?.slice(0, 200) ?? null, result: shorten(n.params.item.result?.content, 80) }));
  const fm = [...rpc.notifications.slice(from)].reverse().find((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage');
  log(`${label}: turn ${done?.params?.turn?.status ?? 'NO-COMPLETE'} | mcpToolCall ${shorten(mc, 400)} | model-visible text: ${shorten(fm?.params?.item?.text, 200)}`);
}
let threadId;
try {
  await handshake(rpc);
  const ts = await rpc.request('thread/start', {
    cwd: E.work, approvalPolicy: 'never', sandbox: 'danger-full-access',
    config: { 'mcp_servers.probe': { url: opened.url, http_headers: opened.headers, enabled: true, required: false, default_tools_approval_mode: 'approve', startup_timeout_sec: 20, tool_timeout_sec: 60 } },
  });
  threadId = ts.result.thread.id;
  await sleep(1500);
  log('mcpServerStatus/list ->', shorten((await rpc.request('mcpServerStatus/list', { threadId }, 15000)).result?.data?.map((s) => ({ name: s.name, tools: Object.keys(s.tools ?? {}), auth: s.authStatus })), 300));
  log('MCP-side methods so far:', seen.join(','));

  await turn('1. baseline (MCP up)', 'MCPCALL:probe:ping');
  log('   MCP-side methods:', seen.join(','));
  const names = (E.mock.requests.at(-2)?.body?.tools ?? []).map((t) => t.type === 'namespace' ? `${t.name}{${(t.tools ?? []).map((x) => x.name)}}` : t.name).filter((n) => /probe|ping/.test(n));
  log('   tool names the model saw:', shorten(names));

  // 2. ポートを閉じる。3 秒つながらない間にツールを呼ぶ。
  seen.length = 0;
  await closeServer(); log('--- MCP port CLOSED');
  const p2 = turn('2. call while port is closed (outage 3s, then reopen mid-turn?)', 'MCPCALL:probe:ping');
  await sleep(3000);
  await openServer(); log('--- MCP port REOPENED (same port) after 3s; turn still pending?');
  await p2;
  log('   MCP-side methods during/after:', seen.join(','));

  // 3. 開き直した後の呼び出し（外されていないか／再 initialize が要るか）
  seen.length = 0;
  await turn('3. call after reopen', 'MCPCALL:probe:ping');
  log('   MCP-side methods:', seen.join(','));
  const st = await rpc.request('mcpServerStatus/list', { threadId }, 15000);
  log('   mcpServerStatus/list ->', shorten(st.result?.data?.map((s) => ({ name: s.name, tools: Object.keys(s.tools ?? {}) })) ?? st.error));

  // 4. 呼び出しの最中に切る（応答の途中の切断）
  seen.length = 0; globalThis.__slow = 2500;
  const p4 = turn('4. connection cut mid-call (handler 2.5s; cut at 1s, reopen at 3s)', 'MCPCALL:probe:ping');
  await sleep(1000); await closeServer(); log('--- MCP port CLOSED mid-call');
  await sleep(2000); globalThis.__slow = 0; await openServer(); log('--- reopened');
  await p4;
  seen.length = 0;
  await turn('5. call after mid-call cut + reopen', 'MCPCALL:probe:ping');
  log('   MCP-side methods:', seen.join(','));

  // 6. 長い不通（10 秒）: 外されるか
  await closeServer(); log('--- MCP port CLOSED for 10s with no call');
  await sleep(10000);
  await openServer(); seen.length = 0;
  await turn('6. call after 10s idle outage', 'MCPCALL:probe:ping');
  log('   MCP-side methods:', seen.join(','));

  // 7. 短い不通（1 秒）。ツールを呼んだ直後に閉じ、1 秒で開き直す。呼び出しは待つか、失敗するか
  for (const gap of [1000, 1800]) {
    await closeServer(); seen.length = 0;
    const p7 = turn(`7. call at start of ${gap}ms outage`, 'MCPCALL:probe:ping');
    await sleep(gap); await openServer(); log(`--- reopened after ${gap}ms`);
    await p7; log('   MCP-side methods:', seen.join(','));
  }
} finally {
  log('stderr (mcp-related):', child.stderrBuf.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /mcp|rmcp/i.test(l)).slice(-8).join(' | ').slice(0, 1200));
  killTree(child); try { await closeServer(); } catch {} await sleep(800); await E.close();
}
