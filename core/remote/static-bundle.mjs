// 画面の殻（web/ の静的ファイル一式）を 1 本に束ねる形（docs/remote.md §8.6、ADR 0901）。
// ホスト（core/static-bundle.mjs）が作り、端末のプロキシ（device-proxy.mjs・Android の DeviceProxy.kt・iOS の DeviceProxy.swift）が
// 保存して、窓の静的ファイルの要求に自分で答える。版（key）が変わったときだけ取り直す。
//
// 形（ビッグエンディアン）:
//   "PLSB" | u32 見出しの長さ | 見出し（UTF-8 の JSON） | 本文を files の順につないだもの
//   見出し: { format: 1, key, files: [{ path: '/index.html', type: 'text/html; charset=utf-8', size }] }
// key は中身から決まる: sha256（各ファイルの `${path}\n${type}\n${size}\n` と本文を files の順につないだもの）の 16 進。
// 受け手は同じ計算で key を確かめる（書きかけ・壊れた保存を使わない）。
//
// 取り方: GET /static-bundle?have=<持っている key>&enc=deflate-raw
//   have が今の key と同じ → 304（本文なし）。違う・無い → 200 と束。enc=deflate-raw なら本文を raw deflate（RFC 1951）で縮める
//   応答ヘッダー: x-pleiad-bundle-key（今の key）、x-pleiad-bundle-encoding（deflate-raw か identity）
//   この口が無い古いホストは 404 を返す。端末はそのとき今までどおり 1 本ずつホストへ流す
import crypto from 'node:crypto';

export const BUNDLE_PATH = '/static-bundle';
export const BUNDLE_FORMAT = 1;
export const BUNDLE_KEY_HEADER = 'x-pleiad-bundle-key';
export const BUNDLE_ENCODING_HEADER = 'x-pleiad-bundle-encoding';
/** 束の上限（縮めた後も戻した後も）。ホストの web/ は 5 MB ほど */
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
const MAGIC = Buffer.from('PLSB', 'latin1');
const KEY_RE = /^[0-9a-f]{64}$/;
const PATH_RE = /^\/[A-Za-z0-9._\-/]+$/;

/** files（{ path, type, body }）の key。 */
export function bundleKey(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(`${f.path}\n${f.type}\n${f.body.length}\n`);
    h.update(f.body);
  }
  return h.digest('hex');
}

/** files（{ path, type, body }）を束ねる。{ key, body } を返す。 */
export function encodeBundle(files) {
  const key = bundleKey(files);
  const head = Buffer.from(JSON.stringify({ format: BUNDLE_FORMAT, key, files: files.map(f => ({ path: f.path, type: f.type, size: f.body.length })) }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return { key, body: Buffer.concat([MAGIC, len, head, ...files.map(f => f.body)]) };
}

/** 束を読む。形・大きさ・key が合わなければ例外。{ key, files: Map<path, { type, body }> } を返す。 */
export function decodeBundle(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('static bundle: bad magic');
  const headLen = buf.readUInt32BE(4);
  if (headLen > buf.length - 8) throw new Error('static bundle: bad header length');
  const head = JSON.parse(buf.subarray(8, 8 + headLen).toString('utf8'));
  if (head?.format !== BUNDLE_FORMAT || !KEY_RE.test(head.key ?? '') || !Array.isArray(head.files)) throw new Error('static bundle: bad header');
  const files = new Map();
  const list = [];
  let at = 8 + headLen;
  for (const f of head.files) {
    if (typeof f?.path !== 'string' || !PATH_RE.test(f.path) || f.path.includes('..') || typeof f.type !== 'string' || /[\r\n]/.test(f.type)
      || !Number.isSafeInteger(f.size) || f.size < 0 || at + f.size > buf.length) throw new Error('static bundle: bad entry');
    const body = buf.subarray(at, at + f.size);
    at += f.size;
    list.push({ path: f.path, type: f.type, body });
    files.set(f.path, { type: f.type, body });
  }
  if (at !== buf.length) throw new Error('static bundle: trailing bytes');
  if (bundleKey(list) !== head.key) throw new Error('static bundle: key mismatch');
  return { key: head.key, files };
}

export const validBundleKey = key => typeof key === 'string' && KEY_RE.test(key);
