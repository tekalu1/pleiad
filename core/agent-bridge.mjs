import crypto from 'node:crypto';

export const AGENTS_MCP_PATH = '/mcp/agents';
export const AGENT_INSTRUCTIONS = `Pleiad delegation tools (ply_agents MCP): use ply_delegate with an explicit backend (claude, codex, antigravity) to create a Pleiad-managed child conversation. This is distinct from native spawn_agent / agent_job / Agent and their IDs. Use only ply_task_* with ply-task- IDs. ply_delegate returns immediately; Pleiad delivers completion results to this conversation in a later turn. You may continue other work or finish your response. ply_task_wait waits at most 30 seconds, and returns as soon as the child is waiting for a human approval (status: waiting); then tell the user which conversation holds the approval instead of waiting again. ply_task_send queues an additional instruction on the same child conversation. Pass the necessary task context explicitly; private reasoning and the parent transcript are not copied. cwd defaults to this conversation's workspace; use separate worktrees for concurrent edits. ply_usage reads each backend's quota usage (read-only, up to 60 seconds old); check it before heavy or parallel delegation. Do not delegate again merely to acknowledge a task completion. Use delegation only when authorized by the user's task and applicable instructions.`;
const str = { type: 'string' };
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const AGENT_TOOLS = [
  tool('ply_delegate', 'Start a Pleiad-managed task using the explicitly selected backend. Returns taskId immediately; completion is delivered automatically. Separate from native spawn_agent. The child inherits the caller approval strength without exceeding it; a stronger child needs one human approval here.', { backend: { type: 'string', enum: ['claude', 'codex', 'antigravity'] }, task: str, context: str, cwd: str, model: str, effort: str }, ['backend', 'task']),
  tool('ply_task_status', 'Read a Pleiad task and its result. Use nextOffset to read the remainder of a long result. status: waiting means the child is stopped on a human approval; the same card is also shown in this conversation, so tell the user where to approve.', { taskId: str, offset: { type: 'integer', minimum: 0 } }, ['taskId']),
  tool('ply_task_wait', 'Wait up to 30 seconds for a Pleiad task; returns immediately once the child is waiting for a human approval (status: waiting). A still-running result is not a failure; completion will also be delivered automatically. On waiting, stop waiting and tell the user which conversation holds the approval.', { taskId: str, seconds: { type: 'integer', minimum: 1, maximum: 30 } }, ['taskId']),
  tool('ply_task_send', 'Queue an additional instruction for the same Pleiad child conversation, including after completion.', { taskId: str, message: str }, ['taskId', 'message']),
  tool('ply_task_cancel', 'Cancel a Pleiad task and its descendant Pleiad tasks.', { taskId: str }, ['taskId']),
  tool('ply_task_list', 'List only the Pleiad tasks created by this conversation. Does not list native subagent jobs.', {}),
  tool('ply_usage', 'Read subscription quota usage (usedPercent, resetsAt) per backend, or all usable backends when backend is omitted. Call before heavy or parallel delegation and avoid backends that are close to their limit. Values may be up to 60 seconds old.', { backend: str }),
];
// 子タスクを始める・動かすツール。読み取り・計画モードの会話からは呼ばせない（core/server.mjs）。
// ply_usage や ply_task_status などの読むだけのツールは含めない
export const DELEGATING_TOOLS = ['ply_delegate', 'ply_task_send'];

// Dedicated, stable names: never remap these tools through the external-MCP hash bridge.
export function createAgentBridge({ call }) {
  const bindings = new Map();
  return {
    open({ origin, owner }) {
      const token = crypto.randomBytes(32).toString('hex'); bindings.set(token, owner);
      return { url: origin + AGENTS_MCP_PATH, headers: { Authorization: `Bearer ${token}` }, instructions: AGENT_INSTRUCTIONS,
        close: () => bindings.delete(token) };
    },
    async handle(req, res) {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const owner = bindings.get(token);
      if (!owner) return reply(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return reply(405);
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403); } catch { return reply(403); }
      }
      let m;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 256000) return reply(413); chunks.push(chunk); }
        m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return reply(400, { error: 'Invalid JSON' }); }
      if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return reply(400);
      if (m.id === undefined) return reply(202);
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ply_agents', version: '1.0.0' }, instructions: AGENT_INSTRUCTIONS };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: AGENT_TOOLS };
      else if (m.method === 'tools/call') {
        try {
          const definition = AGENT_TOOLS.find(t => t.name === m.params?.name);
          const args = m.params?.arguments ?? {};
          if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(definition.inputSchema.properties, k))) throw new Error('不正なツールまたは引数です');
          const data = await call(await owner(), definition.name, args);
          result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch (e) { result = { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] }; }
      } else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      reply(200, { jsonrpc: '2.0', id: m.id, result });
    },
  };
}
