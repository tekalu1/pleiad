// Pleiad の中継サーバー（docs/remote.md §5、issue #12）。
//
// 端末とホストの WebSocket を照合してつなぎ、バイト列を右から左へ流すだけ。
// 中身は端末とホストの間の Noise で暗号化されていて、ここでは読めない（読もうともしない）。
// ディスクには何も書かない。照合の表はメモリだけで、ホストが制御用の接続のたびに sync で送り直す。
//
//   RELAY_ENROLL_SECRET=<32 字以上の乱数> node server.mjs
//
// 依存は ws だけ。1 ファイルで完結させる（Dockerfile はこのファイルだけを入れる）。
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

/** 中継が閉じるときの close code。端末は 4401 と 4404 で案内を分ける（§7.4）。 */
export const CLOSE = Object.freeze({
  BAD_REQUEST: 4400,   // ヘッダーや制御メッセージの形が違う
  UNAUTHORIZED: 4401,  // 登録用の秘密・トークン・入場券が合わない、取り消された
  NOT_FOUND: 4404,     // ホストが居ない（制御用の接続が無い・sync 前）、accept の conn が無い
  TIMEOUT: 4408,       // 認証は通ったが accept が来ない
  REPLACED: 4409,      // 同じ hostId の新しい制御用の接続に置き換わった
  OVERFLOW: 4413,      // 相手側に溜まる量が上限を超えた
  LIMIT: 4429,         // 数の上限・ペアリングの試行の上限
  SHUTDOWN: 1001,      // 中継の終了
});

export const DEFAULTS = Object.freeze({
  port: 8080,
  enrollSecret: '',
  trustProxy: true,
  maxHosts: 8,
  maxDevices: 16,
  maxConnsPerHost: 32,
  maxConnsPerDevice: 4,
  maxFrameBytes: 66000,
  maxBufferBytes: 8 * 1024 * 1024,
  pairingTtlMs: 5 * 60 * 1000,
  logLevel: 'info',
  // 以下は環境変数では変えない（§5.3 の決まり）。試験で短くするためだけに開けてある
  acceptTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  failureLimit: 10,
  failureWindowMs: 60_000,
  failureBlockMs: 10 * 60_000,
  pairingAttempts: 5,
  pairingWindowMs: 60_000,
});

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const HOST_ID = /^[a-z2-7]{26}$/;           // base32(SHA-256(公開鍵)) の先頭 26 字（小文字に揃える）
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET32 = /^[A-Za-z0-9_-]{43}$/;     // 256bit の base64url（パディングなし）
const HASH_HEX = /^[0-9a-f]{64}$/;
const MAX_FAILURE_ENTRIES = 10_000;

