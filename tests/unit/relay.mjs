// 中継サーバー（relay/server.mjs、docs/remote.md §5）。空きポートで立て、ws の素のクライアントで叩く。
// 暗号は中継の外なので、ここではバイト列が変わらずに届くことと、照合・行き先・上限だけを見る。
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createRelay, configFromEnv, CLOSE } from '../../relay/server.mjs';

export const name = 'relay';
export const title = '中継: ホストの登録・端末の照合・入場券・行き先の固定・取り消し・上限・張り直し';

const SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newHostId = () => Array.from(crypto.randomBytes(26), (b) => B32[b & 31]).join('');
function newToken() {
  const raw = crypto.randomBytes(32);
  return { token: raw.toString('base64url'), hash: crypto.createHash('sha256').update(raw).digest('hex') };
}
let ipSeq = 0;
const newIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

async function startRelay(opts = {}) {
  const relay = createRelay({ enrollSecret: SECRET, logger: () => {}, ...opts });
  const { port } = await relay.listen(0, '127.0.0.1');
  return { relay, port };
}

function client(port, path, headers = {}, extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, perMessageDeflate: false, ...extra });
  const msgs = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const m = { data: Buffer.from(data), isBinary };
    const w = waiters.shift();
    if (w) w(m); else msgs.push(m);
  });
  ws.on('error', () => {});
  const closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  const opened = new Promise((res) => {
    ws.once('open', () => res({ open: true }));
    ws.once('unexpected-response', (req, r) => { res({ status: r.statusCode }); r.resume(); req.destroy(); });
    ws.once('error', (e) => res({ error: e.message }));
  });
  const next = (ms = 2000) => msgs.length
    ? Promise.resolve(msgs.shift())
    : new Promise((res, rej) => {
      const t = setTimeout(() => { waiters.splice(waiters.indexOf(done), 1); rej(new Error('届かない')); }, ms);
      const done = (m) => { clearTimeout(t); res(m); };
      waiters.push(done);
    });
  return {
    ws, opened, closed, msgs, next,
    json: async (ms) => JSON.parse((await next(ms)).data.toString('utf8')),
    send: (x, opts) => ws.send(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x), opts),
    /** ms 以内に閉じたら close の情報、閉じなければ null。 */
    closedWithin: (ms = 2000) => Promise.race([closed, sleep(ms).then(() => null)]),
  };
}

const hostHeaders = (hostId, ip, secret = SECRET) => ({ authorization: `Bearer ${secret}`, 'x-pleiad-host': hostId, 'x-forwarded-for': ip });

/** 制御用の接続を張って sync する。 */
async function host(port, hostId, devices = [], ip = newIp()) {
  const c = client(port, '/v1/host', hostHeaders(hostId, ip));
  await c.opened;
  c.send({ type: 'sync', devices });
  await sleep(60);   // sync は別の接続なので、端末より先に中継へ届いたことを待つ
  c.hostId = hostId;
  c.ip = ip;
  return c;
}

function device(port, hostId, deviceId, token, ip = newIp()) {
  return client(port, '/v1/device', { authorization: `Bearer ${token}`, 'x-pleiad-host': hostId, 'x-pleiad-device': deviceId, 'x-forwarded-for': ip });
}

function pairer(port, hostId, ticket, ip = newIp()) {
  return client(port, '/v1/device', { 'x-pleiad-host': hostId, 'x-pleiad-pairing': ticket, 'x-forwarded-for': ip });
}

/** 端末をつなぎ、ホストが incoming を受けて accept を張るところまで。 */
async function connectPair(port, ctl, deviceId, token) {
  const dev = device(port, ctl.hostId, deviceId, token);
  await dev.opened;
  const inc = await ctl.json();
  const acc = client(port, `/v1/host/accept?conn=${inc.conn}`, hostHeaders(ctl.hostId, ctl.ip));
  await acc.opened;
  return { dev, acc, inc };
}

const closeAll = (...cs) => { for (const c of cs) c?.ws.terminate(); };

