// 項目 4（Codex）の続き: MCP の口が閉じたまま thread/start したとき（required: true / false）。開き直したら使えるか。
import { makeEnv, Rpc, handshake, spawnAppServer, killTree, log, sleep } from './lib.mjs';
import { createMcpBridge } from '../../../core/mcp-bridge.mjs';
import http from 'node:http';
const E = await makeEnv();
let calls = 0;
const bridge = createMcpBridge({ path: '/mcp', serverName: 'probe', tools: () => [{ name: 'ping', description: 'pong', inputSchema: { type: 'object', properties: {} } }], call: async () => `pong-${++calls}` });
let srv, port = 0; const sockets = new Set();
const openServer = () => new Promise((res) => { srv = http.createServer((q, s) => bridge.handle(q, s)); srv.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); }); srv.listen(port, '127.0.0.1', () => { port = srv.address().port; res(); }); });
const closeServer = async () => { srv.closeAllConnections?.(); for (const s of sockets) s.destroy(); await new Promise((r) => srv.close(r)); };
await openServer();
const opened = bridge.open({ origin: `http://127.0.0.1:${port}`, locale: 'en' });
await closeServer(); log('--- MCP port CLOSED before thread/start');
const child = spawnAppServer(E.env);
const rpc = new Rpc('c', (s) => child.stdin.write(s));
child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => rpc.feed(d));
const text = (s) => [{ type: 'text', text: s, text_elements: [] }];
const shorten = (o, n = 300) => JSON.stringify(o)?.slice(0, n);
try {
  await handshake(rpc);
  for (const required of [false, true]) {
    const t0 = Date.now();
    const ts = await rpc.request('thread/start', { cwd: E.work, approvalPolicy: 'never', sandbox: 'danger-full-access',
      config: { 'mcp_servers.probe': { url: opened.url, http_headers: opened.headers, enabled: true, required, default_tools_approval_mode: 'approve', startup_timeout_sec: 20, tool_timeout_sec: 60 } } });
    log(`required=${required}: thread/start ${ts.error ? 'ERROR ' + shorten(ts.error) : 'ok'} (${Date.now() - t0}ms)`);
    if (ts.error) continue;
    const threadId = ts.result.thread.id;
    await sleep(1500);
    const st = await rpc.request('mcpServerStatus/list', { threadId }, 15000);
    log(`required=${required}: mcpServerStatus while closed ->`, shorten(st.result?.data?.map((s) => ({ name: s.name, tools: Object.keys(s.tools ?? {}) })) ?? st.error));
    await openServer(); log(`--- MCP port OPENED (same port) [required=${required}]`);
    const from = rpc.notifications.length;
    await rpc.request('turn/start', { threadId, input: text('MCPCALL:probe:ping') });
    await rpc.waitFor((n) => n.method === 'turn/completed' && rpc.notifications.indexOf(n) >= from, 30000, 'turn');
    const mc = rpc.notifications.slice(from).filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').map((n) => ({ status: n.params.item.status, err: n.params.item.error?.message?.slice(0, 100) }));
    const names = (E.mock.requests.at(-1)?.body?.tools ?? []).map((t) => t.name).filter((n) => /probe|mcp/.test(n ?? ''));
    log(`required=${required}: after open: MCP tool offered to model: ${shorten(names)} ; mcpToolCall items: ${shorten(mc)} ; served=${calls}`);
    const st2 = await rpc.request('mcpServerStatus/list', { threadId }, 15000);
    log(`required=${required}: mcpServerStatus after open ->`, shorten(st2.result?.data?.map((s) => ({ name: s.name, tools: Object.keys(s.tools ?? {}) })) ?? st2.error));
    // もう 1 ターン（status を見たあと）。ツールがモデルに渡るようになるか
    const from2 = rpc.notifications.length;
    await rpc.request('turn/start', { threadId, input: text('MCPCALL:probe:ping') });
    await rpc.waitFor((n) => n.method === 'turn/completed' && rpc.notifications.indexOf(n) >= from2, 30000, 'turn2');
    const mc2 = rpc.notifications.slice(from2).filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').map((n) => n.params.item.status);
    log(`required=${required}: 2nd turn after open: mcpToolCall ${shorten(mc2)} served=${calls}`);
    // 同じ thread を resume し直す（loaded 済みの thread へ）と MCP がつなぎ直されるか
    const rs = await rpc.request('thread/resume', { threadId, config: { 'mcp_servers.probe': { url: opened.url, http_headers: opened.headers, enabled: true, required, default_tools_approval_mode: 'approve' } } });
    log(`required=${required}: thread/resume (loaded) ->`, rs.error ? shorten(rs.error) : 'ok');
    const from3 = rpc.notifications.length;
    await rpc.request('turn/start', { threadId, input: text('MCPCALL:probe:ping') });
    await rpc.waitFor((n) => n.method === 'turn/completed' && rpc.notifications.indexOf(n) >= from3, 30000, 'turn3');
    log(`required=${required}: 3rd turn after resume: mcpToolCall ${shorten(rpc.notifications.slice(from3).filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall').map((n) => n.params.item.status))} served=${calls}`);
    await closeServer();
  }
} finally {
  killTree(child); try { await closeServer(); } catch {} await sleep(800); await E.close();
}
