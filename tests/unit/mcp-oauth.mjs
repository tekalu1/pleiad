// 外部 MCP の OAuth（core/mcp-oauth.mjs）と、つながらない MCP を外して進む中継（core/context-bridge.mjs）。
// 認可サーバーと MCP（保護リソース）は、このファイルの中でローカルに立てるモック。実サービスにもブラウザにも触らない。
// 「ブラウザ」は認可 URL を fetch して 302 の行き先（ループバックの戻り先）を叩くことで代わりにする。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createSecretStore } from '../../core/secret-store.mjs';
import { createPlyMcp } from '../../core/ply-mcp.mjs';
import { createMcpOAuth } from '../../core/mcp-oauth.mjs';
import { connectServer, createContextBridge } from '../../core/context-bridge.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'mcp-oauth';
export const title = '外部 MCP の OAuth（探索・DCR の再利用・PKCE/state・リフレッシュ・401 再送・失効）と 1 件失敗の切り離し';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const readBody = async req => { let s = ''; for await (const c of req) s += c; return s; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** モックの認可サーバー（RFC 8414・7591・7009）と保護リソース（RFC 9728 + MCP）。 */
async function mockServers({ dcr = true, manualClient = 'manual-client', tokenDelay = 0 } = {}) {
  const as = { registrations: [], authorize: [], tokenRequests: [], refreshCalls: 0, revoked: [], codes: new Map(), clients: new Set([manualClient]), refresh: new Map(), access: new Set(), n: 0 };
  let asOrigin, rsOrigin;
  const asServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, asOrigin);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: asOrigin, authorization_endpoint: `${asOrigin}/authorize`, token_endpoint: `${asOrigin}/token`, revocation_endpoint: `${asOrigin}/revoke`,
        ...(dcr ? { registration_endpoint: `${asOrigin}/register` } : {}), response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'] });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const client_id = `dcr-${as.registrations.length + 1}`;
      as.registrations.push(body); as.clients.add(client_id);
      return json(201, { ...body, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      as.authorize.push(q);
      if (!as.clients.has(q.client_id)) return json(400, { error: 'invalid_client' });
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
        as.access.add(access); as.refresh.set(refresh, true);
        return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope });
      };
      if (form.grant_type === 'authorization_code') {
        const q = as.codes.get(form.code);
        as.codes.delete(form.code);
        if (!q || q.redirect_uri !== form.redirect_uri) return json(400, { error: 'invalid_grant' });
        // PKCE S256: 認可のときの challenge と、いま届いた verifier が合うか
        if (b64url(crypto.createHash('sha256').update(form.code_verifier ?? '').digest()) !== q.code_challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        if (form.resource !== `${rsOrigin}/mcp`) return json(400, { error: 'invalid_target' });
        return issue(q.scope);
      }
      if (form.grant_type === 'refresh_token') {
        as.refreshCalls++;
        if (!as.refresh.get(form.refresh_token) || form.resource !== `${rsOrigin}/mcp`) return json(400, { error: 'invalid_grant' });
        as.refresh.delete(form.refresh_token); // ローテーション: 使ったリフレッシュトークンは二度と使えない
        return issue('read');
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
  const rs = { calls: 0 };
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, rsOrigin);
    // 既定の置き場（/.well-known/...）ではなく、WWW-Authenticate が指す場所にだけメタデータを置く。探索がヘッダーを使ったことの確かめ
    if (url.pathname === '/meta/prm') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ resource: `${rsOrigin}/mcp`, authorization_servers: [asOrigin], scopes_supported: ['read', 'write'] }));
    }
    if (url.pathname !== '/mcp') { res.writeHead(404); return res.end(); }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !as.access.has(token)) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${rsOrigin}/meta/prm", scope="read"` });
      return res.end();
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    rs.calls++;
    const m = JSON.parse(await readBody(req));
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } }
      : m.method === 'tools/list' ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  asOrigin = await listen(asServer); rsOrigin = await listen(rsServer);
  return { as, rs, asOrigin, rsOrigin, async close() { for (const s of [asServer, rsServer]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } } };
}

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-oauth-'));
  const servers = [];
  try {
    const mock = await mockServers({ tokenDelay: 50 }); servers.push(mock);
    let clock = Date.now();
    const secrets = createSecretStore({ file: path.join(tmp, 'data', 'mcp-secrets.json') });
    const ply = createPlyMcp({ dataDir: path.join(tmp, 'data'), secrets });
    const opened = [], events = [];
    const deps = { secrets, lockDir: path.join(tmp, 'data', 'mcp-locks'), now: () => clock, openExternal: url => opened.push(url), emit: e => events.push(e) };
    const oauth = createMcpOAuth(deps);
    await ply.save({ name: 'remote', mode: 'add', value: { transport: 'http', url: `${mock.rsOrigin}/mcp`, auth: 'oauth' } });
    const def = await ply.registration('remote');
    const item = { id: 'remote', name: 'remote', origins: [{ source: 'ply' }], definition: def };
    const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(20); } return false; };
    /** ブラウザの代わり: 認可 URL を開き、302 の戻り先（ループバック）を叩く */
    const browse = async url => { const r = await fetch(url, { redirect: 'manual' }); const location = r.headers.get('location'); return location ? fetch(location) : r; };

    // ---- 始める前はログインが要る。ターンの中ではブラウザを開かない
    const before = await connectServer(item, { cwd: tmp, plyMcp: ply, oauth });
    t.ok('トークンが無ければ「要ログイン」で、接続を試みない', before.status === 'needs-auth' && mock.rs.calls === 0 && opened.length === 0, JSON.stringify(before));

    // ---- ログイン（探索 → DCR → PKCE の認可 URL）
    const started = await oauth.start('remote', def, await ply.connection('remote', tmp));
    const auth = new URL(started.url);
    t.ok('ブラウザで開く認可 URL を渡す', opened[0] === started.url && events.some(e => e.phase === 'url' && e.name === 'remote'));
    t.ok('WWW-Authenticate の resource_metadata から認可サーバーを見つける', auth.origin === mock.asOrigin && auth.pathname === '/authorize');
    t.ok('WWW-Authenticate の scope を要求する', auth.searchParams.get('scope') === 'read', auth.searchParams.get('scope'));
    t.ok('PKCE は S256', auth.searchParams.get('code_challenge_method') === 'S256' && (auth.searchParams.get('code_challenge') ?? '').length >= 43);
    t.ok('resource（RFC 8707）を付ける', auth.searchParams.get('resource') === `${mock.rsOrigin}/mcp`);
    t.ok('戻り先は 127.0.0.1 のループバック', /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(auth.searchParams.get('redirect_uri')));
    t.ok('DCR でクライアントを登録する（公開クライアント）', mock.as.registrations.length === 1 && mock.as.registrations[0].token_endpoint_auth_method === 'none'
      && mock.as.registrations[0].redirect_uris[0] === auth.searchParams.get('redirect_uri'));
    t.ok('ログイン中の状態は pending', (await oauth.status('remote', def)).state === 'pending');

    // state が合わない戻りは捨てる（待つのはやめない）
    const forged = await fetch(`${started.redirectUri}?code=forged&state=${'0'.repeat(64)}`);
    t.ok('state が合わない戻りは拒否し、ログインは続く', forged.status === 400 && (await oauth.status('remote', def)).state === 'pending' && mock.as.tokenRequests.length === 0);
    const done = await browse(started.url);
    t.ok('正しい戻りでトークンを受け取る（AS が PKCE の verifier を検証済み）', done.status === 200 && await until(() => events.some(e => e.phase === 'done')), String(done.status));
    const signedIn = await oauth.status('remote', def);
    t.ok('状態はログイン済みで、期限と scope が分かる', signedIn.state === 'signed-in' && signedIn.refreshable && signedIn.scope === 'read' && signedIn.client === 'dynamic', JSON.stringify(signedIn));
    const code = mock.as.tokenRequests.find(r => r.grant_type === 'authorization_code');
    t.ok('コード交換にも resource と verifier を付ける', code?.resource === `${mock.rsOrigin}/mcp` && Boolean(code?.code_verifier));
    const port = new URL(started.redirectUri).port;
    t.ok('戻り先の待ち受けは完了後に閉じる', await fetch(started.redirectUri).then(() => false, () => true));

    // ---- つながる
    const live = await connectServer(item, { cwd: tmp, plyMcp: ply, oauth });
    t.ok('保存したトークンで MCP につながる', live.status === 'connected' && live.tools.length === 1, JSON.stringify({ status: live.status, reason: live.reason }));
    await live.client.close();

    // ---- 401 を受けたら 1 回だけリフレッシュして送り直す
    mock.as.access.clear();
    const refreshBefore = mock.as.refreshCalls;
    const retried = await connectServer(item, { cwd: tmp, plyMcp: ply, oauth });
    t.ok('401 で 1 回リフレッシュして再送し、つながる', retried.status === 'connected' && mock.as.refreshCalls === refreshBefore + 1, JSON.stringify({ status: retried.status, reason: retried.reason, calls: mock.as.refreshCalls - refreshBefore }));
    await retried.client?.close();

    // ---- 期限前のリフレッシュ・ローテーション・single-flight
    const stored = async () => (await secrets.get('mcp:remote:oauth')).tokens;
    const oldRefresh = (await stored()).refresh_token;
    clock += 3600_000;
    const calls = mock.as.refreshCalls;
    const tokens = await Promise.all(Array.from({ length: 5 }, () => oauth.accessToken('remote', def)));
    t.ok('同時に 5 本要っても、リフレッシュは 1 回（プロセス内 single-flight）', mock.as.refreshCalls === calls + 1 && new Set(tokens).size === 1, String(mock.as.refreshCalls - calls));
    const rotated = await stored();
    t.ok('ローテーションした新しいリフレッシュトークンを保存する', rotated.refresh_token !== oldRefresh && mock.as.refresh.has(rotated.refresh_token) && !mock.as.refresh.has(oldRefresh));

    // 別のプロセスの代わり: 同じファイルを別のストアとして開いた、別の OAuth の部品
    const otherSecrets = createSecretStore({ file: path.join(tmp, 'data', 'mcp-secrets.json') });
    const other = createMcpOAuth({ ...deps, secrets: otherSecrets });
    clock += 3600_000;
    const calls2 = mock.as.refreshCalls;
    const [a, b] = await Promise.all([oauth.accessToken('remote', def), other.accessToken('remote', def)]);
    t.ok('プロセスをまたいでも、リフレッシュは 1 回（ロック後に読み直す）', mock.as.refreshCalls === calls2 + 1 && a === b, String(mock.as.refreshCalls - calls2));

    // ---- 二度目のログインは、登録したクライアントを使い回す
    const again = await oauth.start('remote', def, await ply.connection('remote', tmp));
    t.ok('同じ戻り先なら DCR をやり直さない', mock.as.registrations.length === 1 && new URL(again.redirectUri).port === port && new URL(again.url).searchParams.get('client_id') === 'dcr-1');
    await browse(again.url);
    await until(async () => (await oauth.status('remote', def)).state === 'signed-in');

    // ---- リフレッシュトークンが失効していたら、要ログインに落とす（ターンは止めない）
    mock.as.refresh.clear(); mock.as.access.clear();
    const expired = await connectServer(item, { cwd: tmp, plyMcp: ply, oauth });
    t.ok('リフレッシュが拒まれたら「要ログイン」', expired.status === 'needs-auth' && /ログイン/.test(expired.reason), JSON.stringify(expired));
    t.ok('使えないトークンは捨てる', (await oauth.status('remote', def)).state === 'signed-out');

    // ---- ログアウトは失効（RFC 7009）
    const third = await oauth.start('remote', def, await ply.connection('remote', tmp));
    await browse(third.url);
    await until(async () => (await oauth.status('remote', def)).state === 'signed-in');
    const refreshToken = (await stored()).refresh_token;
    const out = await oauth.logout('remote', def);
    t.ok('ログアウトでリフレッシュトークンとアクセストークンを失効させる', out.revoked === true && mock.as.revoked.some(r => r.token === refreshToken && r.token_type_hint === 'refresh_token' && r.client_id === 'dcr-1'), JSON.stringify(out));
    t.ok('ログアウト後は未ログイン。登録したクライアントは残す', (await oauth.status('remote', def)).state === 'signed-out' && (await secrets.get('mcp:remote:oauth')).client?.info?.client_id === 'dcr-1');

    // ---- 認可サーバーの拒否は失敗として知らせる
    const denied = await oauth.start('remote', def, await ply.connection('remote', tmp));
    const deny = new URL(denied.redirectUri); deny.searchParams.set('error', 'access_denied'); deny.searchParams.set('state', new URL(denied.url).searchParams.get('state'));
    await fetch(deny);
    t.ok('拒否されたらログインを終え、理由を出す', await until(async () => { const s = await oauth.status('remote', def); return s.state === 'signed-out' && /access_denied/.test(s.message ?? ''); }));

    // ---- DCR 非対応の認可サーバー
    const nodcr = await mockServers({ dcr: false }); servers.push(nodcr);
    await ply.save({ name: 'nodcr', mode: 'add', value: { transport: 'http', url: `${nodcr.rsOrigin}/mcp`, auth: 'oauth' } });
    let nodcrError;
    try { await oauth.start('nodcr', await ply.registration('nodcr'), await ply.connection('nodcr', tmp)); } catch (e) { nodcrError = e; }
    t.ok('DCR 非対応で clientId が無ければ、指定を求める', /clientId/.test(nodcrError?.message ?? ''), nodcrError?.message);
    await ply.save({ name: 'nodcr', mode: 'edit', value: { transport: 'http', url: `${nodcr.rsOrigin}/mcp`, auth: 'oauth', oauth: { clientId: 'manual-client', clientSecret: 'MANUAL_SECRET' } } });
    const manualDef = await ply.registration('nodcr');
    const manual = await oauth.start('nodcr', manualDef, await ply.connection('nodcr', tmp));
    await browse(manual.url);
    await until(async () => (await oauth.status('nodcr', manualDef)).state === 'signed-in');
    const manualToken = nodcr.as.tokenRequests.find(r => r.grant_type === 'authorization_code');
    t.ok('手入力の clientId でログインでき、DCR はしない', (await oauth.status('nodcr', manualDef)).client === 'manual' && nodcr.as.registrations.length === 0 && new URL(manual.url).searchParams.get('client_id') === 'manual-client');
    t.ok('clientSecret は token 要求の本文に平文で載せない（Basic 認証）', manualToken && !JSON.stringify(manualToken).includes('MANUAL_SECRET'));

    // ---- 1 件つながらなくても、ほかの MCP は使える（ターン全体を止めない）
    await oauth.logout('remote', def);
    const runtime = {
      owners: { mcp: 'ply' }, policy: { cwd: tmp }, prompt: '', skills: [], report: { entries: [{ id: 'remote' }, { id: 'broken' }, { id: 'fixture' }] },
      servers: [item,
        { id: 'broken', name: 'broken', origins: [{ source: 'claude' }], definition: { command: process.execPath, args: ['-e', 'process.exit(3)'] } },
        { id: 'fixture', name: 'fixture', origins: [{ source: 'claude' }], definition: { command: process.execPath, args: [path.join(ROOT, 'tests', 'lib', 'stdio-mcp.mjs')] } }],
    };
    const bridge = createContextBridge({ plyMcp: ply, oauth });
    const host = http.createServer(bridge.handle); const origin = await listen(host);
    let connection;
    try {
      connection = await bridge.open({ runtime, prompt: '', origin, isActive: () => true });
      const rows = Object.fromEntries(runtime.report.entries.map(e => [e.id, e]));
      t.ok('要ログインの MCP は外して記録する', rows.remote.status === 'needs-auth' && Boolean(rows.remote.reason) && rows.remote.tools === 0, JSON.stringify(rows.remote));
      t.ok('起動できない MCP は失敗として記録する', rows.broken.status === 'failed' && Boolean(rows.broken.reason), JSON.stringify(rows.broken));
      t.ok('残りの MCP はつながり、ツール数を記録する', rows.fixture.status === 'connected' && rows.fixture.tools === 1 && runtime.report.status === 'ready', JSON.stringify(rows.fixture));
      const list = await (await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
      t.ok('つながった MCP のツールだけを公開する', list.result.tools.some(x => x.description.includes('[fixture / echo]')) && !list.result.tools.some(x => x.description.includes('[remote')));
    } finally { await connection?.close(); host.closeAllConnections(); await new Promise(r => host.close(r)); }
  } finally {
    for (const s of servers) await s.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
