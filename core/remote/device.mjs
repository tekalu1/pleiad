// 端末の側（docs/remote.md §3.1・§3.3・§7）。端末の鍵と、ペアリングしたホストの資格情報の置き場、
// QR（pleiad://pair?...）でのペアリング、ホストごとの端末内プロキシ（device-proxy.mjs）の管理。
// デスクトップ版の main プロセス（desktop/main.cjs から import()）と試験が同じものを使う。
//
//   <dir>/secrets.json  端末の静的鍵（deviceKey）と、ホストごとの中継用トークン（host:<hostId>）。core/secret-store.mjs
//                       （デスクトップは safeStorage で包む cipher を渡す。試験・暗号化できない起動は 0600 の平文）
//   <dir>/hosts.json    { version: 1, hosts: [{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port,
//                         pairedAt, lastConnectedAt, revokedAt, agentUse }] }（秘密は入れない。port は §7.1 のホストごとに覚えるポート。
//                         agentUse = この PC の AI からそのホストへ任せるか。既定オフ。docs/remote.md §4.5）
//   <dir>/static/<hostId>.bin  そのホストの画面の殻の束（core/remote/static-bundle.mjs。docs/remote.md §8.6）
//
//   const device = createRemoteDevice({ dir, cipher, app: '0.1.0', name: os.hostname() });
//   const host = await device.pair(payload, { onCode: code => show(code) });   // ホストで承認されたら解決
//   const proxy = await device.open(host.hostId);                               // proxy.url を窓で開く
//   device.on('status', ({ hostId, state }) => ...);
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSecretStore, plainCipher, withFileLock } from '../secret-store.mjs';
import { Handshake, generateKeyPair, keyPairFromPrivate, prologueFor, derivePairing, confirmationCode } from './noise.mjs';
import { parsePairingPayload, relayWsUrl, cleanLabel, PAIRING_TTL_MS } from './pairing.mjs';
import { openRelaySocket, DeviceLink } from './device-link.mjs';
import { DeviceProxy } from './device-proxy.mjs';
import { AgentLink } from './agent-link.mjs';
import { readJson, writeJson } from './devices.mjs';
import { t } from '../i18n.mjs';

const HOST_ID = /^[a-z2-7]{26}$/;

function publicRecord(h) {
  return {
    hostId: h.hostId, hostName: h.hostName ?? '', label: h.label ?? '', relayUrl: h.relayUrl,
    deviceId: h.deviceId, port: h.port ?? 0, pairedAt: h.pairedAt ?? null,
    lastConnectedAt: h.lastConnectedAt ?? null, revokedAt: h.revokedAt ?? null, agentUse: h.agentUse === true,
  };
}

/** 端末の鍵とホストの資格情報の置き場。 */
export function createDeviceStore({ dir, cipher = plainCipher }) {
  const hostsFile = path.join(dir, 'hosts.json');
  const secrets = createSecretStore({ file: path.join(dir, 'secrets.json'), cipher });
  let keyPair = null;
  let queue = Promise.resolve();
  const locked = fn => { const run = queue.catch(() => {}).then(() => withFileLock(`${hostsFile}.lock`, fn)); queue = run; return run; };

  async function readHosts() {
    const raw = await readJson(hostsFile, { version: 1, hosts: [] });
    if (raw?.version !== 1 || !Array.isArray(raw.hosts)) throw new Error(t('remote.store.badFormat', { file: 'hosts.json' }));
    return raw;
  }

  return {
    dir,
    secrets,
    storageStatus: () => secrets.status(),

    /** 端末の静的鍵。無ければ作る（プロセスをまたいで 1 つになるよう、秘密の置き場の排他の中で）。 */
    async identity() {
      if (keyPair) return keyPair;
      const priv = await secrets.update('deviceKey', cur => cur ?? generateKeyPair().privateKey.toString('base64url'));
      keyPair = keyPairFromPrivate(Buffer.from(priv, 'base64url'));
      return keyPair;
    },

    /** ペアリングしたホストの一覧（秘密を含まない）。 */
    async hosts() { return (await readHosts()).hosts.map(publicRecord); },
    async host(hostId) { return (await this.hosts()).find(h => h.hostId === hostId) ?? null; },

    /** つなぐのに要るもの一式（トークンを含む。プロセスの外に出さない）。無ければ null。 */
    async credentials(hostId) {
      const h = (await readHosts()).hosts.find(x => x.hostId === hostId);
      if (!h) return null;
      const secret = await secrets.get(`host:${hostId}`);
      if (!secret?.token) return null;
      return { ...publicRecord(h), hostPublicKey: Buffer.from(h.hostPublicKey, 'base64url'), token: secret.token };
    },

    /** ペアリングの結果を置く。同じホストを組み直したときは資格を差し替え、覚えたポートと名前は残す。 */
    async saveHost(creds) {
      if (!HOST_ID.test(creds.hostId ?? '')) throw new Error('invalid hostId');
      await secrets.set(`host:${creds.hostId}`, { token: creds.token });
      return locked(async () => {
        const data = await readHosts();
        const prev = data.hosts.find(h => h.hostId === creds.hostId);
        const rec = {
          hostId: creds.hostId, hostName: cleanLabel(creds.hostName), label: prev?.label ?? '',
          relayUrl: creds.relayUrl, hostPublicKey: Buffer.from(creds.hostPublicKey).toString('base64url'),
          deviceId: creds.deviceId, port: prev?.port ?? 0, pairedAt: new Date().toISOString(),
          lastConnectedAt: null, revokedAt: null, ...(prev?.agentUse === true ? { agentUse: true } : {}),
        };
        data.hosts = data.hosts.filter(h => h.hostId !== creds.hostId).concat(rec);
        await writeJson(hostsFile, data);
        return publicRecord(rec);
      });
    },

    /** 秘密でない項目を変える（port・label・hostName・lastConnectedAt・revokedAt・agentUse）。 */
    async updateHost(hostId, patch) {
      return locked(async () => {
        const data = await readHosts();
        const h = data.hosts.find(x => x.hostId === hostId);
        if (!h) return null;
        for (const k of ['port', 'label', 'hostName', 'lastConnectedAt', 'revokedAt']) if (k in patch) h[k] = patch[k];
        if ('agentUse' in patch) { if (patch.agentUse === true) h.agentUse = true; else delete h.agentUse; }
        await writeJson(hostsFile, data);
        return publicRecord(h);
      });
    },

    /** 一覧から消し、トークンも消す。 */
    async removeHost(hostId) {
      await secrets.delete(`host:${hostId}`);
      return locked(async () => {
        const data = await readHosts();
        const hit = data.hosts.find(h => h.hostId === hostId) ?? null;
        data.hosts = data.hosts.filter(h => h.hostId !== hostId);
        await writeJson(hostsFile, data);
        return hit ? publicRecord(hit) : null;
      });
    },
  };
}

