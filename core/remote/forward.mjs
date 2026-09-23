// ホストの接続口の防火壁（docs/remote.md §4.2）。復号したストリームを、ホストの既存サーバーへの HTTP / WebSocket に組み立て直す。
//
// - `/mcp` で始まるパス（エージェント CLI 用の内部口）は通さない
// - HTTP は GET と HEAD だけ、WebSocket は /ws だけ
// - 端末から来たヘッダーは決まったものだけを通す（Cookie・Authorization・Host・Origin・hop-by-hop などは落ちる）。
//   `?token=` も落とし、ホストの UI トークンは接続口が付ける（HTTP は Cookie、/ws は ?token=）
// - 応答の Set-Cookie と hop-by-hop を落とす。ホストの UI トークンは端末に届かない
// 通さないものは RESET 3（防火壁が通さない）で返す。
import http from 'node:http';
import WebSocket from 'ws';
import { RESET_CODE } from './frames.mjs';

const COOKIE_NAME = 'agent_host_token';
/** 端末から通す要求のヘッダー（小文字）。これ以外は捨てる。 */
const PASS_REQUEST = new Set([
  'accept', 'accept-language', 'accept-encoding', 'cache-control', 'pragma',
  'if-none-match', 'if-modified-since', 'if-range', 'range', 'user-agent',
]);
/** 応答から捨てるヘッダー。 */
const DROP_RESPONSE = new Set([
  'set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-connection', 'te', 'trailer',
]);
const WS_RELEASE_BELOW = 64 * 1024;
const WS_PAUSE_ABOVE = 256 * 1024;

/**
 * 端末の言うパスを検める。通すなら { path }（組み立て直したもの。token は落とす）、通さないなら null。
 * WHATWG の URL で読み直してから判定し、判定したものをそのまま送る（`/x/../mcp` や `\mcp` の抜け道を作らない）。
 */
export function checkPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 8192) return null;
  let u;
  try { u = new URL(raw, 'http://host.invalid'); } catch { return null; }
  if (u.host !== 'host.invalid') return null;
  const lower = u.pathname.toLowerCase();
  let decoded = lower;
  try { decoded = decodeURIComponent(lower); } catch { return null; }
  for (const p of [lower, decoded]) if (p === '/mcp' || p.startsWith('/mcp/')) return null;
  u.searchParams.delete('token');
  return { path: u.pathname + u.search, pathname: u.pathname };
}

function requestHeaders(from) {
  const out = {};
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    for (const [k, v] of Object.entries(from)) {
      const key = String(k).toLowerCase();
      if (!PASS_REQUEST.has(key)) continue;
      const value = Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '');
      if (/[\r\n\0]/.test(value) || value.length > 4096) continue;
      out[key] = value;
    }
  }
  return out;
}

function responseHeaders(from) {
  const out = {};
  for (const [k, v] of Object.entries(from ?? {})) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE.has(key) || key.startsWith('proxy-')) continue;
    out[key] = v;
  }
  return out;
}

/** 端末の WebSocket の close code を、ws が送れるものに揃える。 */
function sendableCode(code) {
  return code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
}

/**
 * チャネルのストリーム 1 本を扱う。target() は { host, port }（ホストの既存サーバー）、token はホストの UI トークン。
 */
export function forwardStream(stream, { target, token }) {
  const head = stream.request ?? {};
  const checked = checkPath(head.path);
  if (stream.kind === 'http') {
    const method = String(head.method ?? '').toUpperCase();
    if (!checked || (method !== 'GET' && method !== 'HEAD')) return stream.reset(RESET_CODE.FORBIDDEN);
    return forwardHttp(stream, method, checked.path, requestHeaders(head.headers), target(), token);
  }
  if (!checked || checked.pathname !== '/ws') return stream.reset(RESET_CODE.FORBIDDEN);
  return forwardWs(stream, checked.path, head.protocols, target(), token);
}

