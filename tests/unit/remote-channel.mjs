// リモート接続のチャネル（core/remote/channel.mjs）。本物の Noise で暗号化し、メモリの中の管でつなぐ。
// 多数の同時ストリーム・背圧で送り手が止まること・窓より大きい本文・WebSocket の断片化・RESET・PING・GOAWAY・改ざん。
import crypto from 'node:crypto';
import { Handshake, generateKeyPair, prologueFor, MAX_MESSAGE } from '../../core/remote/noise.mjs';
import { Channel, STREAM_WINDOW, CHANNEL_WINDOW } from '../../core/remote/channel.mjs';
import { T, RESET_CODE, encodeFrame, json, u32 } from '../../core/remote/frames.mjs';

export const name = 'remote-channel';
export const title = 'リモート: ストリームの多重化・流量の制御・WebSocket の断片化・RESET・PING・GOAWAY';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));

async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(2);
  }
  return true;
}

function transports() {
  const host = generateKeyPair(), device = generateKeyPair();
  const d = new Handshake({ pattern: 'IK', initiator: true, prologue: prologueFor('h'), staticKey: device, remoteStatic: host.publicKey });
  const h = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor('h'), staticKey: host });
  h.readMessage(d.writeMessage());
  d.readMessage(h.writeMessage());
  return { td: d.split(), th: h.split() };
}

/**
 * 端末とホストのチャネルを、非同期に届けるメモリの管でつなぐ。
 * 管は向きごとに届けた量と最大の 1 通の大きさを数え、止める・落とす・書き換えることができる。
 */
function pair({ device = {}, host = {}, encrypt = true } = {}) {
  const { td, th } = transports();
  const wire = { toHost: { bytes: 0, frames: 0, max: 0, drop: false, held: null, mutate: null }, toDevice: { bytes: 0, frames: 0, max: 0, drop: false, held: null, mutate: null } };
  let dc, hc;
  const deliver = (dir, target) => bytes => {
    const w = wire[dir];
    w.bytes += bytes.length; w.frames++; w.max = Math.max(w.max, bytes.length);
    if (w.drop) return;
    const b = w.mutate ? w.mutate(Buffer.from(bytes)) : Buffer.from(bytes);
    if (w.held) { w.held.push(b); return; }
    setImmediate(() => target().receive(b));
  };
  dc = new Channel({ role: 'device', transport: encrypt ? td : null, send: deliver('toHost', () => hc), hello: { app: 'test', shell: 'desktop' }, pingIntervalMs: 0, ...device });
  hc = new Channel({ role: 'host', transport: encrypt ? th : null, send: deliver('toDevice', () => dc), hello: { app: 'test', hostName: 'h' }, pingIntervalMs: 0, ...host });
  return { dc, hc, wire, close() { dc.close(); hc.close(); } };
}

/** ホスト側: HTTP の要求ごとに fn(stream) を呼ぶ。 */
function serveHttp(hc, fn) {
  hc.on('stream', s => { if (s.kind === 'http') fn(s); });
}

/** 端末側: 1 本の GET を投げ、応答と本文を集める。release は hold が偽なら即座に返す。 */
function get(dc, path, { hold = false } = {}) {
  const s = dc.openHttp({ method: 'GET', path, headers: {} });
  s.end();
  const r = { s, head: null, chunks: [], releases: [], ended: false, finished: false, reset: null };
  s.on('response', h => { r.head = h; });
  s.on('data', (c, release) => { r.chunks.push(c); hold ? r.releases.push(release) : release(); });
  s.on('end', () => { r.ended = true; });
  s.on('finish', () => { r.finished = true; });
  s.on('reset', code => { r.reset = code; });
  r.body = () => Buffer.concat(r.chunks);
  r.received = () => r.chunks.reduce((n, c) => n + c.length, 0);
  return r;
}

