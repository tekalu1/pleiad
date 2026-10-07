// agy の中継（core/agy-context-relay.mjs）の再試行（無停止の更新 段階 3）。サーバーが入れ替わる間（口が閉じて開き直すまで 1〜数秒）にツールを引く・呼ぶと、
// 中継が「つながる前の失敗」だけ数秒やり直し、agy にはエラーを見せない。つながった後の切れ（ECONNRESET など）は呼び出しが二重に走りうるので、やり直さない。
// 待つ上限は PLY_RELAY_RETRY_MS（0 で再試行しない）。中継は本物のプロセス、口は本物の HTTP サーバー（閉じて、開き直す）
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../lib/server.mjs';

export const name = 'agy-relay-retry';
export const title = 'agy の中継: 口が数秒つながらなくても、つながる前の失敗だけやり直す';

const AUTH = `Bearer ${'a'.repeat(64)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 空きポートを 1 つ決める（閉じた口の代わり） */
async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/** 中継を起こし、JSON-RPC を 1 つ流して、返事を待つ。{ reply, ms } */
async function ask(port, message, { retryMs, env = {} } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'core', 'agy-context-relay.mjs')], {
    env: { ...process.env, PLY_CONTEXT_URL: `http://127.0.0.1:${port}/mcp/context`, PLY_CONTEXT_AUTHORIZATION: AUTH, ...(retryMs !== undefined ? { PLY_RELAY_RETRY_MS: String(retryMs) } : {}), ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  const started = Date.now();
  const got = new Promise(resolve => child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])); }));
  child.stdin.write(`${JSON.stringify(message)}\n`);
  try { return { reply: await Promise.race([got, sleep(30_000).then(() => null)]), ms: Date.now() - started }; }
  finally { child.kill(); }
}

export default async function (t) {
  const listed = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const serve = (port, onRequest) => new Promise(resolve => {
    const server = http.createServer(onRequest);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
  const ok = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  // 閉じた口が、中継の再試行の間に開き直る: エラーにならず、開いた後の返事が返る
  {
    const port = await freePort();
    let server = null;
    const opened = (async () => { await sleep(700); server = await serve(port, (req, res) => { req.resume(); req.on('end', () => ok(res, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'after_reopen' }] } })); }); })();
    try {
      const { reply, ms } = await ask(port, listed);
      await opened;
      t.ok('閉じた口が数秒で開き直せば、中継は再試行して返事を返す（エラーを agy に見せない）', reply?.result?.tools?.[0]?.name === 'after_reopen' && !reply.error, JSON.stringify(reply));
      t.ok('返事は口が開いた後に届く（待った分だけ遅れる）', ms >= 600, `${ms} ms`);
    } finally { server?.close(); }
  }

  // 開かないままなら、上限（PLY_RELAY_RETRY_MS）でエラーにする
  {
    const port = await freePort();
    const { reply, ms } = await ask(port, listed, { retryMs: 600 });
    t.ok('開かないままなら、上限の後に「つながらない」のエラーを返す（中継は落ちない）', reply?.error?.code === -32603 && /Pleiad/.test(reply.error.message), JSON.stringify(reply));
    t.ok('上限を過ぎるまでは待つ', ms >= 500 && ms < 10_000, `${ms} ms`);
  }

  // 再試行なし（0）: 今までどおり即エラー
  {
    const port = await freePort();
    const { reply, ms } = await ask(port, listed, { retryMs: 0 });
    t.ok('PLY_RELAY_RETRY_MS=0 は再試行しない（即エラー）', reply?.error?.code === -32603 && ms < 3000, `${ms} ms ${JSON.stringify(reply)}`);
  }

  // つながった後の切れは、やり直さない（呼び出しが二重に走りうる）
  {
    const port = await freePort();
    let hits = 0;
    const server = await serve(port, req => { hits++; req.socket.destroy(); });
    try {
      const { reply } = await ask(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'once', arguments: {} } });
      t.ok('つながった後の切れは再試行しない（呼び出しは 1 回だけ届く）。エラーは返る', hits === 1 && reply?.error?.code === -32603, `hits=${hits} ${JSON.stringify(reply)}`);
    } finally { server.close(); }
  }

  // 口が開いていれば、今までどおり 1 回で返る（401 などの HTTP のエラーはやり直さない）
  {
    const port = await freePort();
    let hits = 0;
    const server = await serve(port, (req, res) => { hits++; req.resume(); req.on('end', () => { res.writeHead(401); res.end(); }); });
    try {
      const { reply } = await ask(port, listed);
      t.ok('HTTP のエラー（401）は再試行しない', hits === 1 && reply?.error?.code === -32001, `hits=${hits} ${JSON.stringify(reply)}`);
    } finally { server.close(); }
  }
}
