// 会話の MCP の口を、既存のトークンで開き直す open({ token })（無停止の更新 2b-3。docs/zero-downtime-update/stage2-server-state.md の M2・O9）。
// ply_agents・ply_computer・ply_browser・ply_control・ply_context を、使い捨てのポートの HTTP で確かめる。サーバーは立てない。
//   - 同じトークンで開き直すと、前と同じ URL・ヘッダーで呼べる（CLI が持つ値がそのまま通る）
//   - 既定の open()（token なし）は今のまま、呼ぶたびに新しい値
//   - 形の違うトークン・使用中のトークンは断る。閉じた後の同じトークンは受ける
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createAgentBridge } from '../../core/agent-bridge.mjs';
import { createBrowserBridge } from '../../core/browser-bridge.mjs';
import { createComputerBridge } from '../../core/computer-bridge.mjs';
import { createContextBridge } from '../../core/context-bridge.mjs';
import { createControlBridge } from '../../core/ops/surfaces/control.mjs';
import { createMcpBridge } from '../../core/mcp-bridge.mjs';
import { resolveRuntime } from '../../core/context-runtime.mjs';
import { DEFAULT_SCAN } from '../../core/context-settings.mjs';
import { TOKEN_PATTERN, claimToken } from '../../core/mcp-token.mjs';

export const name = 'mcp-bridge-token';
export const title = '会話の MCP の口を同じトークンで開き直す: 同じ URL・ヘッダーで通る・既定の open は新しい値・形の違う値と使用中の値は断る';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const bearer = headers => /^Bearer ([a-f0-9]{64})$/.exec(headers.Authorization)?.[1];

