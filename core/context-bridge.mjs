import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { contextTools, mcpTransportConfig, hash } from './context-runtime.mjs';
import { t, agentT } from './i18n.mjs';

export const CONTEXT_MCP_PATH = '/mcp/context';
const MAX_TOOLS = 500;
// MCP_CONFIG は mcpTransportConfig（core/context-runtime.mjs）の設定の誤り。文言は言語で変わるので code で見る
const configError = e => e?.code === 'INVALID' || e?.code === 'SECRET_LOCKED' || e?.code === 'MCP_CONFIG';

/**
 * 外部 MCP 1 件に接続してツール一覧まで取る。**失敗しても投げない**（1 件のために会話を止めない）。
 * 返り値の status は connected / needs-auth（ログインが要る・トークンが拒まれた）/ failed。
 * item の出所が Pleiad の登録（source: 'ply'）なら、秘密と OAuth のトークンは plyMcp / oauth から取る。
 */
export async function connectServer(item, { cwd, plyMcp, oauth } = {}) {
  const ply = item.origins?.[0]?.source === 'ply';
  const tracker = {};
  let config;
  try {
    if (ply) {
      if (!plyMcp) throw Object.assign(new Error(t('context.bridge.plyUnavailable')), { code: 'INVALID' });
      config = await plyMcp.connection(item.name, cwd);
      if (config.definition.auth === 'oauth') {
        if (!oauth) throw Object.assign(new Error(t('context.bridge.oauthUnavailable')), { code: 'INVALID' });
        // トークンが無ければここで「要ログイン」。ターンの中ではブラウザを開かない
        await oauth.accessToken(item.name, config.definition, config);
        config.fetch = oauth.authFetch(item.name, config.definition, config, tracker);
      }
    } else config = mcpTransportConfig(item, cwd);
  } catch (e) {
    if (e?.code === 'MCP_AUTH_REQUIRED') return { status: 'needs-auth', reason: e.message, ...(e.message === t('mcp.oauth.loginRequired') ? { reasonCode: 'MCP_AUTH_REQUIRED' } : {}) };
    if (!configError(e)) return { status: 'failed', reason: t('context.bridge.configUnreadable') };
    return { status: 'failed', reason: e.unsupported ? t('context.bridge.unsupportedHint', { message: e.message }) : e.message };
  }
  const client = new Client({ name: 'ply-context', version: '1.0.0' }, { capabilities: {} });
  const fetchImpl = config.fetch ?? fetch;
  const transport = config.type === 'stdio' ? new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: 'pipe' })
    : config.type === 'sse' ? new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' }, ...(config.fetch ? { fetch: config.fetch } : {}), eventSourceInit: { fetch: (url, options) => fetchImpl(url, { ...options, headers: { ...options?.headers, ...config.headers }, redirect: 'error' }) } })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' }, ...(config.fetch ? { fetch: config.fetch } : {}) });
  transport.stderr?.resume(); // Do not publish third-party stderr (may contain credentials).
  try {
    await client.connect(transport, { timeout: config.timeout });
    transport.stderr?.resume();
    const caps = client.getServerCapabilities();
    const tools = [];
    let cursor;
    do {
      const list = caps?.tools ? await client.listTools(cursor ? { cursor } : {}, { timeout: config.timeout }) : { tools: [] };
      for (const tool of list.tools) {
        if (item.definition.enabled_tools && !item.definition.enabled_tools.includes(tool.name)) continue;
        if (item.definition.disabled_tools?.includes(tool.name)) continue;
        tools.push(tool);
        if (tools.length > MAX_TOOLS) throw new Error('tool limit');
      }
      cursor = list.nextCursor;
    } while (cursor);
    return { status: 'connected', client, caps, tools };
  } catch (e) {
    await client.close().catch(() => {});
    if (tracker.authRequired || e?.code === 'MCP_AUTH_REQUIRED') {
      const reason = tracker.authRequired ?? e.message;
      // 「ログインが必要」の定型文なら画面は理由を重ねて出さない（文言ではなく reasonCode で見分ける）
      return { status: 'needs-auth', reason, ...(reason === t('mcp.oauth.loginRequired') ? { reasonCode: 'MCP_AUTH_REQUIRED' } : {}) };
    }
    if (e?.code === 401 || /\b401\b/.test(String(e?.message ?? ''))) {
      return { status: 'needs-auth', reason: ply ? t('context.bridge.authRequiredPly') : t('context.bridge.authRequiredNative') };
    }
    return { status: 'failed', reason: e?.message === 'tool limit' ? t('context.bridge.tooManyTools', { max: MAX_TOOLS }) : t('context.bridge.connectFailed') };
  }
}

