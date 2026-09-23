// 試験用の端末（docs/remote.md §3.3・§4）。core/remote/ の Noise・チャネル・ペアリングの取り決めをそのまま使い、
// 中継を通ってホストにつなぐ。デスクトップ版の端末内プロキシ（#14）の代わりに、試験から直接ストリームを開く。
//
//   const p = pairDevice({ payload, name: 'Pixel 9', platform: 'android' });
//   const code = await p.code;            // ホストの承認待ちに出る確認コードと同じはず
//   const creds = await p.result;         // 承認されたら { hostId, hostPublicKey, relayUrl, deviceId, token, hostName, keyPair }
//   const d = await connectDevice(creds);
//   await d.get('/');                     // { status, headers, body } か { reset: code }
//   const w = await d.ws('/ws');          // { accepted, status?, messages, next(), send(), close() }
import WebSocket from 'ws';
import { Handshake, generateKeyPair, prologueFor, derivePairing, confirmationCode } from '../../core/remote/noise.mjs';
import { Channel } from '../../core/remote/channel.mjs';
import { parsePairingPayload, relayWsUrl } from '../../core/remote/pairing.mjs';

function openRelay(url, headers) {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: 70_000 });
  const closed = new Promise(res => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  ws.on('error', () => {});
  const opened = new Promise(res => {
    setTimeout(() => res({ error: 'open timeout' }), 10_000).unref();
    ws.once('open', () => res({ open: true }));
    ws.once('unexpected-response', (req, r) => { res({ status: r.statusCode }); r.resume(); req.destroy(); });
    ws.once('error', e => res({ error: e.message }));
  });
  // 届いた順に溜める。ハンドシェイクのメッセージ 2 と HELLO が同じ区切りで届いても取りこぼさない
  const inbox = [];
  const waiters = [];
  let sink = null;
  ws.on('message', data => {
    const buf = Buffer.from(data);
    if (sink) return sink(buf);
    const w = waiters.shift();
    if (w) w(buf); else inbox.push(buf);
  });
  let isClosed = null;
  closed.then(c => { isClosed = c; for (const w of waiters.splice(0)) w(null, c); });
  /** 次の 1 通。閉じられたら reject（closeCode 付き）。 */
  const next = (ms = 10_000) => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    const fail = c => reject(Object.assign(new Error(`端末: 閉じられた（${c.code}）`), { closeCode: c.code }));
    if (isClosed) return fail(isClosed);
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('端末: メッセージが届かない')); }, ms);
    const w = (buf, c) => { clearTimeout(timer); if (buf) resolve(buf); else fail(c); };
    waiters.push(w);
  });
  /** 以後のメッセージを fn へ（溜まっていた分から順に）。 */
  const drainTo = fn => { sink = fn; for (const b of inbox.splice(0)) fn(b); };
  return { ws, closed, opened, next, drainTo };
}

/**
 * QR の文字列でペアリングする。code は確認コード（ハンドシェイクのあとに決まる）、result は承認の結果。
 * 断られたら result は { denied: true, type } で解決する。つながらなければ reject（closeCode 付き）。
 */
export function pairDevice({ payload, name = 'test device', platform = 'desktop', app = 'test', keyPair = generateKeyPair(), timeoutMs = 30_000 }) {
  const p = parsePairingPayload(payload);
  const { psk, ticket } = derivePairing(p.secret);
  let codeResolve, codeReject;
  const code = new Promise((res, rej) => { codeResolve = res; codeReject = rej; });
  code.catch(() => {});
  const result = (async () => {
    const { ws, opened, next } = openRelay(relayWsUrl(p.relayUrl, '/v1/device'), {
      'x-pleiad-host': p.hostId, 'x-pleiad-pairing': ticket.toString('base64url'),
    });
    try {
      const o = await opened;
      if (!o.open) throw new Error(`端末: 中継につながらない ${JSON.stringify(o)}`);
      const hs = new Handshake({ pattern: 'IKpsk2', initiator: true, prologue: prologueFor(p.hostId), staticKey: keyPair, remoteStatic: p.publicKey, psk });
      ws.send(hs.writeMessage(Buffer.from(JSON.stringify({ proto: 1, name, platform, app }))));
      hs.readMessage(await next());
      const transport = hs.split();
      codeResolve(confirmationCode(hs.handshakeHash));
      ws.send(transport.encrypt(Buffer.from(JSON.stringify({ type: 'pair' }))));
      const msg = JSON.parse(transport.decrypt(await next(timeoutMs)).toString('utf8'));
      ws.close(1000);
      if (msg.type !== 'approved') return { denied: true, type: msg.type };
      return { hostId: p.hostId, hostPublicKey: p.publicKey, relayUrl: p.relayUrl, deviceId: msg.deviceId, token: msg.token, hostName: msg.hostName, keyPair };
    } catch (e) {
      codeReject(e);
      ws.terminate();
      throw e;
    }
  })();
  return { code, result };
}

