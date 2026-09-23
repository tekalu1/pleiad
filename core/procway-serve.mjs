// Runs in a child process, never loads procway's agent dependencies into Pleiad.
// Uses the same native WebSocket server and default session factory as its CLI.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyLimits, startBudgetGateway } from './procway-runtime.mjs';
import { procwayContextSettings } from './backends/context-options.mjs';
import { procwayMcpServers, withPlyCredentials } from './procway-mcp.mjs';

const input = JSON.parse(Buffer.from(process.env.PLY_PROCWAY_RUNTIME, 'base64').toString('utf8'));
delete process.env.PLY_PROCWAY_RUNTIME;
const moduleAt = relative => import(pathToFileURL(path.join(input.src, relative)).href);
const { loadSettings } = await moduleAt('config/load-settings.mjs');
const { applySecretsFromFiles } = await moduleAt('config/load-secrets.mjs');
const { startServer } = await moduleAt('adapters/serve/server.mjs');
await applySecretsFromFiles({ cwd: process.cwd(), onParseError: () => { throw new Error('procway-code の資格情報を読み込めません'); } });
const { settings: native } = await loadSettings({ cwd: process.cwd() });
let context = input.contextRuntime;
if (context) {
  const response = await fetch(context.url, { method: 'POST', headers: { ...context.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ply/bootstrap' }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Pleiad のコンテキストを取得できません');
  const body = await response.json();
  if (typeof body.result?.prompt !== 'string') throw new Error('Pleiad のコンテキスト応答が不正です');
  context = { ...context, prompt: body.result.prompt };
}
const settings = procwayContextSettings(applyLimits(native, input.id, input.provider, input.limits), context);
settings.mcpServers = context?.owners.mcp === 'ply'
  ? procwayMcpServers(settings.mcpServers, [])
  : { ...procwayMcpServers(input.nativeMcp, input.mcpRegistrations), ...(context ? { ply_context: settings.mcpServers.ply_context } : {}) };
// 担当がエージェントでも、同名の Pleiad の登録があれば接続先と資格情報は Pleiad から引く（core/mcp-credential-bridge.mjs）
if (input.plyMcp && context?.owners.mcp !== 'ply') settings.mcpServers = await withPlyCredentials(settings.mcpServers, input.plyMcp);
if (input.agentRuntime) {
  settings.mcpServers.ply_agents = { transport: "http", baseUrl: input.agentRuntime.url, headers: input.agentRuntime.headers, timeoutMs: 60000 };
}
input.visualizeInstructions = [input.visualizeInstructions, input.agentRuntime?.instructions].filter(Boolean).join("\n\n");
if (input.visualizeInstructions) {
  settings.rules ??= {};
  settings.rules.all = [...(settings.rules.all ?? []), input.visualizeInstructions];
  for (const key of Object.keys(settings.rules.projects ?? {})) settings.rules.projects[key] = [...settings.rules.projects[key], input.visualizeInstructions];
}
// The approval mode Pleiad last selected for this conversation. procway's own wake turns carry no
// runTurn options and read settings.approvalMode when a tool is gated, so keep it in step here.
// Updates arrive as JSON lines on stdin; the object is shared by every session this serve creates.
const MODES = new Set(['always-ask', 'auto-readonly', 'full-auto']);
if (MODES.has(input.approvalMode)) settings.approvalMode = input.approvalMode;
let pendingInput = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pendingInput += chunk;
  for (let at = pendingInput.indexOf('\n'); at >= 0; at = pendingInput.indexOf('\n')) {
    const line = pendingInput.slice(0, at);
    pendingInput = pendingInput.slice(at + 1);
    try { const message = JSON.parse(line); if (MODES.has(message.approvalMode)) settings.approvalMode = message.approvalMode; } catch {}
  }
});
process.stdin.on('error', () => {});
let gateway;
if (input.limits && input.provider.type !== 'cli-agent') {
  gateway = await startBudgetGateway(input.provider, input.limits);
  settings.providers[input.id].baseUrl = gateway.baseUrl;
}
let sessionFactory;
if (context?.owners.mcp === 'ply') {
  const { createAgentSession } = await moduleAt('core/index.mjs');
  const { loadSessionState } = await moduleAt('session/store.mjs');
  const { McpToolRegistry } = await moduleAt('mcp/registry.mjs');
  sessionFactory = async ({ settings, cwd, sessionId, origin, allowCreateWithId, hearingReturnMode }) => {
    let state = {};
    if (sessionId) try { state = await loadSessionState({ sessionId }); }
    catch (e) { if (!allowCreateWithId || !/^No session found/.test(e.message)) throw e; }
    // Supplying a registry also bypasses dashboard-distributed native MCP entries.
    return createAgentSession({ settings, cwd, sessionId, origin: state.origin ?? origin, interactive: true, hearingReturnMode,
      messages: state.messages ?? [], title: state.title, procwayMeta: state.procwayMeta ?? null,
      pendingTaskCompletionReminder: Boolean(state.pendingTaskCompletionReminder), mcpRegistry: new McpToolRegistry({ settings, cwd }) });
  };
}
const server = await startServer({ cwd: process.cwd(), settings, port: input.port, host: '127.0.0.1', token: process.env.PROCWAY_SERVE_TOKEN, ...(sessionFactory ? { sessionFactory } : {}) });
console.log(`procway-code serve listening on http://127.0.0.1:${input.port}`);
// Graceful close waits for connected clients, and Pleiad keeps its WebSocket open. Bound it so a
// SIGTERM (proc.kill() on POSIX) still ends the process; Windows kill() never reaches this handler.
const CLOSE_GRACE_MS = 2000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  gateway?.close();
  await Promise.race([server.close(), new Promise(resolve => setTimeout(resolve, CLOSE_GRACE_MS).unref())]).catch(() => {});
  process.exit(0);
});
