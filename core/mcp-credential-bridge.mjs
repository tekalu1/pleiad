// procway の native 経路（MCP の担当がエージェント）で、Pleiad の MCP 登録の接続先と資格情報を serve 子に渡す口。
//
// native の procway は serve 子が外部 MCP に直接つなぐ（Pleiad が Claude / Codex の登録を procway 形式に変換して渡す）。
// そこで同名の Pleiad の登録があれば、その接続先と認証（bearer・ヘッダー・stdio の env・OAuth）を使う。
// 渡し方は procway の「dashboard が .procway-connections.json を書き、ai-agent が起動時と 401 のたびに読み直す」
// 仕組みに倣うが、ファイルではなくこのループバックの口から引く:
//   - 利用者の作業ツリーにも、Pleiad の置き場にも、トークンを平文で書かない
//   - リフレッシュは Pleiad（core/mcp-oauth.mjs）だけが行う。serve 子は 401 のたびに引き直すだけ
// 呼べるのは会話ごとに発行したトークンを持つ serve 子だけ（ply_agents と同じ寿命。server.mjs の agentConnection）。
import crypto from 'node:crypto';

export const MCP_CREDENTIALS_PATH = '/mcp/credentials';
const RESERVED = new Set(['host', 'ply', 'ply_context', 'ply_agents', '__proto__', 'constructor', 'prototype']);

/**
 * Pleiad の登録 1 件を procway の mcpServers の形にする。秘密はここで初めて読む。
 * rejected は serve 子が 401 を受けたときの Authorization のトークン（OAuth なら 1 回だけリフレッシュする）
 */
export async function procwayServerFor(name, { plyMcp, oauth, cwd, rejected } = {}) {
  let definition;
  try { definition = await plyMcp.registration(name); }
  catch { return { status: 'failed', reason: 'その名前の MCP は Pleiad に登録されていません' }; }
  if (definition.enabled === false) return { status: 'disabled' };
  // procway が守れない制限は黙って落とさない（core/procway-mcp.mjs と同じ方針）。この 1 件はエージェント側の登録のまま
  const unsupported = ['enabled_tools', 'disabled_tools', 'cwd'].filter(k => Object.hasOwn(definition, k));
  if (unsupported.length) return { status: 'unsupported', reason: `procway では ${unsupported.join(' / ')} に未対応です` };
  try {
    const conn = await plyMcp.connection(name, cwd);
    const timeoutMs = Number.isFinite(definition.tool_timeout_sec) ? definition.tool_timeout_sec * 1000 : undefined;
    if (conn.type === 'stdio') {
      // env は登録で入れた値だけ（残りは serve 子の環境変数を procway が継ぐ）
      const env = Object.fromEntries((definition.envKeys ?? []).filter(k => conn.env?.[k] !== undefined).map(k => [k, conn.env[k]]));
      return { status: 'ok', server: { transport: 'stdio', command: conn.command, args: conn.args, env, ...(timeoutMs ? { timeoutMs } : {}) } };
    }
    const headers = { ...conn.headers };
    if (definition.auth === 'oauth') {
      if (!oauth) return { status: 'failed', reason: 'OAuth を扱えない起動です' };
      headers.Authorization = `Bearer ${await oauth.accessToken(name, definition, conn, rejected ? { force: true, rejected } : {})}`;
    }
    return { status: 'ok', server: { transport: conn.type === 'sse' ? 'sse' : 'http', baseUrl: conn.url, headers, ...(timeoutMs ? { timeoutMs } : {}) } };
  } catch (e) {
    if (e?.code === 'MCP_AUTH_REQUIRED') return { status: 'needs-auth', reason: e.message };
    return { status: 'failed', reason: e?.code === 'INVALID' || e?.code === 'SECRET_LOCKED' ? e.message : '接続情報を用意できません' };
  }
}

export function createCredentialBridge({ plyMcp, oauth }) {
  const bindings = new Map();
  return {
    /** 会話ごとの口。cwd は stdio の登録の作業場所の解決に使う */
    open({ origin, cwd }) {
      const token = crypto.randomBytes(32).toString('hex');
      bindings.set(token, { cwd });
      return { url: origin + MCP_CREDENTIALS_PATH, headers: { Authorization: `Bearer ${token}` }, close: () => bindings.delete(token) };
    },
    async handle(req, res) {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const binding = bindings.get(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1]);
      if (!binding) return reply(401, { error: 'Unauthorized' });
      if (req.method !== 'POST') return reply(405, {});
      // ブラウザからは呼ばせない（serve 子の fetch は Origin を付けない）
      if (req.headers.origin) return reply(403, {});
      let body;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) return reply(413, {}); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return reply(400, { error: 'Invalid JSON' }); }
      const name = body?.name;
      if (typeof name !== 'string' || RESERVED.has(name)) return reply(400, { error: 'Invalid name' });
      const rejected = typeof body.rejected === 'string' && body.rejected.length <= 16384 ? body.rejected : undefined;
      reply(200, await procwayServerFor(name, { plyMcp, oauth, cwd: binding.cwd, rejected }));
    },
  };
}
