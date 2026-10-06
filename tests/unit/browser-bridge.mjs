// ply_browser（エージェントのブラウザー操作の口。core/browser-bridge.mjs、ADR 0142）の骨組みと、内蔵ブラウザーのプロフィール（ADR 0078）を削除した後の形。
//   - 口: 会話ごとの Bearer の鍵・origin の検査・initialize / tools/list / tools/call（載せるツールは無いので呼び出しは断る）
//   - サーバー越し（fake + parentPort の身代わり）: 設定・中継の準備・新しい会話にプロフィールが無い。ply_browser は渡るが、エージェントへの指示にプロフィールの段落が無い
//   - agy: 2 つ以上のサーバーは 1 本の中継に束ねる（agy は agent.md の mcpServers の先頭 1 本しか起こさない。1.2.14 で実測）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createBrowserBridge, browserTools, BROWSER_SERVER } from '../../core/browser-bridge.mjs';
import { agentDefinition } from '../../core/backends/antigravity-context.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { readSessions } from '../lib/data-store.mjs';
import * as P from '../../core/protocol.mjs';

export const name = 'browser-bridge';
export const title = 'ply_browser の骨組み: 鍵付きの口・載せるツールが無い間の断り方・プロフィールの削除後の形（サーバー越し）・agy の束ね';

