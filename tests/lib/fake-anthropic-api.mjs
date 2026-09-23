// Claude のトークンの持ち主の確認（GET /v1/models?limit=1 の応答ヘッダー anthropic-organization-id）の偽物。
// 本物の api.anthropic.com へは送らない。サーバーには AGENT_HOST_ANTHROPIC_API でこの URL を渡す。
import http from 'node:http';

/**
 * @param {Record<string, string>} orgs  トークン → 組織。載っていないトークンは 401、値が 'fail' なら 500
 * @returns {Promise<{ url: string, requests: { method: string, url: string, headers: object }[], close: () => Promise<void> }>}
 */
export async function startFakeAnthropicApi(orgs) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const org = token && orgs[token];
    if (req.method !== 'GET' || req.url !== '/v1/models?limit=1' || !org) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error"}'); return; }
    if (org === 'fail') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'anthropic-organization-id': org });
    res.end(JSON.stringify({ data: [{ id: 'claude-fake', type: 'model' }], has_more: true }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections?.(); }),
  };
}
