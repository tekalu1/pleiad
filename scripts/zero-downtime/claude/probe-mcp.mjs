// 段階 2-0 の探りで CLI に渡す stdio の MCP サーバー（CLI の子として起きる）。状態を持つツールと elicitation を出すツール。
//   counter: 呼ぶたびに 1 増える数と pid を返す（付け直しの後も同じプロセス・同じ状態かを見る）
//   slow:    seconds 秒待ってから返す（呼び出しの最中に付け直す）
//   ask:     クライアント（CLI）に elicitation（form）を出し、答えを返す
// 出来事は env の PROBE_LOG のファイルに 1 行 1 JSON で足す。使い方: node probe-mcp.mjs（stdio）
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const logFile = process.env.PROBE_LOG;
const log = (ev, data = {}) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ ev, at: Date.now(), pid: process.pid, ...data }) + '\n'); };
let count = 0;
let inits = 0;

const server = new McpServer({ name: 'probe', version: '0.0.0' });
server.registerTool('counter', { description: 'Increments a counter kept in this server process and returns it with the pid. Takes no arguments.', inputSchema: {} }, async () => {
  count++;
  log('counter', { count });
  return { content: [{ type: 'text', text: `count=${count} pid=${process.pid}` }] };
});
server.registerTool('slow', { description: 'Waits the given seconds, then returns SLOW_DONE.', inputSchema: { seconds: z.number() } }, async ({ seconds }) => {
  log('slow.start', { seconds });
  await new Promise(r => setTimeout(r, seconds * 1000));
  log('slow.done', { seconds });
  return { content: [{ type: 'text', text: `SLOW_DONE after ${seconds}s pid=${process.pid}` }] };
});
server.registerTool('ask', { description: 'Asks the user for a codeword through an elicitation and returns the answer.', inputSchema: {} }, async () => {
  log('ask.start');
  try {
    const r = await server.server.elicitInput({ message: 'Type the codeword', requestedSchema: { type: 'object', properties: { codeword: { type: 'string' } }, required: ['codeword'] } }, { timeout: 600_000 });
    log('ask.done', { action: r.action, content: r.content });
    return { content: [{ type: 'text', text: `ELICIT action=${r.action} codeword=${r.content?.codeword ?? '-'}` }] };
  } catch (e) {
    log('ask.error', { error: String(e?.message ?? e) });
    return { isError: true, content: [{ type: 'text', text: `ELICIT_ERROR ${e?.message ?? e}` }] };
  }
});
server.server.oninitialized = () => { inits++; log('initialized', { inits, client: server.server.getClientVersion(), caps: server.server.getClientCapabilities() }); };
process.stdin.on('end', () => { log('stdin.end'); process.exit(0); });
log('start');
await server.connect(new StdioServerTransport());