function pairError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function pairErrorForClose(closeCode) {
  if (closeCode === 4401) return pairError('ticket', t('remote.pair.ticket'), { closeCode });
  if (closeCode === 4429) return pairError('rate', t('remote.pair.rate'), { closeCode });
  if (closeCode === 4404 || closeCode === 4408) return pairError('host-offline', t('remote.pair.hostOffline'), { closeCode });
  return pairError('cancelled', t('remote.pair.cancelled'), { closeCode });
}

/**
 * QR の文字列でペアリングする（§3.3）。ハンドシェイクのあと onCode(確認コード 6 桁) を呼び、ホストの承認を待つ。
 * 承認されたら { hostId, hostPublicKey, relayUrl, deviceId, token, hostName } で解決する。
 * 断られた・期限切れ・つながらないときは reject（err.code: 'denied' | 'expired' | 'ticket' | 'rate' | 'host-offline' |
 * 'offline' | 'cancelled' | 'aborted' | 'timeout' | 'handshake' | 'payload'）。signal で中断できる。
 */
export async function pairWithHost({ payload, keyPair, name = '', platform = 'desktop', app = '', onCode = () => {}, signal, timeoutMs = PAIRING_TTL_MS + 30_000, connectTimeoutMs = 15_000 }) {
  let p;
  try { p = parsePairingPayload(payload); }
  catch (e) { throw pairError('payload', e.message); }
  const { psk, ticket } = derivePairing(p.secret);
  if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
  const sock = openRelaySocket(relayWsUrl(p.relayUrl, '/v1/device'), {
    'x-pleiad-host': p.hostId, 'x-pleiad-pairing': ticket.toString('base64url'),
  }, { openTimeoutMs: connectTimeoutMs });
  const onAbort = () => sock.ws.terminate();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const o = await sock.opened;
    if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
    if (!o.open) {
      if (o.closeCode != null) throw pairErrorForClose(o.closeCode);
      throw pairError('offline', t('remote.device.offline'), o.status ? { httpStatus: o.status } : {});
    }
    const hs = new Handshake({ pattern: 'IKpsk2', initiator: true, prologue: prologueFor(p.hostId), staticKey: keyPair, remoteStatic: p.publicKey, psk });
    sock.ws.send(hs.writeMessage(Buffer.from(JSON.stringify({ proto: 1, name: cleanLabel(name), platform, app: String(app) }))));
    let m2;
    try { m2 = await sock.next(connectTimeoutMs); }
    catch (e) {
      if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
      if (e.closeCode != null) throw pairErrorForClose(e.closeCode);
      throw pairError('host-offline', t('remote.pair.noResponse'));
    }
    try { hs.readMessage(m2); }
    catch { throw pairError('handshake', t('remote.pair.keyMismatch')); }
    const transport = hs.split();
    const code = confirmationCode(hs.handshakeHash);
    sock.ws.send(transport.encrypt(Buffer.from(JSON.stringify({ type: 'pair' }))));
    try { onCode(code); } catch { /* 表示の失敗でペアリングは止めない */ }
    let msg;
    try { msg = JSON.parse(transport.decrypt(await sock.next(timeoutMs)).toString('utf8')); }
    catch (e) {
      if (signal?.aborted) throw pairError('aborted', t('remote.pair.aborted'));
      if (e.closeCode != null) throw pairErrorForClose(e.closeCode);
      if (e.code === 'timeout') throw pairError('timeout', t('remote.pair.timeout'));
      throw pairError('handshake', t('remote.pair.unreadable'));
    }
    if (msg?.type === 'denied') throw pairError('denied', t('remote.pair.denied'));
    if (msg?.type === 'expired') throw pairError('expired', t('remote.pair.expired'));
    if (msg?.type !== 'approved' || typeof msg.deviceId !== 'string' || typeof msg.token !== 'string') throw pairError('handshake', t('remote.pair.badResponse'));
    return {
      hostId: p.hostId, hostPublicKey: p.publicKey, relayUrl: p.relayUrl,
      deviceId: msg.deviceId, token: msg.token, hostName: cleanLabel(msg.hostName || p.hostName),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (sock.ws.readyState === sock.ws.OPEN) sock.ws.close(1000); else sock.ws.terminate();
  }
}

