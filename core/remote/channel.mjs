// 暗号化チャネルの上のストリームの多重化（docs/remote.md §4）。
//
// 運び方には依存しない。暗号文を送る関数 `send(bytes)` を受け取り、届いた暗号文は `channel.receive(bytes)` に渡す。
// 端末内プロキシ（desktop/remote/、モバイル）とホストの接続口（core/remote/connector.mjs）が同じものを使う。
//
//   const ch = new Channel({ role: 'device', transport, send: b => ws.send(b), hello: { app, shell: 'desktop' } });
//   ws.on('message', b => ch.receive(b));
//   ch.start();
//   const s = ch.openHttp({ method: 'GET', path: '/', headers: {} }); s.end();
//   s.on('response', head => ...); s.on('data', (chunk, release) => { local.write(chunk) ? release() : local.once('drain', release) });
//
// 流量の制御（§4.3）: HTTP/2 と同じクレジット方式。DATA と WS_MSG の payload の分だけ窓を減らし、
// 受け側は**下流に渡し終えてから** release() で WINDOW を返す。制御フレームは数えない。
// 窓の初期値（ストリーム 256 KiB・チャネル 1 MiB）は取り決めの定数で、両側が同じ値を使う（交渉しない）。
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import {
  T, TYPE_NAMES, CHUNK, PROTO, RESET_CODE, FrameError, WsAssembler,
  encodeFrame, decodeFrame, json, u16, readU16, u32, readU32, encodeWsClose, decodeWsClose, encodeWsFragment,
} from './frames.mjs';

export const STREAM_WINDOW = 256 * 1024;
export const CHANNEL_WINDOW = 1024 * 1024;
export const MAX_STREAMS = 64;
export const PING_INTERVAL_MS = 20_000;
export const PING_MISSES = 3;
/** 中継への WebSocket の bufferedAmount がこれを超えたら全ストリームを止める。 */
export const MAX_BUFFERED = 4 * 1024 * 1024;
/** 組み立てる WebSocket の 1 メッセージの上限（loadSession の数 MB・添付 8MB の base64 に余裕を持たせる）。 */
export const MAX_WS_MESSAGE = 64 * 1024 * 1024;
const MAX_WINDOW = 2 ** 31 - 1;

export class ChannelError extends Error {
  /** code: 'protocol' | 'version' | 'decrypt' | 'timeout' | 'transport' | GOAWAY の code。remote: 相手から来た GOAWAY か。 */
  constructor(code, message, { remote = false } = {}) {
    super(message || code);
    this.code = code;
    this.remote = remote;
  }
}

class StreamResetError extends Error {
  constructor(code) {
    super(`ストリームが捨てられた（${code}）`);
    this.code = code;
  }
}

function toBytes(v) {
  if (v == null) return Buffer.alloc(0);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  throw new TypeError('バイト列か文字列を渡す');
}

/**
 * 1 本のストリーム（HTTP の要求 1 つ、または WebSocket の接続 1 本）。
 *
 * 出来事:
 *   'response' (head)                 HTTP_RES（端末側）
 *   'data'     (chunk, release)       本文の断片。下流に渡し終えたら release() を呼ぶ（呼ぶ者が居なければ即座に返す）
 *   'end'                              相手の向きの終わり
 *   'accept' / 'reject' (status)       WS_ACCEPT / WS_REJECT（端末側）
 *   'message'  (data, text, release)  組み立て済みの WebSocket のメッセージ。text なら data は UTF-8 の Buffer
 *   'close'    (code, reason)          相手の WS_CLOSE
 *   'reset'    (code, remote)          ストリームが捨てられた（相手の RESET・こちらの reset()・チャネルが閉じた）
 *   'finish'                           両方の向きが正常に終わり、チャネルから外れた
 */
