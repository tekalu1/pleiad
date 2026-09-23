// 手元のフォルダーを送る口を、端末内プロキシ → 中継 → ホストの接続口 → サーバーの経路で通す（docs/remote.md §8.1・§4.3、issue #15）。
// 中継（relay/server.mjs）はこのプロセス、fake バックエンドのサーバーは別プロセス、端末は core/remote/device.mjs。
// 画面と同じく 512 KiB の base64 の断片を同時に 4 つまで投げ、50 MiB・2000 件が流量の制御の下で詰まらずに届くこと、
// 途中で中継が落ちて WebSocket が切れても、つなぎ直して uploadStart から続きを送れることを確かめる。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { CHUNK_BYTES } from '../../core/folder-uploads.mjs';

export const name = 'remote-upload';
export const title = 'リモート経由のフォルダーの送信: 50 MiB・2000 件が中継と端末内プロキシを通って届き、切れても続きから送れる';

const SECRET = crypto.randomBytes(32).toString('base64url');
const MiB = 1024 * 1024;

function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}

async function startRelay(port = 0) {
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(port, '127.0.0.1');
  return { relay, port: addr.port };
}

function waitState(device, hostId, pred, ms, label) {
  return within(new Promise((resolve) => {
    const on = (s) => { if (s.hostId === hostId && pred(s.state)) { device.off('status', on); resolve(s); } };
    device.on('status', on);
    device.proxy(hostId).then((px) => { if (px && pred(px.status.state)) { device.off('status', on); resolve({ hostId, ...px.status }); } });
  }), ms, label);
}

/** 画面（web/folder-upload.mjs）と同じ送り方。stopAfter 個の応答を受けたら止める */
async function pump(cmd, uploadId, files, received, { stopAfter = Infinity } = {}) {
  const jobs = [];
  files.forEach((f, i) => { for (let off = received[i]; off < f.data.length; off += CHUNK_BYTES) jobs.push({ i, off }); });
  let k = 0, acked = 0, stop = false;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < jobs.length && !stop && acked < stopAfter) {
      const { i, off } = jobs[k++];
      const r = await cmd('uploadChunk', { uploadId, file: i, offset: off, data: files[i].data.subarray(off, off + CHUNK_BYTES).toString('base64') })
        .catch((e) => { stop = true; throw e; });
      received[i] = r.received;
      acked++;
    }
  }));
  return acked;
}

const meta = (files) => files.map((f) => ({ path: f.path, size: f.data.length, mtime: 1_700_000_000_000 }));