export function createContextBridge({ plyMcp, oauth } = {}) {
  const bindings = new Map();
  /**
   * token を渡すと、その値で束ねる（会話のあいだ同じ値を使うバックエンド向け。antigravity は agy を会話ごとに
   * 1 本生かし、起動時に受け取った値をターンをまたいで使い続ける）。受け付けるのはこの open が開いている間だけ。
   * 省略時はターンごとに新しい値を作る
   */
  async function open({ runtime, prompt, origin, isActive, changed = async () => {}, progress = () => {}, authorize = async () => true, signal, token: fixed }) {
    if (fixed !== undefined && !/^[a-f0-9]{64}$/.test(fixed)) throw new Error(t('context.bridge.invalidToken'));
    const token = fixed ?? crypto.randomBytes(32).toString('hex'), helpers = contextTools(runtime, prompt);
    const binding = { origin, isActive, runtime, helpers, tools: [...helpers.tools], clients: [], entries: new Map(), calls: new Map(), pending: new Set(), changed, authorize, closed: false };
    const close = async () => {
      if (binding.closed) return;
      binding.closed = true;
      // 同じ token で次のターンが先に束ね直していれば、そちらは消さない
      if (bindings.get(token) === binding) bindings.delete(token);
      await Promise.allSettled(binding.clients.map(c => c.close()));
      await Promise.allSettled([...binding.pending]);
    };
    signal?.addEventListener('abort', () => { void close(); }, { once: true });
    try {
      if (runtime.servers.length > 32) throw new Error(t('context.bridge.tooManyServers'));
      for (const [index, item] of runtime.servers.entries()) {
        if (signal?.aborted || binding.closed) throw new Error(t('context.bridge.aborted'));
        progress({ current: index + 1, total: runtime.servers.length, name: item.name });
        const row = runtime.report.entries.find(e => e.id === item.id);
        const result = await connectServer(item, { cwd: runtime.policy.cwd, plyMcp, oauth });
        if (result.status === 'connected' && binding.closed) { await result.client.close().catch(() => {}); throw new Error(t('context.bridge.aborted')); }
        if (result.status === 'connected' && binding.tools.length + result.tools.length > MAX_TOOLS) {
          await result.client.close().catch(() => {});
          Object.assign(result, { status: 'failed', reason: t('context.bridge.toolTotalExceeded', { max: MAX_TOOLS }) });
        }
        // つながらない 1 件は外して会話を進める。状態と理由は会話の記録（report）に残す
        if (result.status !== 'connected') { row.status = result.status; row.reason = result.reason; if (result.reasonCode) row.reasonCode = result.reasonCode; else delete row.reasonCode; row.tools = 0; await changed(); continue; }
        const { client, caps } = result;
        binding.clients.push(client);
        for (const tool of result.tools) {
          const name = `m_${hash([item.id, tool.name]).slice(0,24)}`;
          binding.tools.push({ ...tool, name, description: `[${item.name} / ${tool.name}] ${tool.description ?? ''}` });
          binding.calls.set(name, { client, name: tool.name, item });
        }
        row.status = 'connected'; row.tools = result.tools.length; delete row.reason; delete row.reasonCode;
        row.capabilities = Object.keys(caps ?? {});
        binding.entries.set(item.id, { client, item, caps });
      }
      if (signal?.aborted || binding.closed) throw new Error(t('context.bridge.aborted'));
      if (binding.entries.size) {
        // ツールの説明はエージェントが読むので会話の言語（runtime.locale）で
        binding.tools.push({ name: 'mcp_resources', description: agentT(runtime.locale, 'context.tools.mcp_resources'), inputSchema: { type:'object',properties:{uri:{type:'string'}},additionalProperties:false } });
        binding.tools.push({ name: 'mcp_prompts', description: agentT(runtime.locale, 'context.tools.mcp_prompts'), inputSchema: { type:'object',properties:{name:{type:'string'},arguments:{type:'object',additionalProperties:{type:'string'}}},additionalProperties:false } });
      }
      bindings.set(token, binding);
      runtime.report.status = 'ready'; await changed();
      // locale は会話の言語。agy（antigravity）はエージェント定義の文と中継のエラーをこの言語で作る。
      // shape: 担当と渡すツールの名前。会話のあいだプロセスを生かすバックエンド（antigravity）は、これが変わったら起こし直す
      // （設定の変更で担当や外部 MCP が変わっても、起動時に受け取ったツール一覧のままになるため）
      const shape = hash([runtime.owners, binding.tools.map(tool => tool.name)]);
      return { owners: runtime.owners, prompt: helpers.prompt, locale: runtime.locale, url: `${origin}${CONTEXT_MCP_PATH}`, headers: { Authorization: `Bearer ${token}` }, shape, close };
    } catch (e) { await close(); throw e; }
  }
  async function metadata(b, kind, params = {}) {
    const resource = kind === 'resources';
    const selected = resource ? params.uri : params.name;
    if (selected) {
      const match = /^ply-mcp:([a-f0-9]+):(.*)$/.exec(selected);
      const entry = match && b.entries.get(match[1]);
      if (!entry) throw new Error('Unknown MCP metadata');
      const key = decodeURIComponent(match[2]);
      return resource ? entry.client.readResource({ uri:key }) : entry.client.getPrompt({name:key,arguments:params.arguments});
    }
    const rows=[];
    for(const [id,{client,caps}] of b.entries) {
      if(!caps?.[kind])continue;
      let cursor;
      do {
        const data=await (resource?client.listResources(cursor?{cursor}:{}):client.listPrompts(cursor?{cursor}:{}));
        for(const item of data[kind]??[]){const field=resource?'uri':'name';rows.push({...item,[field]:`ply-mcp:${id}:${encodeURIComponent(item[field])}`});if(rows.length>500)throw new Error('Metadata limit');}
        cursor=data.nextCursor;
      }while(cursor);
    }
    return {[kind]:rows};
  }
  async function handle(req, res) {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1], b = bindings.get(token);
    if (!b || b.closed || !b.isActive()) return json(401, { error: 'Active context required' });
    if (req.headers.origin && req.headers.origin !== b.origin) return json(403, { error: 'Origin not allowed' });
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    let m;
    try {
      const chunks = []; let bytes = 0;
      req.setTimeout(15000, () => req.destroy());
      for await (const c of req) { bytes += c.length; if (bytes > 1024*1024) return json(413, {}); chunks.push(c); }
      m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return json(400, { error: 'Invalid JSON' }); }
    if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return json(400, {});
    if (!Object.hasOwn(m,'id')) { res.writeHead(202); return res.end(); }
    const reply = result => json(200, { jsonrpc: '2.0', id: m.id, result });
    const error = message => json(200, { jsonrpc: '2.0', id: m.id, error: { code: -32602, message } });
    if (!b.isActive() || b.closed) return error('Turn ended');
    if (m.method === 'initialize') return reply({ protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(m.params?.protocolVersion) ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'Pleiad Context', version: '1.0.0' } });
    if (m.method === 'ping') return reply({});
    if (m.method === 'ply/bootstrap') return reply({ prompt: b.helpers.prompt });
    if (m.method === 'tools/list') return reply({ tools: b.tools });
    if (['resources/list','resources/read','prompts/list','prompts/get'].includes(m.method)) {
      try { return reply(await metadata(b,m.method.startsWith('resources')?'resources':'prompts',m.params)); }
      catch { return error('MCP metadata request failed'); }
    }
    if (m.method !== 'tools/call') return error('Method not supported');
    const call = b.calls.get(m.params?.name);
    if (!b.tools.some(t => t.name === m.params?.name)) return error('Unknown tool');
    const work = (async () => {
      try {
        if (call && !await b.authorize(call.item.name, call.name, m.params.arguments ?? {})) return { isError: true, content: [{type:'text',text:agentT(b.runtime.locale, 'context.errors.mcpDeclined')}] };
        if (b.closed || !b.isActive()) throw new Error('Turn ended');
        const isMetadata=['mcp_resources','mcp_prompts'].includes(m.params.name);
        const result = call ? await call.client.callTool({ name: call.name, arguments: m.params.arguments ?? {} }, undefined,
          { timeout: Math.min(300000, (call.item.definition.tool_timeout_sec ?? 60) * 1000) }) : isMetadata ? {content:[{type:'text',text:JSON.stringify(await metadata(b,m.params.name==='mcp_resources'?'resources':'prompts',m.params.arguments))}]} : await b.helpers.call(m.params.name, m.params.arguments);
        if (call) { const row = b.runtime.report.entries.find(e => e.id === call.item.id); row.calls = (row.calls ?? 0) + 1; }
        await b.changed(); return result;
      } catch { return { isError: true, content: [{ type: 'text', text: agentT(b.runtime.locale, 'context.errors.callFailed') }] }; }
    })();
    b.pending.add(work);
    try { return reply(await work); } finally { b.pending.delete(work); }
  }
  return { open, handle };
}
