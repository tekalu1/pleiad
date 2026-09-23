// ホストの接続口（docs/remote.md §3.3・§4.2・§4.4・§6.1、issue #13）。サーバーのプロセスの中で動く。
//
// - 中継へ外向きに制御用の WebSocket を張り（/v1/host）、つながるたびに端末一覧のハッシュを sync で送り直す。
//   切れたら 1 秒から 60 秒まで倍々（揺らぎ付き）で張り直す
// - 中継の incoming ごとにデータ用の接続（/v1/host/accept）を張り、Noise の応答側としてハンドシェイクする。
//   通常は IK（端末の静的鍵が端末一覧にあり、中継が名乗った deviceId の鍵と一致すること）、ペアリングは IKpsk2
// - 確立したら channel.mjs のチャネルに載せ、ストリームを forward.mjs の防火壁を通して既存サーバーへ流す
// - ペアリング: 入場券を中継に登録 → QR → IKpsk2 → 承認待ち（確認コード）→ 承認で deviceId と中継用トークンを発行
// - 既定は無効。有効にするまで何もつながない（鍵も作らない）
import os from 'node:os';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { Handshake, prologueFor, derivePairing, confirmationCode } from './noise.mjs';
import { Channel } from './channel.mjs';
import { forwardStream } from './forward.mjs';
import { createRemoteStore } from './devices.mjs';
import { normalizeRelayUrl, relayWsUrl, pairingPayload, cleanLabel, PAIRING_TTL_MS } from './pairing.mjs';

/** ホストが閉じるときの close code。中継は 3000–4999 をそのまま端末へ渡す（§5.1）。 */
export const HOST_CLOSE = Object.freeze({ BAD_REQUEST: 4400, UNAUTHORIZED: 4401, TIMEOUT: 4408, SHUTDOWN: 1001 });
const CONN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const STABLE_MS = 10_000;
const CONTROL_PING_MS = 30_000;
const DATA_MAX_PAYLOAD = 70_000;

function describeClose(code) {
  switch (code) {
    case 4400: return '中継との取り決めが合いません（版の違いかもしれません）';
    case 4401: return '中継が登録用の秘密を受け付けませんでした';
    case 4409: return '同じホストの別の接続に置き換わりました（同じデータ置き場の Pleiad が 2 つ動いていませんか）';
    case 4429: return '中継のホスト数の上限に達しています';
    case 1001: return '中継が終了しました';
    case 1006: return '中継との接続が切れました';
    default: return `中継との接続が閉じました（${code}）`;
  }
}

function closeWs(ws, code, reason = '') {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try { ws.close(code, reason); } catch { ws.terminate(); return; }
  setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, 2000).unref();
}

function publicDevice(d, connections = 0) {
  return { id: d.id, name: d.name, platform: d.platform, app: d.app ?? null, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null, connected: connections > 0, connections };
}

function publicRequest(r) {
  return { id: r.id, name: r.name, platform: r.platform, app: r.app, code: r.code, createdAt: r.createdAt, expiresAt: r.expiresAt };
}

