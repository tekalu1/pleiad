// ply_control（Pleiad の操作の一覧。ADR 0081）を 3 つのエージェントへ渡す形。LLM も本物の CLI も呼ばない（tests/unit/computer-delivery.mjs と同じ作り）:
//   - Claude: SDK の query を身代わりにして、mcpServers・env（会話のシェルへ渡す PLEIAD_CONTROL_*）・指示文・ツールごとの承認を見る
//   - Codex: app-server の rpc を身代わりにして、thread/start の config（mcp_servers.ply_control・shell_environment_policy.set・developerInstructions）を見る
//   - Antigravity: エージェント定義と環境変数（prepareAgent）と、4 本目の接続先として束ねる中継（agy は mcpServers の先頭の 1 本しか起こさない）を別プロセスで見る
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../lib/server.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';
import { rpc } from '../../core/backends/codex-rpc.mjs';
import { agentDefinition, prepareAgent } from '../../core/backends/antigravity-context.mjs';
import { plyParts, PLY_PARTS } from '../../core/instruction-amount.mjs';
import { createPlyMcp } from '../../core/ply-mcp.mjs';

export const name = 'control-delivery';
export const title = 'ply_control: 3 つのエージェントへの注入（MCP・環境変数・指示文・承認）と、agy の中継への束ね方';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'b'.repeat(64);
const runtime = {
  url: 'http://127.0.0.1:1/mcp/control', headers: { Authorization: `Bearer ${TOKEN}` }, instructions: 'CONTROL-INSTRUCTIONS',
  env: { PLEIAD_CONTROL_URL: 'http://127.0.0.1:1', PLEIAD_CONTROL_TOKEN: TOKEN },
};
const other = { ...runtime, url: 'http://127.0.0.1:2/mcp/control', headers: { Authorization: `Bearer ${'c'.repeat(64)}` }, env: { PLEIAD_CONTROL_URL: 'http://127.0.0.1:2', PLEIAD_CONTROL_TOKEN: 'c'.repeat(64) } };

