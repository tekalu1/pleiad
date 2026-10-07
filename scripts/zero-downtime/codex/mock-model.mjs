// LLM を呼ばないための、Responses API 風の偽のモデル提供元（段階 0 の実測用）。
// codex の model_providers に base_url として渡し、台本どおりに SSE を返す。
//
// 台本は「直近のユーザーの発言」に含まれる語で決まる。
//   SLOW:<n>   n 秒かけて本文を少しずつ流す（走っているターンを作る）
//   SHELL      承認が要るシェルを 1 回呼ぶ（function_call → 結果が返ったら完了の本文）
//   MCPCALL:<server>:<tool>   MCP のツールを 1 回呼ぶ（結果が返ったら、その中身を本文に写す）
//   SPAWN:<依頼文>   サブエージェントを 1 本起こす（multi_agent_v1.spawn_agent。子の最初の発言が <依頼文>）。結果が返ったら親は SPAWN_PARENT_SLOW 秒（既定 6）かけて本文を流す
//   BGTERM    裏の端末を 1 本起こす（exec_command が数百 ms で応答を返し、プロセスは走ったまま。ターンはすぐ終わる）
//   それ以外    "ok" と返す
// 受けたリクエストは requests に残す（/__requests で読める）。
import http from 'node:http';

export function startMockModel({ port = 0, log = () => {} } = {}) {
  const requests = [];
  let seq = 0;
  const sse = (res, events) => { for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify({ type: ev, ...data })}\n\n`); };
  const respObj = (id, status = 'in_progress', output = []) => ({ id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: 'mock-model', output });
  const text = (t) => ({ id: `msg_${++seq}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: t, annotations: [] }] });

  const server = http.createServer(async (req, res) => {
    if (req.url === '/__requests') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(requests)); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {}; try { body = JSON.parse(raw); } catch {}
    requests.push({ url: req.url, method: req.method, at: Date.now(), body });
    if (!req.url.includes('/responses')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const input = body.input ?? [];
    const lastUser = [...input].reverse().find((i) => i.type === 'message' && i.role === 'user');
    const userText = (lastUser?.content ?? []).map((c) => c.text ?? '').join('\n');
    const lastItem = input[input.length - 1];
    const id = `resp_${++seq}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, [['response.created', { response: respObj(id) }]]);
    const finish = (output) => { sse(res, [['response.completed', { response: { ...respObj(id, 'completed', output), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }]]); res.end(); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    req.on('close', () => log('model request closed', id));

    const spawn = /SPAWN:(.*)$/m.exec(userText);
    const toolBack = lastItem && /function_call_output|custom_tool_call_output/.test(lastItem.type);
    if (spawn && !toolBack) {
      const call = { id: `fc_${++seq}`, type: 'function_call', call_id: `call_${seq}`, name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: JSON.stringify({ message: spawn[1].trim() }), status: 'completed' };
      sse(res, [['response.output_item.added', { output_index: 0, item: call }], ['response.output_item.done', { output_index: 0, item: call }]]);
      return finish([call]);
    }
    if (/BGTERM/.test(userText) && !toolBack) {
      const args = { cmd: 'node -e "setInterval(() => console.log(Date.now()), 500)"', yield_time_ms: 300 };
      const call = { id: `fc_${++seq}`, type: 'function_call', call_id: `call_${seq}`, name: 'exec_command', arguments: JSON.stringify(args), status: 'completed' };
      sse(res, [['response.output_item.added', { output_index: 0, item: call }], ['response.output_item.done', { output_index: 0, item: call }]]);
      return finish([call]);
    }
    // ツールの結果が返ってきた回（SPAWN の親は、子が走っている間ターンを続ける）
    const spawnWait = spawn && toolBack ? Number(process.env.SPAWN_PARENT_SLOW ?? 6) : 0;
    if (spawnWait) {
      const t = text('');
      sse(res, [['response.output_item.added', { output_index: 0, item: { ...t, content: [] } }]]);
      for (let i = 0; i < spawnWait * 2; i++) {
        await sleep(500);
        sse(res, [['response.output_text.delta', { item_id: t.id, output_index: 0, content_index: 0, delta: `parent${i} ` }]]);
      }
      const done = text(Array.from({ length: spawnWait * 2 }, (_, i) => `parent${i} `).join(''));
      sse(res, [['response.output_item.done', { output_index: 0, item: done }]]);
      return finish([done]);
    }
    if (lastItem && /function_call_output|custom_tool_call_output/.test(lastItem.type)) {
      const out = typeof lastItem.output === 'string' ? lastItem.output : JSON.stringify(lastItem.output);
      const t = text(`TOOL_RESULT: ${out.slice(0, 400)}`);
      sse(res, [['response.output_item.added', { output_index: 0, item: { ...t, content: [] } }], ['response.output_text.delta', { item_id: t.id, output_index: 0, content_index: 0, delta: t.content[0].text }], ['response.output_item.done', { output_index: 0, item: t }]]);
      return finish([t]);
    }
    const slow = /SLOW:(\d+)/.exec(userText);
    if (slow) {
      const n = Number(slow[1]);
      const t = text('');
      sse(res, [['response.output_item.added', { output_index: 0, item: { ...t, content: [] } }]]);
      for (let i = 0; i < n * 2; i++) {
        await sleep(500);
        sse(res, [['response.output_text.delta', { item_id: t.id, output_index: 0, content_index: 0, delta: `tick${i} ` }]]);
      }
      const done = text(Array.from({ length: n * 2 }, (_, i) => `tick${i} `).join(''));
      sse(res, [['response.output_item.done', { output_index: 0, item: done }]]);
      return finish([done]);
    }
    const mcp = /MCPCALL:([\w-]+):([\w-]+)/.exec(userText);
    // codex が MCP のツールを名前空間つきで見せる形は版で違うので、tools の中から探す
    if (mcp) {
      const [, server, tool] = mcp;
      const names = JSON.stringify(body.tools ?? []);
      const found = (body.tools ?? []).flatMap((t) => t.type === 'namespace' ? (t.tools ?? []).map((x) => ({ ns: t.name, name: x.name })) : [{ ns: null, name: t.name }]);
      const hit = found.find((f) => (f.ns ?? f.name ?? '').includes(server) && (f.name ?? '').includes(tool)) ?? found.find((f) => (f.name ?? '').includes(tool));
      log('mcp tool lookup', server, tool, '->', JSON.stringify(hit), 'tools=', names.length > 600 ? names.slice(0, 600) : names);
      if (hit) {
        const call = { id: `fc_${++seq}`, type: 'function_call', call_id: `call_${seq}`, name: hit.name, ...(hit.ns ? { namespace: hit.ns } : {}), arguments: '{}', status: 'completed' };
        sse(res, [['response.output_item.added', { output_index: 0, item: call }], ['response.output_item.done', { output_index: 0, item: call }]]);
        return finish([call]);
      }
    }
    if (/SHELL/.test(userText)) {
      const shellTool = (body.tools ?? []).find((t) => /shell|exec_command/.test(t.name ?? '')) ?? { name: 'shell_command' };
      const args = shellTool.name === 'exec_command' ? { cmd: 'node --version' } : { command: 'node --version', workdir: undefined };
      const call = { id: `fc_${++seq}`, type: 'function_call', call_id: `call_${seq}`, name: shellTool.name, arguments: JSON.stringify(args), status: 'completed' };
      sse(res, [['response.output_item.added', { output_index: 0, item: call }], ['response.output_item.done', { output_index: 0, item: call }]]);
      return finish([call]);
    }
    const t = text('ok');
    sse(res, [['response.output_item.added', { output_index: 0, item: { ...t, content: [] } }], ['response.output_text.delta', { item_id: t.id, output_index: 0, content_index: 0, delta: 'ok' }], ['response.output_item.done', { output_index: 0, item: t }]]);
    finish([t]);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, close: () => server.close() })));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const m = await startMockModel({ port: Number(process.argv[2] ?? 0), log: console.error });
  console.log('mock-model listening', m.port);
}
