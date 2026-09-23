// 端末の側（core/remote/device.mjs・device-link.mjs・device-proxy.mjs、docs/remote.md §3.3・§7、issue #14）。
// 中継（relay/server.mjs）をこのプロセスで、fake バックエンドのサーバーを別プロセスで立て、
// 端末のモジュールでペアリングし、端末内プロキシの URL を素の HTTP と ws で叩く。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { classifyClose } from '../../core/remote/device-link.mjs';
import { STREAM_WINDOW } from '../../core/remote/channel.mjs';

export const name = 'remote-device';
export const title = 'リモートの端末側: ペアリング・端末内プロキシ（認証・HTTP・/ws・背圧）・取り消し・中継の張り直し';

const require = createRequire(import.meta.url);
const SECRET = crypto.randomBytes(32).toString('base64url');

async function startRelay(port = 0) {
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(port, '127.0.0.1');
  return { relay, port: addr.port };
}

function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}
const rejects = p => p.then(() => null, e => e);

/** 素の HTTP の GET。Host を変えられる。onResponse で読み方を変えられる（背圧の確認）。 */
function request(port, pathname, { method = 'GET', headers = {}, host, timeoutMs = 10_000, onResponse } = {}) {
  return within(new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false, headers: { ...(host ? { host } : {}), ...headers } }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
      onResponse?.(res);
    });
    req.on('error', reject);
    req.end();
  }), timeoutMs, `${method} ${pathname}`);
}

/** 窓の代わりの WebSocket。開けたら { ws, next }、断られたら { status }。 */
function openWs(url, { host, timeoutMs = 10_000 } = {}) {
  return within(new Promise(resolve => {
    const ws = new WebSocket(url, { perMessageDeflate: false, ...(host ? { headers: { host } } : {}) });
    const inbox = [];
    const waiters = [];
    const closed = new Promise(res => ws.on('close', (code) => res(code)));
    ws.on('message', (data, isBinary) => { const m = isBinary ? data : data.toString('utf8'); const w = waiters.shift(); if (w) w(m); else inbox.push(m); });
    ws.on('error', () => {});
    ws.once('open', () => resolve({
      ws, closed,
      next: (ms = 10_000) => inbox.length ? Promise.resolve(inbox.shift()) : within(new Promise(res => waiters.push(res)), ms, 'WS のメッセージ'),
    }));
    ws.once('unexpected-response', (req, res) => { res.resume(); req.destroy(); resolve({ status: res.statusCode }); });
    ws.once('error', e => resolve({ error: e.message }));
  }), timeoutMs, `WS ${url.replace(/token=[^&]+/, 'token=…')}`);
}

/** 窓の WebSocket でコマンドを 1 つ投げ、その応答を待つ。 */
async function wsCommand(w, command, args = {}) {
  const id = `c${crypto.randomUUID()}`;
  w.ws.send(JSON.stringify({ kind: 'command', command, id, args }));
  for (let i = 0; i < 50; i++) {
    const m = JSON.parse(await w.next());
    if (m.kind === 'response' && m.id === id) return m;
  }
  return null;
}

/** プロキシの状態が pred を満たすまで待つ。 */
function waitState(device, hostId, pred, ms, label) {
  return within(new Promise(resolve => {
    const on = s => { if (s.hostId === hostId && pred(s.state)) { device.off('status', on); resolve(s); } };
    device.on('status', on);
    device.proxy(hostId).then(px => { if (px && pred(px.status.state)) { device.off('status', on); resolve({ hostId, ...px.status }); } });
  }), ms, label);
}