/**
 * ペアリング済みの資格情報でつなぐ。ハンドシェイクと HELLO まで済んだら解決する。
 * つながらなければ reject（closeCode に中継かホストの close code）。
 */
export async function connectDevice(creds, { name = 'test device', app = 'test', helloTimeoutMs = 10_000 } = {}) {
  const { ws, closed, opened, next, drainTo } = openRelay(relayWsUrl(creds.relayUrl, '/v1/device'), {
    authorization: `Bearer ${creds.token}`, 'x-pleiad-host': creds.hostId, 'x-pleiad-device': creds.deviceId,
  });
  const o = await opened;
  if (!o.open) throw Object.assign(new Error(`端末: 中継につながらない ${JSON.stringify(o)}`), { status: o.status });
  const hs = new Handshake({ pattern: 'IK', initiator: true, prologue: prologueFor(creds.hostId), staticKey: creds.keyPair, remoteStatic: creds.hostPublicKey });
  ws.send(hs.writeMessage(Buffer.from(JSON.stringify({ proto: 1, name, app }))));
  try { hs.readMessage(await next()); }
  catch (e) { ws.terminate(); throw e; }
  const ch = new Channel({ role: 'device', transport: hs.split(), send: b => ws.send(b), hello: { app, shell: 'desktop' }, bufferedAmount: () => ws.bufferedAmount });
  // 聞き手を先に付けてから溜まった分を流す。メッセージ 2 と HELLO が同じ読み出しで届くと、
  // drainTo の中で HELLO が同期的に処理されるため、後から付けると 'hello' を取りこぼして待ち続ける
  let helloTimer;
  const hello = new Promise((res, rej) => {
    ch.once('hello', res);
    ch.once('close', err => rej(Object.assign(err ?? new Error('チャネルが閉じた'), { closeCode: err?.closeCode })));
    helloTimer = setTimeout(() => rej(new Error('端末: HELLO が届かない')), helloTimeoutMs);
  });
  hello.catch(() => {});
  ws.on('close', () => ch.close());
  drainTo(b => ch.receive(b));
  ch.start();
  let peerHello;
  try { peerHello = await hello; }
  catch (e) {
    const c = await Promise.race([closed, new Promise(r => setTimeout(r, 200, null))]);
    if (c) e.closeCode ??= c.code;
    ch.close();
    ws.terminate();
    throw e;
  } finally { clearTimeout(helloTimer); }

  return {
    channel: ch,
    ws,
    closed,
    hello: peerHello,
    /** HTTP の要求 1 つ。{ status, headers, body } か、捨てられたら { reset }。 */
    get(path, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`端末: ${method} ${path} の応答が来ない`)), timeoutMs);
        const done = resolve;
        resolve = v => { clearTimeout(t); done(v); };
        const s = ch.openHttp({ method, path, headers });
        const parts = [];
        let head = null;
        s.on('response', h => { head = h; });
        s.on('data', (chunk, release) => { parts.push(Buffer.from(chunk)); release(); });
        s.on('end', () => resolve({ status: head?.status, headers: head?.headers ?? {}, body: Buffer.concat(parts) }));
        s.on('reset', code => resolve({ reset: code }));
        s.end(body ?? undefined).catch(() => {});
      });
    },
    /** WebSocket を 1 本。受け付けられたら accepted: true。 */
    ws(path, { protocols = [], timeoutMs = 10_000 } = {}) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`端末: WS ${path} の受け付けが来ない`)), timeoutMs);
        const done = resolve;
        resolve = v => { clearTimeout(t); done(v); };
        const s = ch.openWs({ path, protocols });
        const messages = [];
        const waiters = [];
        s.on('message', (data, text, release) => {
          const m = text ? data.toString('utf8') : Buffer.from(data);
          release();
          const w = waiters.shift();
          if (w) w(m); else messages.push(m);
        });
        const remoteClose = new Promise(res => s.on('close', (code, reason) => { s.close(code, reason).catch(() => {}); res({ code, reason }); }));
        const api = {
          accepted: true, stream: s, messages, remoteClose,
          next(ms = 10_000) {
            if (messages.length) return Promise.resolve(messages.shift());
            return new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('端末: WS のメッセージが届かない')), ms);
              waiters.push(m => { clearTimeout(t); res(m); });
            });
          },
          send: (data, opts) => s.send(data, opts),
          close: (code = 1000) => s.close(code),
        };
        s.on('accept', () => resolve(api));
        s.on('reject', status => resolve({ accepted: false, status }));
        s.on('reset', code => resolve({ accepted: false, reset: code }));
      });
    },
    close() { ch.close(); ws.close(1000); },
  };
}
