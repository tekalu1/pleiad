// 端末内プロキシ（docs/remote.md §7.1・§7.4）。ホスト 1 台につき 1 つ、127.0.0.1 で待ち受け、
// 窓（WebView）の HTTP と /ws を DeviceLink のチャネルに載せてホストへ流す。画面はホストが配る web/ をそのまま使う。
//
// 認証は今のサーバーと同じ形（web/ を変えずに済むように）:
//   - 窓は http://127.0.0.1:<p>/?token=<プロキシのトークン> を開く。?token= が合えば HttpOnly・SameSite=Strict の Cookie を返し、
//     以後の css / js / 画像は Cookie で通る。/ws は ?token= だけ（web/client.mjs が付ける）
//   - Host が 127.0.0.1:<p> でなければ 403（DNS rebinding 対策）。トークンが無い・違えば 401
//   - HTTP は GET と HEAD だけ（ホストの接続口も同じ。ほかは 405）。WebSocket は /ws だけ
// トークンは起動ごとの乱数。ホストへは送らない（?token= と Cookie はプロキシで落とす。ホストの UI トークンは接続口が付ける）。
//
// 背圧（§4.3）: ホスト → 窓は res.write() が true を返すか drain で release()、WebSocket は bufferedAmount が 64 KiB を
// 下回ったら release()。窓 → ホストの WebSocket は、送り終えていない量が 256 KiB を超えたらローカルの読み出しを止める。
//
// ホストにつながらない・取り消されたとき、画面の読み込み（Accept: text/html）には小さな案内のページを返す（§7.4）。
// それ以外の HTTP は 502、/ws は 502 で断る。画面は既存の 1.5 秒ごとの再接続で、つながり次第追いつく。
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { RESET_CODE } from './frames.mjs';
import { DeviceLink } from './device-link.mjs';

export const PROXY_COOKIE = 'pleiad_remote_token';
const WS_RELEASE_BELOW = 64 * 1024;
const WS_PAUSE_ABOVE = 256 * 1024;
const MAX_WS_MESSAGE = 64 * 1024 * 1024;
/** 窓から通す要求のヘッダー（ホストの接続口の許可と同じ。それ以外はホストで捨てられる）。 */
const PASS_REQUEST = new Set([
  'accept', 'accept-language', 'accept-encoding', 'cache-control', 'pragma',
  'if-none-match', 'if-modified-since', 'if-range', 'range', 'user-agent',
]);
const DROP_RESPONSE = new Set([
  'set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-connection', 'te', 'trailer',
]);

function tokenEq(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenFromCookie(header) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === PROXY_COOKIE) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

