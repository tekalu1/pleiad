import crypto from 'node:crypto';
import { agentT } from './i18n.mjs';

export const AGENTS_MCP_PATH = '/mcp/agents';
// 文はエージェントに渡すので会話の言語で引く（agent 名前空間。docs/design.md「多言語対応」）。en は以前の英語の固定文と同じ
/** ply_agents の instructions。locale は会話の言語 */
export const agentInstructions = locale => agentT(locale, 'bridge.instructions');
const str = { type: 'string' };
const tool = (name, description, properties, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
/** ツールの定義。説明は会話の言語。名前と引数（inputSchema）は言語に依らない */
export const agentTools = locale => [
  tool('ply_delegate', agentT(locale, 'bridge.tools.ply_delegate'), { backend: { type: 'string', enum: ['claude', 'codex', 'antigravity'] }, task: str, context: str, cwd: str, model: str, effort: str }, ['backend', 'task']),
  tool('ply_task_status', agentT(locale, 'bridge.tools.ply_task_status'), { taskId: str, offset: { type: 'integer', minimum: 0 } }, ['taskId']),
  tool('ply_task_wait', agentT(locale, 'bridge.tools.ply_task_wait'), { taskId: str, seconds: { type: 'integer', minimum: 1, maximum: 30 } }, ['taskId']),
  tool('ply_task_send', agentT(locale, 'bridge.tools.ply_task_send'), { taskId: str, message: str }, ['taskId', 'message']),
  tool('ply_task_cancel', agentT(locale, 'bridge.tools.ply_task_cancel'), { taskId: str }, ['taskId']),
  tool('ply_task_list', agentT(locale, 'bridge.tools.ply_task_list'), {}),
  tool('ply_usage', agentT(locale, 'bridge.tools.ply_usage'), { backend: str }),
];
// 子タスクを始める・動かすツール。読み取り・計画モードの会話からは呼ばせない（core/server.mjs）。
// ply_usage や ply_task_status などの読むだけのツールは含めない
export const DELEGATING_TOOLS = ['ply_delegate', 'ply_task_send'];

// Dedicated, stable names: never remap these tools through the external-MCP hash bridge.
export function createAgentBridge({ call }) {
  const bindings = new Map();
  return {
    // locale は接続した会話の言語。橋は会話ごとに開くので、instructions・ツールの説明・エラーはその会話の言語で返す
    open({ origin, owner, locale }) {
      const token = crypto.randomBytes(32).toString('hex'); bindings.set(token, { owner, locale });
      return { url: origin + AGENTS_MCP_PATH, headers: { Authorization: `Bearer ${token}` }, instructions: agentInstructions(locale),
        close: () => bindings.delete(token) };
    },
    async handle(req, res) {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const binding = bindings.get(token);
      if (!binding) return reply(401, { error: 'Unauthorized' });
      const { owner, locale } = binding;
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
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'ply_agents', version: '1.0.0' }, instructions: agentInstructions(locale) };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: agentTools(locale) };
      else if (m.method === 'tools/call') {
        try {
          const definition = agentTools(locale).find(t => t.name === m.params?.name);
          const args = m.params?.arguments ?? {};
          if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(definition.inputSchema.properties, k))) throw new Error(agentT(locale, 'bridge.invalidTool'));
          const data = await call(await owner(), definition.name, args, { locale });
          result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch (e) { result = { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] }; }
      } else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      reply(200, { jsonrpc: '2.0', id: m.id, result });
    },
  };
}
