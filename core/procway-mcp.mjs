// Settings adapters. MCP clients and transports stay in the serve child.
export function procwayMcpServers(native = {}, registrations = {}, env = process.env) {
  const servers = { ...native };
  const expand = value => {
    if (typeof value === 'string') return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const result = env[name] ?? fallback;
      if (result === undefined) throw new Error(`MCP の環境変数 ${name} が設定されていません`);
      return result;
    });
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
    return value;
  };
  for (const [name, entry] of Object.entries(registrations)) {
    if (['ply', 'host', 'ply_agents', '__proto__', 'constructor', 'prototype'].includes(name)) continue;
    const raw = entry.value;
    if (raw?.enabled === false || raw?.disabled === true) { servers[name] = { enabled: false }; continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`MCP ${name} の定義が不正です`);
    // Do not silently discard native access restrictions the child cannot enforce.
    if (['enabled_tools', 'disabled_tools', 'cwd'].some(k => Object.hasOwn(raw, k))) throw new Error(`MCP ${name}: procway では enabled_tools / disabled_tools / cwd に未対応です`);
    const value = entry.format === 'claude' ? expand(raw) : raw;
    const stdio = typeof value.command === 'string' && value.command.trim();
    const http = typeof value.url === 'string' && /^https?:\/\//.test(value.url);
    if ((!stdio && !http) || (stdio && http)) throw new Error(`MCP ${name} の command / url が不正です`);
    const server = stdio ? { transport: 'stdio', command: value.command, args: value.args ?? [], env: value.env ?? {} }
      : { transport: value.type === 'sse' ? 'sse' : 'http', baseUrl: value.url, headers: { ...value.headers, ...value.http_headers } };
    for (const [header, variable] of Object.entries(value.env_http_headers ?? {})) {
      if (!env[variable]) throw new Error(`MCP ${name} の認証環境変数が設定されていません`);
      server.headers[header] = env[variable];
    }
    if (value.bearer_token_env_var) {
      if (!env[value.bearer_token_env_var]) throw new Error(`MCP ${name} の認証環境変数が設定されていません`);
      server.headers.Authorization = `Bearer ${env[value.bearer_token_env_var]}`;
    }
    if (Number.isFinite(value.tool_timeout_sec)) server.timeoutMs = value.tool_timeout_sec * 1000;
    servers[name] = server;
  }
  // Tombstones also shadow procway's connection-distributed reserved names.
  servers.host = { enabled: false };
  servers.ply = { enabled: false };
  return servers;
}

/**
 * native の経路で、エージェント側の登録と同名の Pleiad の登録があれば、その接続先と資格情報に差し替える。
 * Pleiad の登録だけにあるものは足さない（どの MCP を使うかはエージェント側の登録が決める）。
 * access は { url, headers, servers: [{ name }] }（core/mcp-credential-bridge.mjs の口）。
 *
 * HTTP は authProvider で Pleiad から引く。procway の transport は起動時と 401 を受けたときに authProvider を呼ぶので、
 * 2 回目以降は直前に受け取ったトークンを rejected として送り、Pleiad が 1 回だけリフレッシュする
 * （procway の .procway-connections.json を 401 のたびに読み直す仕組みと同じ形。ただしファイルには書かない）。
 * authProvider はゲッターにして、読むたびに別の関数を返す。procway は MCP を起動するたびに設定を
 * Object.entries で写すので、transport ごとに「起動の 1 回目」と「401 の後」を見分けられる
 */
export async function withPlyCredentials(servers, access, { fetchImpl = fetch, log = console } = {}) {
  const out = { ...servers };
  const ask = async (name, rejected) => {
    const response = await fetchImpl(access.url, { method: 'POST', headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name, ...(rejected ? { rejected } : {}) }), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Pleiad から MCP ${name} の接続情報を受け取れません（HTTP ${response.status}）`);
    return response.json();
  };
  for (const { name } of access?.servers ?? []) {
    if (!Object.hasOwn(out, name) || out[name]?.enabled === false || ['host', 'ply', 'ply_context', 'ply_agents'].includes(name)) continue;
    let answer;
    try { answer = await ask(name); } catch (e) { log?.warn?.(`[ply] ${e.message}`); continue; }
    // ログインが要る Pleiad の登録は、認証なしでつなぎに行かない
    if (answer?.status === 'needs-auth') { out[name] = { enabled: false }; log?.warn?.(`[ply] MCP ${name}: ${answer.reason ?? 'Pleiad の MCP 管理でログインしてください'}`); continue; }
    // 使えない Pleiad の登録（procway が守れない制限など）は、エージェント側の登録のまま
    if (answer?.status !== 'ok' || !answer.server) { if (answer?.reason) log?.warn?.(`[ply] MCP ${name}: ${answer.reason}`); continue; }
    const server = { ...answer.server };
    if (server.transport !== 'stdio') {
      server.headers = {};
      Object.defineProperty(server, 'authProvider', { enumerable: true, get: () => {
        let issued = null;
        return async () => {
          const rejected = issued ? /^Bearer (.+)$/.exec(issued.Authorization ?? '')?.[1] : undefined;
          const next = await ask(name, rejected);
          issued = next?.status === 'ok' ? next.server?.headers ?? {} : {};
          return issued;
        };
      } });
    }
    out[name] = server;
  }
  return out;
}
