import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createMcpConfig } from '../../core/mcp-config.mjs';
import { procwayMcpServers } from '../../core/procway-mcp.mjs';
import { startServer, ROOT, PROCWAY_CLI } from '../lib/server.mjs';
import { VISUALIZE_START as VS, VISUALIZE_END as VE } from '../../web/visualize-reference.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'procway-mcp';
export const title = '実物 serve で MCP・可視化・承認待ちと会話分離を検証';
export default async function(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-procway-mcp-')));
  const home = path.join(scratch, 'home'), work = path.join(scratch, 'work'), other = path.join(scratch, 'other');
  const seen = [], calls = [];
  const api = http.createServer(async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    const data = JSON.parse(text);
    if (req.url === '/mcp') {
      assert.equal(req.headers.authorization, 'Bearer fixture-key');
      if (!Object.hasOwn(data, 'id')) { res.writeHead(202).end(); return; }
      const result = data.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
        : data.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
        : data.method === 'tools/call' ? (calls.push(data), { content: [{ type: 'text', text: 'http-result' }] }) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result })); return;
    }
    seen.push(data);
    const last = data.messages.at(-1);
    const prompt = String(last.content);
    const tool = prompt.includes('STDIO') ? 'mcp__stdio__echo' : prompt.includes('HTTP') ? 'mcp__remote__echo' : null;
    const delta = last.role === 'user' && tool ? { tool_calls: [{ index: 0, id: 'call-' + seen.length, type: 'function', function: { name: tool, arguments: JSON.stringify(tool.endsWith('__present') ? { kind: 'text', content: prompt } : {}) } }] } : { content: prompt.startsWith('PRESENT') ? `${VS}${JSON.stringify({path:path.join(prompt.includes('other') ? other : work, 'sample.html'),title:prompt})}${VE}` : 'fixture complete' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  let server, a, b;
  try {
    for (const dir of [home, work, other]) await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { collision: { command: 'user' }, ply: { command: 'bad' } } }));
    await fs.writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.collision]\ncommand="codex-user"\n');
    await fs.writeFile(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: { collision: { command: 'directory' } } }));
    await fs.writeFile(path.join(work, '.codex/config.toml'), '[mcp_servers.collision]\nenabled=false\ncommand="disabled"\n');
    const config = createMcpConfig({ home, codexHome: path.join(home, '.codex') });
    const snapshot = await config.runtimeServers(work);
    assert.equal(snapshot.collision.value.enabled, false); assert(!snapshot.ply);
    const mapped = procwayMcpServers({ host: { command: 'bad' } }, {
      ...snapshot, auth: { format: 'codex', value: { url: 'https://example.test/mcp', bearer_token_env_var: 'KEY', env_http_headers: { 'X-Key': 'KEY' } } },
      expansion: { format: 'claude', value: { command: '${BIN}', args: ['${UNSET:-fallback}'] } },
    }, { KEY: 'secret', BIN: 'node' });
    assert.equal(mapped.collision.enabled, false); assert.equal(mapped.host.enabled, false);
    assert.equal(mapped.auth.headers.Authorization, 'Bearer secret'); assert.equal(mapped.auth.headers['X-Key'], 'secret');
    assert.deepEqual(mapped.expansion.args, ['fallback']);
    assert.throws(() => procwayMcpServers({}, { x: { value: { command: 'node', enabled_tools: [] } } }), /未対応/);
    t.ok('優先順位・無効化・予約名・認証変数と制約を維持', true);
    // Remove precedence fixtures before starting real transports.
    await fs.writeFile(path.join(home, '.claude.json'), '{}');
    await fs.writeFile(path.join(home, '.codex/config.toml'), '');
    await fs.writeFile(path.join(work, '.codex/config.toml'), '');
    const remote = { url: `http://127.0.0.1:${api.address().port}/mcp`, http_headers: { Authorization: 'Bearer fixture-key' } };
    const registrations = { stdio: { command: process.execPath, args: [path.join(ROOT, 'tests/lib/stdio-mcp.mjs')], env: { MCP_TEST_VALUE: 'stdio-proof' } } };
    await fs.writeFile(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: registrations }));
    const listing = await config.list({ cwd: work, scope: 'directory', format: 'codex' });
    await config.save({ cwd: work, scope: 'directory', format: 'codex', name: 'remote', value: remote, revision: listing.revision, mode: 'add' });
    for (const dir of [work, other]) {
      await fs.writeFile(path.join(dir, 'sample.html'), '<p>visualization</p>');
      await fs.mkdir(path.join(dir, '.procway/ai-agent'), { recursive: true });
      await fs.writeFile(path.join(dir, '.procway/ai-agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', providers: { fixture: { type: 'openai-compatible', baseUrl: `http://127.0.0.1:${api.address().port}`, defaultModel: 'fixture', apiKeyEnv: 'FIXTURE_KEY' } }, session: { autoCompact: { enabled: false } } }));
    }
    server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'procway', AGENT_HOST_PROCWAY_HOME: home, AGENT_HOST_PROCWAY_CODE: PROCWAY_CLI, FIXTURE_KEY: 'fixture' } });
    a = await open({ port: server.port, token: server.token, autoAllow: true });
    const id = (await a.cmd('newSession', { backend: 'procway', cwd: work, mode: 'always-ask' })).sessionId;
    for (const prompt of ['PRESENT first', 'STDIO', 'HTTP', 'PRESENT resumed']) {
      const turn = await a.runTurn({ sessionId: id, prompt }, { ms: 60000 });
      assert.equal(turn.outcome, 'ok', JSON.stringify(turn.events.filter(e => e.type === 'turnResult')));
      if (prompt.startsWith('PRESENT')) assert(turn.events.some(e => e.type === 'present' && e.caption === prompt && e.kind === 'visualization' && e.sessionId === id));
      else assert(turn.events.some(e => e.type === 'tool.result' && e.text.includes(prompt === 'STDIO' ? 'stdio-proof' : 'http-result')));
    }
    assert.equal(calls.length, 1);
    assert.equal((await a.cmd('loadSession', { sessionId: id })).presents.length, 2);
    const saved = await fs.readFile(path.join(scratch, 'data/presents', id + '.jsonl'), 'utf8');
    assert(saved.includes('PRESENT resumed'));
    t.ok('stdio / HTTP を実際に呼び、可視化は再開後も会話の JSONL に保存', true);
    a.close(); a = await open({ port: server.port, token: server.token });
    let idB;
    b = await open({ port: server.port, token: server.token, onEvent: (e, client) => {
      if (e.type === 'permission' && e.sessionId === idB) return client.cmd('resolvePermission', { id: e.id, allow: true });
    } });
    idB = (await b.cmd('newSession', { backend: 'procway', cwd: other, mode: 'always-ask' })).sessionId;
    const from = a.mark();
    await a.cmd('runTurn', { sessionId: id, prompt: 'HTTP parked' });
    const permission = await a.waitFor(e => e.type === 'permission' && e.sessionId === id, { from, ms: 60000 });
    const edit = await config.get({ cwd: work, scope: 'directory', format: 'codex', name: 'remote' });
    await config.save({ ...edit, mode: 'edit', value: { ...remote, enabled: false } });
    const otherTurn = await b.runTurn({ sessionId: idB, prompt: 'PRESENT other' }, { ms: 60000 });
    assert.equal(otherTurn.outcome, 'ok');
    assert(otherTurn.events.some(e => e.type === 'present' && e.sessionId === idB));
    const otherRequest = seen.find(r => r.messages.some(m => m.role === 'user' && m.content === 'PRESENT other'));
    assert(!otherRequest.tools.some(tool => /mcp__(remote|stdio)__/.test(tool.function.name)));
    await a.cmd('resolvePermission', { id: permission.id, allow: true });
    await a.waitFor(e => e.type === 'turnEnd' && e.sessionId === id, { from, ms: 60000 });
    assert.equal(calls.length, 2);
    assert(a.since(from).some(e => e.type === 'turnResult' && e.outcome === 'ok' && e.sessionId === id));
    const next = await a.runTurn({ sessionId: id, prompt: 'inventory' }, { ms: 60000 });
    assert.equal(next.outcome, 'ok');
    assert(!seen.at(-1).tools.some(tool => tool.function.name === 'mcp__remote__echo'));
    assert(seen.at(-1).tools.some(tool => tool.function.name === 'mcp__stdio__echo'));
    const disabled = await a.runTurn({ sessionId: id, prompt: 'disabled inventory' }, { ms: 60000 });
    assert.equal(disabled.outcome, 'ok');
    assert(!seen.at(-1).tools.some(tool => tool.function.name === 'mcp__ply__present'));
    t.ok('承認待ち中の設定変更・別会話の実行を隔離し、次ターンだけ登録を更新', true);
  } finally {
    a?.close(); b?.close(); await server?.stop();
    for (const match of (server?.tail(200) || '').matchAll(/serve を起動した pid=(\d+)/g)) { try { process.kill(Number(match[1])); } catch {} }
    api.closeAllConnections(); await new Promise(r => api.close(r));
    // Windows can keep a terminated child's cwd locked briefly after kill().
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