export class Stream extends EventEmitter {
  constructor(channel, id, kind, request, incoming) {
    super();
    this.channel = channel;
    this.id = id;
    this.kind = kind;             // 'http' | 'ws'
    this.request = request;       // HTTP_REQ / WS_OPEN の JSON
    this.incoming = incoming;     // 相手が開いたストリームか
    this.response = null;         // HTTP_RES の JSON
    this.accepted = false;
    this.sendWindow = channel.streamWindow;
    this.recvWindow = channel.streamWindow;
    this.localDone = false;       // END / WS_CLOSE / WS_REJECT を積んだ
    this.remoteDone = false;      // END / WS_CLOSE / WS_REJECT を受けた
    this.destroyed = false;
    this.resetCode = null;
    this.queue = [];
    this.unreleased = 0;          // 受け取ったが release されていない量（チャネルの窓の分）
    this.assembler = kind === 'ws' ? new WsAssembler({ maxBytes: channel.maxWsMessage }) : null;
    this.pendingMsgBytes = 0;
  }

  get closed() { return this.destroyed || (this.localDone && this.remoteDone); }

  // ── 送る ──

  /** HTTP_RES（ホスト側）。 */
  respond(head) { this.#expect('http', this.incoming); return this.#ctl(T.HTTP_RES, json.encode(head)); }

  /** 本文の断片。窓が空くまで待ち、送り終えたら解決する（背圧）。 */
  write(data) {
    this.#expect('http');
    if (this.localDone) return Promise.reject(new Error('この向きは既に終わっている'));
    return this.#enqueue({ kind: 'data', data: toBytes(data), off: 0 });
  }

  /** この向きを終える（半閉じ）。data があれば先に送る。 */
  end(data) {
    this.#expect('http');
    if (this.localDone) return Promise.resolve();
    const p = data != null ? this.write(data) : null;
    const q = this.#ctl(T.END, null, s => { s.localDone = true; });
    this.localDone = true;
    return p ? Promise.all([p, q]).then(() => {}) : q;
  }

  /** WS_ACCEPT（ホスト側）。 */
  accept() { this.#expect('ws', this.incoming); return this.#ctl(T.WS_ACCEPT, null); }

  /** WS_REJECT（ホスト側）。このストリームは両方向とも終わる。 */
  reject(status = 502) {
    this.#expect('ws', this.incoming);
    if (this.localDone) return Promise.resolve();
    this.localDone = true;
    this.remoteDone = true;
    return this.#ctl(T.WS_REJECT, u16(status));
  }

  /** WebSocket の 1 メッセージ。60 KiB ごとの断片に分けて送り、送り終えたら解決する。 */
  send(data, { text = typeof data === 'string' } = {}) {
    this.#expect('ws');
    if (this.localDone) return Promise.reject(new Error('WebSocket は既に閉じている'));
    return this.#enqueue({ kind: 'ws', data: toBytes(data), off: 0, text, started: false });
  }

  /** WS_CLOSE。積んだメッセージを送り終えてから送る。相手の WS_CLOSE と揃ったらストリームは終わる。 */
  close(code = 1000, reason = '') {
    this.#expect('ws');
    if (this.localDone) return Promise.resolve();
    this.localDone = true;
    return this.#ctl(T.WS_CLOSE, encodeWsClose(code, reason));
  }

  /** RESET。積んだものを捨て、すぐに送る。 */
  reset(code = RESET_CODE.CANCEL) {
    if (this.destroyed) return;
    this.channel._sendNow(T.RESET, this.id, u16(code));
    this._destroy(code, false);
  }

  #expect(kind, incoming) {
    if (this.kind !== kind) throw new Error(`${this.kind} のストリームには使えない`);
    if (incoming === false) throw new Error('受けた側だけが使える');
  }

  #ctl(type, payload, after) {
    return this.#enqueue({ kind: 'ctl', type, payload, after });
  }

