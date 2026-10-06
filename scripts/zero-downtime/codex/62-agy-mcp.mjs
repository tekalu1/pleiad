// 項目 4（agy）: Pleiad の MCP の口が不通のとき。agy は MCP を stdio の中継（core/agy-context-relay.mjs）越しに使うので、
// 実物の中継 + 実物の agent.md の作り（agentDefinition）で、口を閉じた状態でツールを呼ばせる。LLM は 3 回（短い応答）。
//   1. 口が開いている: ping が通る
//   2. 口を閉じたまま: ツールの失敗で済むか、agy が MCP ごと外すか
//   3. 口を同じポートで開き直す: また使えるか（外されていないか）
import { HolderSim } from './holder-sim.mjs';
import { log, sleep } from './lib.mjs';
import { createMcpBridge } from '../../../core/mcp-bridge.mjs';
import { agentDefinition } from '../../../core/backends/antigravity-context.mjs';
import http from 'node:http';
import fs from 'node:fs'; import path from 'node:path';
const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
const work = fs.mkdtempSync(path.join(base, 'agy-work-'));
const ctx = fs.mkdtempSync(path.join(base, 'agy-ctx-'));
fs.mkdirSync(path.join(ctx, '.agents', 'agents', 'ply-context'), { recursive: true });
fs.writeFileSync(path.join(ctx, '.agents', 'agents', 'ply-context', 'agent.md'),
  agentDefinition({ owners: {}, prompt: 'Probe agent. Follow the user instructions literally.', cwd: work, home: ctx, locale: 'en', contextEnabled: true, electron: false }));

let calls = 0; const seen = [];
const bridge = createMcpBridge({ path: '/mcp/context', serverName: 'Pleiad Context',
  tools: () => [{ name: 'probe_ping', description: 'Returns a pong token. Call with no arguments.', inputSchema: { type: 'object', properties: {} } }],
  call: async () => `pong-token-${++calls}` });
let srv, port = 0; const sockets = new Set();
const openServer = () => new Promise((res) => { srv = http.createServer((req, rs) => { seen.push(req.method); bridge.handle(req, rs); }); srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); srv.listen(port, '127.0.0.1', () => { port = srv.address().port; res(); }); });
const closeServer = async () => { srv.closeAllConnections?.(); for (const s of sockets) s.destroy(); await new Promise((r) => srv.close(r)); };
await openServer();
const opened = bridge.open({ origin: `http://127.0.0.1:${port}`, locale: 'en' });
const startDown = process.argv[2] === 'startdown';   // 口が閉じたまま agy を起動する（中継の initialize が失敗する場合）
if (startDown) { await closeServer(); log('--- MCP port CLOSED before agy starts'); }
const env = { ...process.env, PLY_CONTEXT_URL: opened.url, PLY_CONTEXT_AUTHORIZATION: opened.headers.Authorization, PLY_CONTEXT_LOCALE: 'en' };
const model = process.env.PROBE_AGY_MODEL ?? 'gemini-3.8-flash-low';
const h = new HolderSim('agy', ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '10m', '--model', model,
  '--add-dir', ctx, '--agent', 'ply-context', '--dangerously-skip-permissions'], { cwd: work, env });
const events = [];
h.sink = (line) => { try { events.push(JSON.parse(line)); } catch {} };
const user = (c) => JSON.stringify({ event: 'user', message: { content: c } }) + '\n';
let conv = null;
async function turn(label, prompt) {
  const n0 = events.length, t0 = Date.now();
  h.write(user(prompt));
  while (!events.slice(n0).some((e) => e.event === 'result') && Date.now() - t0 < 90000) await sleep(150);
  const ev = events.slice(n0);
  conv ??= ev.find((e) => e.conversation_id)?.conversation_id ?? null;
  const steps = ev.filter((e) => e.event === 'step_update' && !/user_input|agent_response/.test(e.step_update.step_type)).map((e) => `${e.step_update.step_type}/${e.step_update.state}`);
  const toolSteps = ev.filter((e) => e.event === 'step_update' && /mcp|tool/i.test(JSON.stringify(e.step_update).slice(0, 400)) && !/user_input|agent_response/.test(e.step_update.step_type));
  const r = ev.find((e) => e.event === 'result')?.result;
  log(`${label}: ${r?.status ?? 'NO RESULT'} (${Date.now() - t0}ms)\n   response: ${JSON.stringify(r?.response).slice(0, 400)}\n   tool steps: ${[...new Set(steps)].join(', ') || '(none)'}`);
  const last = toolSteps.at(-1)?.step_update; if (last) log('   last tool step:', JSON.stringify(last).slice(0, 500));
}
try {
  log('agy mcp probe; model', model);
  if (startDown) {
    await turn('S1. agy started while port CLOSED', 'Call the MCP tool probe_ping exactly once and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.');
    await openServer(); log('--- MCP port OPENED (same port)');
    const b = calls;
    await turn('S2. after OPEN (same agy process)', 'Call the MCP tool probe_ping once more and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.');
    log('   tool calls served after opening:', calls - b);
    throw new Error('startdown done');
  }
  await turn('1. port OPEN', 'Call the MCP tool probe_ping (from the ply_context server) exactly once and tell me the exact token it returned. If the tool fails, say FAILED and quote the error.');
  log('   MCP-side requests so far:', seen.length, 'tool calls served:', calls);
  await closeServer(); log('--- MCP port CLOSED');
  await turn('2. port CLOSED', 'Call the MCP tool probe_ping again exactly once and tell me the exact token it returned. If the tool fails, say FAILED and quote the error.');
  await openServer(); log('--- MCP port REOPENED (same port)');
  const before = calls;
  await turn('3. after REOPEN', 'Call the MCP tool probe_ping once more and tell me the exact token it returned. If the tool fails, say FAILED and quote the error.');
  log('   tool calls served by the reopened port:', calls - before, '(0 = agy no longer reaches the MCP)');
} finally {
  log('CONVERSATION_ID(for cleanup):', conv, '| stderr:', h.err.slice(0, 400));
  try { h.child.stdin.end(); } catch {}
  await Promise.race([h.exited, sleep(15000)]); if (h.exit === null) h.kill();
  try { await closeServer(); } catch {}
  await sleep(800); for (const d of [work, ctx]) fs.rmSync(d, { recursive: true, force: true });
}
