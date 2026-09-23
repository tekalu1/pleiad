import http from 'node:http';
import crypto from 'node:crypto';

// An estimate, not a provider tokenizer. Includes serialized instructions/tools.
// CJK text is counted separately rather than assuming four characters per token.
export function estimateInput(body) {
  const text = JSON.stringify({ messages: body.messages, input: body.input, instructions: body.instructions, system: body.system, tools: body.tools });
  const wide = (text.match(/[^\x00-\x7f]/gu) || []).length;
  return Math.ceil((text.length - wide) / 3 + wide * 1.5);
}
export function prepareRequest(body, type, limits) {
  const next = { ...body };
  if (limits.context && estimateInput(body) + limits.output > limits.context) {
    throw new Error('入力の推定量がコンテキスト予算を超えました。コンテキスト長を増やすか、自動要約の基準を下げて再送信してください。履歴は削除していません。');
  }
  if (limits.output && !type.includes('codex')) {
    if (type.startsWith('anthropic')) {
      if (body.thinking?.budget_tokens >= limits.output) throw new Error('最大出力を thinking のトークン予算より大きくしてください');
      next.max_tokens = limits.output;
    } else if (type === 'openai' || /^o\d|^gpt-5/.test(body.model ?? '')) next.max_completion_tokens = limits.output;
    else next.max_tokens = limits.output;
  }
  return next;
}

// Loopback-only request adapter in the isolated procway process. Native provider
// formatting, image hydration, SSE parsing and OAuth refresh remain unchanged.
export async function startBudgetGateway(provider, limits, fetchImpl = fetch) {
  const upstream = (provider.baseUrl || 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '');
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const ac = new AbortController();
    res.once('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      if (!req.url.startsWith('/' + token + '/') || req.method !== 'POST') { res.writeHead(404).end(); return; }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 32 * 1024 * 1024) throw new Error('入力が大きすぎます'); chunks.push(c); }
      const body = prepareRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), provider.type, limits);
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; delete headers.connection;
      const r = await fetchImpl(upstream + req.url.slice(token.length + 1), { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal, redirect: 'error' });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
      if (r.body) for await (const chunk of r.body) {
        if (!res.write(chunk)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        if (res.destroyed) break;
      }
      res.end();
    } catch (e) {
      if (res.headersSent) return res.destroy();
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message?.includes('予算') || e.message?.includes('入力') || e.message?.includes('最大出力') ? e.message : 'モデルへの接続に失敗しました。接続先を確認してください', type: 'ply_context_budget' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/${token}`, close: () => server.close() };
}

export function applyLimits(settings, id, provider, limits) {
  const out = structuredClone(settings);
  out.defaultProvider = id; out.providers[id] = { ...provider };
  if (!limits) return out;
  const compact = out.session.autoCompact;
  if (limits.compact !== null) compact.enabled = limits.compact;
  if (limits.compact === true) compact.strategy = 'llm-summary';
  if (limits.threshold) compact.estimatedTokens = limits.threshold;
  if (limits.keep) compact.keepLastMessages = limits.keep;
  // Keep the existing strategy; the UI only changes explicitly exposed settings.
  const stale = out.tools.staleToolResults === false ? { enabled: false } : { ...out.tools.staleToolResults };
  if (limits.condense !== null) stale.enabled = limits.condense;
  if (limits.recent) stale.keepRecent = limits.recent;
  if (limits.chars) stale.maxChars = limits.chars;
  out.tools.staleToolResults = stale;
  if (limits.output && provider.type.startsWith('anthropic')) out.providers[id].maxTokens = limits.output;
  return out;
}
