// MCP のツールの生成器（core/ops/surfaces/mcp.mjs）と、会話ごとの HTTP の MCP の骨格（core/mcp-bridge.mjs）・ply_control（core/ops/surfaces/control.mjs）。
// サーバーは立てない。HTTP は 127.0.0.1 の使い捨てのポートで、偽の依存を渡して確かめる。
import http from 'node:http';
import { registry } from '../../core/ops/index.mjs';
import { createMcpBridge } from '../../core/mcp-bridge.mjs';
import { createControlBridge, controlInstructions, controlTexts, CONTROL_MCP_PATH } from '../../core/ops/surfaces/control.mjs';
import { callMcpTool, mcpTools, CONTROL_SERVER } from '../../core/ops/surfaces/mcp.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';

export const name = 'ops-mcp';
export const title = 'MCP の生成器と橋: 直に出すツール・list_ops と call_op・会話ごとの Bearer・権限の配線';

const texts = { instructions: 'I', listOps: 'LIST', listOpsId: 'ID', callOp: 'CALL', callOpOp: 'OP', callOpArgs: 'ARGS', notFound: 'No {{id}}.' };
const catalog = [
  { id: 'a.one', summary: '1', risk: 'read', scope: 'global', mcp: 'direct', tool: 'one_a', input: { type: 'object', properties: { n: { type: 'integer' } }, additionalProperties: false }, cli: null },
  { id: 'a.two', summary: '2', risk: 'write', scope: 'global', mcp: 'catalog', tool: null, input: { type: 'object', properties: {}, additionalProperties: false }, cli: null },
];

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const rpc = async (url, headers, body, raw = false) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 本文なし */ }
  return { status: res.status, json };
};

