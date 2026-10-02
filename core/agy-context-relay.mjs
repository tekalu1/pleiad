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
// `--computer` を付けて起こした中継は ply_computer（/mcp/computer）を中継し、PLY_COMPUTER_URL / PLY_COMPUTER_AUTHORIZATION を読む
// （docs/computer-use.md「エージェントへの渡し方」）。agy はツールの定義をサーバー名の階層なしで書くので、ツール名に
// ply_computer_ を付けて見せ、呼び出しでは外して Pleiad へ渡す（core/backends/computer-delivery.mjs の AGY_TOOL_PREFIX）。
// `--control` を付けて起こした中継は ply_control（/mcp/control。Pleiad の操作の一覧。ADR 0081）を中継し、PLY_CONTROL_URL / PLY_CONTROL_AUTHORIZATION を読む。
// `--browser` を付けて起こした中継は ply_browser（/mcp/browser。内蔵ブラウザーのプロフィールの一覧と切り替え、ADR 0078）を中継し、
// PLY_BROWSER_URL / PLY_BROWSER_AUTHORIZATION を読む。ツール名（list_browser_profiles・use_browser_profile）は衝突しにくいので付け外ししない。
// agy は agent.md の mcpServers に複数書いても先頭の 1 本しか起こさない（1.2.14 で実測。後ろの中継には initialize も来ない）ので、
// 2 つ以上を渡す会話は 1 本の中継に束ねる。`--context` `--computer` `--browser` `--control` を並べて起こすと、接続先ごとの tools/list を足し合わせ、
// 呼び出しは名前で振り分ける（ply_computer_ で始まる名前は computer、ply_control_ で始まる名前は control、list_browser_profiles・use_browser_profile は browser、残りは context）。
// 受け取った JSON-RPC をそのまま Pleiad へ POST し、返事を stdout へ書く。env が無ければ（利用者が手で
// このエージェントを選んだなど）ツールを持たない MCP として振る舞う。
import readline from 'node:readline';
import { agentT } from './i18n.mjs';

// computer-delivery.mjs の AGY_TOOL_PREFIX と同じ（中継は i18n 以外を読み込まずに軽く起こす）
const TOOL_PREFIX = 'ply_computer_';
// core/ops/surfaces/mcp.mjs の ply_control のツール名の接頭辞（同上、軽く起こすため読み込まない）。agy はツールの定義をサーバー名の階層なしで書くので、
// search_sessions のような一般的な名前は他のサーバーと衝突する。tools/list の名前に付け、呼び出しでは外して Pleiad へ渡す
const CONTROL_PREFIX = 'ply_control_';
// core/browser-profiles.mjs の ply_browser のツール名（同上、軽く起こすため読み込まない）
const BROWSER_TOOLS = new Set(['list_browser_profiles', 'use_browser_profile']);
const locale = process.env.PLY_CONTEXT_LOCALE;
// ツールの呼び出しは Pleiad 側で最長 300 秒まで待つ（context-bridge.mjs）。それより少し長く待つ。
// ply_computer のロックの待ちは、橋が 150 秒ごとに分けて返す（agy は 1 回の呼び出しを 3 分で切り、設定では伸びない）
const CALL_TIMEOUT_MS = 330_000;
const KINDS = {
  context: { url: 'PLY_CONTEXT_URL', authorization: 'PLY_CONTEXT_AUTHORIZATION', server: 'Pleiad Context', methods: ['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'] },
  computer: { url: 'PLY_COMPUTER_URL', authorization: 'PLY_COMPUTER_AUTHORIZATION', server: 'Pleiad Computer', methods: ['initialize', 'ping', 'tools/list', 'tools/call'] },
  browser: { url: 'PLY_BROWSER_URL', authorization: 'PLY_BROWSER_AUTHORIZATION', server: 'Pleiad Browser', methods: ['initialize', 'ping', 'tools/list', 'tools/call'] },
  // ply_control は承認が要る呼び出しも待たずに返る（ADR 0088）。ほかの Pleiad の MCP と同じ 60 秒で切る
  control: { url: 'PLY_CONTROL_URL', authorization: 'PLY_CONTROL_AUTHORIZATION', server: 'Pleiad Control', methods: ['initialize', 'ping', 'tools/list', 'tools/call'], timeoutMs: 60_000 },
};
// 旗の無い起動は ply_context だけ
const wanted = Object.keys(KINDS).filter(kind => process.argv.includes(`--${kind}`));
const upstreams = (wanted.length ? wanted : ['context']).map(kind => {
  const url = process.env[KINDS[kind].url], authorization = process.env[KINDS[kind].authorization];
  return { kind, url, authorization, connected: Boolean(url && /^Bearer [a-f0-9]{64}$/.test(authorization ?? '')), methods: new Set(KINDS[kind].methods), timeoutMs: KINDS[kind].timeoutMs ?? CALL_TIMEOUT_MS };
});
const bundled = upstreams.length > 1;
const live = upstreams.filter(up => up.connected);
const find = kind => live.find(up => up.kind === kind);