function forwardHttp(stream, method, path, headers, { host, port }, token) {
  let responded = false;
  const req = http.request({
    host, port, method, path, agent: false,
    headers: { ...headers, cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` },
  });
  stream.on('reset', () => req.destroy());
  req.on('error', () => {
    if (stream.destroyed) return;
    if (responded) return stream.reset(RESET_CODE.INTERNAL);
    responded = true;
    stream.respond({ status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } }).catch(() => {});
    stream.end('bad gateway').catch(() => {});
  });
  req.on('response', res => {
    if (stream.destroyed) { res.destroy(); return; }
    responded = true;
    stream.respond({ status: res.statusCode ?? 502, headers: responseHeaders(res.headers) }).catch(() => {});
    res.on('data', chunk => {
      res.pause();
      stream.write(chunk).then(() => res.resume(), () => res.destroy());
    });
    res.on('end', () => { stream.end().catch(() => {}); });
    res.on('error', () => { if (!stream.destroyed) stream.reset(RESET_CODE.INTERNAL); });
  });
  req.end();
}

function forwardWs(stream, path, protocols, { host, port }, token) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}${path}${sep}token=${encodeURIComponent(token)}`;
  const list = Array.isArray(protocols) ? protocols.filter(p => typeof p === 'string' && /^[\x21-\x7e]{1,64}$/.test(p)).slice(0, 8) : [];
  // ホストのサーバーから見るとループバックの接続なので、印を付けて「サーバーのある PC の画面」と区別させる
  // （core/os-open.mjs の isLocalRequest。エクスプローラーで表示・ブラウザーで開くをリモートの端末から動かさない）
  const local = new WebSocket(url, list, { perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10_000,
    headers: { 'x-forwarded-for': 'pleiad-remote' } });
  let opened = false;
  let inflight = 0;

  stream.on('reset', () => local.terminate());
  local.on('unexpected-response', (req, res) => {
    const status = res.statusCode ?? 502;
    res.resume();
    req.destroy();
    if (!stream.destroyed) stream.reject(status >= 400 && status <= 599 ? status : 502).catch(() => {});
  });
  local.on('error', () => {
    if (stream.destroyed) return;
    if (!opened) stream.reject(502).catch(() => {});
    else stream.reset(RESET_CODE.INTERNAL);
  });
  local.on('open', () => {
    if (stream.destroyed) { local.terminate(); return; }
    opened = true;
    stream.accept().catch(() => {});
  });
  // ホスト → 端末。窓が詰まったらローカルの読み出しを止める
  local.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    inflight += buf.length;
    if (inflight > WS_PAUSE_ABOVE && !local.isPaused) local.pause();
    stream.send(buf, { text: !isBinary }).then(() => {
      inflight -= buf.length;
      if (inflight <= WS_PAUSE_ABOVE && local.isPaused && local.readyState === WebSocket.OPEN) local.resume();
    }, () => local.terminate());
  });
  local.on('close', (code, reason) => {
    if (stream.destroyed || !opened) return;
    stream.close(sendableCode(code), reason?.toString('utf8') ?? '').catch(() => {});
  });
  // 端末 → ホスト。ローカルへの送りが溜まっていないときに窓を返す（§4.3）
  stream.on('message', (data, text, release) => {
    if (local.readyState !== WebSocket.OPEN) { release(); return; }
    local.send(text ? data.toString('utf8') : data, { binary: !text });
    const tryRelease = () => {
      if (local.readyState !== WebSocket.OPEN || local.bufferedAmount < WS_RELEASE_BELOW) release();
      else setTimeout(tryRelease, 10);
    };
    tryRelease();
  });
  stream.on('close', (code, reason) => {
    if (local.readyState === WebSocket.OPEN || local.readyState === WebSocket.CONNECTING) {
      try { local.close(sendableCode(code), reason); } catch { local.terminate(); }
    }
    stream.close(sendableCode(code), reason).catch(() => {});
  });
}
