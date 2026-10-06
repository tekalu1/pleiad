// 項目 4: Pleiad の HTTP MCP（core/mcp-bridge.mjs の口）が数秒つながらないとき、CLI はどうするか。
// mcp-bridge.mjs と同じ形（POST だけ・JSON の応答・通知は 202・GET は 405・Bearer）の最小の MCP サーバーを立て、
// CLI（SDK の query で起動。保持役は使わない）にツールを 1 回呼ばせる。モード:
//   refused  ポートを閉じておき、ツールの呼び出しが見えてから D 秒後に同じポートを開き直す（新旧サーバーの入れ替えの間）
//   reset    呼び出しが届いた瞬間に接続を切り、ポートを閉じ、D 秒後に開き直す（呼び出しの最中にサーバーが落ちる）
//   hang     接続は受けるが、tools/call の応答を D 秒止める（待ち受けを保持役が持つ段階 4 の見立て）
// 使い方: node s4-http-outage.mjs <mode> <D秒> [after=15]   after = 失敗の後、開き直してから次の呼び出しまでの待ち（秒）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudePath, createInput, sleep } from './common.mjs';

const [mode, dArg, ...rest] = process.argv.slice(2);
const D = Number(dArg);
const afterWait = Number((rest.find(s => s.startsWith('after=')) ?? 'after=0').split('=')[1]);
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

// ---- 最小の MCP サーバー（mcp-bridge.mjs の serve を写した形）
const sockets = new Set();
let calls = 0;
let port = 0;
let server = null;
const onCall = { fn: null };   // reset モードで、最初の tools/call が来たときに呼ぶ
function makeServer() {
  const s = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer probe-token') return reply(401, { error: 'Unauthorized' });
    if (req.method !== 'POST') { log('  http', req.method, '-> 405'); return reply(405); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    log('  http POST', m.method, m.id === undefined ? '(notification)' : '');
    if (m.id === undefined) return reply(202);
    let result;
    if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } };
    else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Returns a pong text. Takes no arguments.', inputSchema: { type: 'object', properties: {} } }] };
    else if (m.method === 'tools/call') {
      calls++;
      if (onCall.fn) { const f = onCall.fn; onCall.fn = null; if (f(req)) return; }
      if (mode === 'hang' && calls > 1) await sleep(D * 1000);
      result = { content: [{ type: 'text', text: `pong-${calls}` }] };
    } else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    reply(200, { jsonrpc: '2.0', id: m.id, result });
  });
  s.on('connection', sock => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  return s;
}
const listen = () => new Promise((resolve, reject) => { server = makeServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
const down = () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
await listen();
log('probe MCP server on port', port);

// ---- CLI
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zdu-s4-'));
const input = createInput();
const events = [];
let toolUseAt = null;
const results = [];
let consumed = 0;
const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: claudePath(), cwd, model: 'haiku', settingSources: [], tools: [],
    systemPrompt: 'You are a test fixture. Follow the user instruction literally. Be terse.',
    env: { ...process.env }, extraArgs: { 'strict-mcp-config': null },
    mcpServers: { probe: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer probe-token' } } },
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  },
});
(async () => {
  for await (const m of q) {
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') { toolUseAt = Date.now(); log('  tool_use seen', b.name); }
    if (m.type === 'user') for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b.type === 'tool_result') { log('  tool_result', b.is_error ? 'ERROR' : 'ok', JSON.stringify(b.content).slice(0, 200)); events.push({ toolResultAt: Date.now(), isError: b.is_error ?? false, text: JSON.stringify(b.content) }); }
    if (m.type === 'system' && m.subtype === 'init') log('  init mcp_servers', JSON.stringify(m.mcp_servers), 'tools', JSON.stringify(m.tools));
    if (m.type === 'result') { log('  result', JSON.stringify(String(m.result).slice(0, 160))); results.push(m); }
  }
})().catch(e => log('stream error', String(e)));
// 結果は溜めておき、呼ぶ側が早い遅いにかかわらず 1 つずつ受け取る
const nextResult = async (ms = 180_000) => { const end = Date.now() + ms; while (results.length <= consumed) { if (Date.now() > end) return null; await sleep(50); } return results[consumed++]; };
const status = async label => { try { const st = await q.mcpServerStatus(); log(`  mcp_status[${label}]`, JSON.stringify(st.map?.(s => ({ name: s.name, status: s.status, error: s.error })) ?? st)); } catch (e) { log('  mcp_status failed', String(e).slice(0, 120)); } };
const PROMPT = 'Call the tool mcp__probe__ping exactly once, with no retries. If the call fails, reply with FAILED followed by the error text. If it works, reply with OK followed by the tool result.';

// 準備: 最初の接続（CLI 起動後の initialize / tools/list）を待つ
input.push('Reply with the single word READY.');
await nextResult();
await status('before');

// 基準: サーバーが生きているときの呼び出し
input.push(PROMPT);
await nextResult();

log(`### mode=${mode} D=${D}s`);
let lastSt = '';
const poll = setInterval(async () => { try { const st = JSON.stringify((await q.mcpServerStatus()).map(x => [x.name, x.status])); if (st !== lastSt) { lastSt = st; log('  mcp_status[changed]', st); } } catch { /* ignore */ } }, 500);
let upAt = null;
let reopening = Promise.resolve();
const prompted = Date.now();
if (mode === 'refused') {
  await down();
  log('port closed; asking for a tool call');
  toolUseAt = null;
  input.push(PROMPT);
  while (!toolUseAt) await sleep(50);
  log(`tool call issued; reopening the port in ${D}s`);
  await sleep(D * 1000);
  await listen(); upAt = Date.now();
  log('port reopened');
} else if (mode === 'reset') {
  onCall.fn = req => { log('  tools/call arrived -> dropping the connection and closing the port'); req.socket.destroy(); reopening = down().then(async () => { await sleep(D * 1000); await listen(); upAt = Date.now(); log('port reopened'); }); return true; };
  input.push(PROMPT);
} else if (mode === 'hang') {
  input.push(PROMPT);
}
const res = await nextResult(120_000);
clearInterval(poll);
const first = events.at(-1);
log('RESULT of the call during the outage:', first ? (first.isError ? 'tool error' : 'tool ok') : 'no tool_result', res ? 'turn finished' : 'turn did not finish in 120s');
await status('after-outage');
await reopening;
if (afterWait) { log(`waiting ${afterWait}s with the port open`); await sleep(afterWait * 1000); }
log('### second call after the port is back');
input.push(PROMPT);
await nextResult(60_000);
await status('end');
input.close();
await sleep(1500);
process.exit(0);