export default async function (t) {
  // ── 基本の往復 ──
  {
    const p = pair();
    let hello = null;
    p.hc.on('hello', h => { hello = h; });
    serveHttp(p.hc, async s => {
      await s.respond({ status: 200, headers: { 'content-type': 'text/plain' } });
      await s.end(`path=${s.request.path}`);
    });
    p.dc.start(); p.hc.start();
    const r = get(p.dc, '/hello');
    await until(() => r.finished);
    t.ok('HTTP: 要求・応答・本文・半閉じが通り、両側のストリームが外れる',
      hello?.shell === 'desktop' && r.head?.status === 200 && r.body().toString() === 'path=/hello' && r.ended &&
      p.dc.streams.size === 0 && (await until(() => p.hc.streams.size === 0)));
    t.ok('端末のストリームは奇数', r.s.id === 1 && get(p.dc, '/b').s.id === 3);
    const rtt = await p.dc.ping();
    t.ok('PING に PONG が返る', typeof rtt === 'number' && rtt >= 0);
    p.close();
  }

  // ── 多数の同時ストリーム ──
  {
    const p = pair();
    const bodies = new Map();
    serveHttp(p.hc, async s => {
      const body = crypto.randomBytes(100_000 + Number(s.request.path.slice(1)) * 997);
      bodies.set(s.request.path, body);
      s.respond({ status: 200, headers: {} });
      await s.write(body.subarray(0, 30_000));
      await s.end(body.subarray(30_000));
    });
    p.dc.start(); p.hc.start();
    const rs = Array.from({ length: 64 }, (_, i) => get(p.dc, `/${i}`));
    let overflow = false;
    try { p.dc.openHttp({ method: 'GET', path: '/x', headers: {} }); } catch { overflow = true; }
    await until(() => rs.every(r => r.finished), 20000);
    t.ok('64 本を同時に流しても全部そろい、中身が混ざらない（約 9.5 MB）',
      rs.every(r => r.finished && r.body().equals(bodies.get(r.s.request.path))));
    t.ok('65 本目は開けない（同時ストリームの上限）', overflow);
    t.ok('どの暗号文も Noise の 1 通（65535 バイト）に収まる', p.wire.toDevice.max <= MAX_MESSAGE && p.wire.toHost.max <= MAX_MESSAGE, `max ${p.wire.toDevice.max}`);
    p.close();
  }

  // ── 背圧: 受け手が返さなければ送り手が止まる ──
  {
    const p = pair();
    const big = crypto.randomBytes(2 * 1024 * 1024);
    let written = false;
    serveHttp(p.hc, async s => {
      s.respond({ status: 200, headers: {} });
      await s.write(big);
      written = true;
      s.end();
    });
    p.dc.start(); p.hc.start();
    const r = get(p.dc, '/big', { hold: true });
    await until(() => r.received() >= STREAM_WINDOW);
    await sleep(50);
    t.ok('ストリームの窓（256 KiB）を使い切ると送り手の write が止まる',
      r.received() === STREAM_WINDOW && !written, `受け取り ${r.received()}`);
    // 半分だけ返すと、その分だけ進む
    const half = r.releases.splice(0, 2);
    half.forEach(f => f());
    const released = 2 * 61440;
    await until(() => r.received() >= STREAM_WINDOW + released);
    await sleep(30);
    t.ok('返した分だけ進み、それ以上は送られない', r.received() === STREAM_WINDOW + released && !written, `受け取り ${r.received()}`);
    // 以後は届いたそばから返す
    r.releases.splice(0).forEach(f => f());
    r.s.removeAllListeners('data');
    r.s.on('data', (c, release) => { r.chunks.push(c); release(); });
    await until(() => r.finished);
    t.ok('返し始めると最後まで届く（窓より大きい本文）', written && r.body().equals(big));
    p.close();
  }

  // ── チャネル全体の窓: 1 MiB ──
  {
    const p = pair();
    serveHttp(p.hc, async s => {
      s.respond({ status: 200, headers: {} });
      await s.end(crypto.randomBytes(512 * 1024));
    });
    p.dc.start(); p.hc.start();
    const rs = Array.from({ length: 8 }, (_, i) => get(p.dc, `/${i}`, { hold: true }));
    const total = () => rs.reduce((n, r) => n + r.received(), 0);
    await until(() => total() >= CHANNEL_WINDOW);
    await sleep(50);
    t.ok('全ストリームを合わせてもチャネルの窓（1 MiB）で止まる', total() === CHANNEL_WINDOW, `合計 ${total()}`);
    for (const r of rs) {
      r.releases.splice(0).forEach(f => f());
      r.s.removeAllListeners('data');
      r.s.on('data', (c, release) => { r.chunks.push(c); release(); });
    }
    await until(() => rs.every(r => r.finished), 10000);
    t.ok('返すと全部そろう', rs.every(r => r.received() === 512 * 1024));
    p.close();
  }

  // ── 窓より大きい本文を、下流が遅くても最後まで ──
  {
    const p = pair();
    const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
    serveHttp(p.hc, async s => { s.respond({ status: 200, headers: {} }); await s.end(big); });
    p.dc.start(); p.hc.start();
    const s = p.dc.openHttp({ method: 'GET', path: '/', headers: {} });
    s.end();
    const chunks = [];
    let done = false;
    // 下流に渡し終えるまで少し待ってから返す（ソケットの drain の真似）
    s.on('data', (c, release) => { chunks.push(c); setTimeout(release, 0); });
    s.on('finish', () => { done = true; });
    await until(() => done, 20000);
    t.ok('5 MB の本文（窓の 5 倍）が遅い下流でも崩れずに届く', Buffer.concat(chunks).equals(big));
    p.close();
  }

  // ── 中継への送り口が詰まったら止まる ──
  {
    let buffered = 10 * 1024 * 1024;
    const p = pair({ host: { bufferedAmount: () => buffered } });
    serveHttp(p.hc, async s => { s.respond({ status: 200, headers: {} }); await s.end(Buffer.alloc(100_000, 7)); });
    p.dc.start(); p.hc.start();
    const r = get(p.dc, '/');
    await until(() => p.hc.streams.size === 1);
    await sleep(50);
    let pong = false;
    p.hc.ping().then(() => { pong = true; });
    await until(() => pong, 1000);
    t.ok('送り口の bufferedAmount が 4 MiB を超えている間はストリームのフレームを送らない（チャネルの制御フレームは通る）',
      !r.head && r.received() === 0 && pong);
    buffered = 0;
    await until(() => r.finished);
    t.ok('空いたら続きを送る', r.head?.status === 200 && r.received() === 100_000);
    p.close();
  }

  // ── WebSocket ──
  {
    const p = pair();
    const hostSide = [];
    p.hc.on('stream', s => {
      if (s.kind !== 'ws') return;
      if (s.request.path !== '/ws') { s.reject(404); return; }
      s.accept();
      s.on('message', async (data, text, release) => {
        hostSide.push({ data, text });
        release();
        await s.send(data, { text });   // こだま
      });
      s.on('close', (code, reason) => s.close(code, reason));
    });
    p.dc.start(); p.hc.start();

    const ws = p.dc.openWs({ path: '/ws', protocols: [] });
    const got = [];
    let accepted = false, closed = null, finished = false;
    ws.on('accept', () => { accepted = true; });
    ws.on('message', (data, text, release) => { got.push({ data, text }); release(); });
    ws.on('close', (code, reason) => { closed = { code, reason }; });
    ws.on('finish', () => { finished = true; });

    const bigText = JSON.stringify({ kind: 'loadSession', blob: crypto.randomBytes(1_500_000).toString('base64') }); // 約 2 MB
    const bin = crypto.randomBytes(200_000);
    ws.send('{"kind":"hello"}');
    ws.send(bigText);
    ws.send(bin);
    ws.send(Buffer.alloc(0));
    await until(() => got.length === 4, 20000);
    t.ok('WS: 受け入れられ、窓より大きい文字のメッセージも 1 つに組み立てて渡る',
      accepted && hostSide[1]?.text && hostSide[1].data.toString() === bigText);
    t.ok('WS: 順序・文字 / バイナリの別・空のメッセージが保たれ、こだまも戻る',
      got.map(m => m.text).join() === 'true,true,false,false' && got[0].data.toString() === '{"kind":"hello"}' &&
      got[1].data.toString() === bigText && got[2].data.equals(bin) && got[3].data.length === 0);
    const frames = p.wire.toHost.frames;
    t.ok('WS: 大きいメッセージは複数のフレームに分かれて送られた', frames > Math.ceil(bigText.length / 61440));
    ws.close(1000, 'bye');
    await until(() => finished);
    t.ok('WS: close を交わすと両側のストリームが外れる',
      closed?.code === 1000 && closed.reason === 'bye' && p.dc.streams.size === 0 && (await until(() => p.hc.streams.size === 0)));

    const rej = p.dc.openWs({ path: '/nope', protocols: [] });
    let status = null, rejFinished = false;
    rej.on('reject', s => { status = s; });
    rej.on('finish', () => { rejFinished = true; });
    await until(() => rejFinished);
    t.ok('WS: 断られると WS_REJECT の状態が届き、ストリームは終わる', status === 404 && p.dc.streams.size === 0);
    p.close();
  }

  // ── WebSocket の上限 ──
  {
    const p = pair({ host: { maxWsMessage: 100_000 } });
    let hostReset = null;
    p.hc.on('stream', s => { s.accept(); s.on('reset', c => { hostReset = c; }); });
    p.dc.start(); p.hc.start();
    const ws = p.dc.openWs({ path: '/ws', protocols: [] });
    let devReset = null;
    ws.on('reset', (c, remote) => { devReset = { c, remote }; });
    ws.on('accept', () => ws.send(Buffer.alloc(300_000)).catch(() => {}));
    await until(() => devReset);
    t.ok('WS: 組み立ての上限を超えたメッセージは RESET TOO_LARGE で捨てる',
      hostReset === RESET_CODE.TOO_LARGE && devReset?.c === RESET_CODE.TOO_LARGE && devReset.remote);
    p.close();
  }

  // ── RESET ──
  {
    const p = pair();
    let writeErr = null, hostReset = null;
    serveHttp(p.hc, async s => {
      s.on('reset', (code, remote) => { hostReset = { code, remote }; });
      s.respond({ status: 200, headers: {} });
      if (s.request.path === '/cancel') {
        try { await s.write(Buffer.alloc(3 * 1024 * 1024)); } catch (e) { writeErr = e; }
      } else {
        await s.end(Buffer.alloc(2 * 1024 * 1024, 1));
      }
    });
    p.dc.start(); p.hc.start();
    const r = get(p.dc, '/cancel', { hold: true });
    await until(() => r.received() >= STREAM_WINDOW);
    r.s.reset(RESET_CODE.CANCEL);
    await until(() => writeErr);
    t.ok('RESET: 相手のストリームに届き、止まっていた write は失敗で返る',
      hostReset?.code === RESET_CODE.CANCEL && hostReset.remote && writeErr && p.dc.streams.size === 0 && p.hc.streams.size === 0);
    t.ok('RESET: 捨てたあとに release しても何も起きない', (() => { r.releases.forEach(f => f()); return !p.dc.closed; })());
    // 返していなかった分のチャネルの窓が戻っていること: 窓より大きい本文がまた通る
    const r2 = get(p.dc, '/after');
    await until(() => r2.finished, 10000);
    t.ok('RESET: 捨てたストリームの分のチャネルの窓は戻る（あとの 2 MB が通る）', r2.received() === 2 * 1024 * 1024);
    p.close();
  }

  // ── 受ける者が居ない・上限を超えた要求は REFUSED ──
  {
    const p = pair();
    p.dc.start(); p.hc.start();
    const r = get(p.dc, '/');
    await until(() => r.reset != null);
    t.ok('ホストに受ける者が居なければ RESET REFUSED', r.reset === RESET_CODE.REFUSED);
    p.close();
  }

  // ── GOAWAY ──
  {
    const p = pair();
    serveHttp(p.hc, () => {});
    p.dc.start(); p.hc.start();
    const r = get(p.dc, '/hang');
    let goaway = null, closeErr = null;
    p.dc.on('goaway', g => { goaway = g; });
    p.dc.on('close', e => { closeErr = e; });
    await until(() => p.hc.streams.size === 1);
    p.hc.goaway('revoked', 'この端末は取り消された');
    await until(() => closeErr);
    t.ok('GOAWAY: 相手に理由が届き、チャネルが閉じ、処理中のストリームは CHANNEL_CLOSED',
      goaway?.code === 'revoked' && closeErr.code === 'revoked' && closeErr.remote && p.hc.closed && r.reset === RESET_CODE.CHANNEL_CLOSED);
    let threw = false;
    try { p.dc.openHttp({ method: 'GET', path: '/', headers: {} }); } catch { threw = true; }
    t.ok('閉じたチャネルではストリームを開けない', threw);
  }

  // ── 版が合わない ──
  {
    const p = pair({ device: { hello: { app: 'x', proto: 2 } } });
    // proto は channel が 1 に上書きするので、生のフレームで送る
    let err = null;
    p.hc.on('close', e => { err = e; });
    p.hc.start();
    p.hc.receive(encodeFrame(T.HELLO, 0, json.encode({ proto: 2 })));  // 暗号化していないので復号で落ちる
    t.ok('暗号化されていないフレームは復号の失敗として閉じる', err?.code === 'decrypt');
    const q = pair({ encrypt: false });
    let qerr = null, dg = null;
    q.hc.on('close', e => { qerr = e; });
    q.dc.on('goaway', g => { dg = g; });
    q.dc.start(); q.hc.start();
    q.hc.receive(encodeFrame(T.HELLO, 0, json.encode({ proto: 2 })));
    await until(() => dg);
    t.ok('HELLO の proto が合わなければ GOAWAY version', qerr?.code === 'version' && dg?.code === 'version');
    p.close(); q.close();
  }

  // ── 決まりに反するフレーム ──
  {
    const cases = [
      ['最初が HELLO でない', [encodeFrame(T.PING, 0, Buffer.alloc(8))]],
      ['開かれていないストリームへの DATA', [encodeFrame(T.HELLO, 0, json.encode({ proto: 1 })), encodeFrame(T.DATA, 9, Buffer.from('x'))]],
      ['窓を超えた DATA', [encodeFrame(T.HELLO, 0, json.encode({ proto: 1 })), encodeFrame(T.HTTP_REQ, 1, json.encode({ method: 'GET', path: '/', headers: {} })),
        ...Array.from({ length: 5 }, () => encodeFrame(T.DATA, 1, Buffer.alloc(61440)))]],
      ['番号が戻るストリーム', [encodeFrame(T.HELLO, 0, json.encode({ proto: 1 })), encodeFrame(T.HTTP_REQ, 3, json.encode({ method: 'GET', path: '/', headers: {} })),
        encodeFrame(T.HTTP_REQ, 1, json.encode({ method: 'GET', path: '/', headers: {} }))]],
      ['WINDOW の増分 0', [encodeFrame(T.HELLO, 0, json.encode({ proto: 1 })), encodeFrame(T.WINDOW, 0, u32(0))]],
    ];
    const results = [];
    for (const [label, frames] of cases) {
      const sent = [];
      const hc = new Channel({ role: 'host', send: b => sent.push(b), pingIntervalMs: 0 });
      hc.on('stream', s => s.on('data', () => {}));   // 受けるが release しない（窓を返さない）
      let err = null;
      hc.on('close', e => { err = e; });
      hc.start();
      for (const f of frames) hc.receive(f);
      const goaway = sent.map(b => b[0]).includes(T.GOAWAY);
      results.push([label, err?.code === 'protocol' && goaway]);
    }
    const bad = results.filter(([, ok]) => !ok).map(([l]) => l);
    t.ok('決まりに反するフレームは GOAWAY protocol で閉じる（最初が HELLO でない・未開のストリーム・窓超え・番号の逆行・増分 0）', !bad.length, bad.join(', '));
  }

  // ── 改ざん ──
  {
    const p = pair();
    serveHttp(p.hc, async s => { s.respond({ status: 200, headers: {} }); await s.end('x'); });
    p.dc.start(); p.hc.start();
    let err = null;
    p.hc.on('close', e => { err = e; });
    await tick(); await tick();
    p.wire.toHost.mutate = b => { b[b.length - 1] ^= 0x80; return b; };
    get(p.dc, '/');
    await until(() => err);
    t.ok('通り道での改ざんは復号の失敗として検出し、何も送らずに閉じる', err?.code === 'decrypt' && p.hc.closed);
    p.close();
  }
  {
    const p = pair();
    p.dc.start(); p.hc.start();
    let err = null;
    p.hc.on('close', e => { err = e; });
    await tick(); await tick();
    p.wire.toHost.held = [];
    get(p.dc, '/a');
    get(p.dc, '/b');
    const [x, y] = p.wire.toHost.held;
    p.hc.receive(y);   // 順序を入れ替える
    p.hc.receive(x);
    t.ok('順序を入れ替えた暗号文も検出する', err?.code === 'decrypt');
    p.close();
  }

  // ── PING の打ち切り ──
  {
    const p = pair({ device: { pingIntervalMs: 15, pingMisses: 3 } });
    let err = null;
    p.dc.on('close', e => { err = e; });
    p.dc.start(); p.hc.start();
    await tick(); await tick();
    p.wire.toDevice.drop = true;   // ホストからの PONG が届かない
    await until(() => err, 2000);
    t.ok('PING に 3 回返らなければ timeout で閉じる', err?.code === 'timeout');
    p.close();
  }
}