  #enqueue(item) {
    if (this.destroyed) return Promise.reject(new StreamResetError(this.resetCode));
    const p = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    this.queue.push(item);
    this.channel._pump();
    return p;
  }

  /** 先頭の 1 フレームを送れたら true。窓が足りなければ false。 */
  _sendOne() {
    const item = this.queue[0];
    if (!item || this.destroyed) return false;
    const ch = this.channel;
    if (item.kind === 'ctl') {
      ch._sendNow(item.type, this.id, item.payload);
      this.queue.shift();
      item.after?.(this);
      item.resolve();
      this._maybeFinish();
      return true;
    }
    const remaining = item.data.length - item.off;
    const avail = Math.min(this.sendWindow, ch.sendWindow);
    if (item.kind === 'data') {
      if (remaining === 0) { this.queue.shift(); item.resolve(); return true; }
      const n = Math.min(CHUNK, remaining, avail);
      if (n <= 0) return false;
      const chunk = item.data.subarray(item.off, item.off + n);
      this.sendWindow -= n;
      ch.sendWindow -= n;
      item.off += n;
      ch._sendNow(T.DATA, this.id, chunk);
    } else {
      // WS_MSG: 印の 1 バイトも窓に数える
      if (avail < 1) return false;
      const n = Math.min(CHUNK, remaining, avail - 1);
      if (n === 0 && remaining > 0) return false;
      const fin = n === remaining;
      const payload = encodeWsFragment(item.data.subarray(item.off, item.off + n), { text: item.text, fin });
      this.sendWindow -= payload.length;
      ch.sendWindow -= payload.length;
      item.off += n;
      ch._sendNow(T.WS_MSG, this.id, payload);
      if (!fin) return true;
    }
    if (item.off >= item.data.length) { this.queue.shift(); item.resolve(); }
    return true;
  }

  // ── 受ける ──

  /** 受け取った n バイトの窓を返す関数を作る。1 回だけ効く。 */
  _releaser(n) {
    this.unreleased += n;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.destroyed) return;   // 捨てたときにまとめて返してある
      this.unreleased -= n;
      this.channel._returnCredit(this, n);
    };
  }

  _onFlow(n) {
    if (n > this.recvWindow) throw new ChannelError('protocol', `stream ${this.id} の窓を超えた`);
    this.recvWindow -= n;
  }

  _destroy(code, remote) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resetCode = code;
    const err = new StreamResetError(code);
    for (const item of this.queue.splice(0)) item.reject(err);
    // 下流に渡していない分も、チャネルの窓は返す（ストリームの窓はもう要らない）
    if (this.unreleased > 0 && !this.channel.closed) this.channel._returnCredit(null, this.unreleased);
    this.unreleased = 0;
    this.channel._forget(this);
    if (this.listenerCount('reset')) this.emit('reset', code, remote);
  }

  _maybeFinish() {
    if (this.destroyed || !this.localDone || !this.remoteDone || this.queue.length) return;
    this.channel._forget(this);
    this.emit('finish');
  }
}

/**
 * 1 本の暗号化チャネル。
 *
 * 出来事:
 *   'hello'  (hello)        相手の HELLO（版が合ったあと）
 *   'stream' (stream)       相手が開いたストリーム（ホスト側）。聞く者が居なければ RESET REFUSED
 *   'goaway' ({ code, reason })
 *   'close'  (err | null)   チャネルが終わった。以後は何も送らない。運び手（WebSocket）を閉じるのは呼び側
 */