/** 環境変数から設定を組む。おかしな値なら投げる（起動しない）。 */
export function configFromEnv(env = process.env) {
  const int = (name, fallback) => {
    const raw = env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} は正の整数: ${raw}`);
    return n;
  };
  const level = env.RELAY_LOG || DEFAULTS.logLevel;
  if (!(level in LEVELS)) throw new Error(`RELAY_LOG は ${Object.keys(LEVELS).join(' / ')}: ${level}`);
  return {
    port: int('PORT', DEFAULTS.port),
    enrollSecret: env.RELAY_ENROLL_SECRET || '',
    trustProxy: (env.RELAY_TRUST_PROXY ?? '1') !== '0',
    maxHosts: int('RELAY_MAX_HOSTS', DEFAULTS.maxHosts),
    maxDevices: int('RELAY_MAX_DEVICES', DEFAULTS.maxDevices),
    maxConnsPerHost: int('RELAY_MAX_CONNS_PER_HOST', DEFAULTS.maxConnsPerHost),
    maxConnsPerDevice: int('RELAY_MAX_CONNS_PER_DEVICE', DEFAULTS.maxConnsPerDevice),
    maxFrameBytes: int('RELAY_MAX_FRAME_BYTES', DEFAULTS.maxFrameBytes),
    maxBufferBytes: int('RELAY_MAX_BUFFER_BYTES', DEFAULTS.maxBufferBytes),
    pairingTtlMs: int('RELAY_PAIRING_TTL_MS', DEFAULTS.pairingTtlMs),
    logLevel: level,
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/** 256bit の秘密（base64url 43 字）を生のバイトに。形が違えば null。 */
function secret32(value) {
  if (typeof value !== 'string' || !SECRET32.test(value)) return null;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === 32 ? raw : null;
}

function bearer(header) {
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(typeof header === 'string' ? header : '');
  return m ? m[1] : null;
}

function hostIdOf(header) {
  if (typeof header !== 'string') return null;
  const id = header.toLowerCase();
  return HOST_ID.test(id) ? id : null;
}

function hashOf(value) {
  return typeof value === 'string' && HASH_HEX.test(value) ? Buffer.from(value, 'hex') : null;
}

/** 相手の close code を反対側へ渡す。送れない番号（1005・1006 など）は 1001 にする。 */
function passCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1001;
}

function closeWs(ws, code, reason = '') {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  try { ws.close(code, reason); } catch { ws.terminate(); return; }
  // 相手が読まない（背圧で詰まった）と close の往復が終わらない。長く待たずに落とす
  setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 1000).unref();
}

function rejectUpgrade(socket, status) {
  try {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* 既に切れている */ }
  socket.destroy();
}

/**
 * 中継を作る。listen するまでは待ち受けない。
 * opts は DEFAULTS と同じ名前。opts.logger を渡すとログをそこへ出す（試験用）。
 */
export function createRelay(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (typeof o.enrollSecret !== 'string' || o.enrollSecret.length < 32) {
    throw new Error('RELAY_ENROLL_SECRET が無いか短い（32 字以上の乱数を指定する）');
  }
  const secretHash = sha256(Buffer.from(o.enrollSecret, 'utf8'));
  const minLevel = LEVELS[o.logLevel] ?? LEVELS.info;
  const logger = o.logger ?? ((line) => process.stdout.write(JSON.stringify(line) + '\n'));
  const log = (level, event, fields = {}) => {
    if (LEVELS[level] < minLevel) return;
    logger({ t: new Date().toISOString(), level, event, ...fields });
  };
  const short = (hostId) => hostId?.slice(0, 8);

  /** hostId → 制御用の接続と照合の表。制御用の接続がある間だけ居る。 */
  const hosts = new Map();
  /** conn → 端末 1 本（accept 待ち・つながり中）。 */
  const conns = new Map();
  /** hostId → その hostId の端末の接続。制御用の接続の張り直しをまたいで数える。 */
  const hostConns = new Map();
  /** IP → 認証の失敗の記録。 */
  const failures = new Map();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: o.maxFrameBytes,  // 超えたら ws が 1009 で切る
    perMessageDeflate: false,     // 暗号文は縮まない。展開の爆弾も避ける
  });

  const server = http.createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : 'ok');
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.on('upgrade', onUpgrade);
  server.on('clientError', (_err, socket) => socket.destroy());

  // 30 秒ごとに ping。2 回続けて pong が返らない接続を捨てる（§4.4・§5.3）
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missedPongs >= 2) { ws.terminate(); continue; }
      ws.missedPongs = (ws.missedPongs ?? 0) + 1;
      try { ws.ping(); } catch { /* 閉じかけ */ }
    }
  }, o.pingIntervalMs);
  pinger.unref();

  // ── 認証の失敗と遮断 ──────────────────────────────────────────

  function clientIp(req) {
    if (o.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? '?';
  }

  function blocked(ip) {
    const e = failures.get(ip);
    return Boolean(e && e.blockedUntil > Date.now());
  }

  function recordFailure(ip) {
    const now = Date.now();
    if (!failures.has(ip) && failures.size >= MAX_FAILURE_ENTRIES) {
      for (const [k, e] of failures) {
        if (e.blockedUntil <= now && e.times.every((t) => now - t > o.failureWindowMs)) failures.delete(k);
      }
      // それでも溢れるなら古い順に捨てる（遮断中を捨てることがあっても、表が際限なく育つよりよい）
      while (failures.size >= MAX_FAILURE_ENTRIES) failures.delete(failures.keys().next().value);
    }
    const e = failures.get(ip) ?? { times: [], blockedUntil: 0 };
    e.times = e.times.filter((t) => now - t < o.failureWindowMs);
    e.times.push(now);
    if (e.times.length >= o.failureLimit) {
      e.blockedUntil = now + o.failureBlockMs;
      e.times = [];
      log('warn', 'blocked', { minutes: Math.round(o.failureBlockMs / 60000) });
    }
    failures.set(ip, e);
  }

  function fail(ws, code, reason) {
    recordFailure(ws.ip);
    log('info', 'auth-failed', { path: ws.route, reason });
    closeWs(ws, code, reason);
  }

  // ── 入口 ────────────────────────────────────────────────────

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const ip = clientIp(req);
    if (blocked(ip)) return rejectUpgrade(socket, 429);
    let url;
    try { url = new URL(req.url, 'http://relay'); } catch { return rejectUpgrade(socket, 400); }
    const route = url.pathname;
    if (route !== '/v1/host' && route !== '/v1/host/accept' && route !== '/v1/device') {
      return rejectUpgrade(socket, 404);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      ws.route = route;
      ws.missedPongs = 0;
      ws.on('pong', () => { ws.missedPongs = 0; });
      ws.on('error', () => {});   // 1009 などは close で扱う
      if (route === '/v1/host') onControl(ws, req);
      else if (route === '/v1/host/accept') onAccept(ws, req, url);
      else onDevice(ws, req);
    });
  }

  /** ホストの認証。通れば hostId、通らなければ閉じて null。 */
  function hostAuth(ws, req) {
    const secret = bearer(req.headers.authorization);
    if (!secret || !sameHash(sha256(Buffer.from(secret, 'utf8')), secretHash)) {
      fail(ws, CLOSE.UNAUTHORIZED, 'enroll secret');
      return null;
    }
    const hostId = hostIdOf(req.headers['x-pleiad-host']);
    if (!hostId) {
      closeWs(ws, CLOSE.BAD_REQUEST, 'host id');
      return null;
    }
    return hostId;
  }

  // ── ホストの制御用の接続 ──────────────────────────────────────

  function onControl(ws, req) {
    const hostId = hostAuth(ws, req);
    if (!hostId) return;
    const old = hosts.get(hostId);
    if (!old && hosts.size >= o.maxHosts) {
      log('warn', 'host-limit', { host: short(hostId) });
      return closeWs(ws, CLOSE.LIMIT, 'too many hosts');
    }
    const h = {
      id: hostId,
      ws,
      devices: new Map(),   // deviceId → SHA-256(トークン)
      synced: false,
      pairing: null,        // { hash, expiresAt }
      pairTimes: old?.pairTimes ?? [],
      openedAt: Date.now(),
    };
    hosts.set(hostId, h);
    if (old) {
      closeWs(old.ws, CLOSE.REPLACED, 'replaced');
      closePending(hostId, CLOSE.NOT_FOUND, 'host reconnected');
    }
    log('info', 'host-open', { host: short(hostId), replaced: Boolean(old) });

    ws.on('message', (data, isBinary) => onControlMessage(h, data, isBinary));
    ws.on('close', (code) => {
      log('info', 'host-close', { host: short(hostId), code, ms: Date.now() - h.openedAt });
      if (hosts.get(hostId) !== h) return;   // 置き換わった古い方
      hosts.delete(hostId);
      closePending(hostId, CLOSE.NOT_FOUND, 'host offline');
    });
  }

  function onControlMessage(h, data, isBinary) {
    if (hosts.get(h.id) !== h) return;
    let msg = null;
    if (!isBinary) { try { msg = JSON.parse(data.toString('utf8')); } catch { /* 下で閉じる */ } }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return closeWs(h.ws, CLOSE.BAD_REQUEST, 'control message');
    }
    switch (msg.type) {
      case 'sync': {
        if (!Array.isArray(msg.devices)) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'sync');
        const next = new Map();
        for (const d of msg.devices) {
          const hash = hashOf(d?.tokenHash);
          if (!hash || typeof d.id !== 'string' || !DEVICE_ID.test(d.id)) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'sync');
          if (!next.has(d.id) && next.size >= o.maxDevices) {
            log('warn', 'device-limit', { host: short(h.id), device: d.id });
            continue;
          }
          next.set(d.id, hash);
        }
        h.devices = next;
        h.synced = true;
        log('debug', 'sync', { host: short(h.id), devices: next.size });
        return cutRevoked(h);
      }
      case 'allow': {
        const hash = hashOf(msg.tokenHash);
        if (!hash || typeof msg.id !== 'string' || !DEVICE_ID.test(msg.id)) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'allow');
        if (!h.devices.has(msg.id) && h.devices.size >= o.maxDevices) {
          return log('warn', 'device-limit', { host: short(h.id), device: msg.id });
        }
        h.devices.set(msg.id, hash);
        return cutRevoked(h);   // トークンを差し替えたら古いトークンの接続を切る
      }
      case 'revoke': {
        if (typeof msg.id !== 'string') return closeWs(h.ws, CLOSE.BAD_REQUEST, 'revoke');
        h.devices.delete(msg.id);
        log('info', 'revoke', { host: short(h.id), device: msg.id });
        return cutRevoked(h);
      }
      case 'pairing': {
        if (msg.ticketHash == null) { h.pairing = null; return; }   // 取り下げ
        const hash = hashOf(msg.ticketHash);
        if (!hash) return closeWs(h.ws, CLOSE.BAD_REQUEST, 'pairing');
        const asked = Number(msg.ttlMs);
        const ttl = Number.isFinite(asked) && asked > 0 ? Math.min(asked, o.pairingTtlMs) : o.pairingTtlMs;
        h.pairing = { hash, expiresAt: Date.now() + ttl };   // 入場券は 1 枚だけ。新しいものが古いものを置き換える
        return;
      }
      default:
        return;   // 知らない種類は無視する（新しいホストと古い中継の組み合わせで切らない）
    }
  }

  /** 表から消えた・トークンが変わった端末の接続を切る。 */
  function cutRevoked(h) {
    for (const c of hostConns.get(h.id) ?? []) {
      if (c.pairing) continue;
      const hash = h.devices.get(c.deviceId);
      if (!hash || !sameHash(hash, c.tokenHash)) endConn(c, CLOSE.UNAUTHORIZED, 'revoked');
    }
  }

  function closePending(hostId, code, reason) {
    for (const c of [...(hostConns.get(hostId) ?? [])]) if (!c.hostWs) endConn(c, code, reason);
  }

  function sendControl(hostId, msg) {
    const h = hosts.get(hostId);
    if (h && h.ws.readyState === WebSocket.OPEN) h.ws.send(JSON.stringify(msg));
  }

  // ── 端末の接続 ──────────────────────────────────────────────

  function onDevice(ws, req) {
    const hostId = hostIdOf(req.headers['x-pleiad-host']);
    if (!hostId) return fail(ws, CLOSE.BAD_REQUEST, 'host id');
    const h = hosts.get(hostId);
    // sync の前は表が空なので、正しい端末まで 4401 にしないよう「居ない」として返す
    if (!h || !h.synced) return closeWs(ws, CLOSE.NOT_FOUND, 'host offline');
    const active = hostConns.get(hostId) ?? new Set();

    const ticket = req.headers['x-pleiad-pairing'];
    if (ticket !== undefined) {
      const now = Date.now();
      h.pairTimes = h.pairTimes.filter((t) => now - t < o.pairingWindowMs);
      if (h.pairTimes.length >= o.pairingAttempts) return closeWs(ws, CLOSE.LIMIT, 'pairing rate');
      h.pairTimes.push(now);
      const raw = secret32(ticket);
      const p = h.pairing;
      if (p && p.expiresAt <= now) h.pairing = null;
      if (!raw || !h.pairing || !sameHash(sha256(raw), h.pairing.hash)) return fail(ws, CLOSE.UNAUTHORIZED, 'pairing ticket');
      if (active.size >= o.maxConnsPerHost) return closeWs(ws, CLOSE.LIMIT, 'too many connections');
      h.pairing = null;   // 1 回きり
      return startConn(ws, h, { pairing: true });
    }

    const deviceId = req.headers['x-pleiad-device'];
    const raw = secret32(bearer(req.headers.authorization));
    const hash = typeof deviceId === 'string' ? h.devices.get(deviceId) : undefined;
    if (!raw || !hash || !sameHash(sha256(raw), hash)) return fail(ws, CLOSE.UNAUTHORIZED, 'device token');
    let perDevice = 0;
    for (const c of active) if (c.deviceId === deviceId) perDevice++;
    if (active.size >= o.maxConnsPerHost || perDevice >= o.maxConnsPerDevice) {
      return closeWs(ws, CLOSE.LIMIT, 'too many connections');
    }
    startConn(ws, h, { deviceId, tokenHash: hash });
  }

  function startConn(ws, h, { deviceId = null, tokenHash = null, pairing = false }) {
    const c = {
      id: crypto.randomBytes(16).toString('base64url'),
      hostId: h.id,
      deviceId,
      tokenHash,
      pairing,
      deviceWs: ws,
      hostWs: null,
      pending: [],
      pendingBytes: 0,
      up: 0,
      down: 0,
      startedAt: Date.now(),
      ended: false,
      timer: null,
    };
    conns.set(c.id, c);
    if (!hostConns.has(h.id)) hostConns.set(h.id, new Set());
    hostConns.get(h.id).add(c);
    c.timer = setTimeout(() => endConn(c, CLOSE.TIMEOUT, 'accept timeout'), o.acceptTimeoutMs);
    c.timer.unref();

    ws.on('message', (data, isBinary) => {
      if (c.ended) return;
      if (c.hostWs) return forward(c, c.hostWs, data, isBinary, 'up');
      // accept が来るまで溜める（Noise のメッセージ 1 がすぐ来る）。溜める量も上限で抑える
      c.pendingBytes += data.length;
      if (c.pendingBytes > o.maxBufferBytes) return endConn(c, CLOSE.OVERFLOW, 'buffer');
      c.pending.push([data, isBinary]);
    });
    ws.on('close', (code) => endConn(c, passCode(code), 'device closed'));

    log('info', 'device-open', { host: short(h.id), device: deviceId, pairing, conn: c.id });
    sendControl(h.id, pairing ? { type: 'incoming', conn: c.id, pairing: true } : { type: 'incoming', conn: c.id, deviceId });
  }

  // ── ホストのデータ用の接続 ────────────────────────────────────

  function onAccept(ws, req, url) {
    const hostId = hostAuth(ws, req);
    if (!hostId) return;
    const c = conns.get(url.searchParams.get('conn') ?? '');
    // 別のホストの conn は「無い」と同じに扱う（行き先は端末を登録したホストだけ）
    if (!c || c.ended || c.hostId !== hostId || c.hostWs) return closeWs(ws, CLOSE.NOT_FOUND, 'no such conn');
    clearTimeout(c.timer);
    c.hostWs = ws;
    for (const [data, isBinary] of c.pending) forward(c, ws, data, isBinary, 'up');
    c.pending = [];
    c.pendingBytes = 0;
    ws.on('message', (data, isBinary) => { if (!c.ended) forward(c, c.deviceWs, data, isBinary, 'down'); });
    ws.on('close', (code) => endConn(c, passCode(code), 'host closed'));
    log('debug', 'accept', { host: short(hostId), conn: c.id });
  }

  function forward(c, to, data, isBinary, dir) {
    if (to.readyState !== WebSocket.OPEN) return;
    if (to.bufferedAmount + data.length > o.maxBufferBytes) {
      // 読まない相手に際限なく溜めない。詰まった側は close の往復も終わらないので落とす
      to.terminate();
      return endConn(c, CLOSE.OVERFLOW, 'buffer');
    }
    to.send(data, { binary: isBinary });
    c[dir] += data.length;
  }

  function endConn(c, code, reason) {
    if (c.ended) return;
    c.ended = true;
    clearTimeout(c.timer);
    conns.delete(c.id);
    const set = hostConns.get(c.hostId);
    set?.delete(c);
    if (set && !set.size) hostConns.delete(c.hostId);
    closeWs(c.deviceWs, code, reason === 'device closed' ? '' : reason);
    closeWs(c.hostWs, code, reason === 'host closed' ? '' : reason);
    c.pending = [];
    sendControl(c.hostId, { type: 'closed', conn: c.id });
    log('info', 'device-close', {
      host: short(c.hostId), device: c.deviceId, pairing: c.pairing, conn: c.id,
      code, reason, up: c.up, down: c.down, ms: Date.now() - c.startedAt,
    });
  }

  // ── 起動と終了 ──────────────────────────────────────────────

  return {
    server,
    options: o,
    /** 試験と監視用の数。中身は含まない。 */
    stats: () => ({ hosts: hosts.size, conns: conns.size, blocked: [...failures.values()].filter((e) => e.blockedUntil > Date.now()).length }),
    listen(port = o.port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() {
      clearInterval(pinger);
      for (const c of [...conns.values()]) endConn(c, CLOSE.SHUTDOWN, 'shutdown');
      for (const ws of wss.clients) closeWs(ws, CLOSE.SHUTDOWN, 'shutdown');
      return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(() => { for (const ws of wss.clients) ws.terminate(); server.closeAllConnections?.(); }, 200).unref();
      });
    },
  };
}

// node server.mjs で直接起動したときだけ待ち受ける（試験は createRelay を import する）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let cfg;
  try {
    cfg = configFromEnv();
    const relay = createRelay(cfg);
    const addr = await relay.listen(cfg.port);
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', event: 'listening', port: addr.port }));
    const stop = () => relay.close().then(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (err) {
    console.error(`relay: ${err.message}`);
    process.exit(1);
  }
}