export default async function (t) {
  const calls = [];
  const agents = createAgentBridge({ call: async (owner, tool, args) => { calls.push({ owner, tool, args }); return { ok: true }; } });
  const browser = createBrowserBridge();
  const computer = createComputerBridge({ driver: {}, lock: { endTurn() {} }, shots: {}, access: {}, askPermission: async () => true, translate: x => x });
  const control = createControlBridge({ registry: { describe: () => [], invoke: async () => ({}) }, depsFor: () => ({}) });
  const mcp = createMcpBridge({ path: '/mcp/test', serverName: 'ply_test', tools: () => [], call: async (binding, name) => `${binding.owner}:${name}` });
  const context = createContextBridge();
  // 外部 MCP が無い（つなぎに行かない）空の runtime。探索は一時の cwd と home の中だけ
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-token-'));
  const policy = { version: 1, cwd: scratch, owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' }, user: { ...DEFAULT_SCAN, sources: [] }, directory: { ...DEFAULT_SCAN, sources: [] } };
  const emptyRuntime = await resolveRuntime(policy, { home: path.join(scratch, 'home'), locale: 'ja' });

  // 口ごとの道。どの口も POST の JSON-RPC を同じ形で受ける
  const server = http.createServer((req, res) => {
    const handler = { '/mcp/agents': agents, '/mcp/browser': browser, '/mcp/computer': computer, '/mcp/context': context, [control.path]: control, [mcp.path]: mcp }[req.url];
    handler.handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rpc = (url, headers, method, params) => fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const status = async (port) => (await rpc(port.url, port.headers, 'ping')).status;

  try {
    // ---- 共通の検査
    assert.match(TOKEN_A, TOKEN_PATTERN);
    assert.notEqual(claimToken(new Map()), claimToken(new Map()), '省略なら新しい値');
    assert.equal(claimToken(new Map(), TOKEN_A), TOKEN_A);
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, 12, {}]) assert.throws(() => claimToken(new Map(), bad), /Invalid token/, `形の違う値は断る: ${String(bad)}`);
    assert.throws(() => claimToken(new Map([[TOKEN_A, {}]]), TOKEN_A), /already in use/);
    t.ok('共通: 省略なら新しい値・64 桁の小文字の 16 進だけ受ける・使用中は断る', true);

    // ---- ply_agents
    {
      const owner = async () => 'conv-1';
      const first = agents.open({ origin, owner, locale: 'ja' });
      const second = agents.open({ origin, owner, locale: 'ja' });
      assert.notEqual(first.headers.Authorization, second.headers.Authorization, '既定の open は呼ぶたびに新しい値');
      assert.match(first.headers.Authorization, /^Bearer [a-f0-9]{64}$/);
      first.close(); second.close();

      const restored = agents.open({ origin, owner, locale: 'ja', token: TOKEN_A });
      assert.equal(restored.headers.Authorization, `Bearer ${TOKEN_A}`);
      assert.equal(restored.url, `${origin}/mcp/agents`);
      // CLI が前に持っていた値（URL・ヘッダー）をそのまま使って呼べる
      const before = { url: `${origin}/mcp/agents`, headers: { Authorization: `Bearer ${TOKEN_A}` } };
      assert.equal(await status(before), 200);
      const out = await (await rpc(before.url, before.headers, 'tools/call', { name: 'ply_usage', arguments: {} })).json();
      assert.equal(out.result.isError, undefined);
      assert.deepEqual(calls.at(-1), { owner: 'conv-1', tool: 'ply_usage', args: {} });
      assert.equal((await (await rpc(before.url, before.headers, 'initialize', {})).json()).result.instructions, undefined, 'initialize では instructions を返さない（append だけ。ADR 0169）');
      assert.throws(() => agents.open({ origin, owner, locale: 'ja', token: TOKEN_A }), /already in use/, '使用中は断る');
      assert.throws(() => agents.open({ origin, owner, locale: 'ja', token: 'zz' }), /Invalid token/);
      assert.equal(await status(before), 200, '断った後も元の口は生きている');
      restored.close();
      assert.equal(await status(before), 401, '閉じた口は断る');
      const again = agents.open({ origin, owner, locale: 'ja', token: TOKEN_A });
      assert.equal(await status(before), 200, '閉じた後の同じトークンは受ける');
      again.close();
    }
    t.ok('ply_agents: 同じトークンで開き直すと前の URL・ヘッダーで initialize・tools/call が通る。二重・不正は断る', true);

    // ---- ply_browser
    {
      const owner = () => 'conv-1';
      const a = browser.open({ origin, owner, locale: 'ja' }), b = browser.open({ origin, owner, locale: 'ja' });
      assert.notEqual(a.headers.Authorization, b.headers.Authorization);
      a.close(); b.close();
      const restored = browser.open({ origin, owner, locale: 'ja', token: TOKEN_A });
      assert.deepEqual(restored.headers, { Authorization: `Bearer ${TOKEN_A}` });
      assert.equal(await status(restored), 200);
      assert.deepEqual((await (await rpc(restored.url, restored.headers, 'tools/list', {})).json()).result.tools, []);
      assert.throws(() => browser.open({ origin, owner, locale: 'ja', token: TOKEN_A }), /already in use/);
      assert.throws(() => browser.open({ origin, owner, locale: 'ja', token: TOKEN_A.toUpperCase() }), /Invalid token/);
      restored.close();
      assert.equal(await status(restored), 401);
      browser.open({ origin, owner, locale: 'ja', token: TOKEN_A }).close();
    }
    t.ok('ply_browser: 同じトークンで開き直せる。二重・不正は断る。閉じた後は受ける', true);

    // ---- ply_computer
    {
      const owner = async () => ({ sessionId: 's', turnId: 't', title: '', mode: 'default', signal: new AbortController().signal, ancestors: [] });
      const a = computer.open({ origin, owner, locale: 'ja' }), b = computer.open({ origin, owner, locale: 'ja' });
      assert.notEqual(a.headers.Authorization, b.headers.Authorization);
      a.close(); b.close();
      const restored = computer.open({ origin, owner, locale: 'ja', delivery: { images: 'path' }, token: TOKEN_A });
      assert.deepEqual(restored.headers, { Authorization: `Bearer ${TOKEN_A}` });
      assert.match(restored.instructions, /\S/);
      const listed = (await (await rpc(restored.url, restored.headers, 'tools/list', {})).json()).result.tools;
      assert(listed.length > 0, '前の URL・ヘッダーでツールの一覧が返る');
      assert.throws(() => computer.open({ origin, owner, locale: 'ja', token: TOKEN_A }), /already in use/);
      assert.throws(() => computer.open({ origin, owner, locale: 'ja', token: 'not-a-token' }), /Invalid token/);
      restored.close();
      assert.equal(await status(restored), 401);
      computer.open({ origin, owner, locale: 'ja', token: TOKEN_A }).close();
    }
    t.ok('ply_computer: 同じトークンで開き直せる。二重・不正は断る。閉じた後は受ける', true);

    // ---- ply_control（createMcpBridge の骨格。token は返り値にも載る）
    {
      for (const bridge of [control, mcp]) {
        const a = bridge.open({ origin, locale: 'ja', owner: 'conv-1' }), b = bridge.open({ origin, locale: 'ja', owner: 'conv-1' });
        assert.notEqual(a.token, b.token, '既定の open は呼ぶたびに新しい値');
        assert.equal(bearer(a.headers), a.token);
        a.close(); b.close();
        const restored = bridge.open({ origin, locale: 'ja', owner: 'conv-1', token: TOKEN_A });
        assert.equal(restored.token, TOKEN_A);
        assert.deepEqual(restored.headers, { Authorization: `Bearer ${TOKEN_A}` });
        assert.deepEqual(bridge.lookup(TOKEN_A), { owner: 'conv-1', locale: 'ja' }, '同じトークンで束縛を引ける（CLI の /api/ops の認証）');
        assert.equal(await status(restored), 200);
        assert.throws(() => bridge.open({ origin, locale: 'ja', owner: 'conv-2', token: TOKEN_A }), /already in use/);
        assert.equal(bridge.lookup(TOKEN_A).owner, 'conv-1', '断った開き直しは元の束縛を変えない');
        assert.throws(() => bridge.open({ origin, locale: 'ja', owner: 'conv-1', token: TOKEN_A.slice(1) }), /Invalid token/);
        restored.close();
        assert.equal(bridge.lookup(TOKEN_A), undefined);
        assert.equal(await status(restored), 401);
        bridge.open({ origin, locale: 'ja', owner: 'conv-1', token: TOKEN_A }).close();
      }
      // 汎用の骨格は tools/call も同じトークンで通る
      const restored = mcp.open({ origin, locale: 'ja', owner: 'conv-1', token: TOKEN_B });
      const out = await (await rpc(restored.url, restored.headers, 'tools/call', { name: 'x', arguments: {} })).json();
      assert.equal(out.result.content[0].text, 'conv-1:x');
      restored.close();
    }
    t.ok('ply_control（骨格）: 同じトークンで開き直せて lookup・tools/call が通る。二重・不正は断る。閉じた後は受ける', true);

    // ---- ply_context（開く時点で token を受ける。会話のあいだ同じ値を使う口の、もとからの形）
    {
      const opened = await context.open({ runtime: emptyRuntime, prompt: '', origin, isActive: () => true, token: TOKEN_A });
      assert.deepEqual(opened.headers, { Authorization: `Bearer ${TOKEN_A}` });
      assert.equal(await status(opened), 200);
      await assert.rejects(context.open({ runtime: emptyRuntime, prompt: '', origin, isActive: () => true, token: 'xyz' }));
      assert.equal(await status(opened), 200, '断った後も元の口は生きている');
      const fresh = await context.open({ runtime: emptyRuntime, prompt: '', origin, isActive: () => true });
      assert.notEqual(bearer(fresh.headers), TOKEN_A, '省略時は新しい値');
      await fresh.close();
      await opened.close();
      assert.equal(await status(opened), 401);
    }
    t.ok('ply_context: token を受ける（形の違う値は断る・省略時は新しい値・閉じたら 401）', true);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(scratch, { recursive: true, force: true }); }
}
