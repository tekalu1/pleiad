// agy（Antigravity CLI）に Pleiad のコンテキスト（ply_context）とコンピューターの操作（ply_computer）を渡す stdio MCP の中継。
//
// agy には会話ごとに HTTP の MCP を渡す口が無い（CLI 引数も env も無い。設定はユーザー全体の
// ~/.gemini/config/mcp_config.json かワークスペースの .agents/ だけ）。そこで Pleiad は、自分の置き場に作った
// カスタムエージェント（agent.md の mcpServers）にこのスクリプトを stdio の MCP として書き、agy を
// `--add-dir <その置き場> --agent <名前>` で起こす。agy は MCP の子プロセスに自分の環境変数を引き継ぐ
// （agy 1.2.7 で実測）ので、接続先とトークンはファイルに書かず、agy を起こすときの env だけで渡す:
//   PLY_CONTEXT_URL            ply_context の URL（http://127.0.0.1:<port>/mcp/context）
//   PLY_CONTEXT_AUTHORIZATION  `Bearer <会話ごとのトークン>`
//   PLY_CONTEXT_LOCALE         会話の言語（ja|en）。agy へ返すエラーの言語（agent 名前空間）。無ければ英語
// `--computer` を付けて起こした 2 本目は ply_computer（/mcp/computer）を中継し、PLY_COMPUTER_URL / PLY_COMPUTER_AUTHORIZATION を読む
// （docs/computer-use.md「エージェントへの渡し方」）。agy はツールの定義をサーバー名の階層なしで書くので、ツール名に
// ply_computer_ を付けて見せ、呼び出しでは外して Pleiad へ渡す（core/backends/computer-delivery.mjs の AGY_TOOL_PREFIX）。
// `--browser` を付けて起こした 3 本目は ply_browser（/mcp/browser。内蔵ブラウザーのプロフィールの一覧と切り替え、ADR 0077）を中継し、
// PLY_BROWSER_URL / PLY_BROWSER_AUTHORIZATION を読む。ツール名（list_browser_profiles・use_browser_profile）は衝突しにくいので付け外ししない。
// 受け取った JSON-RPC をそのまま Pleiad へ POST し、返事を stdout へ書く。env が無ければ（利用者が手で
// このエージェントを選んだなど）ツールを持たない MCP として振る舞う。
import readline from 'node:readline';
import { agentT } from './i18n.mjs';

const computer = process.argv.includes('--computer');
const browser = !computer && process.argv.includes('--browser');
// computer-delivery.mjs の AGY_TOOL_PREFIX と同じ（中継は i18n 以外を読み込まずに軽く起こす）
const TOOL_PREFIX = 'ply_computer_';
const url = computer ? process.env.PLY_COMPUTER_URL : browser ? process.env.PLY_BROWSER_URL : process.env.PLY_CONTEXT_URL;
const authorization = computer ? process.env.PLY_COMPUTER_AUTHORIZATION : browser ? process.env.PLY_BROWSER_AUTHORIZATION : process.env.PLY_CONTEXT_AUTHORIZATION;
const locale = process.env.PLY_CONTEXT_LOCALE;
const connected = Boolean(url && /^Bearer [a-f0-9]{64}$/.test(authorization ?? ''));
const FORWARDED = new Set(computer || browser ? ['initialize', 'ping', 'tools/list', 'tools/call']
  : ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get']);
// ツールの呼び出しは Pleiad 側で最長 300 秒まで待つ（context-bridge.mjs）。それより少し長く待つ。
// ply_computer のロックの待ちは、橋が 150 秒ごとに分けて返す（agy は 1 回の呼び出しを 3 分で切り、設定では伸びない）
const CALL_TIMEOUT_MS = 330_000;

const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

/** ply_computer の名前の付け外し。tools/list の名前に付け、tools/call の名前から外す */
function outgoing(message) {
  if (!computer || message.method !== 'tools/call' || typeof message.params?.name !== 'string') return message;
  const name = message.params.name.startsWith(TOOL_PREFIX) ? message.params.name.slice(TOOL_PREFIX.length) : message.params.name;
  return { ...message, params: { ...message.params, name } };
}
function incoming(method, body) {
  if (!computer || method !== 'tools/list' || !Array.isArray(body?.result?.tools)) return body;
  return { ...body, result: { ...body.result, tools: body.result.tools.map(tool => ({ ...tool, name: TOOL_PREFIX + tool.name })) } };
}

async function forward(message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(outgoing(message)),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (message.id === undefined) { await response.body?.cancel().catch(() => {}); return; }
  if (response.status === 401) return fail(message.id, -32001, agentT(locale, 'relay.inactive'));
  if (!response.ok) return fail(message.id, -32603, agentT(locale, 'relay.unreachableStatus', { status: response.status }));
  const body = await response.json();
  write({ ...incoming(message.method, body), id: message.id });
}

function local(message) {
  if (message.method === 'initialize') {
    return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: computer ? 'Pleiad Computer' : browser ? 'Pleiad Browser' : 'Pleiad Context', version: '1.0.0' } } });
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