export default async function (t) {
  // ---- 生成器
  const tools = mcpTools({ catalog, texts });
  t.ok('ツールは直に出す操作 → list_ops → call_op の順', tools.map((x) => x.name).join() === 'one_a,list_ops,call_op');
  t.ok('catalog の操作は直に出さない（量が増えない）', !tools.some((x) => x.name.includes('two')));
  t.ok('直に出すツールの名前・説明・入力は操作のもの', tools[0].description === '1' && tools[0].inputSchema.properties.n.type === 'integer');
  t.ok('list_ops・call_op は additionalProperties: false で、call_op は op が必須', tools.slice(1).every((x) => x.inputSchema.additionalProperties === false) && tools[2].inputSchema.required.join() === 'op');
  t.ok('全ツールの名前は MCP の名前の規則（英数・_・-、64 字まで）', tools.every((x) => /^[a-zA-Z0-9_-]{1,64}$/.test(x.name)));

  const calls = [];
  const invoke = async (id, args) => { calls.push([id, args]); return id === 'a.bad' ? { ok: false, code: 'INVALID', error: 'bad', issues: [{ path: 'n', code: 'invalid_type', message: 'x' }] } : { ok: true, result: { id, args } }; };
  const call = (name, args) => callMcpTool({ catalog, texts, name, args, invoke });
  const all = JSON.parse((await call('list_ops', {})).text);
  t.ok('list_ops は全部の id・説明・危険度（直に出すものにはツール名）', all.ops.length === 2 && all.ops[0].tool === 'one_a' && all.ops[1].risk === 'write' && !('tool' in all.ops[1]));
  const one = JSON.parse((await call('list_ops', { id: 'a.one' })).text);
  t.ok('list_ops に id を渡すと入力の JSON Schema を返す', one.input.properties.n.type === 'integer' && one.scope === 'global');
  const nf = await call('list_ops', { id: 'a.zzz' });
  t.ok('list_ops の無い id は NOT_FOUND（isError）', nf.isError === true && JSON.parse(nf.text).code === 'NOT_FOUND' && JSON.parse(nf.text).error === 'No a.zzz.');
  const viaCall = await call('call_op', { op: 'a.two', args: { k: 1 } });
  t.ok('call_op は invoke に op と args を渡し、結果を JSON で返す', !viaCall.isError && JSON.parse(viaCall.text).id === 'a.two' && calls.at(-1)[1].k === 1);
  t.ok('call_op の args を省くと {}', (await call('call_op', { op: 'a.two' })) && calls.at(-1)[1] && Object.keys(calls.at(-1)[1]).length === 0);
  const failed = await call('call_op', { op: 'a.bad', args: {} });
  t.ok('失敗は isError で、code・error・issues を返す（モデルが自分で直せる）', failed.isError === true && JSON.parse(failed.text).code === 'INVALID' && JSON.parse(failed.text).issues[0].path === 'n');
  const directCall = await call('one_a', { n: 2 });
  t.ok('直に出すツールは対応する操作を呼ぶ', calls.at(-1)[0] === 'a.one' && JSON.parse(directCall.text).args.n === 2);
  t.ok('知らないツールは NOT_FOUND', (await call('nope', {})).isError === true);
  t.ok('op が文字列でなくても落ちない', (await call('call_op', { op: 5 })).text !== undefined);

  // ---- 骨格（会話ごとの Bearer）
  const seen = [];
  const bridge = createMcpBridge({ path: '/mcp/x', serverName: 'ply_x', tools: (locale, b) => [{ name: `t_${b.tag}_${locale}` }], call: async (b, name, args) => { seen.push([b.tag, name, args]); if (name === 'boom') throw new Error('壊れた'); return name === 'err' ? { text: 'E', isError: true } : `ok:${b.tag}`; }, maxBody: 2000 });
  const a = bridge.open({ origin: 'http://h', locale: 'ja', tag: 'A' });
  const b = bridge.open({ origin: 'http://h', locale: 'en', tag: 'B' });
  t.ok('open は url・Bearer（64 桁の 16 進）・token・close を返し、会話ごとに別のトークン', a.url === 'http://h/mcp/x' && /^Bearer [a-f0-9]{64}$/.test(a.headers.Authorization) && a.token !== b.token && a.headers.Authorization === `Bearer ${a.token}`);
  t.ok('lookup はトークンの束縛を返す。知らないトークンは undefined', bridge.lookup(a.token).tag === 'A' && bridge.lookup('x'.repeat(64)) === undefined && bridge.lookup(undefined) === undefined);
  const srv = await listen((req, res) => bridge.handle(req, res));
  try {
    const url = `${srv.origin}/mcp/x`;
    const authA = { authorization: a.headers.Authorization }, authB = { authorization: b.headers.Authorization };
    t.ok('トークンが無いと 401', (await rpc(url, {}, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
    t.ok('知らないトークンは 401', (await rpc(url, { authorization: `Bearer ${'0'.repeat(64)}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
    t.ok('形の違うトークンは 401', (await rpc(url, { authorization: 'Bearer short' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
    t.ok('GET は 405', (await fetch(url, { headers: authA })).status === 405);
    const init = (await rpc(url, authA, { jsonrpc: '2.0', id: 1, method: 'initialize' })).json.result;
    t.ok('initialize は serverInfo を返し、instructions は渡さない（指示は別の経路。二重にしない）', init.serverInfo.name === 'ply_x' && !('instructions' in init) && init.capabilities.tools !== undefined);
    t.ok('tools/list は会話の言語と束縛で作る（別の会話は別の一覧）', (await rpc(url, authA, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools[0].name === 't_A_ja'
      && (await rpc(url, authB, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools[0].name === 't_B_en');
    const ok = (await rpc(url, authA, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x', arguments: { k: 1 } } })).json.result;
    t.ok('tools/call は束縛を渡し、文字列を text にする', ok.content[0].text === 'ok:A' && !ok.isError && seen.at(-1)[0] === 'A' && seen.at(-1)[2].k === 1);
    t.ok('別の会話のトークンは別の束縛で呼ばれる', (await rpc(url, authB, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } })).json.result.content[0].text === 'ok:B');
    t.ok('{ text, isError } を返せる', (await rpc(url, authA, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'err' } })).json.result.isError === true);
    const boom = (await rpc(url, authA, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } })).json.result;
    t.ok('投げたら isError の文になる（落ちない）', boom.isError === true && boom.content[0].text === '壊れた');
    t.ok('arguments が配列・name が無いと isError', (await rpc(url, authA, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'x', arguments: [] } })).json.result.isError === true
      && (await rpc(url, authA, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} })).json.result.isError === true);
    t.ok('ping・知らないメソッド（-32601）・通知（202）', (await rpc(url, authA, { jsonrpc: '2.0', id: 7, method: 'ping' })).json.result !== undefined
      && (await rpc(url, authA, { jsonrpc: '2.0', id: 8, method: 'nope' })).json.error.code === -32601
      && (await rpc(url, authA, { jsonrpc: '2.0', method: 'notifications/initialized' })).status === 202);
    t.ok('壊れた JSON は 400、jsonrpc でないものも 400', (await rpc(url, authA, '{', true)).status === 400 && (await rpc(url, authA, { id: 1 })).status === 400);
    t.ok('本文が大きすぎると 413', (await rpc(url, authA, { jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(3000) })).status === 413);
    t.ok('別のページ（Origin が違う）からは 403', (await rpc(url, { ...authA, origin: 'http://evil.example' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 403);
    a.close();
    t.ok('close したトークンは 401', (await rpc(url, authA, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401 && (await rpc(url, authB, { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 200);
  } finally { await srv.close(); }

  // ---- 想定外の例外でサーバーごと落ちない
  const crashy = createMcpBridge({ path: '/mcp/y', serverName: 'ply_y', tools: () => { throw new Error('壊れた一覧'); }, call: async () => 'ok' });
  const cy = crashy.open({ origin: 'http://h', locale: 'ja' });
  const crash = await listen((req, res) => crashy.handle(req, res));
  try {
    const bad = await rpc(`${crash.origin}/mcp/y`, cy.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    t.ok('tools/list が投げても 500 で返す（未処理の例外でサーバーが終わらない）', bad.status === 500 && /壊れた一覧/.test(bad.json?.error ?? ''));
    t.ok('その後も同じトークンで使える', (await rpc(`${crash.origin}/mcp/y`, cy.headers, { jsonrpc: '2.0', id: 2, method: 'ping' })).status === 200);
  } finally { await crash.close(); }

  // ---- ply_control（実際の操作の一覧と偽の依存）
  const MODES = { bypass: { scope: 'full', autonomy: 'never' }, ask: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'readonly', autonomy: 'ask' } };
  const titles = [];
  const depsFor = (locale) => ({ locale, modeOf: async (id) => MODES[id], audit: () => {},
    sessions: { list: async () => [], get: async (id) => ({ row: { id, title: 't', backend: 'fake' }, children: [], history: [] }), setTitle: async (id, title) => { titles.push([id, title]); } } });
  const control = createControlBridge({ registry, depsFor });
  const owners = {};
  const open = (sessionId, locale = 'ja') => control.open({ origin: 'http://h', locale, owner: async () => { if (!sessionId) throw new Error('会話の id がまだ決まっていません'); return sessionId; } });
  const cs = await listen((req, res) => control.handle(req, res));
  try {
    const url = `${cs.origin}${CONTROL_MCP_PATH}`;
    const ask = open('ask'), plan = open('plan'), pending = open(null), en = open('ask', 'en');
    const call2 = (c, name, args) => rpc(url, c.headers, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).then((r) => r.json.result);
    const list = (await rpc(url, ask.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools;
    t.ok('ply_control の tools/list は直に出す操作と list_ops・call_op', list.at(-2).name === 'list_ops' && list.at(-1).name === 'call_op' && list.some((x) => x.name === 'search_sessions') && list.some((x) => x.name === 'get_session') && list.some((x) => x.name === 'read_session') && list.some((x) => x.name === 'get_setting'), list.map((x) => x.name).join());
    t.ok('サーバー名は ply_control・パスは /mcp/control', CONTROL_SERVER === 'ply_control' && CONTROL_MCP_PATH === '/mcp/control');
    const j = (r) => JSON.parse(r.content[0].text);
    t.ok('直に出すツールで読める（get_session）', j(await call2(ask, 'get_session', { sessionId: 's1' })).id === 's1');
    t.ok('call_op で catalog の操作を呼べる（sessions.list）', Array.isArray(j(await call2(ask, 'call_op', { op: 'sessions.list', args: {} })).sessions));
    const wrote = await call2(ask, 'call_op', { op: 'sessions.setTitle', args: { title: '題' } });
    t.ok('write は束縛された会話（sessionId を省いた先）に対して通る', !wrote.isError && j(wrote).sessionId === 'ask' && titles.at(-1).join() === 'ask,題');
    const ro = await call2(plan, 'call_op', { op: 'sessions.setTitle', args: { title: '題' } });
    t.ok('読み取りの会話の write は READ_ONLY_MODE（束縛した会話の承認モードで決まる）', ro.isError === true && j(ro).code === 'READ_ONLY_MODE');
    const early = await call2(pending, 'call_op', { op: 'sessions.setTitle', args: { title: '題' } });
    t.ok('会話の id が決まる前は、束縛なしとして通さず失敗する（書き込みを断れなくなるため）', early.isError === true && /まだ決まっていません/.test(early.content[0].text) && titles.length === 1);
    const bad = await call2(ask, 'call_op', { op: 'sessions.setTitle', args: { title: '' } });
    t.ok('入力の誤りは INVALID と issues', bad.isError === true && j(bad).code === 'INVALID' && j(bad).issues[0].path === 'title');
    t.ok('無い操作は NOT_FOUND', j(await call2(ask, 'call_op', { op: 'x.y', args: {} })).code === 'NOT_FOUND');
    const hidden = await call2(ask, 'list_ops', {});
    t.ok('list_ops の一覧に human-only は無い', !j(hidden).ops.some((o) => registry.get(o.id)?.risk === 'human-only'));
    const enList = (await rpc(url, en.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools;
    t.ok('説明は会話の言語（ja と en で違う）', enList.find((x) => x.name === 'call_op').description !== list.find((x) => x.name === 'call_op').description && /operation/i.test(enList.find((x) => x.name === 'call_op').description));

    // 文の量: ply_control が毎ターン文脈に載せる文（指示 + ツールの定義）
    for (const lng of ['ja', 'en']) {
      const principal = { by: 'agent', via: 'mcp' };
      const tokens = estimateTokens(JSON.stringify(mcpTools({ catalog: registry.describe(principal, lng), texts: controlTexts(lng) })) + controlInstructions(lng));
      t.note(`ply_control の文の量（${lng}）: ${tokens} トークン（指示 ${estimateTokens(controlInstructions(lng))}）`);
      t.ok(`指示は 3〜4 行（${lng}）`, controlInstructions(lng).split('\n').length >= 3 && controlInstructions(lng).split('\n').length <= 4);
    }
  } finally { await cs.close(); }
}