async function sameTree(dest, files) {
  let bad = 0;
  for (const f of files) {
    const got = await fs.readFile(path.join(dest, ...f.path.split('/'))).catch(() => null);
    if (!got || !got.equals(f.data)) bad++;
  }
  return bad;
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-upload-')));
  const uploads = path.join(scratch, 'uploads');
  let { relay, port: relayPort } = await within(startRelay(), 5000, '中継の起動');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FOLDER_UPLOADS: uploads }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
  const host = await within(open({ port: server.port, token: server.token }), 10_000, 'サーバーへの接続');
  const device = createRemoteDevice({ dir: path.join(scratch, 'device'), app: 'test', name: 'upload-laptop',
    proxyOptions: { backoff: { minMs: 200, maxMs: 1000, stableMs: 1000 }, connectTimeoutMs: 5000, requestWaitMs: 5000 } });
  let c = null;
  try {
    let from = host.mark();
    await host.cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'upload-host' });
    await host.waitFor((e) => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });
    const offer = await host.cmd('remotePairingStart');
    from = host.mark();
    const pairing = device.pair(offer.payload);
    pairing.catch(() => {});
    const req = await host.waitFor((e) => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await host.cmd('remotePairingApprove', { id: req.request.id });
    const { hostId } = await within(pairing, 15_000, 'ペアリング');
    const proxy = await within(device.open(hostId), 10_000, 'プロキシを開く');
    await waitState(device, hostId, (s) => s === 'connected', 10_000, 'つながる');
    c = await within(open({ port: proxy.port, token: proxy.token }), 10_000, 'プロキシ経由の /ws');
    const cmd = (command, args) => within(c.cmd(command, args), 30_000, command);

    // ---- 50 MiB・2000 件（2 MiB の 10 件は断片に分かれる。残りは小さいファイル）
    const pool = crypto.randomBytes(50 * MiB);
    const files = [];
    let at = 0;
    for (let i = 0; i < 10; i++) { files.push({ path: `big/blob-${i}.bin`, data: pool.subarray(at, at + 2 * MiB) }); at += 2 * MiB; }
    const small = Math.floor((pool.length - at) / 1990);
    for (let i = 0; i < 1990; i++) {
      const size = i === 1989 ? pool.length - at : small;
      files.push({ path: `src/m${Math.floor(i / 100)}/file-${i}.txt`, data: pool.subarray(at, at + size) });
      at += size;
    }
    const total = files.reduce((a, f) => a + f.data.length, 0);
    const t0 = Date.now();
    const st = await cmd('uploadStart', { name: 'bulk', files: meta(files) });
    const received = st.received.slice();
    await within(pump(cmd, st.uploadId, files, received), 180_000, '50 MiB の送信');
    const fin = await cmd('uploadFinish', { uploadId: st.uploadId });
    const sec = (Date.now() - t0) / 1000;
    t.note(`50 MiB・2000 件: ${sec.toFixed(1)} 秒（${(total / MiB / sec).toFixed(1)} MiB/s。base64 と JSON を含む）`);
    t.ok('50 MiB・2000 件がプロキシと中継を通って届き、中身がすべて同じ', total === 50 * MiB && files.length === 2000
      && fin.files === 2000 && fin.dest === path.join(uploads, 'bulk') && await sameTree(fin.dest, files) === 0, `${fin.files} 件`);
    t.ok('流量の制御の下でも、中継が接続を切らずに終わる（同じ /ws のまま）', c.ws.readyState === 1 && (await device.proxy(hostId)).status.state === 'connected');

    // ---- 途中で中継が落ちる → つなぎ直して続きから
    const pool2 = crypto.randomBytes(12 * MiB);
    const files2 = [{ path: 'video.bin', data: pool2.subarray(0, 8 * MiB) }, ...Array.from({ length: 40 }, (_, i) => ({ path: `notes/n${i}.md`, data: pool2.subarray(8 * MiB + i * 100 * 1024, 8 * MiB + (i + 1) * 100 * 1024) }))];
    const s1 = await cmd('uploadStart', { name: 'resume-me', files: meta(files2) });
    const r1 = s1.received.slice();
    await pump(cmd, s1.uploadId, files2, r1, { stopAfter: 6 });
    const closed = new Promise((res) => c.ws.once('close', res));
    await within(relay.close(), 5000, '中継の停止');
    await within(closed, 10_000, 'プロキシ経由の /ws が閉じる');
    t.ok('中継が落ちると、端末内プロキシは窓の /ws を閉じる（画面は接続が切れたと知る）', c.ws.readyState === 3);
    ({ relay } = await within(startRelay(relayPort), 5000, '中継の立て直し'));
    await waitState(device, hostId, (s) => s === 'connected', 20_000, 'つながり直す');
    c = await within(open({ port: proxy.port, token: proxy.token }), 10_000, 'つなぎ直した /ws');
    const s2 = await cmd('uploadStart', { name: 'resume-me', files: meta(files2) });
    const have = s2.received.reduce((a, b) => a + b, 0);
    t.ok('つなぎ直して uploadStart を呼ぶと、同じ uploadId と受け取り済みの位置が返る', s2.uploadId === s1.uploadId && s2.resumed && have >= 6 * 100 * 1024 && have < 12 * MiB, `${have} バイト`);
    const r2 = s2.received.slice();
    const rest = await pump(cmd, s2.uploadId, files2, r2);
    const fin2 = await cmd('uploadFinish', { uploadId: s2.uploadId });
    t.ok('続きだけを送って仕上がり、中身がすべて同じ', await sameTree(fin2.dest, files2) === 0 && rest < 16 + 40, `続きの断片 ${rest}`);

    // 作業フォルダーにする（プロキシ経由でも同じコマンド）
    const { sessionId } = await cmd('newSession', { backend: 'fake', cwd: scratch });
    await cmd('setTurnSettings', { sessionId, cwd: fin2.dest });
    const row = (await cmd('listSessions')).find((s) => s.id === sessionId);
    t.ok('送り先をその会話の作業フォルダーにできる（未送信の会話でも nextSettings.cwd）', row?.nextSettings?.cwd === fin2.dest || row?.cwd === fin2.dest, JSON.stringify({ cwd: row?.cwd, next: row?.nextSettings }));
  } finally {
    try { c?.close(); } catch {}
    host.close();
    await device.closeAll().catch(() => {});
    await server.stop();
    await relay.close().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
