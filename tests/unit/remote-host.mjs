// ホストの接続口とペアリング（core/remote/connector.mjs、docs/remote.md §3.3・§4.2・§6.1、issue #13）。
// 中継（relay/server.mjs）をこのプロセスで立て、fake バックエンドのサーバーを別プロセスで立て、
// 試験用の端末（tests/lib/remote-device.mjs）で 端末 → 中継 → ホスト を往復する。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { pairDevice, connectDevice } from '../lib/remote-device.mjs';
import { checkPath } from '../../core/remote/forward.mjs';
import { normalizeRelayUrl, parsePairingPayload } from '../../core/remote/pairing.mjs';

export const name = 'remote-host';
export const title = 'リモートのホスト側: 有効化・ペアリングと承認・防火壁・取り消し・中継の張り直し';

const SECRET = crypto.randomBytes(32).toString('base64url');

async function startRelay(port = 0) {
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const addr = await relay.listen(port, '127.0.0.1');
  return { relay, port: addr.port };
}

const rejects = p => p.then(() => null, e => e);
/** 待ちを必ず有限にする。止まったら何を待っていたかを例外で報告する（試験全体を止めない）。 */
function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}

export default async function (t) {
  // ---- 純粋な部品
  t.ok('防火壁: /mcp で始まるパスを通さない（大文字・.. ・符号化も）',
    ['/mcp/agents', '/MCP/context', '/x/../mcp/agents', '/%6Dcp/agents', '/mcp', '\\mcp/agents', '//evil/mcp'].every(p => checkPath(p) === null));
  t.ok('防火壁: 普通のパスは通り、?token= は落ちる',
    checkPath('/?token=abc&x=1')?.path === '/?x=1' && checkPath('/app.mjs')?.path === '/app.mjs' && checkPath('/ws?token=a')?.pathname === '/ws');
  t.ok('中継の URL: http はループバックだけ', normalizeRelayUrl('http://127.0.0.1:8080/') === 'http://127.0.0.1:8080'
    && Boolean(await rejects(Promise.resolve().then(() => normalizeRelayUrl('http://relay.example.com')))));

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-')));
  const dataDir = path.join(scratch, 'data');
  let { relay, port: relayPort } = await within(startRelay(), 5000, '中継の起動');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await within(open({ port: server.port, token: server.token }), 10_000, 'サーバーへの接続');
  const cmd = (command, args = {}) => within(c.cmd(command, args), 15_000, `コマンド ${command}`);
  const devices = [];
  try {
    // ---- 既定は無効。鍵も作らない
    const s0 = await cmd('remoteStatus');
    t.ok('既定は無効で、中継にもつながらない', s0.enabled === false && s0.connection.state === 'disabled' && s0.hostId === null, JSON.stringify(s0.connection));
    t.ok('無効のうちは鍵もファイルも作らない', !(await fs.stat(path.join(dataDir, 'remote', 'secrets.json')).catch(() => null)));
    t.ok('設定が無いまま有効にはできない', Boolean(await rejects(cmd('setRemoteSettings', { enabled: true }))));
    t.ok('http の中継（ループバック以外）は受け付けない', Boolean(await rejects(cmd('setRemoteSettings', { relayUrl: 'http://relay.example.com' }))));
    t.ok('無効のうちはペアリングを始められない', Boolean(await rejects(cmd('remotePairingStart'))));

    // ---- 有効化
    let from = c.mark();
    const s1 = await cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
    t.ok('状態に登録用の秘密を出さない', !JSON.stringify(s1).includes(SECRET) && s1.hasEnrollSecret === true);
    const connected = await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 }).catch(() => null);
    t.ok('有効にすると中継へつながり、remoteStatus が配られる', Boolean(connected), JSON.stringify((await cmd('remoteStatus')).connection));
    const st = await cmd('remoteStatus');
    t.ok('hostId は base32 の 26 字', /^[a-z2-7]{26}$/.test(st.hostId ?? ''), st.hostId);
    t.ok('ホスト名を設定できる', st.hostName === 'desk-test');

    // ---- ペアリング（承認）
    const offer = await cmd('remotePairingStart');
    t.ok('ペアリングの文字列は pleiad://pair?...', offer.payload.startsWith('pleiad://pair?v=1&') && Boolean(Date.parse(offer.expiresAt)), offer.payload.slice(0, 40));
    const parsed = parsePairingPayload(offer.payload);
    t.ok('QR の中身は hostId・公開鍵・中継・ホスト名と合う', parsed.hostId === st.hostId && parsed.hostName === 'desk-test' && parsed.relayUrl === `http://127.0.0.1:${relayPort}`);
    const expiresIn = Date.parse(offer.expiresAt) - Date.now();
    t.ok('ペアリングは 5 分で失効する', expiresIn > 280_000 && expiresIn <= 300_000, String(expiresIn));
    const offered = await cmd('remoteStatus');
    t.ok('状態には期限だけが出て、秘密は出ない', Boolean(offered.pairing.offer?.expiresAt) && !JSON.stringify(offered).includes(offer.payload.split('&s=')[1]?.split('&')[0]));

    from = c.mark();
    const pa = pairDevice({ payload: offer.payload, name: 'Pixel 9', platform: 'android' });
    const req = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    const deviceCode = await within(pa.code, 15_000, '確認コード');
    t.ok('承認待ちが配られ、確認コードが端末と一致する', req.request.code === deviceCode && /^\d{6}$/.test(deviceCode), `${req.request.code} / ${deviceCode}`);
    t.ok('承認待ちに端末名と種類が出る', req.request.name === 'Pixel 9' && req.request.platform === 'android');
    t.ok('承認待ちは remoteStatus にも出る', (await cmd('remoteStatus')).pairing.requests.some(r => r.id === req.request.id));
    t.ok('ペアリングの入場券は使った時点で消える', (await cmd('remoteStatus')).pairing.offer === null);
    const added = await cmd('remotePairingApprove', { id: req.request.id });
    const credsA = await within(pa.result, 15_000, 'ペアリングの結果');
    t.ok('承認すると deviceId と中継用トークンが端末に渡る', credsA.deviceId === added.id && /^[A-Za-z0-9_-]{43}$/.test(credsA.token ?? ''), added.id);
    await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'approved', { from, ms: 5000 });
    const list1 = await cmd('remoteDevices');
    t.ok('端末一覧に載り、鍵やハッシュは返さない', list1.length === 1 && list1[0].name === 'Pixel 9' && !('publicKey' in list1[0]) && !('tokenHash' in list1[0]));
    const devFile = await fs.readFile(path.join(dataDir, 'remote', 'devices.json'), 'utf8');
    t.ok('devices.json はトークンのハッシュだけを持つ', devFile.includes(added.id) && !devFile.includes(credsA.token) && /"tokenHash": "[0-9a-f]{64}"/.test(devFile));

    // ---- つないで HTTP と WebSocket
    const dA = await connectDevice(credsA);
    devices.push(dA);
    t.ok('IK でつながり、HELLO にホスト名が来る', dA.hello.hostName === 'desk-test' && dA.hello.proto === 1);
    const index = await fs.readFile(path.join(ROOT, 'web', 'index.html'));
    const root = await dA.get('/');
    t.ok('GET / でホストの画面が返る（トークンは接続口が付ける）', root.status === 200 && root.body.equals(index), `${root.status ?? 'reset ' + root.reset}`);
    const withToken = await dA.get(`/?token=${server.token}`, { headers: { cookie: 'agent_host_token=wrong', authorization: 'Bearer x', origin: 'http://evil' } });
    t.ok('端末の Cookie・Authorization・Origin・?token= は捨て、Set-Cookie は返さない',
      withToken.status === 200 && !Object.keys(withToken.headers).some(k => k.toLowerCase() === 'set-cookie'), JSON.stringify(withToken.headers));
    const big = await dA.get('/client.mjs');
    t.ok('複数の断片に分かれる大きさのファイルも欠けずに届く', big.status === 200 && big.body.equals(await fs.readFile(path.join(ROOT, 'web', 'client.mjs'))), String(big.body?.length));
    const head = await dA.get('/', { method: 'HEAD' });
    t.ok('HEAD は通る', head.status === 200 && head.body.length === 0);
    const mcp = await Promise.all(['/mcp/agents', '/mcp/context', '/MCP/agents', '/x/../mcp/agents'].map(p => dA.get(p)));
    t.ok('/mcp/ は RESET 3 で通さない', mcp.every(r => r.reset === 3), JSON.stringify(mcp.map(r => r.reset ?? r.status)));
    const post = await dA.get('/', { method: 'POST', body: 'x' });
    t.ok('POST は RESET 3 で通さない', post.reset === 3, JSON.stringify(post.reset ?? post.status));
    const notFound = await dA.get('/no-such-file.txt');
    t.ok('無いファイルはホストの 404 がそのまま返る', notFound.status === 404);
    const w = await dA.ws('/ws');
    t.ok('/ws の WebSocket が受け付けられる', w.accepted === true, JSON.stringify(w.status ?? w.reset));
    const ready = w.accepted ? JSON.parse(await w.next()) : null;
    t.ok('/ws で ready が届く', ready?.kind === 'ready' && ready.protocolVersion === 3);
    if (w.accepted) {
      // 窓（256 KiB）より大きいメッセージを先に流してから、コマンドが通ること
      await within(w.send(JSON.stringify({ kind: 'noise', pad: 'x'.repeat(1_500_000) })), 15_000, '大きい WS メッセージの送信');
      await within(w.send(JSON.stringify({ kind: 'command', command: 'remoteStatus', id: 'r1', args: {} })), 5000, 'WS コマンドの送信');
      let reply = null;
      for (let i = 0; i < 20 && !reply; i++) { const m = JSON.parse(await w.next()); if (m.kind === 'response' && m.id === 'r1') reply = m; }
      t.ok('リモートの画面からもコマンドが通る', reply?.ok === true && reply.result.devices.some(d => d.id === added.id && d.connected));
      await within(w.close(), 5000, 'WS を閉じる');
    }
    const other = await dA.ws('/mcp/agents');
    const other2 = await dA.ws('/elsewhere');
    t.ok('/ws 以外の WebSocket は RESET 3', other.reset === 3 && other2.reset === 3, JSON.stringify([other, other2].map(x => x.reset ?? x.status)));

    // ---- ペアリング（拒否・使い回し）
    const offer2 = await cmd('remotePairingStart');
    from = c.mark();
    const pd = pairDevice({ payload: offer2.payload, name: 'stranger' });
    const req2 = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await cmd('remotePairingDeny', { id: req2.request.id });
    const denied = await within(pd.result, 15_000, 'ペアリングの結果');
    t.ok('拒否すると端末に denied が届き、一覧に載らない', denied.denied === true && denied.type === 'denied' && (await cmd('remoteDevices')).length === 1);
    const reuse = await rejects(within(pairDevice({ payload: offer2.payload }).result, 15_000, '使い回しのペアリング'));
    t.ok('使った QR ではもうペアリングできない（中継が 4401）', reuse?.closeCode === 4401, String(reuse?.closeCode ?? reuse?.message));

    // ---- 2 台目（取り消しの二重の守りに使う）
    const offer3 = await cmd('remotePairingStart');
    from = c.mark();
    const pb = pairDevice({ payload: offer3.payload, name: 'laptop' });
    const req3 = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await cmd('remotePairingApprove', { id: req3.request.id });
    const credsB = await within(pb.result, 15_000, 'ペアリングの結果');
    const mixed = await rejects(connectDevice({ ...credsB, keyPair: credsA.keyPair }));
    t.ok('中継を通っても、名乗った端末の鍵と違えばホストが 4401 で弾く', mixed?.closeCode === 4401, String(mixed?.closeCode ?? mixed?.message));

    // ---- 取り消し
    from = c.mark();
    await cmd('remoteRevoke', { id: credsA.deviceId });
    const cut = await Promise.race([dA.closed, sleep(5000).then(() => null)]);
    t.ok('取り消すと、つながり中のチャネルがすぐ切れる（4401）', cut?.code === 4401, JSON.stringify(cut));
    const again = await rejects(connectDevice(credsA));
    t.ok('取り消した端末はつながらない', again?.closeCode === 4401, String(again?.closeCode ?? again?.message));
    t.ok('一覧からも消える', !(await cmd('remoteDevices')).some(d => d.id === credsA.deviceId));

    // ---- 中継の張り直し
    const dB = await connectDevice(credsB);
    devices.push(dB);
    await within(relay.close(), 5000, '中継の停止');
    const dropped = await Promise.race([dB.closed, sleep(5000).then(() => null)]);
    t.ok('中継が落ちると端末の接続も切れる', Boolean(dropped));
    from = c.mark();
    await sleep(200);
    ({ relay } = await within(startRelay(relayPort), 5000, '中継の立て直し'));
    const back = await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 15_000 }).catch(() => null);
    t.ok('ホストが中継へ張り直す', Boolean(back));
    const dB2 = back ? await connectDevice(credsB).catch(e => e) : null;
    if (dB2 && !(dB2 instanceof Error)) devices.push(dB2);
    const after = dB2 && !(dB2 instanceof Error) ? await dB2.get('/') : null;
    t.ok('張り直しの sync で端末の照合が戻り、また使える', after?.status === 200, String(dB2?.closeCode ?? after?.status ?? after?.reset));

    // ---- 無効化
    await cmd('setRemoteSettings', { enabled: false });
    const off = await cmd('remoteStatus');
    t.ok('無効にすると中継から離れる', off.enabled === false && off.connection.state === 'disabled');
    const offline = await rejects(connectDevice(credsB));
    t.ok('無効の間は端末がつながらない（中継が 4404）', offline?.closeCode === 4404, String(offline?.closeCode ?? offline?.message));
  } finally {
    for (const d of devices) { try { d.close(); } catch {} }
    c.close();
    await within(server.stop(), 15_000, 'サーバーの停止').catch(e => t.note(e.message));
    await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
