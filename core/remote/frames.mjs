// リモート接続の平文のフレーム（docs/remote.md §4.1）。
//
//   type (u8) | stream (u32, BE) | payload
//
// 1 フレーム = Noise の 1 通 = 中継への WebSocket の 1 メッセージ（バイナリ）。
// stream 0 はチャネル自体。端末が開くストリームは奇数、ホストが開くもの（今は無い）は偶数。
// ここはバイト列との変換だけ。流量の制御・ストリームの状態は channel.mjs が持つ。
import { MAX_PLAINTEXT } from './noise.mjs';

export const T = Object.freeze({
  HELLO: 0x01,
  PING: 0x02,
  PONG: 0x03,
  GOAWAY: 0x04,
  HTTP_REQ: 0x10,
  HTTP_RES: 0x11,
  DATA: 0x12,
  END: 0x13,
  RESET: 0x14,
  WS_OPEN: 0x20,
  WS_ACCEPT: 0x21,
  WS_REJECT: 0x22,
  WS_MSG: 0x23,
  WS_CLOSE: 0x24,
  WINDOW: 0x30,
});

export const TYPE_NAMES = Object.freeze(Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k])));

/** stream 0 だけに載る型と、stream 0 には載らない型。 */
const CHANNEL_ONLY = new Set([T.HELLO, T.PING, T.PONG, T.GOAWAY]);

export const HEADER_BYTES = 5;
/** 平文のフレームの上限（Noise の 1 通 65535 - タグ 16）。 */
export const MAX_FRAME = MAX_PLAINTEXT;
export const MAX_PAYLOAD = MAX_FRAME - HEADER_BYTES;
/** 本文・WebSocket のメッセージはこの大きさごとに分ける。 */
export const CHUNK = 60 * 1024;
export const PROTO = 1;

/** WS_MSG の印（payload の先頭 1 バイト）。 */
export const WS_TEXT = 0x01;
export const WS_FIN = 0x02;

/** RESET の理由（u16）。docs/remote.md §4.1 に表を置いた。 */
export const RESET_CODE = Object.freeze({
  CANCEL: 0,          // 片方が要らなくなった（窓を閉じた・要求を取り消した）
  PROTOCOL: 1,        // 決まりに反するフレーム
  REFUSED: 2,         // 同時ストリームの上限・受け付けない種類
  FORBIDDEN: 3,       // 接続口の防火壁が通さない（/mcp/・GET/HEAD 以外・/ws 以外の WS）
  INTERNAL: 4,        // 受け側の失敗（ローカルのサーバーにつながらないなど）
  FLOW_CONTROL: 5,    // 窓を超えて送られた
  CHANNEL_CLOSED: 6,  // チャネルが閉じた（ローカルで付く。送られはしない）
  TOO_LARGE: 7,       // 組み立てた WebSocket のメッセージが上限を超えた
});

export class FrameError extends Error {}

