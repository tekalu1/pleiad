// 外部 MCP の OAuth のテスト用に、ローカルに立てる認可サーバー（RFC 8414・7591・7592・7009）と保護リソース（RFC 9728 + MCP）。
// 実サービスにもブラウザにも触らない。tests/unit/mcp-oauth-more.mjs・mcp-oauth-processes.mjs が使う。
//
// 変えられる振る舞い:
//   rejectLoopbackIp: 'register' | 'authorize'  127.0.0.1 の戻り先を DCR / 認可で拒む（localhost だけ許す AS）
//   cimd: true                                     client_id_metadata_document_supported を示し、https の URL の client_id を受け付ける
//   expiresIn: null                                expires_in を返さない（期限の無いトークン）
//   requiredScope: 'write'                         tools/call にこの scope が要る（無ければ 403 insufficient_scope）
//   authServers: [...]                             保護リソースメタデータの authorization_servers を差し替える（SSRF の確かめ）
//   prmRedirect: 'http://…'                        保護リソースメタデータを 302 でほかへ飛ばす
//   sse: true                                      旧方式の SSE（GET /sse ＋ POST /messages）で MCP を出す
//   tokenDelay: ms                                 トークン要求の応答を遅らせる（同時のリフレッシュを重ねる）
import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

export const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
const readBody = async req => { let s = ''; for await (const c of req) s += c; return s; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function mockOAuth({ dcr = true, manualClient = 'manual-client', tokenDelay = 0, rejectLoopbackIp, cimd = false, expiresIn = 3600,
  requiredScope, authServers, prmRedirect, sse = false, defaultScope = 'read' } = {}) {
  const as = { registrations: [], registerAttempts: [], deleted: [], authorize: [], tokenRequests: [], refreshCalls: 0, revoked: [], codes: new Map(),
    clients: new Map([[manualClient, { redirect_uris: null }]]), refresh: new Map(), access: new Map(), n: 0 };
  let asOrigin, rsOrigin;
  const loopbackIp = uri => { try { return new URL(uri).hostname === '127.0.0.1'; } catch { return false; } };
  const asServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, asOrigin);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: asOrigin, authorization_endpoint: `${asOrigin}/authorize`, token_endpoint: `${asOrigin}/token`, revocation_endpoint: `${asOrigin}/revoke`,
        ...(dcr ? { registration_endpoint: `${asOrigin}/register` } : {}), ...(cimd ? { client_id_metadata_document_supported: true } : {}),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'] });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      as.registerAttempts.push(body);
      if (rejectLoopbackIp === 'register' && body.redirect_uris?.some(loopbackIp)) return json(400, { error: 'invalid_redirect_uri', error_description: 'loopback IP literal is not allowed; use localhost' });
      const client_id = `dcr-${as.registrations.length + 1}`;
      const token = crypto.randomBytes(16).toString('hex');
      as.registrations.push(body); as.clients.set(client_id, { redirect_uris: body.redirect_uris, token });
      return json(201, { ...body, client_id, client_id_issued_at: Math.floor(Date.now() / 1000), registration_access_token: token, registration_client_uri: `${asOrigin}/register/${client_id}` });
    }
    const manage = /^\/register\/([^/]+)$/.exec(url.pathname);
    if (manage && req.method === 'DELETE') {
      const client = as.clients.get(manage[1]);
      if (!client || req.headers.authorization !== `Bearer ${client.token}`) return json(401, { error: 'invalid_token' });
      as.clients.delete(manage[1]); as.deleted.push(manage[1]);
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      as.authorize.push(q);
      const known = as.clients.get(q.client_id) ?? (cimd && /^https:\/\//.test(q.client_id) ? { redirect_uris: null } : null);
      if (!known) return json(400, { error: 'invalid_client' });
      if (rejectLoopbackIp === 'authorize' && loopbackIp(q.redirect_uri)) { res.writeHead(400, { 'content-type': 'text/html' }); return res.end('<p>Error: invalid redirect_uri (127.0.0.1 is not registered)</p>'); }
      // 登録済みの戻り先と照らす（ループバックはポート違いを許す RFC 8252 §7.3）
      if (known.redirect_uris && !known.redirect_uris.some(r => { const a = new URL(r), b = new URL(q.redirect_uri); return a.hostname === b.hostname && a.pathname === b.pathname; })) return json(400, { error: 'invalid_request', error_description: 'redirect_uri mismatch' });
      const code = `code-${++as.n}`;
      as.codes.set(code, q);
      const back = new URL(q.redirect_uri); back.searchParams.set('code', code); back.searchParams.set('state', q.state);
      res.writeHead(302, { location: back.href }); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      as.tokenRequests.push(form);
      if (tokenDelay) await sleep(tokenDelay);
      const issue = scope => {
        const access = `at-${++as.n}`, refresh = `rt-${++as.n}`;
        as.access.set(access, scope ?? ''); as.refresh.set(refresh, scope ?? '');
        return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', ...(expiresIn === null ? {} : { expires_in: expiresIn }), scope });
      };
      if (form.grant_type === 'authorization_code') {
        const q = as.codes.get(form.code);
        as.codes.delete(form.code);
        if (!q || q.redirect_uri !== form.redirect_uri) return json(400, { error: 'invalid_grant' });
        if (b64url(crypto.createHash('sha256').update(form.code_verifier ?? '').digest()) !== q.code_challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        return issue(q.scope ?? defaultScope);
      }
      if (form.grant_type === 'refresh_token') {
        as.refreshCalls++;
        if (!as.refresh.has(form.refresh_token)) return json(400, { error: 'invalid_grant' });
        const scope = as.refresh.get(form.refresh_token);
        as.refresh.delete(form.refresh_token); // ローテーション
        return issue(scope);
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      as.revoked.push(form); as.refresh.delete(form.token); as.access.delete(form.token);
      res.writeHead(200); return res.end();
    }
    res.writeHead(404); res.end();
  });

  const rs = { calls: 0, forbidden: 0, sseSessions: new Map() };
  const tokenOf = req => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const challenge = res => { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${rsOrigin}/meta/prm", scope="${defaultScope}"` }); res.end(); };
  const toolResult = (m, token) => {
    if (m.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } };
    if (m.method === 'tools/list') return { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] };
    if (m.method === 'tools/call') return { content: [{ type: 'text', text: `token=${token}` }] };
    return {};
  };
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, rsOrigin);
    if (url.pathname === '/meta/prm') {
      if (prmRedirect) { res.writeHead(302, { location: prmRedirect }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ resource: `${rsOrigin}${sse ? '/sse' : '/mcp'}`, authorization_servers: authServers ?? [asOrigin], scopes_supported: ['read', 'write'] }));
    }
    const token = tokenOf(req);
    const valid = token && as.access.has(token);
    if (sse && url.pathname === '/sse' && req.method === 'GET') {
      if (!valid) return challenge(res);
      rs.calls++;
      const server = new McpServer({ name: 'mock-sse', version: '1' });
      server.registerTool('whoami', { description: 'who am i' }, async () => ({ content: [{ type: 'text', text: 'sse' }] }));
      const transport = new SSEServerTransport('/messages', res);
      rs.sseSessions.set(transport.sessionId, transport);
      res.on('close', () => rs.sseSessions.delete(transport.sessionId));
      await server.connect(transport);
      return;
    }
    if (sse && url.pathname === '/messages' && req.method === 'POST') {
      if (!valid) return challenge(res);
      rs.calls++;
      const transport = rs.sseSessions.get(url.searchParams.get('sessionId'));
      if (!transport) { res.writeHead(404); return res.end(); }
      return transport.handlePostMessage(req, res);
    }
    if (url.pathname !== '/mcp') { res.writeHead(404); return res.end(); }
    if (!valid) return challenge(res);
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const m = JSON.parse(await readBody(req));
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    if (requiredScope && m.method === 'tools/call' && !as.access.get(token).split(' ').includes(requiredScope)) {
      rs.forbidden++;
      res.writeHead(403, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${rsOrigin}/meta/prm"` });
      return res.end();
    }
    rs.calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: toolResult(m, token) }));
  });
  asOrigin = await listen(asServer); rsOrigin = await listen(rsServer);
  return { as, rs, asOrigin, rsOrigin, mcpUrl: `${rsOrigin}${sse ? '/sse' : '/mcp'}`,
    async close() { for (const s of [asServer, rsServer]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } } };
}

/** ブラウザの代わり: 認可 URL を開き、302 の戻り先（ループバック）を叩く */
export async function browse(url) {
  const r = await fetch(url, { redirect: 'manual' });
  const location = r.headers.get('location');
  return location ? fetch(location) : r;
}

export async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(20); }
  return false;
}