export class Channel extends EventEmitter {
  constructor({
    role, send, transport = null, hello = {},
    streamWindow = STREAM_WINDOW, channelWindow = CHANNEL_WINDOW, maxStreams = MAX_STREAMS,
    pingIntervalMs = PING_INTERVAL_MS, pingMisses = PING_MISSES,
    bufferedAmount = null, maxBuffered = MAX_BUFFERED, maxWsMessage = MAX_WS_MESSAGE,
  }) {
    super();
    if (role !== 'device' && role !== 'host') throw new TypeError("role は 'device' か 'host'");
    if (typeof send !== 'function') throw new TypeError('send(bytes) が要る');
    this.role = role;
    this.sendFn = send;
    this.transport = transport;
    this.hello = hello;
    this.streamWindow = streamWindow;
    this.channelWindow = channelWindow;
    this.maxStreams = maxStreams;
    this.pingIntervalMs = pingIntervalMs;
    this.pingMisses = pingMisses;
    this.bufferedAmount = bufferedAmount;
    this.maxBuffered = maxBuffered;
    this.maxWsMessage = maxWsMessage;

    this.sendWindow = channelWindow;
    this.recvWindow = channelWindow;
    this.streams = new Map();
    this.nextId = role === 'device' ? 1 : 2;
    this.lastPeerId = 0;
    this.started = false;
    this.peerHello = null;
    this.closed = false;
    this.closeError = null;
    this.missedPings = 0;
    this.pings = new Map();
    this.pingTimer = null;
    this.retryTimer = null;
    this.pumping = false;
    this.pumpAgain = false;
  }

  /** HELLO を送り、PING を始める。 */
  start() {
    if (this.started) return;
    this.started = true;
    this._sendNow(T.HELLO, 0, json.encode({ ...this.hello, proto: PROTO }));
    if (this.pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => this.#tick(), this.pingIntervalMs);
      this.pingTimer.unref?.();
    }
  }