export default async function (t) {
  // ---- 口
  {
    const bridge = createBrowserBridge();
    const server = http.createServer((req, res) => bridge.handle(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const binding = bridge.open({ origin: `http://127.0.0.1:${server.address().port}`, owner: () => 'conv-1', locale: 'ja' });
      const rpc = async (method, params, headers = binding.headers, extra = {}) => fetch(binding.url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.match(binding.url, /\/mcp\/browser$/);
      assert.equal(BROWSER_SERVER, 'ply_browser');
      const init = await (await rpc('initialize', {})).json();
      assert.equal(init.result.serverInfo.name, 'ply_browser');
      assert.deepEqual((await (await rpc('tools/list', {})).json()).result.tools, [], '載せるツールは次の段で足す');
      assert.deepEqual(browserTools('en'), []);
      const call = await (await rpc('tools/call', { name: 'use_browser_profile', arguments: { profile: 'x' } })).json();
      assert.equal(call.result.isError, true, '載せていないツールの呼び出しは断る');
      assert.match(call.result.content[0].text, /ply_browser/);
      assert.equal((await rpc('tools/list', {}, { Authorization: `Bearer ${'0'.repeat(64)}` })).status, 401, '鍵の違う呼び出しは断る');
      assert.equal((await rpc('tools/list', {}, binding.headers, { origin: 'http://evil.example' })).status, 403, '別の origin からは断る');
      binding.close();
      assert.equal((await rpc('tools/list', {})).status, 401, '閉じた口は断る');
    } finally { server.close(); }
  }
  t.ok('口: 会話ごとの Bearer の鍵・origin の検査・載せるツールが無い間は tools/list が空で呼び出しは断る', true);

  // ---- サーバー越し: プロフィールが無くなったこと
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-browser-bridge-server-'));
  const log = path.join(scratch, 'parent-port.ndjson');
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const cwd = path.join(scratch, 'work');
  await fs.mkdir(cwd);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', FAKE_PARENT_PORT_LOG: log }, dataDir, entry: path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs') });
  let c;
  const messages = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  try {
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    // 無いコマンドはサーバーが黙って捨て、cmd は応答待ちのまま止まるので、WS では送らずに一覧で確かめる
    assert(!P.COMMANDS.has('setBrowserProfile'), '会話のプロフィールを替えるコマンドが無くなった');
    await assert.rejects(c.cmd('setPref', { key: 'browserProfiles', value: [{ id: 'main' }] }), '設定のキーが無くなった');
    await assert.rejects(c.cmd('setPref', { key: 'browserDefaultProfile', value: 'main' }));
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd });
    assert.equal(readSessions(dataDir)[sessionId]?.browserProfile, undefined, '新しい会話はプロフィールを持たない');
    const turn = await c.runTurn({ backend: 'fake', cwd, sessionId, prompt: 'browser:{"name":"list_browser_profiles","arguments":{}}' });
    const endpoint = (await messages()).filter(m => m.type === 'agent-browser-endpoint').at(-1);
    assert(endpoint, '中継の準備は今までどおり main に頼む');
    assert.equal(endpoint.profile, undefined, '中継の準備にプロフィールを渡さない');
    const prefsMessage = (await messages()).filter(m => m.type === 'agent-browser-prefs').at(-1);
    assert(prefsMessage && prefsMessage.profiles === undefined && prefsMessage.defaultProfile === undefined, 'main に使えるプロフィールを知らせない');
    const result = turn.events.find(e => e.type === 'tool.result');
    assert.equal(result?.isError, true, 'ply_browser は渡るが、呼べるツールは無い');
    assert.deepEqual(turn.tools, ['mcp__ply_browser__list_browser_profiles'], '呼び出しは会話のツール履歴に残る');
    const second = await c.runTurn({ backend: 'fake', cwd, sessionId, prompt: 'browser-instructions' });
    const text = second.events.filter(e => e.type === 'text.delta').map(e => e.text ?? e.delta ?? '').join('') || second.events.find(e => e.type === 'text.end')?.text || '';
    assert.match(text, /agent-browser/, 'エージェント向けの指示は残る');
    assert(!/profile|プロフィール/i.test(text), '指示にプロフィールの段落が無い');
  } finally { c?.close?.(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
  t.ok('サーバー越し: 設定・コマンド・会話のメタ・中継の準備・main への知らせにプロフィールが無い。ply_browser は渡るがツールは無く、エージェントへの指示にプロフィールの段落が無い', true);

  // ---- agy: 2 つ以上のサーバーは 1 本の中継に束ねる
  {
    const servers = opts => JSON.parse(/\nmcpServers: (\[[^\n]*\])\n/.exec(agentDefinition({ owners: {}, prompt: 'P', cwd: 'C:/w', home: 'C:/h', ...opts }))[1]);
    const one = servers({ contextEnabled: false, browserEnabled: true });
    t.ok('agy: 1 つだけなら従来どおりのサーバー名と旗', one.length === 1 && one[0].serverName === 'ply_browser' && one[0].args.at(-1) === '--browser'
      && servers({ contextEnabled: true })[0].args.length === 1 && servers({ contextEnabled: false, computerEnabled: true })[0].args.at(-1) === '--computer', JSON.stringify(one));
    const bundled = servers({ contextEnabled: false, computerEnabled: true, browserEnabled: true });
    t.ok('agy: ply_computer と ply_browser は 1 本の中継に旗を並べる', bundled.length === 1 && bundled[0].serverName === 'ply_computer' && bundled[0].args.slice(-2).join() === '--computer,--browser', JSON.stringify(bundled));
    const all = servers({ contextEnabled: true, computerEnabled: true, browserEnabled: true });
    t.ok('agy: 3 つとも渡しても 1 本（先頭の名前）', all.length === 1 && all[0].serverName === 'ply_context' && all[0].args.slice(-3).join() === '--context,--computer,--browser', JSON.stringify(all));

    const seen = [];
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const m = JSON.parse(body);
        const kind = req.url.split('/').pop();
        seen.push(`${kind} ${m.method}${m.params?.name ? ` ${m.params.name}` : ''} ${req.headers.authorization?.slice(0, 8)}`);
        const tools = { context: ['instructions_for_path'], computer: ['screenshot'], browser: ['hand_to_user', 'close_browser_window'] }[kind].map(n => ({ name: n, inputSchema: { type: 'object' } }));
        const result = m.method === 'tools/list' ? { tools } : m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: kind === 'context' ? { tools: {}, resources: {} } : { tools: {} }, serverInfo: { name: kind, version: '1' } }
          : m.method === 'resources/list' ? { resources: [] } : { content: [{ type: 'text', text: `${kind}:${m.params?.name}` }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${upstream.address().port}/mcp`;
      const auth = 'Bearer ' + 'a'.repeat(64);
      const child = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs'), '--context', '--computer', '--browser'], {
        env: { ...process.env, PLY_CONTEXT_URL: `${base}/context`, PLY_CONTEXT_AUTHORIZATION: auth, PLY_COMPUTER_URL: `${base}/computer`, PLY_COMPUTER_AUTHORIZATION: auth, PLY_BROWSER_URL: `${base}/browser`, PLY_BROWSER_AUTHORIZATION: auth },
        stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ply_computer_screenshot', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hand_to_user', arguments: { reason: 'login' } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'instructions_for_path', arguments: {} } },
        { jsonrpc: '2.0', id: 6, method: 'resources/list' },
      ];
      for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
      const deadline = Date.now() + 10000;
      while (out.split('\n').filter(Boolean).length < requests.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      child.kill();
      const replies = Object.fromEntries(out.split('\n').filter(Boolean).map(l => JSON.parse(l)).map(m => [m.id, m]));
      const names = (replies[2]?.result?.tools ?? []).map(x => x.name).sort().join();
      t.ok('agy: 束ねた中継は接続先ごとの tools/list を足し合わせる（computer は ply_computer_ 付き、browser は付けない）',
        names === 'close_browser_window,hand_to_user,instructions_for_path,ply_computer_screenshot', names);
      t.ok('agy: initialize は context の返事（resources を持つ）。呼び出しは名前で振り分け、computer の接頭辞は外す',
        replies[1]?.result?.capabilities?.resources && replies[3]?.result?.content?.[0]?.text === 'computer:screenshot' && replies[4]?.result?.content?.[0]?.text === 'browser:hand_to_user'
        && replies[5]?.result?.content?.[0]?.text === 'context:instructions_for_path' && replies[6]?.result?.resources && seen.includes('browser tools/call hand_to_user Bearer a'), JSON.stringify([replies, seen]).slice(0, 600));
      // つながらない接続先（env 無し）は黙って外し、残りで動く
      const partial = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs'), '--computer', '--browser'], {
        env: { ...process.env, PLY_COMPUTER_URL: '', PLY_COMPUTER_AUTHORIZATION: '', PLY_BROWSER_URL: `${base}/browser`, PLY_BROWSER_AUTHORIZATION: auth }, stdio: ['pipe', 'pipe', 'ignore'] });
      let pout = '';
      partial.stdout.on('data', d => { pout += d; });
      partial.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      const until = Date.now() + 10000;
      while (!pout.includes('\n') && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      partial.kill();
      t.ok('agy: 接続先が欠けても束ねた中継は残りのツールだけを出す', JSON.parse(pout.split('\n')[0]).result.tools.map(x => x.name).join() === 'hand_to_user,close_browser_window', pout.slice(0, 300));
    } finally { upstream.close(); }
  }
}
