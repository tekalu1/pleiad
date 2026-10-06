// ply_browser: エージェントのブラウザー操作のための MCP の口（core/agent-bridge.mjs と同じ型。会話ごとに Bearer の付いた HTTP）。
// 内蔵ブラウザーを渡すターン（デスクトップ版で中継がある）にだけ渡す。ADR 0148 でエージェントの接続先が Chrome の専用の窓に移るまでの骨組みで、
// 載せるツール（Chrome のプロフィールの一覧・hand_to_user・close_browser_window）は browserTools に足す。
// 今は空で、3 つのバックエンドへの渡し方・Bearer の鍵・agy の中継への束ねだけを保つ
import { claimToken } from './mcp-token.mjs';
import { agentT } from './i18n.mjs';

export const BROWSER_MCP_PATH = '/mcp/browser';
export const BROWSER_SERVER = 'ply_browser';

/** ply_browser が出すツールの定義（{ name, description, inputSchema }）。agentT で説明をエージェントの言語にする */
export const browserTools = _locale => [];

/** ply_browser の口。会話ごとに open し、橋は会話の id が決まっても使い回す（agy は会話のあいだ同じトークンを使う） */
export function createBrowserBridge() {
  const bindings = new Map();
  return {
    // token は開き直す口の値（省略なら新しく作る。形が違う・使用中なら投げる）
    open({ origin, owner, locale, token: fixed }) {
      const token = claimToken(bindings, fixed);
      bindings.set(token, { owner, locale });
      return { url: origin + BROWSER_MCP_PATH, headers: { Authorization: `Bearer ${token}` }, close: () => bindings.delete(token) };
    },
    async handle(req, res) {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const binding = bindings.get(token);
      if (!binding) return reply(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return reply(405);
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403); } catch { return reply(403); }
      }
      let m;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 64000) return reply(413); chunks.push(chunk); }
        m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return reply(400, { error: 'Invalid JSON' }); }
      if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return reply(400);
      if (m.id === undefined) return reply(202);
      const { locale } = binding;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: BROWSER_SERVER, version: '1.0.0' } };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: browserTools(locale) };
      // 載せるツールが無いので、呼び出しはどれも断る
      else if (m.method === 'tools/call') result = { isError: true, content: [{ type: 'text', text: agentT(locale, 'browserBridge.invalidTool') }] };
      else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      reply(200, { jsonrpc: '2.0', id: m.id, result });
    },
  };
}
