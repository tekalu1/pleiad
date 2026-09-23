// procway の native 経路（MCP の担当がエージェント）で、同名の Pleiad の登録の接続先と資格情報が serve 子に届くこと。
// 本物の procway serve を使う（tests/unit/procway-mcp.mjs と同じ。LLM・MCP・認可サーバーはローカルのモック）。
//   - stdio: Pleiad の登録の env（秘密）で起動する
//   - HTTP + OAuth: Pleiad が持つアクセストークンで接続し、MCP が 401 を返したら serve 子が Pleiad に引き直し、
//     Pleiad が 1 回だけリフレッシュして再送が通る（procway の .procway-connections.json の読み直しと同じ形。ファイルは書かない）
//   - Pleiad の登録だけにある MCP は足さない（どの MCP を使うかはエージェント側の登録が決める）
//   - 資格情報の口は会話ごとのトークンが無いと 401
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createSecretStore } from '../../core/secret-store.mjs';
import { startServer, ROOT, PROCWAY_CLI } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'procway-ply-mcp';
export const title = 'procway の native 経路で、同名の Pleiad の登録（stdio の env・OAuth のリフレッシュ）を使う';

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-procway-plymcp-')));
  const home = path.join(scratch, 'home'), work = path.join(scratch, 'work'), dataDir = path.join(scratch, 'data'), launches = path.join(scratch, 'launches.txt');
  const seen = [], tokenRequests = [], mcpAuth = [];
  let validToken = 'tok-1';
  let origin;
  const api = http.createServer(async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    if (req.url === '/token') {
      tokenRequests.push(Object.fromEntries(new URLSearchParams(text)));
      validToken = 'tok-2';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'tok-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r2' }));
      return;
    }
    if (req.url === '/mcp') {
      mcpAuth.push(req.headers.authorization ?? null);
      if (req.headers.authorization !== `Bearer ${validToken}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
      const data = JSON.parse(text);
      if (!Object.hasOwn(data, 'id')) { res.writeHead(202).end(); return; }
      const result = data.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
        : data.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
        : data.method === 'tools/call' ? { content: [{ type: 'text', text: `http-result:${validToken}` }] } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result }));
      return;
    }
    // LLM（OpenAI 互換）のモック。プロンプトに STDIO / HTTP があれば、その MCP のツールを 1 回呼ぶ
    const data = JSON.parse(text);
    seen.push(data);
    const last = data.messages.at(-1);
    const prompt = String(last.content);
    const tool = last.role !== 'user' ? null : prompt.includes('STDIO') ? 'mcp__local__echo' : prompt.includes('HTTP') ? 'mcp__remote__echo' : null;
    const delta = tool ? { tool_calls: [{ index: 0, id: 'call-' + seen.length, type: 'function', function: { name: tool, arguments: '{}' } }] } : { content: 'fixture complete' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${api.address().port}`;
  let server, client;
  try {
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.mkdir(path.join(work, '.codex'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude.json'), '{}');
    // エージェント側（Claude 形式・この場所）の登録。認証は無い（本来は Claude CLI が自分の OAuth で付けるもの）
    await fs.writeFile(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: {
      remote: { type: 'http', url: `${origin}/mcp` },
      local: { command: process.execPath, args: [path.join(ROOT, 'tests/lib/stdio-mcp.mjs')] },
    } }));
    await fs.mkdir(path.join(work, '.procway/ai-agent'), { recursive: true });
    await fs.writeFile(path.join(work, '.procway/ai-agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', providers: { fixture: { type: 'openai-compatible', baseUrl: origin, defaultModel: 'fixture', apiKeyEnv: 'FIXTURE_KEY' } }, session: { autoCompact: { enabled: false } } }));
    const marker = path.join(scratch, 'onlyply.mjs');
    await fs.writeFile(marker, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(launches)},'onlyply\\n');process.exit(0);`);

    server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'procway', AGENT_HOST_PROCWAY_HOME: home, AGENT_HOST_PROCWAY_CODE: PROCWAY_CLI, FIXTURE_KEY: 'fixture' } });
    client = await open({ port: server.port, token: server.token, autoAllow: true });
    // Pleiad の登録。remote は OAuth、local は env に秘密、onlyply はエージェント側に同名が無い
    await client.cmd('savePlyMcp', { name: 'remote', mode: 'add', value: { transport: 'http', url: `${origin}/mcp`, auth: 'oauth' } });
    await client.cmd('savePlyMcp', { name: 'local', mode: 'add', value: { transport: 'stdio', command: process.execPath, args: [path.join(ROOT, 'tests/lib/stdio-mcp.mjs')], env: { MCP_TEST_VALUE: 'ply-stdio-secret' } } });
    await client.cmd('savePlyMcp', { name: 'onlyply', mode: 'add', value: { transport: 'stdio', command: process.execPath, args: [marker] } });
    // ログイン済みの状態を置く（npm start 相当なので平文のストア。形は core/mcp-oauth.mjs が保存するもの）
    const secrets = createSecretStore({ file: path.join(dataDir, 'mcp-secrets.json') });
    const metadata = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'] };
    await secrets.set('mcp:remote:oauth', { serverUrl: `${origin}/mcp`, client: { info: { client_id: 'dcr-1' }, issuer: origin, redirectUri: 'http://127.0.0.1:1/callback', dynamic: true },
      discovery: { authorizationServerUrl: origin, authorizationServerMetadata: metadata }, resource: `${origin}/mcp`,
      tokens: { access_token: 'tok-1', refresh_token: 'r1', token_type: 'Bearer', expires_at: Date.now() + 3600_000 } });

    const id = (await client.cmd('newSession', { backend: 'procway', cwd: work, mode: 'full-auto' })).sessionId;
    const stdio = await client.runTurn({ sessionId: id, prompt: 'STDIO' }, { ms: 90000 });
    assert.equal(stdio.outcome, 'ok', JSON.stringify(stdio.events.filter(e => e.type === 'turnResult')));
    t.ok('stdio: 同名の Pleiad の登録の env（秘密）で起動する', stdio.events.some(e => e.type === 'tool.result' && e.text.includes('ply-stdio-secret')),
      JSON.stringify(stdio.events.filter(e => e.type === 'tool.result').map(e => e.text)));

    const first = await client.runTurn({ sessionId: id, prompt: 'HTTP first' }, { ms: 90000 });
    t.ok('HTTP: Pleiad が持つ OAuth のアクセストークンで接続する', first.outcome === 'ok' && first.events.some(e => e.type === 'tool.result' && e.text.includes('http-result:tok-1')),
      JSON.stringify(first.events.filter(e => e.type === 'tool.result' || e.type === 'turnResult')));
    t.ok('エージェント側の登録には無い認証を、ファイルを介さず渡す', mcpAuth.includes('Bearer tok-1') && !(await fs.readdir(work)).includes('.procway-connections.json'));

    // MCP 側がトークンを失効させた（期限の前でも）。serve 子は 401 を受けて Pleiad に引き直し、Pleiad がリフレッシュする
    validToken = 'tok-rotated';
    const second = await client.runTurn({ sessionId: id, prompt: 'HTTP again' }, { ms: 90000 });
    t.ok('401 のあと Pleiad が 1 回だけリフレッシュし、再送が通る', second.outcome === 'ok' && second.events.some(e => e.type === 'tool.result' && e.text.includes('http-result:tok-2')) && tokenRequests.length === 1,
      JSON.stringify({ tokenRequests, results: second.events.filter(e => e.type === 'tool.result').map(e => e.text), tail: mcpAuth.slice(-4) }));
    t.ok('リフレッシュには保存済みのリフレッシュトークンを使い、新しいトークンを保存する', tokenRequests[0]?.grant_type === 'refresh_token' && tokenRequests[0]?.refresh_token === 'r1'
      && (await secrets.get('mcp:remote:oauth'))?.tokens?.access_token === 'tok-2');

    let launched = '';
    try { launched = await fs.readFile(launches, 'utf8'); } catch {}
    t.ok('Pleiad の登録だけにある MCP は起動しない', !launched.includes('onlyply'));
    const tools = seen.at(-1).tools.map(tool => tool.function.name);
    t.ok('ツールの名前はエージェント側の登録名のまま', tools.includes('mcp__remote__echo') && tools.includes('mcp__local__echo') && !tools.some(n => n.includes('onlyply')), JSON.stringify(tools));

    const denied = await fetch(`http://127.0.0.1:${server.port}/mcp/credentials`, { method: 'POST', headers: { authorization: `Bearer ${'0'.repeat(64)}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'remote' }) });
    t.ok('資格情報の口は会話ごとのトークンが無いと 401', denied.status === 401);
  } finally {
    client?.close(); await server?.stop();
    for (const match of (server?.tail(200) || '').matchAll(/serve を起動した pid=(\d+)/g)) { try { process.kill(Number(match[1])); } catch {} }
    api.closeAllConnections(); await new Promise(r => api.close(r));
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