function parseJson(buf) {
  try { const v = JSON.parse(Buffer.from(buf).toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}

/**
 * @param dataDir     store.dataDir
 * @param cipher      秘密の暗号器（server の secretCipher）
 * @param target      () => ({ host, port })。ホストの既存サーバー（listen 後に呼ぶ）
 * @param token       ホストの UI トークン（接続口が差し込む。外には出さない）
 * @param appVersion  HELLO の app
 * @param emit        (event) => void。{ type: 'remoteStatus' | 'remotePairing', ... } を画面へ配る
 * @param env         AGENT_HOST_RELAY_URL / AGENT_HOST_RELAY_SECRET（設定が空のときの代わり）
 */
export function createRemoteHost({
  dataDir, cipher, target, token, appVersion = '', emit = () => {}, env = process.env,
  backoff = { minMs: 1000, maxMs: 60_000 }, log = () => {},
}) {
  const store = createRemoteStore({ dataDir, cipher });
  let cfg = { enabled: false, relayUrl: '', secret: '', hostName: os.hostname(), relayUrlFromEnv: false, secretFromEnv: false };
  let identity = null;
  let phase = 'disabled';          // disabled | connecting | connected | retrying | error
  let error = null;
  let since = Date.now();
  let retryAt = null;
  let generation = 0;
  let control = null;
  let controlOpenedAt = 0;
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let offer = null;                // { secret, psk, ticketHash, expiresAt, timer }
  const requests = new Map();      // id → 承認待ち
  const deviceCache = new Map();   // id → devices.json の 1 件（照合は同期で行う）
  const channels = new Map();      // deviceId → Set<{ ch, ws }>
  const dataConns = new Set();
  let applying = Promise.resolve();
  let statusQueued = false;

  const setPhase = (next, err = null) => {
    if (phase !== next) since = Date.now();
    phase = next;
    error = err;
    queueStatus();
  };

  function queueStatus() {
    if (statusQueued) return;
    statusQueued = true;
    queueMicrotask(async () => {
      statusQueued = false;
      try { emit({ type: 'remoteStatus', status: await status() }); } catch (e) { log(`remote status: ${e.message}`); }
    });
  }

  async function loadConfig() {
    const s = await store.settings();
    const secretStored = await store.enrollSecret();
    const relayUrl = s.relayUrl || env.AGENT_HOST_RELAY_URL || '';
    cfg = {
      enabled: s.enabled,
      relayUrl,
      secret: secretStored || env.AGENT_HOST_RELAY_SECRET || '',
      hostName: s.hostName || os.hostname(),
      relayUrlFromEnv: !s.relayUrl && Boolean(env.AGENT_HOST_RELAY_URL),
      secretFromEnv: !secretStored && Boolean(env.AGENT_HOST_RELAY_SECRET),
    };
    deviceCache.clear();
    for (const d of await store.devices()) deviceCache.set(d.id, d);
    return cfg;
  }

  // ── 中継への制御用の接続 ──────────────────────────────────────

  function relayHeaders() {
    return { authorization: `Bearer ${cfg.secret}`, 'x-pleiad-host': identity.hostId };
  }

  function sendControl(msg) {
    if (control?.readyState === WebSocket.OPEN) control.send(JSON.stringify(msg));
  }

  function syncDevices() {
    sendControl({ type: 'sync', devices: [...deviceCache.values()].map(d => ({ id: d.id, tokenHash: d.tokenHash })) });
    if (offer && offer.expiresAt > Date.now()) {
      sendControl({ type: 'pairing', ticketHash: offer.ticketHash.toString('hex'), ttlMs: offer.expiresAt - Date.now() });
    }
  }

  function connect() {
    const gen = generation;
    let url;
    try { url = relayWsUrl(cfg.relayUrl, '/v1/host'); }
    catch (e) { setPhase('error', { code: 'config', message: e.message }); return; }
    setPhase(attempt ? 'retrying' : 'connecting', error);
    const ws = new WebSocket(url, { headers: relayHeaders(), perMessageDeflate: false, handshakeTimeout: 15_000, maxPayload: 1024 * 1024, followRedirects: false });
    control = ws;
    let failure = null;
    ws.on('unexpected-response', (req, res) => {
      failure = res.statusCode === 429 ? '中継が一時的に接続を止めています（認証の失敗が続いたため）' : `中継が接続を受け付けませんでした（HTTP ${res.statusCode}）`;
      res.resume();
      req.destroy();
    });
    ws.on('error', e => { failure ??= `中継につながりません（${e.code || e.message}）`; });
    ws.on('open', () => {
      if (gen !== generation) return closeWs(ws, 1000);
      controlOpenedAt = Date.now();
      retryAt = null;
      syncDevices();
      setPhase('connected');
      clearInterval(pingTimer);
      let missed = 0;
      ws.on('pong', () => { missed = 0; });
      pingTimer = setInterval(() => {
        if (missed >= 2) return ws.terminate();
        missed++;
        try { ws.ping(); } catch { /* 閉じかけ */ }
      }, CONTROL_PING_MS);
      pingTimer.unref();
    });
    ws.on('message', (data, isBinary) => {
      if (gen !== generation || isBinary) return;
      const msg = parseJson(data);
      if (msg.type === 'incoming') onIncoming(msg);
    });
    ws.on('close', code => {
      if (control === ws) control = null;
      clearInterval(pingTimer);
      if (gen !== generation) return;
      const stable = controlOpenedAt && Date.now() - controlOpenedAt > STABLE_MS;
      if (stable) attempt = 0;
      controlOpenedAt = 0;
      const message = failure ?? describeClose(code);
      log(`remote: ${message}`);
      scheduleRetry({ code: `relay-${code}`, message });
    });
  }

  function scheduleRetry(err) {
    const base = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt);
    const delay = Math.round(Math.min(backoff.maxMs, base * (0.75 + Math.random() * 0.5)));
    attempt++;
    retryAt = Date.now() + delay;
    setPhase('retrying', err);
    const gen = generation;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (gen === generation) connect(); }, delay);
    retryTimer.unref?.();
  }

  /** 中継との接続とデータ用の接続をすべて閉じる。 */
  function disconnectAll() {
    generation++;
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    retryTimer = null;
    retryAt = null;
    attempt = 0;
    if (control) { closeWs(control, 1000); control = null; }
    for (const set of channels.values()) for (const { ch } of set) ch.goaway('shutdown', 'リモートを止めました');
    for (const ws of dataConns) closeWs(ws, HOST_CLOSE.SHUTDOWN);
    dataConns.clear();
    clearOffer(false);
  }

  // ── データ用の接続 ────────────────────────────────────────────

  function onIncoming({ conn, deviceId, pairing }) {
    if (typeof conn !== 'string' || !CONN_ID.test(conn) || !identity) return;
    const gen = generation;
    const ws = new WebSocket(relayWsUrl(cfg.relayUrl, `/v1/host/accept?conn=${encodeURIComponent(conn)}`), {
      headers: relayHeaders(), perMessageDeflate: false, handshakeTimeout: 15_000, maxPayload: DATA_MAX_PAYLOAD, followRedirects: false,
    });
    dataConns.add(ws);
    ws.on('error', () => {});
    ws.on('unexpected-response', (req, res) => { res.resume(); req.destroy(); dataConns.delete(ws); });
    ws.on('close', () => dataConns.delete(ws));
    const timer = setTimeout(() => closeWs(ws, HOST_CLOSE.TIMEOUT, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS);
    timer.unref();
    ws.once('open', () => { if (gen !== generation) closeWs(ws, HOST_CLOSE.SHUTDOWN); });
    if (pairing === true) handlePairing(ws, timer);
    else handleDevice(ws, typeof deviceId === 'string' ? deviceId : '', timer);
  }

  /** 最初のメッセージ（Noise のメッセージ 1）を受けて fn に渡す。文字のメッセージは形の誤り。 */
  function firstMessage(ws, fn) {
    ws.once('message', (data, isBinary) => {
      if (!isBinary) return closeWs(ws, HOST_CLOSE.BAD_REQUEST, 'binary expected');
      try { fn(Buffer.from(data)); }
      catch (e) { log(`remote handshake: ${e.message}`); closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'handshake'); }
    });
  }

  function handleDevice(ws, deviceId, timer) {
    const device = deviceCache.get(deviceId);
    if (!device) {
      clearTimeout(timer);
      ws.once('open', () => closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'unknown device'));
      return;
    }
    firstMessage(ws, m1 => {
      const hs = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor(identity.hostId), staticKey: identity });
      hs.readMessage(m1);
      // 中継が名乗った deviceId の鍵と、ハンドシェイクで証明された鍵が一致し、今も一覧にあること（取り消しの二重の守り）
      const current = deviceCache.get(deviceId);
      if (!current || !hs.remoteStatic.equals(Buffer.from(current.publicKey, 'base64url'))) {
        clearTimeout(timer);
        return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'revoked');
      }
      ws.send(hs.writeMessage());
      clearTimeout(timer);
      const ch = new Channel({
        role: 'host', transport: hs.split(), send: b => ws.send(b),
        hello: { app: appVersion, hostName: cfg.hostName }, bufferedAmount: () => ws.bufferedAmount,
      });
      const entry = { ch, ws };
      if (!channels.has(deviceId)) channels.set(deviceId, new Set());
      channels.get(deviceId).add(entry);
      ws.on('message', b => ch.receive(b));
      ch.on('stream', s => forwardStream(s, { target, token }));
      ch.on('close', err => closeWs(ws, err?.code === 'revoked' ? HOST_CLOSE.UNAUTHORIZED : err?.code === 'shutdown' ? HOST_CLOSE.SHUTDOWN : 1000));
      ws.on('close', () => {
        ch.close();
        const set = channels.get(deviceId);
        set?.delete(entry);
        if (set && !set.size) channels.delete(deviceId);
        touch(deviceId);
      });
      ch.start();
      touch(deviceId);
    });
  }

  function touch(deviceId) {
    const at = new Date().toISOString();
    const d = deviceCache.get(deviceId);
    if (d) d.lastSeenAt = at;
    store.touchDevice(deviceId, at).catch(() => {}).finally(queueStatus);
  }

  // ── ペアリング ────────────────────────────────────────────────

  function clearOffer(tellRelay) {
    if (!offer) return;
    clearTimeout(offer.timer);
    offer = null;
    if (tellRelay) sendControl({ type: 'pairing', ticketHash: null });
    queueStatus();
  }

  function handlePairing(ws, timer) {
    const o = offer && offer.expiresAt > Date.now() ? offer : null;
    // 入場券は 1 回きり（中継も消している）。次は作り直す
    clearOffer(false);
    if (!o) {
      clearTimeout(timer);
      ws.once('open', () => closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'no pairing'));
      return;
    }
    emit({ type: 'remotePairing', phase: 'connecting' });
    firstMessage(ws, m1 => {
      const hs = new Handshake({ pattern: 'IKpsk2', initiator: false, prologue: prologueFor(identity.hostId), staticKey: identity, psk: o.psk });
      const hello = parseJson(hs.readMessage(m1));
      ws.send(hs.writeMessage());
      const transport = hs.split();
      const code = confirmationCode(hs.handshakeHash);
      const publicKey = Buffer.from(hs.remoteStatic);
      // 次の 1 通を復号できれば psk を持っていた（QR を読んだ）端末。ここで初めて承認を尋ねる
      ws.once('message', data => {
        let msg;
        try { msg = parseJson(transport.decrypt(Buffer.from(data))); } catch { msg = null; }
        clearTimeout(timer);
        if (msg?.type !== 'pair') return closeWs(ws, HOST_CLOSE.UNAUTHORIZED, 'pairing');
        const now = Date.now();
        const r = {
          id: crypto.randomBytes(9).toString('base64url'),
          name: cleanLabel(hello.name) || '名前のない端末',
          platform: cleanLabel(hello.platform, 32) || 'unknown',
          app: cleanLabel(hello.app, 32) || null,
          code, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
          publicKey, ws,
          send: obj => { if (ws.readyState === WebSocket.OPEN) ws.send(transport.encrypt(Buffer.from(JSON.stringify(obj), 'utf8'))); },
          timer: null,
        };
        r.timer = setTimeout(() => finishRequest(r, 'expired'), PAIRING_TTL_MS);
        r.timer.unref();
        requests.set(r.id, r);
        ws.on('close', () => {
          if (requests.get(r.id) !== r) return;
          finishRequest(r, 'cancelled');
        });
        emit({ type: 'remotePairing', phase: 'request', request: publicRequest(r) });
        queueStatus();
      });
    });
  }

  function finishRequest(r, phaseName, extra = {}) {
    if (requests.get(r.id) !== r) return;
    requests.delete(r.id);
    clearTimeout(r.timer);
    if (phaseName === 'denied' || phaseName === 'expired') r.send({ type: phaseName });
    closeWs(r.ws, 1000);
    emit({ type: 'remotePairing', phase: phaseName, request: publicRequest(r), ...extra });
    queueStatus();
  }

  // ── 状態 ──────────────────────────────────────────────────────

  async function status() {
    const peek = identity ?? await store.peekIdentity().catch(() => null);
    const storage = await store.storageStatus().catch(() => null);
    return {
      enabled: cfg.enabled,
      configured: Boolean(cfg.relayUrl && cfg.secret),
      relayUrl: cfg.relayUrl,
      relayUrlFromEnv: cfg.relayUrlFromEnv,
      hasEnrollSecret: Boolean(cfg.secret),
      enrollSecretFromEnv: cfg.secretFromEnv,
      hostName: cfg.hostName,
      hostId: peek?.hostId ?? null,
      connection: { state: phase, error, since: new Date(since).toISOString(), retryAt: retryAt ? new Date(retryAt).toISOString() : null },
      pairing: {
        offer: offer ? { expiresAt: new Date(offer.expiresAt).toISOString() } : null,
        requests: [...requests.values()].map(publicRequest),
      },
      devices: [...deviceCache.values()].map(d => publicDevice(d, channels.get(d.id)?.size ?? 0)),
      storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
    };
  }

  /** 設定を読み直して、有効なら中継へつなぐ（直列に）。 */
  function apply() {
    const run = applying.catch(() => {}).then(async () => {
      disconnectAll();
      try {
        await loadConfig();
        if (!cfg.enabled) { setPhase('disabled'); return; }
        if (!cfg.relayUrl || !cfg.secret) { setPhase('error', { code: 'config', message: '中継の URL と登録用の秘密を入れてください' }); return; }
        normalizeRelayUrl(cfg.relayUrl);
        identity = await store.identity();
        connect();
      } catch (e) {
        setPhase('error', { code: e.code === 'SECRET_LOCKED' ? 'locked' : 'config', message: e.message });
      }
    });
    applying = run;
    return run;
  }

  return {
    store,
    /** 起動時に 1 回。無効なら何もしない（鍵も作らない）。 */
    start: () => apply(),
    status,

    /** { enabled?, relayUrl?, enrollSecret?, hostName? }。enrollSecret は undefined なら残し、'' か null で消す。 */
    async setSettings(args = {}) {
      const patch = {};
      if (args.relayUrl !== undefined) patch.relayUrl = normalizeRelayUrl(args.relayUrl);
      if (args.hostName !== undefined) patch.hostName = cleanLabel(args.hostName);
      if (args.enabled !== undefined) patch.enabled = args.enabled === true;
      if (args.enrollSecret !== undefined) {
        const secret = args.enrollSecret == null ? '' : String(args.enrollSecret).trim();
        if (/[\s]/.test(secret) || secret.length > 1024) throw new Error('登録用の秘密に空白は入れられません');
        await store.setEnrollSecret(secret);
      }
      if (patch.enabled) {
        const s = await store.settings();
        const url = patch.relayUrl ?? (s.relayUrl || env.AGENT_HOST_RELAY_URL || '');
        const secret = (await store.enrollSecret()) || env.AGENT_HOST_RELAY_SECRET || '';
        if (!url || !secret) throw new Error('中継の URL と登録用の秘密を入れてから有効にしてください');
      }
      if (Object.keys(patch).length) await store.saveSettings(patch);
      await apply();
      return status();
    },

    /** 端末を追加する。QR に入れる文字列と期限を返す。 */
    async startPairing() {
      if (!cfg.enabled) throw new Error('リモートが無効です');
      if (phase !== 'connected') throw new Error('中継につながっていません');
      const secret = crypto.randomBytes(32);
      const { psk, ticketHash } = derivePairing(secret);
      clearOffer(false);
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      offer = { psk, ticketHash, expiresAt, timer: null };
      const mine = offer;
      offer.timer = setTimeout(() => {
        if (offer !== mine) return;
        clearOffer(true);
        emit({ type: 'remotePairing', phase: 'expired' });
      }, PAIRING_TTL_MS);
      offer.timer.unref();
      sendControl({ type: 'pairing', ticketHash: ticketHash.toString('hex'), ttlMs: PAIRING_TTL_MS });
      queueStatus();
      return {
        payload: pairingPayload({ relayUrl: cfg.relayUrl, hostId: identity.hostId, publicKey: identity.publicKey, secret, hostName: cfg.hostName }),
        expiresAt: new Date(expiresAt).toISOString(),
        hostId: identity.hostId,
        hostName: cfg.hostName,
      };
    },
    cancelPairing() { clearOffer(true); return status(); },

    /** 承認。deviceId と中継用トークンを発行し、端末一覧・中継へ登録して端末へ渡す。 */
    async approve(id) {
      const r = requests.get(String(id ?? ''));
      if (!r) throw new Error('その承認待ちはもうありません');
      const raw = crypto.randomBytes(32);
      const device = {
        id: `d${crypto.randomBytes(12).toString('base64url')}`,
        name: r.name, platform: r.platform, app: r.app,
        publicKey: r.publicKey.toString('base64url'),
        tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
      };
      await store.addDevice(device);
      deviceCache.set(device.id, device);
      sendControl({ type: 'allow', id: device.id, tokenHash: device.tokenHash });
      r.send({ type: 'approved', deviceId: device.id, token: raw.toString('base64url'), hostName: cfg.hostName });
      finishRequest(r, 'approved', { device: publicDevice(device) });
      return publicDevice(device);
    },
    async deny(id) {
      const r = requests.get(String(id ?? ''));
      if (!r) throw new Error('その承認待ちはもうありません');
      finishRequest(r, 'denied');
      return status();
    },

    async devices() { return (await status()).devices; },

    /** 取り消し: 一覧から消し、中継からも消し、つながり中のチャネルを切る。 */
    async revoke(id) {
      id = String(id ?? '');
      deviceCache.delete(id);   // 照合は先に止める（消し終わるのを待つ間にハンドシェイクを通さない）
      await store.removeDevice(id);
      sendControl({ type: 'revoke', id });
      for (const { ch } of channels.get(id) ?? []) ch.goaway('revoked', 'この端末は取り消されました');
      queueStatus();
      return status();
    },

    /** 終了時。設定は変えずにつながりだけ閉じる。 */
    stop() { disconnectAll(); setPhase('disabled'); },
  };
}
