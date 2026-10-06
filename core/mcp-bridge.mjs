// 会話ごとの HTTP の MCP の骨格（ADR 0081）。会話ごとに Bearer のトークンを開き、そのトークンに束縛を持たせる。
// ply_control が最初の利用者。ply_agents・ply_browser は同じ骨格のコピーを持っていて、名前と返り値の形を保ったまま後でここへ移す（移行の段階 3）。
//
//   createMcpBridge({ path, serverName, instructions?, tools, call, maxBody? })
//     tools(locale, binding)               tools/list の中身（会話の言語で）
//     call(binding, name, args, { locale, signal }) ツールの本体。文字列か { text, isError } を返す（投げれば isError の文になる）。
//                                          signal は呼び出した側が切断したら中断される（承認を待つ呼び出しが取り下げるのに使う）
//     instructions(locale)                 initialize の instructions。無ければ返さない（指示を別の経路で渡す会話の二重を避ける）
//   bridge.open({ origin, locale, token?, ...bound }) → { url, headers, token, close }   bound は call と tools に渡る束縛（owner など）。
//                                          token を渡すと、その値で開き直す（形が違う・使用中なら投げる。省略なら新しく作る）
//   bridge.lookup(token)                 そのトークンの束縛（無ければ undefined）。同じトークンで CLI（/api/ops）を束縛するのに使う
//   bridge.handle(req, res)              POST だけ受ける。トークンが無い・知らないものは 401
import { claimToken } from './mcp-token.mjs';

const TOKEN = /^Bearer ([a-f0-9]{64})$/;

export function createMcpBridge({ path, serverName, version = '1.0.0', instructions, tools, call, maxBody = 256_000 }) {
  const bindings = new Map();

  async function serve(req, res) {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    const binding = bindings.get(TOKEN.exec(req.headers.authorization ?? '')?.[1]);
    if (!binding) return reply(401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return reply(405);
    // ブラウザーの別のページから叩かれても通さない（トークンが要るので念のため）
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403); } catch { return reply(403); }
    }
    let m;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBody) return reply(413); chunks.push(chunk); }
      m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return reply(400, { error: 'Invalid JSON' }); }
    if (m?.jsonrpc !== '2.0' || typeof m.method !== 'string') return reply(400);
    if (m.id === undefined) return reply(202);
    const { locale } = binding;
    let result;
    if (m.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: serverName, version },
        ...(instructions ? { instructions: instructions(locale) } : {}) };
    } else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools: tools(locale, binding) };
    else if (m.method === 'tools/call') {
      try {
        const name = m.params?.name;
        const args = m.params?.arguments ?? {};
        if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool call');
        // 返す前に呼び出した側がつながりを切ったら（クライアントの時間切れ・プロセスの終了）、待っている承認などを取り下げられるようにする
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableFinished) gone.abort(); });
        const out = await call(binding, name, args, { locale, signal: gone.signal });
        const { text, isError = false } = typeof out === 'string' ? { text: out } : out;
        result = { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
      } catch (e) { result = { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] }; }
    } else return reply(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    reply(200, { jsonrpc: '2.0', id: m.id, result });
  }

  return {
    path,
    open({ origin, locale, token: fixed, ...bound }) {
      const token = claimToken(bindings, fixed);
      bindings.set(token, { ...bound, locale });
      return { url: origin + path, headers: { Authorization: `Bearer ${token}` }, token, close: () => bindings.delete(token) };
    },
    lookup(token) {
      return typeof token === 'string' ? bindings.get(token) : undefined;
    },
    async handle(req, res) {
      // 想定外の例外でサーバーごと落とさない（未処理の reject はプロセスを終わらせる）
      try { await serve(req, res); }
      catch (e) { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: String(e?.message ?? e) })); } }
    },
  };
}