function fakeClaudeSdk() {
  const q = { options: null, close() {}, interrupt: async () => ({}) };
  let release;
  const gate = new Promise((r) => { release = r; });
  q.finish = () => release();
  q[Symbol.asyncIterator] = async function* () { await gate; yield { type: 'result', subtype: 'success', num_turns: 1, session_id: 'claude-control' }; };
  const query = ({ prompt, options }) => { q.options = options; (async () => { for await (const _ of prompt) { /* 入力は読み捨てる */ } })(); return q; };
  return { q, restore: setClaudeSdkForTest({ query, executable: () => 'claude-fake' }) };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/** 中継を起こし、JSON-RPC を流して返事を集める */
async function relay(args, env, messages) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('PLY_')) delete base[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs'), ...args], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  const expected = messages.filter((m) => m.id !== undefined).length;
  for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < expected; i++) await sleep(50);
  child.kill();
  return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export default async function (t) {
  // ---- 共通
  const registry = createPlyMcp({ dataDir: path.join(ROOT, 'temporary', 'no-such-dir'), secrets: {} });
  const rejects = async (name) => { try { await registry.save({ name, value: { transport: 'http', url: 'https://x.example/' }, mode: 'add' }); return false; } catch (e) { return e.code === 'INVALID'; } };
  t.ok('予約名: ply_control を外部 MCP の登録名にできない（ply_agents・ply_browser と同じ）', await rejects('ply_control') && await rejects('ply_agents') && await rejects('ply_browser'));
  t.ok('指示の量の内訳に control があり、渡した文だけ数える', PLY_PARTS.includes('control') && plyParts({ plyAgents: false, control: 'x'.repeat(100) }).map((p) => p.id).join() === 'control' && plyParts({ plyAgents: true }).length === 0);
  t.ok('指示の量の内訳は、ply_agents を受け取らないエージェントにも control を数える', plyParts({ plyAgents: false, control: 'abc' }).some((p) => p.id === 'control'));

  // ---- Claude
  {
    const { q, restore } = fakeClaudeSdk();
    let asked = 0;
    try {
      const done = claude.runTurn({ prompt: 'p', sessionId: null, cwd: process.cwd(), mode: 'default', locale: 'ja', emit: () => {}, askPermission: async () => { asked++; return { allow: false }; },
        signal: new AbortController(), control: {}, hostSessionId: 'host-control', controlRuntime: runtime });
      done.catch(() => {});
      for (let i = 0; i < 200 && !q.options; i++) await sleep(5);
      const server = q.options?.mcpServers?.ply_control;
      t.ok('Claude: mcpServers に ply_control（http・Bearer）', server?.type === 'http' && server.url === runtime.url && server.headers?.Authorization === runtime.headers.Authorization, JSON.stringify(server));
      t.ok('Claude: 会話のシェルへ PLEIAD_CONTROL_URL・PLEIAD_CONTROL_TOKEN を渡す（CLI がこの会話に束縛される）', q.options?.env?.PLEIAD_CONTROL_URL === runtime.env.PLEIAD_CONTROL_URL && q.options.env.PLEIAD_CONTROL_TOKEN === TOKEN);
      t.ok('Claude: 指示文を systemPrompt.append に足す', q.options?.systemPrompt?.append?.includes('CONTROL-INSTRUCTIONS'), JSON.stringify(q.options?.systemPrompt ?? null).slice(0, 200));
      const decision = await q.options?.canUseTool?.('mcp__ply_control__call_op', { op: 'sessions.list' }, { signal: new AbortController().signal, suggestions: [] });
      t.ok('Claude: ply_control はツールごとに聞かずに allow（承認は registry.invoke が会話の承認モードで決める）', decision?.behavior === 'allow' && asked === 0, JSON.stringify(decision));
      const lookalike = await q.options?.canUseTool?.('mcp__ply_control_x__call_op', {}, { signal: new AbortController().signal, suggestions: [] });
      t.ok('Claude: 名前の似た別のサーバーのツールは今までどおり聞く', lookalike?.behavior === 'deny' && asked === 1, JSON.stringify(lookalike));
      q.finish();
      await Promise.race([done.catch(() => {}), sleep(3000)]);
    } finally { restore(); }
  }
  {
    const { q, restore } = fakeClaudeSdk();
    try {
      const done = claude.runTurn({ prompt: 'p', sessionId: null, cwd: process.cwd(), mode: 'default', locale: 'ja', emit: () => {}, askPermission: async () => ({ allow: true }), signal: new AbortController(), control: {}, hostSessionId: 'host-control-2' });
      done.catch(() => {});
      for (let i = 0; i < 200 && !q.options; i++) await sleep(5);
      t.ok('Claude: controlRuntime が無ければ（直接呼ぶテスト）何も足さない', q.options && !q.options.mcpServers?.ply_control && !('PLEIAD_CONTROL_TOKEN' in (q.options.env ?? {})) && !String(q.options.systemPrompt?.append ?? '').includes('CONTROL-INSTRUCTIONS'));
      q.finish();
      await Promise.race([done.catch(() => {}), sleep(3000)]);
    } finally { restore(); }
  }

  // ---- Codex
  const originals = { request: rpc.request, attach: rpc.attach, claimOrphan: rpc.claimOrphan };
  const requests = [];
  let handlers;
  rpc.attach = (_id, h) => { handlers = h; return () => {}; };
  rpc.claimOrphan = (h) => { handlers = h; return () => {}; };
  rpc.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `control-thread-${requests.length}` } };
    if (method !== 'turn/start') throw new Error(method);
    queueMicrotask(() => handlers.onNotification('turn/completed', { turn: { id: 't', status: 'completed' } }));
    return { turn: { id: 't' } };
  };
  try {
    await codex.runTurn({ prompt: 'fixture', cwd: process.cwd(), mode: 'default', locale: 'ja', emit: () => {}, controlRuntime: runtime });
    const start = requests.find((r) => r.method === 'thread/start')?.params;
    const server = start?.config?.['mcp_servers.ply_control'];
    t.ok('Codex: thread/start の config に ply_control（Bearer・approve・required: false）', server?.url === runtime.url && server.http_headers?.Authorization === runtime.headers.Authorization && server.required === false && server.default_tools_approval_mode === 'approve', JSON.stringify(server));
    t.ok('Codex: 会話のシェルの環境変数は、スレッドごとの shell_environment_policy.set で渡す（app-server は全会話で 1 本なのでプロセスの env では渡せない）',
      start?.config?.['shell_environment_policy.set']?.PLEIAD_CONTROL_TOKEN === TOKEN && start.config['shell_environment_policy.set'].PLEIAD_CONTROL_URL === runtime.env.PLEIAD_CONTROL_URL, JSON.stringify(start?.config?.['shell_environment_policy.set']));
    t.ok('Codex: developerInstructions に指示文', start?.developerInstructions?.includes('CONTROL-INSTRUCTIONS'), String(start?.developerInstructions ?? '').slice(-200));

    requests.length = 0;
    await codex.runTurn({ prompt: 'fixture', cwd: process.cwd(), mode: 'default', locale: 'ja', emit: () => {}, controlRuntime: other,
      browserEnv: { AGENT_BROWSER_CONFIG: 'cfg', AGENT_BROWSER_SESSION: 'ses', AGENT_BROWSER_SOCKET_DIR: 'dir', AGENT_BROWSER_NAMESPACE: 'ns' } });
    const second = requests.find((r) => r.method === 'thread/start')?.params;
    const env = second?.config?.['shell_environment_policy.set'];
    t.ok('Codex: 内蔵ブラウザーの環境変数と束ねて 1 つの shell_environment_policy.set にする（片方が他方を消さない）',
      env?.AGENT_BROWSER_CONFIG === 'cfg' && env.AGENT_BROWSER_NAMESPACE === 'ns' && env.PLEIAD_CONTROL_TOKEN === 'c'.repeat(64), JSON.stringify(env));
    t.ok('Codex: 会話ごとに別のトークン（別の会話の接続情報が混ざらない）', second?.config?.['mcp_servers.ply_control']?.http_headers?.Authorization === other.headers.Authorization && !JSON.stringify(second.config).includes(TOKEN));

    requests.length = 0;
    await codex.runTurn({ prompt: 'fixture', cwd: process.cwd(), mode: 'default', locale: 'ja', emit: () => {}, browserEnv: { AGENT_BROWSER_CONFIG: 'cfg' } });
    const plain = requests.find((r) => r.method === 'thread/start')?.params;
    t.ok('Codex: controlRuntime が無ければ config にも指示にも足さない（ブラウザーの環境変数は今までどおり）', plain && !Object.keys(plain.config).some((k) => k.includes('ply_control'))
      && plain.config['shell_environment_policy.set']?.AGENT_BROWSER_CONFIG === 'cfg' && !('PLEIAD_CONTROL_URL' in plain.config['shell_environment_policy.set']), JSON.stringify(Object.keys(plain?.config ?? {})));
  } finally { Object.assign(rpc, originals); }

  // ---- Antigravity: エージェント定義と環境
  const frontOf = (text) => Object.fromEntries(text.split('---')[1].trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  const serversOf = (def) => JSON.parse(frontOf(def).mcpServers);
  const base = { owners: { instruction: 'native', skill: 'native', mcp: 'native' }, prompt: 'P', cwd: '/w', home: '/h', locale: 'ja', execPath: 'node', electron: false };
  const aloneControl = serversOf(agentDefinition({ ...base, contextEnabled: false, controlEnabled: true }));
  t.ok('agy: control だけなら ply_control の中継を 1 本（--control）', aloneControl.length === 1 && aloneControl[0].serverName === 'ply_control' && aloneControl[0].args.at(-1) === '--control', JSON.stringify(aloneControl));
  const bundled = serversOf(agentDefinition({ ...base, contextEnabled: true, computerEnabled: true, browserEnabled: true, controlEnabled: true }));
  t.ok('agy: mcpServers の先頭の 1 本しか起こさないので、context・computer・browser・control は 1 本の中継に束ねる', bundled.length === 1
    && bundled[0].args.slice(1).join() === '--context,--computer,--browser,--control' && bundled[0].serverName === 'ply_context', JSON.stringify(bundled));
  t.ok('agy: control を渡さなければ今までどおり（旗に --control が出ない）', !serversOf(agentDefinition({ ...base, contextEnabled: true, browserEnabled: true })).some((s) => s.args.includes('--control')));
  const withContext = serversOf(agentDefinition({ ...base, contextEnabled: true, controlEnabled: true }));
  t.ok('agy: context と control の 2 つも束ねる', withContext.length === 1 && withContext[0].args.slice(1).join() === '--context,--control');

  const prepared = await prepareAgent({ owners: base.owners, prompt: 'P', cwd: process.cwd(), locale: 'ja', context: true, control: { url: runtime.url, authorization: runtime.headers.Authorization, env: runtime.env } });
  try {
    t.ok('agy: 置き場の agent.md に --control の中継が書かれる', /--control/.test(fs.readFileSync(path.join(prepared.home, '.agents', 'agents', 'ply-context', 'agent.md'), 'utf8')));
    t.ok('agy: env に中継の接続先（PLY_CONTROL_*）と、会話のシェルの CLI の接続情報（PLEIAD_CONTROL_*）', prepared.env.PLY_CONTROL_URL === runtime.url && prepared.env.PLY_CONTROL_AUTHORIZATION === runtime.headers.Authorization
      && prepared.env.PLEIAD_CONTROL_URL === runtime.env.PLEIAD_CONTROL_URL && prepared.env.PLEIAD_CONTROL_TOKEN === TOKEN, JSON.stringify(Object.keys(prepared.env)));
  } finally { prepared.cleanup(); }
  const without = await prepareAgent({ owners: base.owners, prompt: 'P', cwd: process.cwd(), locale: 'ja', context: true });
  try { t.ok('agy: control を渡さなければ env にも足さない', !Object.keys(without.env).some((k) => k.includes('CONTROL'))); } finally { without.cleanup(); }

  // ---- Antigravity: 中継（別プロセス）
  const seen = [];
  const mk = (label, tools) => listen(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const m = JSON.parse(body); seen.push({ label, auth: req.headers.authorization, method: m.method, name: m.params?.name });
    const result = m.method === 'tools/list' ? { tools } : m.method === 'tools/call' ? { content: [{ type: 'text', text: `${label}:${m.params.name}` }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  const ctl = await mk('control', [{ name: 'list_ops' }, { name: 'call_op' }, { name: 'search_sessions' }]);
  const ctx = await mk('context', [{ name: 'load_skill' }]);
  try {
    const env = { PLY_CONTROL_URL: ctl.url, PLY_CONTROL_AUTHORIZATION: runtime.headers.Authorization, PLY_CONTEXT_URL: ctx.url, PLY_CONTEXT_AUTHORIZATION: `Bearer ${'d'.repeat(64)}` };
    const alone = await relay(['--control'], env, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ply_control_call_op', arguments: { op: 'sessions.list' } } },
    ]);
    t.ok('agy 中継（--control）: ツール名に ply_control_ を付けて見せる（agy はサーバー名の階層なしで書くので、一般的な名前が他と衝突しない）',
      alone[0]?.result?.tools?.map((x) => x.name).join() === 'ply_control_list_ops,ply_control_call_op,ply_control_search_sessions', JSON.stringify(alone[0]));
    t.ok('agy 中継（--control）: 呼び出しでは接頭辞を外し、control の Bearer で Pleiad へ渡す', alone[1]?.result?.content?.[0]?.text === 'control:call_op' && seen.some((s) => s.name === 'call_op' && s.auth === runtime.headers.Authorization), JSON.stringify(alone[1]));

    seen.length = 0;
    const both = await relay(['--context', '--control'], env, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ply_control_list_ops', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'load_skill', arguments: {} } },
    ]);
    t.ok('agy 中継（--context --control）: 一覧を足し合わせる', both[0]?.result?.tools?.map((x) => x.name).sort().join() === 'load_skill,ply_control_call_op,ply_control_list_ops,ply_control_search_sessions', JSON.stringify(both[0]));
    t.ok('agy 中継（束ね）: 名前で振り分ける（ply_control_ は control、それ以外は context。トークンを取り違えない）', both.find((m) => m.id === 2)?.result?.content?.[0]?.text === 'control:list_ops'
      && both.find((m) => m.id === 3)?.result?.content?.[0]?.text === 'context:load_skill'
      && seen.find((s) => s.name === 'list_ops')?.auth === runtime.headers.Authorization && seen.find((s) => s.name === 'load_skill')?.auth === `Bearer ${'d'.repeat(64)}`, JSON.stringify(seen));
    const none = await relay(['--control'], {}, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    t.ok('agy 中継（--control）: 接続先が無ければツールを持たない ply_control として答える', none.find((m) => m.id === 1)?.result?.serverInfo?.name === 'Pleiad Control' && none.find((m) => m.id === 2)?.result?.tools?.length === 0, JSON.stringify(none));
  } finally { await ctl.close(); await ctx.close(); }
}