export default async function (t) {
  // ── 設定 ──
  let threw = false;
  try { createRelay({ enrollSecret: '' }); } catch { threw = true; }
  t.ok('登録用の秘密が無ければ起動しない', threw);
  threw = false;
  try { createRelay({ enrollSecret: 'short' }); } catch { threw = true; }
  t.ok('短い登録用の秘密では起動しない', threw);
  const cfg = configFromEnv({ RELAY_ENROLL_SECRET: SECRET });
  t.ok('環境変数の既定は §5.4 の表のとおり',
    cfg.port === 8080 && cfg.maxHosts === 8 && cfg.maxDevices === 16 && cfg.maxConnsPerHost === 32 && cfg.maxConnsPerDevice === 4
    && cfg.maxFrameBytes === 66000 && cfg.maxBufferBytes === 8388608 && cfg.pairingTtlMs === 300000 && cfg.trustProxy === true,
    JSON.stringify(cfg));
  threw = false;
  try { configFromEnv({ RELAY_ENROLL_SECRET: SECRET, RELAY_MAX_HOSTS: 'abc' }); } catch { threw = true; }
  t.ok('数でない上限は起動時に弾く', threw);

  const { relay, port } = await startRelay();
  try {
    // ── /healthz と知らない口 ──
    const hz = await fetch(`http://127.0.0.1:${port}/healthz`);
    t.ok('/healthz は 200 ok', hz.status === 200 && (await hz.text()) === 'ok');
    t.ok('ほかのパスは 404', (await fetch(`http://127.0.0.1:${port}/`)).status === 404);
    const stray = client(port, '/v1/other', hostHeaders(newHostId(), newIp()));
    t.ok('知らない WebSocket の口は Upgrade せずに 404', (await stray.opened).status === 404);

    // ── ホストの登録 ──
    const hA = newHostId();
    const noSecret = client(port, '/v1/host', { 'x-pleiad-host': hA, 'x-forwarded-for': newIp() });
    t.ok('登録用の秘密なしのホストは 4401', (await noSecret.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const badSecret = client(port, '/v1/host', hostHeaders(hA, newIp(), SECRET + 'x'));
    t.ok('違う登録用の秘密は 4401', (await badSecret.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const badId = client(port, '/v1/host', hostHeaders('not-a-host-id', newIp()));
    t.ok('hostId の形が違えば 4400', (await badId.closedWithin())?.code === CLOSE.BAD_REQUEST);

    const tA = newToken();
    const early = device(port, hA, 'devA', tA.token);
    t.ok('ホストが居なければ端末は 4404', (await early.closedWithin())?.code === CLOSE.NOT_FOUND);

    const ctlA = await host(port, hA, [{ id: 'devA', tokenHash: tA.hash }]);
    t.ok('正しい登録用の秘密のホストはつながったまま', ctlA.ws.readyState === WebSocket.OPEN && relay.stats().hosts >= 1);

    // ── 端末の照合と中継 ──
    const wrong = device(port, hA, 'devA', newToken().token);
    t.ok('違うトークンの端末は 4401', (await wrong.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const unknown = device(port, hA, 'devX', tA.token);
    t.ok('登録されていない deviceId は 4401', (await unknown.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const noAuth = client(port, '/v1/device', { 'x-pleiad-host': hA, 'x-pleiad-device': 'devA', 'x-forwarded-for': newIp() });
    t.ok('トークンなしの端末は 4401', (await noAuth.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    ctlA.msgs.length = 0;   // 失敗した端末の分は incoming を出していないはず

    const dev = device(port, hA, 'devA', tA.token);
    await dev.opened;
    const early1 = crypto.randomBytes(1000);
    dev.send(early1);   // accept より前に送った分（Noise のメッセージ 1）も失わない
    const inc = await ctlA.json();
    t.ok('照合が通るとホストに incoming { conn, deviceId }', inc.type === 'incoming' && inc.deviceId === 'devA' && typeof inc.conn === 'string', JSON.stringify(inc));
    const acc = client(port, `/v1/host/accept?conn=${inc.conn}`, hostHeaders(hA, ctlA.ip));
    await acc.opened;
    const got1 = await acc.next();
    t.ok('accept 前に端末が送った分がホストに届く', got1.isBinary && got1.data.equals(early1));
    const up = crypto.randomBytes(60 * 1024);
    dev.send(up);
    const gotUp = await acc.next();
    t.ok('端末→ホストのバイト列がそのまま届く', gotUp.isBinary && gotUp.data.equals(up));
    const down = crypto.randomBytes(65519);
    acc.send(down);
    const gotDown = await dev.next();
    t.ok('ホスト→端末のバイト列がそのまま届く', gotDown.isBinary && gotDown.data.equals(down));
    acc.send('text frame');
    const gotText = await dev.next();
    t.ok('文字のメッセージは文字のまま届く', !gotText.isBinary && gotText.data.toString() === 'text frame');
    const dup = client(port, `/v1/host/accept?conn=${inc.conn}`, hostHeaders(hA, ctlA.ip));
    t.ok('同じ conn への 2 本目の accept は 4404', (await dup.closedWithin())?.code === CLOSE.NOT_FOUND);
    dev.ws.close(4000, 'bye');
    t.ok('端末が閉じるとホストのデータ用の接続も同じ code で閉じる', (await acc.closedWithin())?.code === 4000);
    const closedMsg = await ctlA.json();
    t.ok('ホストの制御用の接続に closed { conn }', closedMsg.type === 'closed' && closedMsg.conn === inc.conn);

    // ── 行き先の固定（別のホストへは届かない） ──
    const hB = newHostId();
    const tB = newToken();
    const ctlB = await host(port, hB, [{ id: 'devB', tokenHash: tB.hash }]);
    const cross = device(port, hB, 'devA', tA.token);
    t.ok('A の端末が B を名乗っても 4401', (await cross.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const cross2 = device(port, hB, 'devB', tA.token);
    t.ok('A のトークンで B の deviceId を名乗っても 4401', (await cross2.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const devA2 = device(port, hA, 'devA', tA.token);
    await devA2.opened;
    const incA2 = await ctlA.json();
    await sleep(50);
    t.ok('A の端末の incoming は B に届かない', ctlB.msgs.length === 0);
    const steal = client(port, `/v1/host/accept?conn=${incA2.conn}`, hostHeaders(hB, ctlB.ip));
    t.ok('B のホストは A の conn を accept できない（4404）', (await steal.closedWithin())?.code === CLOSE.NOT_FOUND);
    const stealNoSecret = client(port, `/v1/host/accept?conn=${incA2.conn}`, { 'x-pleiad-host': hA, 'x-forwarded-for': newIp() });
    t.ok('登録用の秘密なしの accept は 4401', (await stealNoSecret.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const accA2 = client(port, `/v1/host/accept?conn=${incA2.conn}`, hostHeaders(hA, ctlA.ip));
    await accA2.opened;
    devA2.send(Buffer.from('still mine'));
    t.ok('奪われかけた conn も本来のホストにつながる', (await accA2.next()).data.toString() === 'still mine');

    // ── 取り消し（sync・revoke） ──
    ctlA.msgs.length = 0;
    ctlA.send({ type: 'sync', devices: [] });
    t.ok('sync で消えた端末のつながり中の接続は 4401 で切れる', (await devA2.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    t.ok('ホスト側のデータ用の接続も切れる', (await accA2.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    await sleep(30);
    const again = device(port, hA, 'devA', tA.token);
    t.ok('取り消し後の端末は 4401', (await again.closedWithin())?.code === CLOSE.UNAUTHORIZED);

    const tA3 = newToken();
    ctlA.send({ type: 'allow', id: 'devA3', tokenHash: tA3.hash });
    await sleep(50);
    ctlA.msgs.length = 0;
    const p3 = await connectPair(port, ctlA, 'devA3', tA3.token);
    t.ok('allow で足した端末はつながる', p3.inc.deviceId === 'devA3');
    ctlA.send({ type: 'revoke', id: 'devA3' });
    t.ok('revoke でその端末の接続が 4401 で切れる', (await p3.dev.closedWithin())?.code === CLOSE.UNAUTHORIZED);

    const tA4 = newToken();
    ctlA.send({ type: 'allow', id: 'devA4', tokenHash: tA4.hash });
    await sleep(50);
    ctlA.msgs.length = 0;
    const p4 = await connectPair(port, ctlA, 'devA4', tA4.token);
    ctlA.send({ type: 'allow', id: 'devA4', tokenHash: newToken().hash });
    t.ok('トークンを差し替えると古いトークンの接続は切れる', (await p4.dev.closedWithin())?.code === CLOSE.UNAUTHORIZED);

    // ── ペアリングの入場券 ──
    const ticketRaw = crypto.randomBytes(32);
    const ticket = ticketRaw.toString('base64url');
    const ticketHash = crypto.createHash('sha256').update(ticketRaw).digest('hex');
    const noTicket = pairer(port, hB, ticket);
    t.ok('入場券を登録する前は 4401', (await noTicket.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    ctlB.msgs.length = 0;
    ctlB.send({ type: 'pairing', ticketHash, ttlMs: 60_000 });
    await sleep(50);
    const pr = pairer(port, hB, ticket);
    await pr.opened;
    const pinc = await ctlB.json();
    t.ok('入場券が合えば incoming { conn, pairing: true }', pinc.type === 'incoming' && pinc.pairing === true && !('deviceId' in pinc), JSON.stringify(pinc));
    const pacc = client(port, `/v1/host/accept?conn=${pinc.conn}`, hostHeaders(hB, ctlB.ip));
    await pacc.opened;
    pr.send(Buffer.from([1, 2, 3]));
    t.ok('ペアリングの接続もバイト列を流す', (await pacc.next()).data.equals(Buffer.from([1, 2, 3])));
    const reuse = pairer(port, hB, ticket);
    t.ok('入場券は 1 回きり（2 回目は 4401）', (await reuse.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    const otherHost = pairer(port, hA, ticket);
    t.ok('別のホスト宛てには使えない', (await otherHost.closedWithin())?.code === CLOSE.UNAUTHORIZED);
    closeAll(pr, pacc);

    // ── ホストの張り直し ──
    const tB2 = newToken();
    ctlB.ws.close();
    await ctlB.closed;
    await sleep(30);
    const gone = device(port, hB, 'devB', tB.token);
    t.ok('制御用の接続が切れたホストの端末は 4404', (await gone.closedWithin())?.code === CLOSE.NOT_FOUND);
    const ipB2 = newIp();
    const ctlB2 = client(port, '/v1/host', hostHeaders(hB, ipB2));
    await ctlB2.opened;
    ctlB2.hostId = hB;
    ctlB2.ip = ipB2;
    await sleep(30);
    const beforeSync = device(port, hB, 'devB', tB.token);
    t.ok('張り直して sync する前は 4404（4401 にしない）', (await beforeSync.closedWithin())?.code === CLOSE.NOT_FOUND);
    ctlB2.send({ type: 'sync', devices: [{ id: 'devB', tokenHash: tB.hash }, { id: 'devB2', tokenHash: tB2.hash }] });
    await sleep(60);
    const pB = await connectPair(port, ctlB2, 'devB', tB.token);
    pB.dev.send(Buffer.from('back'));
    t.ok('張り直しと sync で照合が戻る', (await pB.acc.next()).data.toString() === 'back');

    const ctlB3 = client(port, '/v1/host', hostHeaders(hB, newIp()));
    await ctlB3.opened;
    t.ok('同じ hostId の 2 本目の制御接続で古い方は 4409', (await ctlB2.closedWithin())?.code === CLOSE.REPLACED);
    pB.dev.send(Buffer.from('kept'));
    t.ok('制御用の接続が替わってもつながり中のデータは流れ続ける', (await pB.acc.next()).data.toString() === 'kept');
    ctlB3.send({ type: 'sync', devices: [{ id: 'devB2', tokenHash: tB2.hash }] });
    t.ok('新しい制御接続の sync に無い端末は切れる', (await pB.dev.closedWithin())?.code === CLOSE.UNAUTHORIZED);

    // ── 大きさ ──
    ctlA.msgs.length = 0;
    const tBig = newToken();
    ctlA.send({ type: 'allow', id: 'big', tokenHash: tBig.hash });
    await sleep(50);
    const pBig = await connectPair(port, ctlA, 'big', tBig.token);
    const atLimit = crypto.randomBytes(66000);
    pBig.dev.send(atLimit);
    t.ok('66,000 バイトちょうどは通る', (await pBig.acc.next()).data.equals(atLimit));
    pBig.dev.send(crypto.randomBytes(66001));
    t.ok('66,000 バイトを超えるメッセージで切れる（1009）', (await pBig.dev.closedWithin())?.code === 1009);
    t.ok('相手側も閉じる', (await pBig.acc.closedWithin()) != null);
    ctlA.send(JSON.stringify({ type: 'x', pad: 'a'.repeat(70000) }));
    t.ok('制御用の接続にも同じ上限（1009）', (await ctlA.closedWithin())?.code === 1009);

    closeAll(ctlB3, ctlA);
  } finally {
    await relay.close();
  }

  // ── 時間: accept が来ない・ping に応えない ──
  {
    const { relay, port } = await startRelay({ acceptTimeoutMs: 200, pingIntervalMs: 100 });
    try {
      const hostId = newHostId();
      const tk = newToken();
      const ctl = await host(port, hostId, [{ id: 'd', tokenHash: tk.hash }]);
      const dev = device(port, hostId, 'd', tk.token);
      await dev.opened;
      const inc = await ctl.json();
      t.ok('accept が来なければ 4408 で切る', (await dev.closedWithin(1500))?.code === CLOSE.TIMEOUT);
      const cl = await ctl.json();
      t.ok('ホストにも closed が届く', cl.type === 'closed' && cl.conn === inc.conn);
      const late = client(port, `/v1/host/accept?conn=${inc.conn}`, hostHeaders(hostId, ctl.ip));
      t.ok('遅れた accept は 4404', (await late.closedWithin())?.code === CLOSE.NOT_FOUND);

      const mute = client(port, '/v1/host', hostHeaders(newHostId(), newIp()), { autoPong: false });
      await mute.opened;
      t.ok('ping に 2 回応えない接続は捨てる', (await mute.closedWithin(1500)) != null);
      t.ok('ping に応える接続は残る', ctl.ws.readyState === WebSocket.OPEN);
      closeAll(ctl);
    } finally {
      await relay.close();
    }
  }

  // ── 数の上限 ──
  {
    const { relay, port } = await startRelay({ maxHosts: 2, maxDevices: 2, maxConnsPerHost: 5, maxConnsPerDevice: 4 });
    try {
      const h1 = await host(port, newHostId());
      const h2id = newHostId();
      const h2 = await host(port, h2id);
      const h3 = client(port, '/v1/host', hostHeaders(newHostId(), newIp()));
      t.ok('ホスト数の上限を超えると 4429', (await h3.closedWithin())?.code === CLOSE.LIMIT);
      const k = [newToken(), newToken(), newToken()];
      const h2b = await host(port, h2id, k.map((x, i) => ({ id: `d${i}`, tokenHash: x.hash })));
      t.ok('上限に達していても同じ hostId の張り直しはできる', h2b.ws.readyState === WebSocket.OPEN && (await h2.closedWithin())?.code === CLOSE.REPLACED);
      const over = device(port, h2id, 'd2', k[2].token);
      t.ok('ホストあたりの端末数を超えた分は登録されない（4401）', (await over.closedWithin())?.code === CLOSE.UNAUTHORIZED);

      const opened = [];
      for (let i = 0; i < 4; i++) { const d = device(port, h2id, 'd0', k[0].token); await d.opened; opened.push(d); }
      const fifth = device(port, h2id, 'd0', k[0].token);
      t.ok('端末あたりの同時接続の上限を超えると 4429', (await fifth.closedWithin())?.code === CLOSE.LIMIT);
      const other = device(port, h2id, 'd1', k[1].token);
      await other.opened;
      opened.push(other);
      const sixth = device(port, h2id, 'd1', k[1].token);
      t.ok('ホストあたりの同時接続の上限を超えると 4429', (await sixth.closedWithin())?.code === CLOSE.LIMIT);
      closeAll(h1, h2b, ...opened);
    } finally {
      await relay.close();
    }
  }

  // ── 背圧: 相手が読まないと溜める量に上限 ──
  {
    const { relay, port } = await startRelay({ maxBufferBytes: 256 * 1024 });
    try {
      const hostId = newHostId();
      const tk = newToken();
      const ctl = await host(port, hostId, [{ id: 'd', tokenHash: tk.hash }]);

      const dev0 = device(port, hostId, 'd', tk.token);
      await dev0.opened;
      await ctl.json();
      const chunk = crypto.randomBytes(60 * 1024);
      for (let i = 0; i < 6; i++) dev0.send(chunk);
      t.ok('accept 前に溜める量も上限で切る（4413）', (await dev0.closedWithin())?.code === CLOSE.OVERFLOW);
      await ctl.json();

      const { dev, acc } = await connectPair(port, ctl, 'd', tk.token);
      acc.ws.pause();   // ホストが読まない
      let result = null;
      dev.closed.then((c) => { result = c; });
      for (let i = 0; i < 3000 && !result; i++) {
        if (dev.ws.readyState === WebSocket.OPEN) dev.send(chunk);
        if (i % 8 === 0) await sleep(5);
      }
      await dev.closedWithin(3000);
      t.ok('相手側に溜まる量が上限を超えた接続は切る（4413）', result?.code === CLOSE.OVERFLOW, JSON.stringify(result));
      acc.ws.resume();
      closeAll(ctl, acc);
    } finally {
      await relay.close();
    }
  }

  // ── 認証の失敗の遮断と、ペアリングの試行の上限 ──
  {
    const { relay, port } = await startRelay();
    try {
      const hostId = newHostId();
      const ctl = await host(port, hostId);
      const badIp = newIp();
      for (let i = 0; i < 10; i++) {
        const c = client(port, '/v1/host', hostHeaders(hostId, badIp, 'x'.repeat(40)));
        await c.closedWithin();
      }
      const blockedTry = client(port, '/v1/host', hostHeaders(hostId, badIp));
      t.ok('IP ごとに 10 回失敗すると、正しい秘密でも 429 で Upgrade しない', (await blockedTry.opened).status === 429);
      const blockedDev = pairer(port, hostId, 'x', badIp);
      t.ok('遮断はどの口にも効く', (await blockedDev.opened).status === 429);
      const hz = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-forwarded-for': badIp } });
      t.ok('/healthz は遮断しない', hz.status === 200);
      t.ok('制御用の接続は巻き込まれない', ctl.ws.readyState === WebSocket.OPEN);
      t.ok('別の IP は遮断されない', ctl.ws.readyState === WebSocket.OPEN && relay.stats().blocked === 1);

      const raw = crypto.randomBytes(32);
      ctl.send({ type: 'pairing', ticketHash: crypto.createHash('sha256').update(raw).digest('hex'), ttlMs: 60_000 });
      await sleep(50);
      for (let i = 0; i < 5; i++) {
        const c = pairer(port, hostId, crypto.randomBytes(32).toString('base64url'));
        await c.closedWithin();
      }
      const sixth = pairer(port, hostId, raw.toString('base64url'));
      t.ok('ペアリングの試行はホストごとに 1 分 5 回まで（6 回目は正しい入場券でも 4429）', (await sixth.closedWithin())?.code === CLOSE.LIMIT);
      closeAll(ctl);
    } finally {
      await relay.close();
    }
  }

  // ── 入場券の寿命は中継の上限で頭打ち ──
  {
    const { relay, port } = await startRelay({ pairingTtlMs: 150 });
    try {
      const hostId = newHostId();
      const ctl = await host(port, hostId);
      const raw = crypto.randomBytes(32);
      ctl.send({ type: 'pairing', ticketHash: crypto.createHash('sha256').update(raw).digest('hex'), ttlMs: 60_000 });
      await sleep(300);
      const late = pairer(port, hostId, raw.toString('base64url'));
      t.ok('期限が切れた入場券は 4401（ホストの指定より中継の上限が勝つ）', (await late.closedWithin())?.code === CLOSE.UNAUTHORIZED);
      closeAll(ctl);
    } finally {
      await relay.close();
    }
  }
}