/**
 * 端末の全体。ホストの一覧・ペアリング・ホストごとのプロキシ。
 *   dir: 置き場（デスクトップは userData の下）、cipher: 秘密を包むもの（desktop/secret-bridge.cjs の safeStorageCipher）
 *   app: アプリの版、name: この端末の名前（ホストの端末一覧に出る）、platform: 'desktop' など
 *   proxyOptions: DeviceProxy に足すもの（backoff・connectTimeoutMs・requestWaitMs。試験で縮める）
 * 出来事: 'status' ({ hostId, state, ... })。プロキシの状態が変わるたび
 */
export function createRemoteDevice({ dir, cipher = plainCipher, app = '', name = '', platform = 'desktop', proxyOptions = {}, log = () => {} }) {
  const store = createDeviceStore({ dir, cipher });
  const events = new EventEmitter();
  const proxies = new Map();   // hostId -> Promise<DeviceProxy>
  const agents = new Map();    // hostId -> { link: DeviceLink, agent: AgentLink }。この PC の AI からホストへ任せる線（agentUse のホストだけ。窓を開かなくても持つ）

  /** ホストごとの画面の殻の束（docs/remote.md §8.6）。忘れたホストの分は remove で消す */
  const staticCacheFile = hostId => path.join(dir, 'static', `${hostId}.bin`);

  async function list() {
    const hosts = await store.hosts();
    return Promise.all(hosts.map(async h => {
      const px = proxies.has(h.hostId) ? await proxies.get(h.hostId).catch(() => null) : null;
      const st = px?.status;
      const ag = agents.get(h.hostId);
      return { ...h, open: Boolean(px), state: st?.state ?? (h.revokedAt ? 'revoked' : 'closed'), ...(st?.hostName ? { hostName: st.hostName } : {}),
        ...(ag ? { agent: ag.agent.status, agentLinkState: ag.link.state } : {}) };
    }));
  }

  async function open(hostId) {
    if (proxies.has(hostId)) return proxies.get(hostId);
    const run = (async () => {
      const creds = await store.credentials(hostId);
      if (!creds) throw Object.assign(new Error(t('remote.device.unknownHost')), { code: 'unknown-host' });
      const keyPair = await store.identity();
      const px = new DeviceProxy({ creds, keyPair, port: creds.port, app, name, shell: platform === 'desktop' ? 'desktop' : 'mobile', log,
        staticCacheFile: staticCacheFile(hostId), ...proxyOptions });
      px.on('status', s => {
        if (s.state === 'connected') store.updateHost(hostId, { lastConnectedAt: new Date().toISOString(), revokedAt: null, ...(s.hostName ? { hostName: cleanLabel(s.hostName) } : {}) }).catch(() => {});
        if (s.state === 'revoked') store.updateHost(hostId, { revokedAt: new Date().toISOString() }).catch(() => {});
        events.emit('status', { hostId, ...s });
      });
      await px.start();
      if (px.port !== creds.port) await store.updateHost(hostId, { port: px.port });
      return px;
    })();
    proxies.set(hostId, run);
    run.catch(() => proxies.delete(hostId));
    return run;
  }

  // ---- この PC の AI からホストへ任せる線（docs/remote.md §4.5、ADR 0146）。端末の main が持ち、ローカルのサーバーとは parentPort の橋で話す

  /** agentUse のホストの線を張る（窓のプロキシとは別のチャネル）。取り消し済み・資格が無いホストは張らない。張った AgentLink を返す */
  async function agentOpen(hostId) {
    if (agents.has(hostId)) return agents.get(hostId).agent;
    const creds = await store.credentials(hostId);
    if (!creds || creds.revokedAt) return null;
    if (agents.has(hostId)) return agents.get(hostId).agent;
    const keyPair = await store.identity();
    const link = new DeviceLink({ creds, keyPair, app, name, shell: platform === 'desktop' ? 'desktop' : 'mobile', log, ...(proxyOptions.backoff ? { backoff: proxyOptions.backoff } : {}),
      ...(proxyOptions.connectTimeoutMs ? { connectTimeoutMs: proxyOptions.connectTimeoutMs } : {}) });
    const agent = new AgentLink({ link, log, ...(proxyOptions.agentRequestTimeoutMs ? { requestTimeoutMs: proxyOptions.agentRequestTimeoutMs } : {}) });
    link.on('status', s => {
      if (s.state === 'connected') store.updateHost(hostId, { lastConnectedAt: new Date().toISOString(), revokedAt: null, ...(s.hostName ? { hostName: cleanLabel(s.hostName) } : {}) }).catch(() => {});
      if (s.state === 'revoked') store.updateHost(hostId, { revokedAt: new Date().toISOString() }).catch(() => {});
    });
    agent.on('state', st => events.emit('agent-state', { hostId, ...st }));
    agents.set(hostId, { link, agent });
    agent.start();
    link.start();
    return agent;
  }

  async function agentClose(hostId) {
    const entry = agents.get(hostId);
    if (!entry) return;
    agents.delete(hostId);
    entry.agent.stop();
    entry.link.stop();
    events.emit('agent-state', { hostId, state: 'offline', allowed: false, hostName: '' });
  }

  /** hosts.json の agentUse に合わせて線を張る・閉じる（起動のとき・agentUse を替えたとき） */
  async function agentSync() {
    const hosts = await store.hosts();
    const want = new Set(hosts.filter(h => h.agentUse && !h.revokedAt).map(h => h.hostId));
    for (const id of [...agents.keys()]) if (!want.has(id)) await agentClose(id);
    for (const id of want) await agentOpen(id).catch(e => log(`remote agent: ${e.message}`));
  }

  async function close(hostId) {
    const run = proxies.get(hostId);
    if (!run) return;
    proxies.delete(hostId);
    const px = await run.catch(() => null);
    await px?.close();
  }

  return {
    store,
    on: (...a) => events.on(...a),
    off: (...a) => events.off(...a),
    identity: () => store.identity(),
    list,
    /** ペアリングして保存する。開いているプロキシがあれば新しい資格でつなぎ直す。 */
    async pair(payload, { onCode, signal, timeoutMs } = {}) {
      const keyPair = await store.identity();
      const creds = await pairWithHost({ payload, keyPair, name, platform, app, onCode, signal, timeoutMs });
      const rec = await store.saveHost(creds);
      if (proxies.has(rec.hostId)) {
        const px = await proxies.get(rec.hostId).catch(() => null);
        const full = await store.credentials(rec.hostId);
        px?.retryNow(full);
      }
      if (agents.has(rec.hostId)) agents.get(rec.hostId).link.retryNow(await store.credentials(rec.hostId));
      return rec;
    },
    open,
    /** 開いているプロキシ（無ければ null）。 */
    async proxy(hostId) { return proxies.has(hostId) ? proxies.get(hostId).catch(() => null) : null; },
    close,
    async rename(hostId, label) { return store.updateHost(hostId, { label: cleanLabel(label) }); },
    /** ペアリングを忘れる（ホストの端末一覧からは消えない。ホストで取り消す）。 */
    async remove(hostId) {
      await close(hostId); await agentClose(hostId);
      await fs.rm(staticCacheFile(hostId), { force: true }).catch(() => {});
      return store.removeHost(hostId);
    },
    async closeAll() { await Promise.all([...proxies.keys()].map(close)); await Promise.all([...agents.keys()].map(agentClose)); },
    /** この PC の AI からそのホストへ任せるか（人だけが窓で変える。既定オフ）。入れたら線を張り、切ったら閉じる */
    async setAgentUse(hostId, enabled) {
      const rec = await store.updateHost(hostId, { agentUse: enabled === true });
      if (!rec) throw Object.assign(new Error(t('remote.device.unknownHost')), { code: 'unknown-host' });
      if (enabled === true) await agentOpen(hostId); else await agentClose(hostId);
      return rec;
    },
    agentSync,
    /** 張ってある線（無ければ null） */
    agent: hostId => agents.get(hostId)?.agent ?? null,
  };
}
