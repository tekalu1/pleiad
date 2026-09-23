// 互換の接続先の偽物（Anthropic Messages 互換・OpenAI Responses 互換・Chat Completions だけの先）。
// 本物の LLM は呼ばない。受けた要求を requests に残す（鍵が届いた先を確かめるため）。
//
//   const api = await startFakeCompatApi({ keys: ['sk-good'], auth: 'bearer' });
//   api.url                    http://127.0.0.1:<port>
//   api.requests               [{ method, path, headers, body }]
//   api.set({ ... })           振る舞いを変える
//
// 振る舞い:
//   keys        受け付けるキー（空なら認証を見ない）
//   auth        'bearer' | 'x-api-key' | 'api-key' | 'any'（どのヘッダーのキーを見るか）
//   messages    POST /v1/messages に応答するか（Anthropic 互換）
//   responses   POST /responses（/v1/responses も）に応答するか
//   chat        POST /chat/completions に応答するか
//   models      GET /models・/v1/models の ID（null なら 404）
//   knownModels 推論の要求で受け付けるモデル（空なら全部）。知らないモデルは 400
//   status      推論の要求に返す HTTP（既定 200）
//   redirect    true なら全部 307
import http from 'node:http';

export async function startFakeCompatApi(options = {}) {
  const state = { keys: [], auth: 'any', messages: true, responses: true, chat: true, models: ['fake-large', 'vendor/fake-small'], knownModels: [], status: 200, redirect: false, ...options };
  const requests = [];
  const keyOf = (h) => {
    const bearer = /^Bearer (.+)$/.exec(h.authorization ?? '')?.[1];
    if (state.auth === 'bearer') return bearer;
    if (state.auth === 'x-api-key') return h['x-api-key'];
    if (state.auth === 'api-key') return h['api-key'];
    return bearer ?? h['x-api-key'] ?? h['api-key'];
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null; try { body = JSON.parse(raw); } catch {}
    const u = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: u.pathname + u.search, headers: { ...req.headers }, body });
    if (state.redirect) { res.writeHead(307, { location: 'http://127.0.0.1:9/elsewhere' }); res.end(); return; }
    const p = u.pathname.replace(/\/+$/, '');
    const authed = !state.keys.length || state.keys.includes(keyOf(req.headers));
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    if (req.method === 'GET' && /\/models$/.test(p)) {
      if (!state.models) return json(res, 404, { error: { message: 'not found' } });
      if (!authed) return json(res, 401, { error: { message: 'bad key' } });
      return json(res, 200, { object: 'list', data: state.models.map(id => ({ id, object: 'model' })) });
    }
    const infer = (kind) => {
      if (!authed) return json(res, 401, { error: { message: 'invalid api key' } }), true;
      if (state.status !== 200) return json(res, state.status, { error: { message: 'failure ' + state.status } }), true;
      if (state.knownModels.length && !state.knownModels.includes(body?.model)) return json(res, 400, { error: { message: `model ${body?.model} not found` } }), true;
      return false;
    };
    if (req.method === 'POST' && /\/v1\/messages$/.test(p) && state.messages) {
      if (infer('messages')) return;
      const msg = { id: 'msg_fake', type: 'message', role: 'assistant', model: body?.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
      if (!body?.stream) return json(res, 200, { ...msg, content: [{ type: 'text', text: 'ok' }], stop_reason: 'max_tokens' });
      return sse(res, [
        ['message_start', { type: 'message_start', message: msg }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello from fake compat' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    if (req.method === 'POST' && /\/responses$/.test(p) && state.responses) {
      if (infer('responses')) return;
      const item = { type: 'message', id: 'msg_fake', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello from fake compat', annotations: [] }] };
      const response = { id: 'resp_fake', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body?.model, output: [item],
        usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 9 } };
      if (!body?.stream) return json(res, 200, response);
      return sse(res, [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_fake', delta: 'hello from fake compat' }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response }],
      ]);
    }
    if (req.method === 'POST' && /\/chat\/completions$/.test(p) && state.chat) {
      if (!authed) return json(res, 401, { error: { message: 'invalid api key' } });
      if (!body?.messages) return json(res, 400, { error: { message: 'messages is required' } });
      return json(res, 200, { id: 'chat_fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }
    json(res, 404, { error: { message: 'not found' } });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    set(patch) { Object.assign(state, patch); },
    close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections?.(); }),
  };
}