function bytes(v) {
  if (v == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  throw new TypeError('payload はバイト列か文字列');
}

export function encodeFrame(type, stream, payload) {
  if (!TYPE_NAMES[type]) throw new FrameError(`知らない型: ${type}`);
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new FrameError(`stream が範囲外: ${stream}`);
  const body = bytes(payload);
  if (body.length > MAX_PAYLOAD) throw new FrameError(`payload が大きすぎる（${body.length} > ${MAX_PAYLOAD}）`);
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(stream, 1);
  body.copy(out, HEADER_BYTES);
  return out;
}

/** バイト列 → `{ type, stream, payload }`。形の誤り（短い・知らない型・stream の取り違え）は FrameError。 */
export function decodeFrame(buf) {
  buf = bytes(buf);
  if (buf.length < HEADER_BYTES) throw new FrameError('フレームが短すぎる');
  if (buf.length > MAX_FRAME) throw new FrameError('フレームが大きすぎる');
  const type = buf.readUInt8(0);
  const stream = buf.readUInt32BE(1);
  if (!TYPE_NAMES[type]) throw new FrameError(`知らない型: 0x${type.toString(16)}`);
  if (CHANNEL_ONLY.has(type) && stream !== 0) throw new FrameError(`${TYPE_NAMES[type]} は stream 0 だけ`);
  if (!CHANNEL_ONLY.has(type) && type !== T.WINDOW && stream === 0) throw new FrameError(`${TYPE_NAMES[type]} は stream 0 に載らない`);
  return { type, stream, payload: buf.subarray(HEADER_BYTES) };
}

// ── payload の形 ───────────────────────────────────────────

export const json = {
  encode: v => Buffer.from(JSON.stringify(v), 'utf8'),
  decode(buf) {
    let v;
    try { v = JSON.parse(bytes(buf).toString('utf8')); } catch { throw new FrameError('JSON として読めない'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FrameError('JSON のオブジェクトではない');
    return v;
  },
};

export function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
export function readU16(buf) {
  if (buf.length !== 2) throw new FrameError('u16 の長さが違う');
  return buf.readUInt16BE(0);
}
export function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
export function readU32(buf) {
  if (buf.length !== 4) throw new FrameError('u32 の長さが違う');
  return buf.readUInt32BE(0);
}

/** WS_CLOSE: u16 の close code + 理由（UTF-8。WebSocket と同じく 123 バイトまでに切る）。 */
export function encodeWsClose(code = 1000, reason = '') {
  let r = Buffer.from(String(reason ?? ''), 'utf8');
  if (r.length > 123) r = r.subarray(0, 123);
  return Buffer.concat([u16(code), r]);
}
export function decodeWsClose(buf) {
  if (buf.length < 2) throw new FrameError('WS_CLOSE が短すぎる');
  return { code: buf.readUInt16BE(0), reason: buf.subarray(2).toString('utf8') };
}

/** WS_MSG の 1 断片: 印（bit0 文字、bit1 最後の断片）+ 断片。 */
export function encodeWsFragment(chunk, { text = false, fin = true } = {}) {
  return Buffer.concat([Buffer.from([(text ? WS_TEXT : 0) | (fin ? WS_FIN : 0)]), bytes(chunk)]);
}
export function decodeWsFragment(buf) {
  if (buf.length < 1) throw new FrameError('WS_MSG が短すぎる');
  const flags = buf.readUInt8(0);
  if (flags & ~(WS_TEXT | WS_FIN)) throw new FrameError('WS_MSG の印に知らないビット');
  return { text: Boolean(flags & WS_TEXT), fin: Boolean(flags & WS_FIN), data: buf.subarray(1) };
}

/** 大きいバイト列を CHUNK ごとに分ける。空なら空の配列。 */
export function chunks(buf, size = CHUNK) {
  buf = bytes(buf);
  const out = [];
  for (let off = 0; off < buf.length; off += size) out.push(buf.subarray(off, off + size));
  return out;
}

/** WebSocket の 1 メッセージを WS_MSG の payload の列にする（最後の断片にだけ fin）。空のメッセージも 1 断片。 */
export function fragmentWsMessage(data, { text = typeof data === 'string', size = CHUNK } = {}) {
  const parts = chunks(data, size);
  if (!parts.length) parts.push(Buffer.alloc(0));
  return parts.map((p, i) => encodeWsFragment(p, { text, fin: i === parts.length - 1 }));
}

/**
 * WS_MSG の断片を組み立てる。最初の断片の印で文字 / バイナリを決め、途中で変わったら誤り。
 * 組み立て途中の大きさが maxBytes を超えたら FrameError（RESET TOO_LARGE にする）。
 */
export class WsAssembler {
  constructor({ maxBytes = 64 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.parts = [];
    this.size = 0;
    this.text = null;
  }
  get pending() { return this.text != null; }
  /** 断片を足す。メッセージが揃ったら `{ data, text }`、まだなら null。 */
  push(payload) {
    const f = decodeWsFragment(bytes(payload));
    if (this.text == null) this.text = f.text;
    else if (this.text !== f.text) throw new FrameError('WS_MSG の文字 / バイナリが途中で変わった');
    this.size += f.data.length;
    if (this.size > this.maxBytes) throw new FrameError('WebSocket のメッセージが上限を超えた');
    this.parts.push(f.data);
    if (!f.fin) return null;
    const data = this.parts.length === 1 ? Buffer.from(this.parts[0]) : Buffer.concat(this.parts);
    const text = this.text;
    this.parts = [];
    this.size = 0;
    this.text = null;
    return { data, text };
  }
}
