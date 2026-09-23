// リモート接続の平文のフレーム（core/remote/frames.mjs）。ベクトルとの往復・形の誤り・分割と組み立て。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  T, CHUNK, MAX_PAYLOAD, MAX_FRAME, WsAssembler,
  encodeFrame, decodeFrame, chunks, fragmentWsMessage, decodeWsFragment, encodeWsClose, decodeWsClose, json,
} from '../../core/remote/frames.mjs';
import { MAX_MESSAGE, TAGLEN } from '../../core/remote/noise.mjs';

export const name = 'remote-frames';
export const title = 'リモート: フレームの形・60 KiB の分割・WebSocket のメッセージの断片化';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'remote', 'vectors.json'), 'utf8'));

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

export default async function (t) {
  const bad = [];
  for (const f of VECTORS.frames) {
    const enc = encodeFrame(f.type, f.stream, Buffer.from(f.payload, 'hex')).toString('hex');
    const dec = decodeFrame(Buffer.from(f.frame, 'hex'));
    if (enc !== f.frame) bad.push(`${f.name} の符号化`);
    if (dec.type !== f.type || dec.stream !== f.stream || dec.payload.toString('hex') !== f.payload) bad.push(`${f.name} の復号`);
  }
  const types = new Set(VECTORS.frames.map(f => f.type));
  t.ok('ベクトルのフレームが符号化・復号とも一致し、全ての型を含む', !bad.length && Object.values(T).every(v => types.has(v)), bad.join(', '));

  const hdr = encodeFrame(T.DATA, 0x01020304, Buffer.from('ab'));
  t.ok('ヘッダーは type u8 + stream u32 BE', hdr.toString('hex') === '12010203046162');
  t.ok('平文の上限は Noise の 1 通 - タグ', MAX_FRAME === MAX_MESSAGE - TAGLEN && MAX_PAYLOAD === MAX_FRAME - 5);
  t.ok('上限ちょうどの payload は通り、1 バイト超えると断る',
    encodeFrame(T.DATA, 1, Buffer.alloc(MAX_PAYLOAD)).length === MAX_FRAME && throws(() => encodeFrame(T.DATA, 1, Buffer.alloc(MAX_PAYLOAD + 1))));
  t.ok('形の誤りを弾く（短い・知らない型・PING が stream 1・DATA が stream 0）',
    throws(() => decodeFrame(Buffer.from('12000000', 'hex'))) &&
    throws(() => decodeFrame(Buffer.from('7f00000001', 'hex'))) &&
    throws(() => decodeFrame(encodeFrame(T.DATA, 1, null).fill(0x02, 0, 1))) &&
    throws(() => decodeFrame(Buffer.from('1200000000', 'hex'))));
  t.ok('WINDOW は stream 0 にも個別のストリームにも載る',
    decodeFrame(encodeFrame(T.WINDOW, 0, Buffer.alloc(4))).stream === 0 && decodeFrame(encodeFrame(T.WINDOW, 9, Buffer.alloc(4))).stream === 9);
  t.ok('JSON の payload はオブジェクトだけ', json.decode(json.encode({ a: 1 })).a === 1 && throws(() => json.decode(Buffer.from('[1]'))) && throws(() => json.decode(Buffer.from('{'))));

  const body = crypto.randomBytes(CHUNK * 3 + 17);
  const parts = chunks(body);
  t.ok('本文は 60 KiB ごとに分ける', CHUNK === 61440 && parts.length === 4 && parts.slice(0, 3).every(p => p.length === CHUNK) &&
    Buffer.concat(parts).equals(body) && chunks(Buffer.alloc(0)).length === 0);

  const c = decodeWsClose(encodeWsClose(4401, 'x'.repeat(200)));
  t.ok('WS_CLOSE は close code + 理由（123 バイトまで）', c.code === 4401 && c.reason.length === 123);

  // WebSocket のメッセージ
  const big = crypto.randomBytes(3 * 1024 * 1024 + 5);
  const frags = fragmentWsMessage(big);
  const flags = frags.map(f => decodeWsFragment(f));
  t.ok('大きいメッセージは断片に分かれ、最後にだけ fin が立つ（どの断片も 1 フレームに収まる）',
    frags.length === Math.ceil(big.length / CHUNK) && flags.slice(0, -1).every(f => !f.fin) && flags.at(-1).fin &&
    frags.every(f => f.length + 5 <= MAX_FRAME));
  const asm = new WsAssembler();
  let got = null;
  for (const f of frags) got = asm.push(f) ?? got;
  t.ok('組み立てると元に戻る（バイナリ）', got && !got.text && got.data.equals(big) && !asm.pending);

  const text = 'あ'.repeat(40000);
  const tf = fragmentWsMessage(text);
  let gt = null;
  for (const f of tf) gt = asm.push(f) ?? gt;
  t.ok('文字のメッセージは印が立ち、マルチバイト文字が断片の境目で割れても組み立てれば戻る',
    tf.length > 1 && gt.text && gt.data.toString('utf8') === text);
  const empty = fragmentWsMessage('');
  t.ok('空のメッセージも 1 断片', empty.length === 1 && asm.push(empty[0]).data.length === 0);

  const mixed = new WsAssembler();
  mixed.push(fragmentWsMessage(Buffer.alloc(CHUNK + 1), { text: true })[0]);
  t.ok('途中で文字 / バイナリが変わったら誤り', throws(() => mixed.push(fragmentWsMessage(Buffer.alloc(1), { text: false })[0])));
  const small = new WsAssembler({ maxBytes: CHUNK });
  const two = fragmentWsMessage(Buffer.alloc(CHUNK + 1));
  small.push(two[0]);
  t.ok('組み立ての上限を超えたら誤り', throws(() => small.push(two[1])));
  t.ok('知らない印のビットは誤り', throws(() => decodeWsFragment(Buffer.from([0x04]))));
}
