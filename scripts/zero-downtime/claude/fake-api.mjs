// 段階 2-0 の探り: Anthropic の Messages API のふりをする最小の接続先（互換の接続先・数 MB の出力の場面に使う。LLM の費用がかからない）。
// 使い方: node fake-api.mjs <port> <tag> [log file]
//   env FAKE_BYTES   本文のバイト数（既定 64）。FAKE_CHUNK 1 回の delta のバイト数（既定 2048）
//   env FAKE_TOOL    最初の応答で Bash の tool_use を返し、tool_result を受けたら本文を返す（値はコマンド）
// 本文の頭に FROM=<tag> を付ける（どの接続先が答えたかを見分ける）
import http from 'node:http';
import fs from 'node:fs';

const [port, tag, logFile] = process.argv.slice(2);
const BYTES = Number(process.env.FAKE_BYTES ?? 64);
const CHUNK = Number(process.env.FAKE_CHUNK ?? 2048);
const TOOL = process.env.FAKE_TOOL ?? '';
const log = obj => { if (logFile) fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), tag, ...obj }) + '\n'); };
let n = 0;

function bodyText() {
  const head = `FROM=${tag} `;
  if (BYTES <= head.length + 4) return head + 'DONE';
  const line = '0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\n';
  let s = head;
  while (s.length < BYTES - 4) s += line;
  return s.slice(0, BYTES - 4) + 'DONE';
}

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = null;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* ignore */ }
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url.endsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 10 })); }
  if (!(req.method === 'POST' && url.endsWith('/v1/messages'))) { log({ path: url, method: req.method, status: 404 }); res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } })); }
  const id = `msg_fake_${++n}`;
  const msgs = body?.messages ?? [];
  // ツールの結果を受けた後は本文を返す（1 回の会話でツールは 1 回。CLI は tool_result の後ろに別の user 行を足すことがあるので、最後の行だけを見ない）
  const lastIsToolResult = msgs.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
  const hasTools = Array.isArray(body?.tools) && body.tools.some(t => t.name === 'Bash');
  const useTool = TOOL && hasTools && !lastIsToolResult;
  log({ path: url, model: body?.model, stream: Boolean(body?.stream), messages: msgs.length, lastIsToolResult, useTool, auth: Boolean(req.headers.authorization || req.headers['x-api-key']) });
  const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const text = bodyText();
  const content = useTool ? [{ type: 'tool_use', id: `toolu_fake_${n}`, name: 'Bash', input: { command: TOOL, description: 'probe' } }] : [{ type: 'text', text }];
  const stop = useTool ? 'tool_use' : 'end_turn';
  if (!body?.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content, stop_reason: stop, stop_sequence: null, usage })); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body?.model ?? 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  if (useTool) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: content[0].id, name: 'Bash', input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } });
  } else {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < text.length; i += CHUNK) {
      const ok = res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + CHUNK) } })}\n\n`);
      if (!ok) await new Promise(r => res.once('drain', r));
    }
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
});
server.listen(Number(port), '127.0.0.1', () => { console.log(`fake-api ${tag} listening ${port}`); });