function sendableCode(code) {
  return code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1000;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** ホストにつながらないときの案内（§7.4）。取り消し以外は 5 秒ごとに読み直し、つながれば画面に移る。 */
export function unavailablePage({ state, hostName = '' }) {
  const revoked = state === 'revoked';
  const title = revoked ? 'この端末はホストで取り消されました' : 'ホストにつながりません';
  const body = revoked
    ? 'もう一度ペアリングしてください。'
    : state === 'host-offline'
      ? 'ホストの Pleiad が起動しているか確かめてください。つながり次第、自動で開きます。'
      : '中継につながりません。ネットワークを確かめてください。つながり次第、自動で開きます。';
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">${revoked ? '' : '<meta http-equiv="refresh" content="5">'}
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:#333;background:#f6f6f4}
main{max-width:28rem;padding:24px}h1{font-size:16px;margin:0 0 8px}p{margin:0;color:#666}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#1c1c1c}p{color:#aaa}}</style></head>
<body><main data-remote-state="${escapeHtml(state)}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${hostName ? `<p>${escapeHtml(hostName)}</p>` : ''}</main></body></html>
`;
}

/**
 * ホスト 1 台のプロキシ。
 *   creds: { hostId, hostPublicKey, relayUrl, deviceId, token, hostName? }、keyPair: 端末の静的鍵
 *   port: 覚えているポート（塞がっていれば空きポート）。0 なら空きポート
 *   requestWaitMs: つないでいる最中に来た要求を待たせる上限
 * 出来事: 'status'（DeviceLink の状態 + { port }）
 */
export class DeviceProxy extends EventEmitter {
  constructor({ creds, keyPair, port = 0, app = '', name = '', shell = 'desktop', backoff, connectTimeoutMs, requestWaitMs = 10_000, channelOptions, log = () => {} }) {
    super();
    this.creds = creds;
    this.wantPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
    this.port = 0;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.requestWaitMs = requestWaitMs;
    this.log = log;
    this.link = new DeviceLink({ creds, keyPair, app, name, shell, backoff, connectTimeoutMs, channelOptions, log });
    this.link.on('status', s => this.emit('status', { ...s, port: this.port }));
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    this.server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_WS_MESSAGE });
    this.sockets = new Set();
    this.closed = false;
  }

  get status() { return { ...this.link.status, port: this.port }; }
  /** 窓が開く URL（トークン付き。記録やログに出さない）。 */
  get url() { return `http://127.0.0.1:${this.port}/?token=${this.token}`; }

  /** 待ち受けを始め、ホストへつなぎ始める。 */
  async start() {
    const listen = port => new Promise((resolve, reject) => {
      const onError = e => { this.server.off('listening', onListen); reject(e); };
      const onListen = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListen);
      this.server.listen(port, '127.0.0.1');
    });
    try { await listen(this.wantPort); }
    catch (e) {
      if (!this.wantPort || !['EADDRINUSE', 'EACCES'].includes(e.code)) throw e;
      this.log(`remote proxy: port ${this.wantPort} は使えない (${e.code})`);
      await listen(0);
    }
    this.port = this.server.address().port;
    this.link.start();
    return this;
  }

  /** つなぎ直す（「再試行」）。creds を渡せば資格を差し替える。 */
  retryNow(creds) { if (creds) this.creds = creds; this.link.retryNow(creds); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.link.stop();
    for (const ws of this.wss.clients) ws.terminate();
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections?.();
    await new Promise(res => this.server.close(() => res()));
  }

  // ── 照合 ──

  #hostOk(req) { return req.headers.host === `127.0.0.1:${this.port}`; }

  #parse(req) {
    try { return new URL(req.url, `http://127.0.0.1:${this.port}`); } catch { return null; }
  }

  /** ホストへ送るパス（?token= を落とす）。 */
  #forwardPath(url) {
    url.searchParams.delete('token');
    return url.pathname + url.search;
  }

  #unavailable(req, res, err) {
    const state = err?.state ?? 'offline';
    const wantsHtml = req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''));
    if (wantsHtml) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-pleiad-remote-state': state });
      return res.end(unavailablePage({ state, hostName: this.creds.hostName ?? '' }));
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-pleiad-remote-state': state });
    res.end(err?.message ?? 'ホストにつながりません');
  }

  // ── HTTP ──

  async #onRequest(req, res) {
    this.sockets.add(req.socket);
    req.socket.once('close', () => this.sockets.delete(req.socket));
    if (!this.#hostOk(req)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
    const url = this.#parse(req);
    if (!url) { res.writeHead(400); return res.end(); }
    const viaQuery = url.searchParams.get('token');
    const queryOk = tokenEq(viaQuery, this.token);
    if (!queryOk && !tokenEq(tokenFromCookie(req.headers.cookie), this.token)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('トークンが要る（アプリから開いてください）');
    }
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('method not allowed');
    }
    // 窓が中断したら（読み込みの取り消し）ストリームも捨てる
    let stream = null;
    let finished = false;
    res.once('close', () => { if (!finished && stream && !stream.destroyed) stream.reset(RESET_CODE.CANCEL); });

    let ch;
    try { ch = await this.link.ready(this.requestWaitMs); }
    catch (e) { if (!res.destroyed) this.#unavailable(req, res, e); return; }
    if (res.destroyed) return;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (PASS_REQUEST.has(k)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    try { stream = ch.openHttp({ method, path: this.#forwardPath(url), headers }); }
    catch (e) { return this.#unavailable(req, res, e); }
    stream.on('response', head => {
      const out = {};
      for (const [k, v] of Object.entries(head?.headers ?? {})) {
        const key = k.toLowerCase();
        if (!DROP_RESPONSE.has(key) && !key.startsWith('proxy-')) out[key] = v;
      }
      if (queryOk) out['set-cookie'] = `${PROXY_COOKIE}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/`;
      const status = Number.isInteger(head?.status) && head.status >= 100 && head.status <= 599 ? head.status : 502;
      try { res.writeHead(status, out); } catch { res.writeHead(status, queryOk ? { 'set-cookie': out['set-cookie'] } : {}); }
    });
    stream.on('data', (chunk, release) => {
      if (res.destroyed) return release();
      if (res.write(chunk)) release(); else res.once('drain', release);
    });
    stream.on('end', () => { finished = true; res.end(); });
    stream.on('reset', code => {
      finished = true;
      if (res.headersSent) return res.destroy();
      if (code === RESET_CODE.FORBIDDEN) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }
      if (code === RESET_CODE.CHANNEL_CLOSED) return this.#unavailable(req, res, { state: this.link.state === 'connected' ? 'offline' : this.link.state, message: 'ホストとの接続が切れました' });
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad gateway');
    });
    stream.end().catch(() => {});
  }

  // ── WebSocket ──

  async #onUpgrade(req, socket, head) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const refuse = (status, text) => {
      if (socket.destroyed) return;
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroySoon?.();
    };
    if (!this.#hostOk(req)) return refuse(403, 'Forbidden');
    const url = this.#parse(req);
    if (!url || url.pathname !== '/ws') return refuse(404, 'Not Found');
    if (!tokenEq(url.searchParams.get('token'), this.token)) return refuse(401, 'Unauthorized');

    let ch;
    try { ch = await this.link.ready(this.requestWaitMs); }
    catch { return refuse(502, 'Bad Gateway'); }
    if (socket.destroyed) return;

    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    let stream;
    try { stream = ch.openWs({ path: this.#forwardPath(url), protocols }); }
    catch { return refuse(502, 'Bad Gateway'); }
    socket.once('close', () => { if (!stream.destroyed && !stream.accepted) stream.reset(RESET_CODE.CANCEL); });
    // 受け付け（WS_ACCEPT）と最初のメッセージ（ready）は同じ読み出しで届く。窓の WebSocket ができるまで溜めておく
    const early = { messages: [], close: null };
    const onEarlyMessage = (data, text, release) => early.messages.push([data, text, release]);
    const onEarlyClose = (code, reason) => { early.close = [code, reason]; };
    stream.on('message', onEarlyMessage);
    stream.on('close', onEarlyClose);

    const outcome = await new Promise(resolve => {
      stream.once('accept', () => resolve('accept'));
      stream.once('reject', status => resolve(status));
      stream.once('reset', code => resolve(code === RESET_CODE.FORBIDDEN ? 403 : 502));
    });
    if (outcome !== 'accept') return refuse(outcome, outcome === 403 ? 'Forbidden' : outcome === 401 ? 'Unauthorized' : 'Bad Gateway');
    if (socket.destroyed || stream.destroyed) { stream.reset(RESET_CODE.CANCEL); return refuse(502, 'Bad Gateway'); }
    this.wss.handleUpgrade(req, socket, head, local => {
      stream.off('message', onEarlyMessage);
      stream.off('close', onEarlyClose);
      this.#bridge(local, stream, early);
    });
  }

  #bridge(local, stream, early = { messages: [], close: null }) {
    let inflight = 0;
    local.on('error', () => local.terminate());
    // 窓 → ホスト。送り終えていない量が多ければ読み出しを止める
    local.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      if (stream.destroyed || stream.localDone) return;
      inflight += buf.length;
      if (inflight > WS_PAUSE_ABOVE && !local.isPaused) local.pause();
      stream.send(buf, { text: !isBinary }).then(() => {
        inflight -= buf.length;
        if (inflight <= WS_PAUSE_ABOVE && local.isPaused && local.readyState === WebSocket.OPEN) local.resume();
      }, () => local.terminate());
    });
    local.on('close', (code, reason) => {
      if (!stream.destroyed) stream.close(sendableCode(code), reason?.toString('utf8') ?? '').catch(() => {});
    });
    // ホスト → 窓。窓への送りが溜まっていないときに窓（クレジット）を返す
    stream.on('message', (data, text, release) => {
      if (local.readyState !== WebSocket.OPEN) return release();
      local.send(text ? data.toString('utf8') : data, { binary: !text });
      const tryRelease = () => {
        if (local.readyState !== WebSocket.OPEN || local.bufferedAmount < WS_RELEASE_BELOW) release();
        else setTimeout(tryRelease, 10);
      };
      tryRelease();
    });
    stream.on('close', (code, reason) => {
      if (local.readyState === WebSocket.OPEN) { try { local.close(sendableCode(code), reason); } catch { local.terminate(); } }
      stream.close(sendableCode(code), reason).catch(() => {});
    });
    // チャネルが切れた・ホストが捨てた: 窓には 1006（close フレームなし）で知らせ、画面の再接続に任せる
    stream.on('reset', () => local.terminate());
    for (const [data, text, release] of early.messages) stream.emit('message', data, text, release);
    if (early.close) stream.emit('close', ...early.close);
    if (stream.destroyed) local.terminate();
  }
}
