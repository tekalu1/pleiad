// agy（Antigravity CLI）に Pleiad のコンテキスト（ply_context）を渡す stdio MCP の中継。
//
// agy には会話ごとに HTTP の MCP を渡す口が無い（CLI 引数も env も無い。設定はユーザー全体の
// ~/.gemini/config/mcp_config.json かワークスペースの .agents/ だけ）。そこで Pleiad は、自分の置き場に作った
// カスタムエージェント（agent.md の mcpServers）にこのスクリプトを stdio の MCP として書き、agy を
// `--add-dir <その置き場> --agent <名前>` で起こす。agy は MCP の子プロセスに自分の環境変数を引き継ぐ
// （agy 1.2.7 で実測）ので、接続先とトークンはファイルに書かず、agy を起こすときの env だけで渡す:
//   PLY_CONTEXT_URL            ply_context の URL（http://127.0.0.1:<port>/mcp/context）
//   PLY_CONTEXT_AUTHORIZATION  `Bearer <会話ごとのトークン>`
//   PLY_CONTEXT_LOCALE         会話の言語（ja|en）。agy へ返すエラーの言語（agent 名前空間）。無ければ英語
// 受け取った JSON-RPC をそのまま Pleiad へ POST し、返事を stdout へ書く。env が無ければ（利用者が手で
// このエージェントを選んだなど）ツールを持たない MCP として振る舞う。
import readline from 'node:readline';
import { agentT } from './i18n.mjs';

const url = process.env.PLY_CONTEXT_URL;
const authorization = process.env.PLY_CONTEXT_AUTHORIZATION;
const locale = process.env.PLY_CONTEXT_LOCALE;
const connected = Boolean(url && /^Bearer [a-f0-9]{64}$/.test(authorization ?? ''));
const FORWARDED = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get']);
// ツールの呼び出しは Pleiad 側で最長 300 秒まで待つ（context-bridge.mjs）。それより少し長く待つ
const CALL_TIMEOUT_MS = 330_000;

const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function forward(message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (message.id === undefined) { await response.body?.cancel().catch(() => {}); return; }
  if (response.status === 401) return fail(message.id, -32001, agentT(locale, 'relay.inactive'));
  if (!response.ok) return fail(message.id, -32603, agentT(locale, 'relay.unreachableStatus', { status: response.status }));
  const body = await response.json();
  write({ ...body, id: message.id });
}

function local(message) {
  if (message.method === 'initialize') {
    return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Pleiad Context', version: '1.0.0' } } });
  }
  if (message.method === 'ping') return write({ jsonrpc: '2.0', id: message.id, result: {} });
  if (message.method === 'tools/list') return write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  return fail(message.id, -32601, 'Method not found');
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') continue;
  // 通知（id なし）は Pleiad へ流すだけ。agy が最初に送る server/discover など、知らない要求は MCP の約束どおり断る
  if (message.id === undefined) {
    if (connected && message.method.startsWith('notifications/')) forward(message).catch(() => {});
    continue;
  }
  if (!connected || !FORWARDED.has(message.method)) { local(message); continue; }
  forward(message).catch(error => fail(message.id, -32603, agentT(locale, 'relay.unreachable', { error: error?.message ?? error })));
}