/** 試験用の暗号器（safeStorage の代わり）。置き場のファイルに平文が出ないことを確かめる。 */
function testCipher() {
  const key = crypto.randomBytes(32);
  return {
    async status() { return { encrypted: true, backend: 'test' }; },
    async encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    async decrypt(b64) {
      const raw = Buffer.from(b64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

export default async function (t) {
  // ---- 純粋な部品
  t.ok('close code から状態: 4401 と GOAWAY revoked は取り消し、4404・4408・shutdown はホストが居ない、ほかは通信の失敗',
    classifyClose({ closeCode: 4401 }) === 'revoked' && classifyClose({ goaway: 'revoked', closeCode: 1000 }) === 'revoked'
    && classifyClose({ closeCode: 4404 }) === 'host-offline' && classifyClose({ closeCode: 4408 }) === 'host-offline'
    && classifyClose({ goaway: 'shutdown', closeCode: 1001 }) === 'host-offline' && classifyClose({ closeCode: 1006 }) === 'offline');
  const { safeStorageCipher } = require('../../desktop/secret-bridge.cjs');
  const fakeSafe = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4) };
  const sc = safeStorageCipher({ safeStorage: fakeSafe, platform: 'win32' });
  const sealed = await sc.encrypt('secret-value');
  t.ok('safeStorageCipher: main の safeStorage を secret-store の暗号器の形で使える',
    (await sc.status()).encrypted === true && sealed !== 'secret-value' && await sc.decrypt(sealed) === 'secret-value');
  const noSafe = safeStorageCipher({ safeStorage: { isEncryptionAvailable: () => false }, platform: 'win32' });
  t.ok('safeStorageCipher: 暗号化できないときは encrypted: false（置き場は平文に落ちる）', (await noSafe.status()).encrypted === false);

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-device-')));
  const dataDir = path.join(scratch, 'data');
  const deviceDir = path.join(scratch, 'device');
  let { relay, port: relayPort } = await within(startRelay(), 5000, '中継の起動');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await within(open({ port: server.port, token: server.token }), 10_000, 'サーバーへの接続');
  const cmd = (command, args = {}) => within(c.cmd(command, args), 15_000, `コマンド ${command}`);
  const device = createRemoteDevice({
    dir: deviceDir, cipher: testCipher(), app: 'test', name: 'dev-laptop',
    proxyOptions: { backoff: { minMs: 200, maxMs: 1000, stableMs: 1000 }, connectTimeoutMs: 5000, requestWaitMs: 5000 },
  });
  const sockets = [];
  try {
    let from = c.mark();
    await cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
    await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });

    // ---- ペアリング
    const bad = await rejects(device.pair('pleiad://pair?v=1&h=x'));
    t.ok('形の違うコードは payload のエラー', bad?.code === 'payload', bad?.message);
    const offer = await cmd('remotePairingStart');
    from = c.mark();
    let shownCode = null;
    const pairing = device.pair(offer.payload, { onCode: code => { shownCode = code; } });
    pairing.catch(() => {});
    const req = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    t.ok('端末に出す確認コードがホストの承認待ちと一致する', /^\d{6}$/.test(shownCode ?? '') && req.request.code === shownCode, `${req.request.code} / ${shownCode}`);
    t.ok('ホストに端末名と種類が出る', req.request.name === 'dev-laptop' && req.request.platform === 'desktop');
    await cmd('remotePairingApprove', { id: req.request.id });
    const host = await within(pairing, 15_000, 'ペアリングの結果');
    const hostId = host.hostId;
    const st = await cmd('remoteStatus');
    t.ok('承認されるとホストが一覧に載る（hostId・ホスト名・deviceId）',
      hostId === st.hostId && host.hostName === 'desk-test' && st.devices.some(d => d.id === host.deviceId), JSON.stringify(host));
    const creds = await device.store.credentials(hostId);
    const hostsFile = await fs.readFile(path.join(deviceDir, 'hosts.json'), 'utf8');
    const secretsFile = await fs.readFile(path.join(deviceDir, 'secrets.json'), 'utf8');
    t.ok('hosts.json に中継用トークンを置かない', /^[A-Za-z0-9_-]{43}$/.test(creds?.token ?? '') && !hostsFile.includes(creds.token) && hostsFile.includes(hostId));
    t.ok('secrets.json のトークンと端末の鍵は暗号器で包まれる（平文が出ない）',
      !secretsFile.includes(creds.token) && /"enc": "safeStorage"/.test(secretsFile) && !/"enc": "plain"/.test(secretsFile));

    // ---- プロキシを開く
    const proxy = await within(device.open(hostId), 10_000, 'プロキシを開く');
    await waitState(device, hostId, s => s === 'connected', 10_000, 'つながる');
    const port = proxy.port;
    t.ok('プロキシは 127.0.0.1 の空きポートで、URL は ?token= 付き', port > 0 && proxy.url === `http://127.0.0.1:${port}/?token=${proxy.token}` && proxy.token.length >= 43);
    t.ok('HELLO のホスト名が状態に出る', proxy.status.hostName === 'desk-test' && (await device.list())[0]?.state === 'connected');
    t.ok('使ったポートを覚える', (await device.store.host(hostId)).port === port);

    // ---- 認証
    const noToken = await request(port, '/');
    const wrongToken = await request(port, '/?token=wrong');
    const wrongCookie = await request(port, '/', { headers: { cookie: 'pleiad_remote_token=wrong' } });
    t.ok('トークンが無い・違えば 401', noToken.status === 401 && wrongToken.status === 401 && wrongCookie.status === 401, `${noToken.status} ${wrongToken.status} ${wrongCookie.status}`);
    const badHost = await request(port, `/?token=${proxy.token}`, { host: `localhost:${port}` });
    const evilHost = await request(port, `/?token=${proxy.token}`, { host: 'evil.example:80' });
    t.ok('Host が 127.0.0.1:<p> でなければ 403（DNS rebinding）', badHost.status === 403 && evilHost.status === 403, `${badHost.status} ${evilHost.status}`);
    const post = await request(port, `/?token=${proxy.token}`, { method: 'POST' });
    t.ok('GET / HEAD 以外は 405', post.status === 405, String(post.status));
    const wsNoToken = await openWs(`ws://127.0.0.1:${port}/ws?token=wrong`);
    const wsBadHost = await openWs(`ws://127.0.0.1:${port}/ws?token=${proxy.token}`, { host: `localhost:${port}` });
    t.ok('/ws もトークンが違えば 401、Host が違えば 403', wsNoToken.status === 401 && wsBadHost.status === 403, `${wsNoToken.status} ${wsBadHost.status}`);

    // ---- HTTP
    const index = await fs.readFile(path.join(ROOT, 'web', 'index.html'));
    const root = await request(port, `/?token=${proxy.token}`, { headers: { accept: 'text/html' } });
    const setCookie = [root.headers['set-cookie'] ?? []].flat().join('\n');
    t.ok('GET / でホストの画面がそのまま返る', root.status === 200 && root.body.equals(index), `${root.status} ${root.body.length}`);
    t.ok('?token= で HttpOnly・SameSite=Strict の Cookie を返し、ホストの UI トークンは届かない',
      /pleiad_remote_token=[^;]+; HttpOnly; SameSite=Strict; Path=\//.test(setCookie) && !setCookie.includes('agent_host_token') && !root.body.includes(server.token), setCookie);
    const cookie = `pleiad_remote_token=${encodeURIComponent(proxy.token)}`;
    const asset = await request(port, '/client.mjs', { headers: { cookie } });
    t.ok('Cookie で静的ファイルも取れる（複数の断片）', asset.status === 200 && asset.body.equals(await fs.readFile(path.join(ROOT, 'web', 'client.mjs'))) && !asset.headers['set-cookie'], String(asset.status));
    const head = await request(port, '/', { method: 'HEAD', headers: { cookie } });
    t.ok('HEAD も通る', head.status === 200 && head.body.length === 0);
    const mcp = await request(port, '/mcp/agents', { headers: { cookie } });
    t.ok('/mcp/ はホストの防火壁で断られ、403 になる', mcp.status === 403, String(mcp.status));

    // ---- 大きい応答と背圧（2 MB のファイルを、窓を止めながら読む）
    const worker = await fs.readFile(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs'));
    let heldMax = 0;
    const slow = await request(port, '/vendor/pdfjs/build/pdf.worker.mjs', {
      headers: { cookie }, timeoutMs: 30_000,
      onResponse: res => {
        res.pause();
        const tick = setInterval(() => {
          for (const s of proxy.link.channel?.streams.values() ?? []) heldMax = Math.max(heldMax, s.unreleased);
        }, 20);
        setTimeout(() => {
          // 少しずつ読む
          const step = () => { res.resume(); setTimeout(() => { res.pause(); if (!res.readableEnded) setTimeout(step, 30); else clearInterval(tick); }, 15); };
          step();
          res.once('end', () => clearInterval(tick));
        }, 400);
      },
    });
    t.ok('2 MB の応答が、読み手が遅くても欠けずに届く', slow.status === 200 && slow.body.equals(worker), `${slow.status} ${slow.body.length}/${worker.length}`);
    t.ok('読み手が止まっている間、プロキシが抱える量はストリームの窓（256 KiB）以内', heldMax <= STREAM_WINDOW, String(heldMax));

    // ---- /ws
    const w = await openWs(`ws://127.0.0.1:${port}/ws?token=${proxy.token}`);
    sockets.push(w);
    const ready = w.ws ? JSON.parse(await w.next()) : null;
    t.ok('プロキシの /ws でホストの ready が届く', ready?.kind === 'ready' && ready.protocolVersion === 3, JSON.stringify(w.status ?? w.error ?? ready?.kind));
    const r1 = w.ws ? await wsCommand(w, 'remoteStatus') : null;
    t.ok('プロキシの /ws でコマンドが通る（端末がつながり中に見える）', r1?.ok === true && r1.result.devices.some(d => d.id === host.deviceId && d.connected));
    if (w.ws) {
      w.ws.send(JSON.stringify({ kind: 'noise', pad: 'x'.repeat(1_500_000) }));
      const r2 = await wsCommand(w, 'remoteStatus');
      t.ok('窓より大きいメッセージ（1.5 MB）のあとでもコマンドが通る', r2?.ok === true);
    }

    // ---- 開き直すとポートは同じ、トークンは新しい
    const oldToken = proxy.token;
    const closedWs = w.closed ? within(w.closed, 5000, '窓の WS が閉じる') : null;
    await within(device.close(hostId), 5000, 'プロキシを閉じる');
    t.ok('プロキシを閉じると窓の WebSocket も閉じる', (await closedWs.catch(() => null)) != null);
    const proxy2 = await within(device.open(hostId), 10_000, 'プロキシを開き直す');
    await waitState(device, hostId, s => s === 'connected', 10_000, 'つながり直す');
    const old = await request(proxy2.port, `/?token=${oldToken}`);
    t.ok('開き直すと覚えたポートを使い、前のトークンは通らない', proxy2.port === port && proxy2.token !== oldToken && old.status === 401, `${proxy2.port}/${port} ${old.status}`);
    const url2 = `ws://127.0.0.1:${port}/ws?token=${proxy2.token}`;
    const html = { accept: 'text/html,application/xhtml+xml' };

    // ---- 中継の張り直し
    const w2 = await openWs(url2);
    sockets.push(w2);
    await within(relay.close(), 5000, '中継の停止');
    const dropCode = w2.closed ? await within(w2.closed, 5000, '窓の WS が切れる').catch(() => null) : null;
    t.ok('中継が落ちると、窓の WebSocket は 1006 で切れる（画面の再接続に任せる）', dropCode === 1006, String(dropCode));
    const down = await waitState(device, hostId, s => s === 'offline' || s === 'host-offline', 10_000, '切れたことに気づく').catch(e => e);
    t.ok('中継が落ちると状態が offline になる', down?.state === 'offline' || down?.state === 'host-offline', down?.message ?? down?.state);
    const offlinePage = await request(port, `/?token=${proxy2.token}`, { headers: html });
    t.ok('つながらない間の読み込みには案内のページ（503・自動で読み直す）',
      offlinePage.status === 503 && offlinePage.body.toString().includes('つながりません') && offlinePage.body.toString().includes('http-equiv="refresh"'), String(offlinePage.status));
    const offlineAsset = await request(port, '/client.mjs', { headers: { cookie: `pleiad_remote_token=${proxy2.token}` } });
    const offlineWs = await openWs(url2);
    t.ok('つながらない間、画面以外の HTTP と /ws は 502', offlineAsset.status === 502 && offlineWs.status === 502, `${offlineAsset.status} ${offlineWs.status ?? offlineWs.error}`);
    await sleep(200);
    ({ relay } = await within(startRelay(relayPort), 5000, '中継の立て直し'));
    const back = await waitState(device, hostId, s => s === 'connected', 25_000, '中継の張り直し後につながる').catch(e => e);
    t.ok('中継が戻ると、ホストと端末が張り直してつながる', back?.state === 'connected', back?.message);
    const afterRoot = await request(port, `/?token=${proxy2.token}`, { headers: html });
    const w3 = await openWs(url2);
    sockets.push(w3);
    const ready3 = w3.ws ? JSON.parse(await w3.next()) : null;
    t.ok('張り直したあと、画面も /ws もまた使える', afterRoot.status === 200 && ready3?.kind === 'ready', `${afterRoot.status} ${ready3?.kind}`);

    // ---- ホストが居ない（無効にした）
    await cmd('setRemoteSettings', { enabled: false });
    const hostOff = await waitState(device, hostId, s => s === 'host-offline', 10_000, 'ホストが居ない').catch(e => e);
    t.ok('ホストがリモートを止めると host-offline（GOAWAY shutdown・4404）', hostOff?.state === 'host-offline', hostOff?.message ?? JSON.stringify(proxy2.status));
    const hostOffPage = await request(port, `/?token=${proxy2.token}`, { headers: html });
    t.ok('ホストが居ないときの案内は「ホストの Pleiad が起動しているか」', hostOffPage.status === 503 && hostOffPage.body.toString().includes('ホストの Pleiad が起動しているか'));
    from = c.mark();
    await cmd('setRemoteSettings', { enabled: true });
    await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });
    const again = await waitState(device, hostId, s => s === 'connected', 15_000, 'ホストが戻ってつながる').catch(e => e);
    t.ok('ホストが戻るとつながり直す', again?.state === 'connected', again?.message);

    // ---- 取り消し
    await cmd('remoteRevoke', { id: host.deviceId });
    const revoked = await waitState(device, hostId, s => s === 'revoked', 10_000, '取り消し').catch(e => e);
    t.ok('ホストで取り消すと状態が revoked になる', revoked?.state === 'revoked', revoked?.message ?? JSON.stringify(proxy2.status));
    await sleep(1500);
    t.ok('取り消したら張り直さない', proxy2.status.state === 'revoked');
    const revokedPage = await request(port, `/?token=${proxy2.token}`, { headers: html });
    t.ok('取り消し後の読み込みは「もう一度ペアリング」の案内（自動では読み直さない）',
      revokedPage.status === 503 && revokedPage.body.toString().includes('取り消されました') && !revokedPage.body.toString().includes('refresh'));
    let listed = null;
    for (let i = 0; i < 20 && !listed?.revokedAt; i++) { listed = (await device.list()).find(h => h.hostId === hostId); if (!listed?.revokedAt) await sleep(100); }
    t.ok('一覧に取り消されたことが残る', listed?.state === 'revoked' && Boolean(listed.revokedAt));

    // ---- 忘れる
    await within(device.remove(hostId), 5000, 'ホストを忘れる');
    const secretsAfter = await fs.readFile(path.join(deviceDir, 'secrets.json'), 'utf8');
    t.ok('忘れると一覧とトークンが消え、プロキシも止まる',
      (await device.list()).length === 0 && !secretsAfter.includes(`host:${hostId}`) && (await rejects(request(port, '/', { timeoutMs: 3000 }))) != null);
  } finally {
    for (const s of sockets) { try { s.ws?.terminate(); } catch {} }
    await within(device.closeAll(), 5000, 'プロキシを閉じる').catch(e => t.note(e.message));
    c.close();
    await within(server.stop(), 15_000, 'サーバーの停止').catch(e => t.note(e.message));
    await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