const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

/** ply_computer の名前の付け外し。tools/list の名前に付け、tools/call の名前から外す */
const PREFIXES = { computer: TOOL_PREFIX, control: CONTROL_PREFIX };
function outgoing(up, message) {
  const prefix = PREFIXES[up.kind];
  if (!prefix || message.method !== 'tools/call' || typeof message.params?.name !== 'string') return message;
  const name = message.params.name.startsWith(prefix) ? message.params.name.slice(prefix.length) : message.params.name;
  return { ...message, params: { ...message.params, name } };
}
function incoming(up, method, body) {
  const prefix = PREFIXES[up.kind];
  if (!prefix || method !== 'tools/list' || !Array.isArray(body?.result?.tools)) return body;
  return { ...body, result: { ...body.result, tools: body.result.tools.map(tool => ({ ...tool, name: prefix + tool.name })) } };
}

/** 1 つの接続先へ POST する。通知（id なし）は返事を待たず null。失敗は { error: [code, message] } */
async function post(up, message) {
  const response = await fetch(up.url, {
    method: 'POST',
    headers: { authorization: up.authorization, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(outgoing(up, message)),
    signal: AbortSignal.timeout(up.timeoutMs),
  });
  if (message.id === undefined) { await response.body?.cancel().catch(() => {}); return null; }
  if (response.status === 401) return { error: [-32001, agentT(locale, 'relay.inactive')] };
  if (!response.ok) return { error: [-32603, agentT(locale, 'relay.unreachableStatus', { status: response.status })] };
  return { body: incoming(up, message.method, await response.json()) };
}

async function forward(up, message) {
  const reply = await post(up, message);
  if (!reply) return;
  if (reply.error) return fail(message.id, ...reply.error);
  write({ ...reply.body, id: message.id });
}

/** 束ねた中継の tools/list。接続先ごとの一覧を足し合わせる（つながらない接続先は黙って外す） */
async function listBundled(message) {
  const replies = await Promise.all(live.map(up => post(up, message).catch(() => null)));
  const tools = replies.flatMap(reply => (Array.isArray(reply?.body?.result?.tools) ? reply.body.result.tools : []));
  write({ jsonrpc: '2.0', id: message.id, result: { tools } });
}

/** 束ねた中継の initialize。接続先すべてへ送り、context があればその返事（resources・prompts を持つ）を、無ければ先頭の返事を返す */
async function initializeBundled(message) {
  const replies = await Promise.all(live.map(up => post(up, message).catch(() => null)));
  const body = replies[Math.max(0, live.findIndex(up => up.kind === 'context'))]?.body ?? replies.find(reply => reply?.body)?.body;
  if (!body?.result) return local(message);
  write({ ...body, id: message.id });
}

/** 束ねた中継で、この要求を受け持つ接続先。tools/call は名前で、それ以外（resources・prompts）は context */
function target(message) {
  if (message.method !== 'tools/call') return find('context') ?? null;
  const name = message.params?.name;
  if (typeof name === 'string' && name.startsWith(TOOL_PREFIX) && find('computer')) return find('computer');
  if (typeof name === 'string' && name.startsWith(CONTROL_PREFIX) && find('control')) return find('control');
  if (BROWSER_TOOLS.has(name) && find('browser')) return find('browser');
  return find('context') ?? null;
}

function local(message) {
  if (message.method === 'initialize') {
    return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: bundled ? 'Pleiad' : KINDS[upstreams[0].kind].server, version: '1.0.0' } } });
  }
  if (message.method === 'ping') return write({ jsonrpc: '2.0', id: message.id, result: {} });
  if (message.method === 'tools/list') return write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
  return fail(message.id, -32601, 'Method not found');
}

const onError = message => error => fail(message.id, -32603, agentT(locale, 'relay.unreachable', { error: error?.message ?? error }));

for await (const line of readline.createInterface({ input: process.stdin })) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') continue;
  // 通知（id なし）は Pleiad へ流すだけ。agy が最初に送る server/discover など、知らない要求は MCP の約束どおり断る
  if (message.id === undefined) {
    if (message.method.startsWith('notifications/')) for (const up of live) post(up, message).catch(() => {});
    continue;
  }
  if (!live.length) { local(message); continue; }
  if (!bundled) {
    const [up] = live;
    if (up.methods.has(message.method)) forward(up, message).catch(onError(message)); else local(message);
    continue;
  }
  if (message.method === 'initialize') { initializeBundled(message).catch(onError(message)); continue; }
  if (message.method === 'ping') { local(message); continue; }
  if (message.method === 'tools/list') { listBundled(message).catch(onError(message)); continue; }
  const up = target(message);
  if (up?.methods.has(message.method)) forward(up, message).catch(onError(message)); else local(message);
}