  openHttp(head) { return this.#open('http', T.HTTP_REQ, head); }
  openWs(head) { return this.#open('ws', T.WS_OPEN, head); }

  #open(kind, type, head) {
    if (!this.started) throw new Error('start() の前には開けない');
    if (this.closed) throw new ChannelError('closed', 'チャネルは閉じている');
    if (this.role !== 'device') throw new Error('今はホストからストリームを開かない');
    if (this.streams.size >= this.maxStreams) throw new ChannelError('streams', '同時ストリームの上限');
    const id = this.nextId;
    this.nextId += 2;
    const s = new Stream(this, id, kind, head, false);
    this.streams.set(id, s);
    this._sendNow(type, id, json.encode(head));
    return s;
  }

  /** 生存確認。PONG までの時間（ms）で解決する。 */
  ping() {
    if (this.closed) return Promise.reject(new ChannelError('closed', 'チャネルは閉じている'));
    const data = crypto.randomBytes(8);
    const key = data.toString('hex');
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      this.pings.set(key, { resolve: () => resolve(Date.now() - t0), reject });
      this._sendNow(T.PING, 0, data);
    });
  }

  #tick() {
    if (this.closed) return;
    if (this.missedPings >= this.pingMisses) {
      this.close(new ChannelError('timeout', `PING に ${this.pingMisses} 回返らなかった`));
      return;
    }
    this.missedPings++;
    this.ping().catch(() => {});
  }

  /** GOAWAY を送って閉じる。code は 'revoked' | 'version' | 'shutdown' | 'protocol' など。 */
  goaway(code, reason = '') {
    if (this.closed) return;
    try { this._sendNow(T.GOAWAY, 0, json.encode({ code, reason })); } catch { /* 閉じるので構わない */ }
    this.close(new ChannelError(code, reason));
  }

  /** チャネルを終える。全ストリームは 'reset'（CHANNEL_CLOSED）になり、以後は何も送らない。 */
  close(err = null) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    for (const s of [...this.streams.values()]) s._destroy(RESET_CODE.CHANNEL_CLOSED, false);
    for (const p of this.pings.values()) p.reject(err ?? new ChannelError('closed', 'チャネルは閉じた'));
    this.pings.clear();
    this.emit('close', err);
  }

  // ── 送る（内部） ──

  _sendNow(type, stream, payload) {
    if (this.closed) return;
    const frame = encodeFrame(type, stream, payload);
    const bytes = this.transport ? this.transport.encrypt(frame) : frame;
    try { this.sendFn(bytes); } catch (e) { this.close(new ChannelError('transport', e?.message ?? String(e))); }
  }

  /** 積まれたものを窓の許す限り送る。ストリームを 1 フレームずつ順に回す。外から呼んでもよい（送り手の詰まりが解けたとき）。 */
  _pump() {
    if (this.closed) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        let progressed = true;
        while (progressed && !this.closed) {
          progressed = false;
          for (const s of [...this.streams.values()]) {
            if (this.#outboundBlocked()) return;
            if (s._sendOne()) progressed = true;
          }
        }
      } while (this.pumpAgain && !this.closed);
    } finally {
      this.pumping = false;
    }
  }
  pump() { this._pump(); }

  #outboundBlocked() {
    if (!this.bufferedAmount || this.bufferedAmount() <= this.maxBuffered) return false;
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this._pump(); }, 10);
    }
    return true;
  }

  _returnCredit(stream, n) {
    if (n <= 0 || this.closed) return;
    if (stream && !stream.destroyed && !stream.remoteDone) {
      stream.recvWindow += n;
      this._sendNow(T.WINDOW, stream.id, u32(n));
    }
    this.recvWindow += n;
    this._sendNow(T.WINDOW, 0, u32(n));
  }

  _forget(stream) {
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
  }

  // ── 受ける ──

  /** 運び手から届いた 1 メッセージ（暗号文）を渡す。 */
  receive(bytes) {
    if (this.closed) return;
    let frame;
    try {
      frame = this.transport ? this.transport.decrypt(toBytes(bytes)) : toBytes(bytes);
    } catch (e) {
      // 改ざん・順序違い。以後の通信は信用できないので、何も送らずに閉じる
      this.close(new ChannelError('decrypt', e.message));
      return;
    }
    try {
      this.#dispatch(decodeFrame(frame));
    } catch (e) {
      if (e instanceof FrameError || (e instanceof ChannelError && e.code === 'protocol')) {
        this.goaway('protocol', e.message);
      } else {
        this.close(e instanceof ChannelError ? e : new ChannelError('internal', e?.message ?? String(e)));
      }
    }
  }

  #dispatch({ type, stream: id, payload }) {
    if (!this.peerHello && type !== T.HELLO) throw new ChannelError('protocol', '最初のフレームが HELLO ではない');
    switch (type) {
      case T.HELLO: {
        if (this.peerHello) throw new ChannelError('protocol', 'HELLO が 2 回来た');
        const h = json.decode(payload);
        this.peerHello = h;
        if (h.proto !== PROTO) { this.goaway('version', `proto ${h.proto} には対応しない`); return; }
        this.emit('hello', h);
        return;
      }
      case T.PING:
        if (payload.length !== 8) throw new FrameError('PING は 8 バイト');
        this._sendNow(T.PONG, 0, payload);
        return;
      case T.PONG: {
        this.missedPings = 0;
        const key = payload.toString('hex');
        const p = this.pings.get(key);
        if (p) { this.pings.delete(key); p.resolve(); }
        return;
      }
      case T.GOAWAY: {
        let g;
        try { g = json.decode(payload); } catch { g = { code: 'unknown' }; }
        this.emit('goaway', g);
        this.close(new ChannelError(String(g.code ?? 'unknown'), String(g.reason ?? ''), { remote: true }));
        return;
      }
      case T.WINDOW: {
        const inc = readU32(payload);
        if (inc === 0) throw new FrameError('WINDOW の増分が 0');
        if (id === 0) {
          if (this.sendWindow + inc > MAX_WINDOW) throw new FrameError('チャネルの窓があふれた');
          this.sendWindow += inc;
        } else {
          const s = this.streams.get(id);
          if (!s) { this.#checkKnown(id); return; }
          if (s.sendWindow + inc > MAX_WINDOW) throw new FrameError('ストリームの窓があふれた');
          s.sendWindow += inc;
        }
        this._pump();
        return;
      }
      case T.HTTP_REQ:
      case T.WS_OPEN:
        this.#onOpen(type, id, payload);
        return;
    }

    const flow = type === T.DATA || type === T.WS_MSG ? payload.length : 0;
    if (flow > this.recvWindow) throw new ChannelError('protocol', 'チャネルの窓を超えた');
    this.recvWindow -= flow;
    const s = this.streams.get(id);
    if (!s) {
      // 捨てた直後に行き違いで届いたもの。窓だけ返して読み捨てる
      this.#checkKnown(id);
      if (flow) this._returnCredit(null, flow);
      return;
    }
    if (flow) s._onFlow(flow);

    switch (type) {
      case T.HTTP_RES:
        this.#need(s, 'http', !s.incoming && !s.response);
        s.response = json.decode(payload);
        s.emit('response', s.response);
        return;
      case T.DATA: {
        this.#need(s, 'http', !s.remoteDone);
        const release = s._releaser(flow);
        if (s.listenerCount('data')) s.emit('data', payload, release); else release();
        return;
      }
      case T.END:
        this.#need(s, 'http', !s.remoteDone);
        s.remoteDone = true;
        s.emit('end');
        s._maybeFinish();
        return;
      case T.RESET:
        s._destroy(readU16(payload), true);
        return;
      case T.WS_ACCEPT:
        this.#need(s, 'ws', !s.incoming && !s.accepted && !s.remoteDone);
        s.accepted = true;
        s.emit('accept');
        return;
      case T.WS_REJECT: {
        this.#need(s, 'ws', !s.incoming && !s.accepted && !s.remoteDone);
        const status = readU16(payload);
        s.remoteDone = true;
        s.localDone = true;
        s.queue.splice(0).forEach(item => item.reject(new Error(`WebSocket を断られた（${status}）`)));
        s.emit('reject', status);
        s._maybeFinish();
        return;
      }
      case T.WS_MSG: {
        this.#need(s, 'ws', !s.remoteDone && (s.incoming || s.accepted));
        let msg;
        try { msg = s.assembler.push(payload); } catch (e) {
          if (e instanceof FrameError && /上限/.test(e.message)) {
            s._releaser(flow)();   // 窓は返してから捨てる
            s.reset(RESET_CODE.TOO_LARGE);
            return;
          }
          throw e;
        }
        if (!msg) {
          // 途中の断片は組み立ての入れ物（上限 maxWsMessage）に渡し終えたので、すぐ返す。
          // 返さないとメッセージが窓より大きいときに詰まる。
          s._releaser(flow)();
          return;
        }
        const release = s._releaser(flow);
        if (s.listenerCount('message')) s.emit('message', msg.data, msg.text, release); else release();
        return;
      }
      case T.WS_CLOSE: {
        this.#need(s, 'ws', !s.remoteDone);
        const { code, reason } = decodeWsClose(payload);
        s.remoteDone = true;
        s.emit('close', code, reason);
        s._maybeFinish();
        return;
      }
    }
    throw new FrameError(`${TYPE_NAMES[type]} はここでは使えない`);
  }

  #need(s, kind, ok) {
    if (s.kind !== kind || !ok) throw new ChannelError('protocol', `stream ${s.id} に合わないフレーム`);
  }

  /** 相手の番号で、まだ開かれていないストリームへのフレームは誤り。こちらの番号で未使用のものも誤り。 */
  #checkKnown(id) {
    const mine = (id % 2 === 1) === (this.role === 'device');
    if (mine ? id >= this.nextId : id > this.lastPeerId) throw new ChannelError('protocol', `開かれていない stream ${id}`);
  }

  #onOpen(type, id, payload) {
    if (this.role !== 'host') throw new ChannelError('protocol', '端末はストリームを受けない');
    if (id % 2 !== 1 || id <= this.lastPeerId) throw new ChannelError('protocol', `stream ${id} の番号が不正`);
    this.lastPeerId = id;
    const head = json.decode(payload);
    if (this.streams.size >= this.maxStreams || !this.listenerCount('stream')) {
      this._sendNow(T.RESET, id, u16(RESET_CODE.REFUSED));
      return;
    }
    const s = new Stream(this, id, type === T.HTTP_REQ ? 'http' : 'ws', head, true);
    this.streams.set(id, s);
    this.emit('stream', s);
  }
}
