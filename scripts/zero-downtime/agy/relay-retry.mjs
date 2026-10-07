// 無停止の更新 段階 3（agy）: 中継（core/agy-context-relay.mjs）の再試行を、本物の agy・本物の中継・本物の MCP の口（core/mcp-bridge.mjs）で確かめる。
// stage0-codex-agy §4 は「口を閉じたままツールを呼ぶと、中継に再試行が無いので即エラー」だった（62-agy-mcp.mjs）。再試行を足した後、口が数秒閉じて開き直しても
// agy にはエラーが見えないか。LLM は 2 ターン（短い応答）。
//   1. 口が開いている: ツールが通る（基準）
//   2. 口を閉じたままターンを送り、数秒後（--reopen-ms。既定 1500）に同じポートで開き直す。中継が再試行して、ツール（一覧・呼び出し）が通るか
// 置き場は worktree の temporary/zdu-agy-relay/。agy の会話は ~/.gemini/antigravity-cli に残る（終わりに会話 id を出す）。
//
//   node scripts/zero-downtime/agy/relay-retry.mjs [--model <id>] [--reopen-ms <ms>]
// 再試行なしとの対照は、中継の env に PLY_RELAY_RETRY_MS=0 を付けて流す（中継は agy の env を継ぐ）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HolderSim } from '../codex/holder-sim.mjs';
import { createMcpBridge } from '../../../core/mcp-bridge.mjs';
import { agentDefinition } from '../../../core/backends/antigravity-context.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const model = flag('--model', 'gemini-3.8-flash-low');
const reopenMs = Number(flag('--reopen-ms', 1500));
const base = path.join(repo, 'temporary', 'zdu-agy-relay');
fs.rmSync(base, { recursive: true, force: true });
const work = path.join(base, 'work'), ctx = path.join(base, 'ctx');
fs.mkdirSync(path.join(ctx, '.agents', 'agents', 'ply-context'), { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(ctx, '.agents', 'agents', 'ply-context', 'agent.md'),
  agentDefinition({ owners: {}, prompt: 'Probe agent. Follow the user instructions literally.', cwd: work, home: ctx, locale: 'en', contextEnabled: true, electron: false }));
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let calls = 0;
const bridge = createMcpBridge({ path: '/mcp/context', serverName: 'Pleiad Context',
  tools: () => [{ name: 'probe_ping', description: 'Returns a pong token. Call with no arguments.', inputSchema: { type: 'object', properties: {} } }],
  call: async () => `pong-token-${++calls}` });
let srv, port = 0;
const sockets = new Set();
const openServer = () => new Promise(resolve => {
  srv = http.createServer((req, res) => bridge.handle(req, res));
  srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  srv.listen(port, '127.0.0.1', () => { port = srv.address().port; resolve(); });
});
const closeServer = async () => { srv.closeAllConnections?.(); for (const s of sockets) s.destroy(); await new Promise(resolve => srv.close(resolve)); };
await openServer();
const opened = bridge.open({ origin: `http://127.0.0.1:${port}`, locale: 'en' });
const env = { ...process.env, PLY_CONTEXT_URL: opened.url, PLY_CONTEXT_AUTHORIZATION: opened.headers.Authorization, PLY_CONTEXT_LOCALE: 'en' };
const h = new HolderSim('agy', ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '10m', '--model', model,
  '--add-dir', ctx, '--agent', 'ply-context', '--dangerously-skip-permissions'], { cwd: work, env });
const events = [];
h.sink = line => { try { events.push(JSON.parse(line)); } catch { /* 行でないもの */ } };
const user = text => `${JSON.stringify({ event: 'user', message: { content: text } })}\n`;
let conv = null;
async function turn(label, prompt, { whileSending = null } = {}) {
  const n0 = events.length, started = Date.now();
  h.write(user(prompt));
  const during = whileSending?.();
  while (!events.slice(n0).some(e => e.event === 'result') && Date.now() - started < 120_000) await sleep(150);
  await during;
  const slice = events.slice(n0);
  conv ??= slice.find(e => e.conversation_id)?.conversation_id ?? null;
  const result = slice.find(e => e.event === 'result')?.result;
  log(`${label}: ${result?.status ?? 'NO RESULT'} (${Date.now() - started} ms) response=${JSON.stringify(result?.response).slice(0, 300)}`);
  return result;
}
let ok = false;
try {
  log('agy', model, 'relay retry probe');
  const r1 = await turn('1. 口が開いている', 'Call the MCP tool probe_ping exactly once and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.');
  const base1 = calls;
  await closeServer();
  log(`--- 口を閉じた。ターンを送り、${reopenMs} ms 後に同じポートで開き直す`);
  const r2 = await turn(`2. 閉じたまま送って ${reopenMs} ms 後に開き直す`, 'Call the MCP tool probe_ping once more and tell me the exact token it returned. If the tool fails or does not exist, say FAILED and quote the error.', {
    whileSending: async () => { await sleep(reopenMs); await openServer(); log('--- 口を開き直した'); } });
  log('口が閉じていた間に始めたターンで、開き直した口が受けた呼び出し:', calls - base1);
  ok = /pong-token-1/.test(r1?.response ?? '') && /pong-token-2/.test(r2?.response ?? '') && calls - base1 === 1;
} finally {
  log('CONVERSATION_ID(for cleanup):', conv, '| stderr:', h.err.slice(0, 300));
  try { h.child.stdin.end(); } catch { /* 終わっている */ }
  await Promise.race([h.exited, sleep(15_000)]);
  if (h.exit === null) h.kill();
  try { await closeServer(); } catch { /* 閉じている */ }
  await sleep(800);
  fs.rmSync(base, { recursive: true, force: true });
  console.log(JSON.stringify({ ok }));
  process.exit(ok ? 0 : 1);
}
