// main とサーバーを名前付きパイプで結ぶ口（core/main-link.mjs・desktop/server-link.cjs）の符号化。
// 1 行 1 JSON。utilityProcess の parentPort は構造化複製で Uint8Array（computer-result の画面の写真など）をそのまま運ぶが、
// 行の JSON は運べないので、バイナリーは { "$bin": "<base64>" } に包んで運び、受ける側で Uint8Array に戻す
// （docs/zero-downtime-update/design.md §7.1）。両側が同じ実装を使うので、main 側は動的 import で読む（desktop/i18n.cjs と同じ）。

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

const BIN = '$bin';
const ESC = '$esc';

const isBytes = value => ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function encodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (isBytes(value)) return { [BIN]: bytesOf(value).toString('base64') };
  if (Array.isArray(value)) return value.map(item => { const out = encodeValue(item); return out === undefined || typeof out === 'function' || typeof out === 'symbol' ? null : out; });
  if (typeof value.toJSON === 'function') return encodeValue(value.toJSON());
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const encoded = encodeValue(item);
    if (encoded === undefined || typeof encoded === 'function' || typeof encoded === 'symbol') continue;
    out[key] = encoded;
  }
  // メッセージ自身が $bin・$esc のキーを持つときは、受ける側が取り違えないよう包む
  return hasOwn(out, BIN) || hasOwn(out, ESC) ? { [ESC]: out } : out;
}

function decodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === BIN && typeof value[BIN] === 'string') return new Uint8Array(Buffer.from(value[BIN], 'base64'));
  const body = keys.length === 1 && keys[0] === ESC && value[ESC] && typeof value[ESC] === 'object' && !Array.isArray(value[ESC]) ? value[ESC] : value;
  const out = {};
  for (const [key, item] of Object.entries(body)) out[key] = decodeValue(item);
  return out;
}

/** 値を 1 行の JSON にする（改行を含まない。末尾の改行は付けない）。JSON にできない値は投げる */
export function encodeLine(value) {
  return JSON.stringify(encodeValue(value));
}

/** encodeLine の逆。JSON として読めなければ投げる */
export function decodeLine(text) {
  return decodeValue(JSON.parse(text));
}

/**
 * バイト列を行に分ける（0x0A 区切り。UTF-8 の多バイトの中には現れない）。
 * 1 行が maxBytes（後から maxBytes に代入して変えられる）を超えたら、その行の残りを次の改行まで捨てて onDrop({ reason: 'oversize', bytes }) を呼ぶ（つながりは保つ）。
 * 改行の来ないまま終わった行は reset で捨てる（行の途中で切れた入力は渡さない）
 */
export function createLineReader({ maxBytes = DEFAULT_MAX_LINE_BYTES, onLine, onDrop = () => {} }) {
  let chunks = [];
  let size = 0;
  let skipping = false;
  let skipped = 0;
  let limit = maxBytes;
  const dropOversize = bytes => onDrop({ reason: 'oversize', bytes });
  return {
    push(chunk) {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(0x0a, start);
        if (end < 0) break;
        const piece = chunk.subarray(start, end);
        start = end + 1;
        if (skipping) {
          dropOversize(skipped + piece.length);
          skipping = false; skipped = 0;
          continue;
        }
        if (size + piece.length > limit) { dropOversize(size + piece.length); chunks = []; size = 0; continue; }
        const line = chunks.length ? Buffer.concat([...chunks, piece]) : piece;
        chunks = []; size = 0;
        if (line.length) onLine(line.toString('utf8'));
      }
      const rest = chunk.subarray(start);
      if (!rest.length) return;
      if (skipping) { skipped += rest.length; return; }
      if (size + rest.length > limit) { skipping = true; skipped = size + rest.length; chunks = []; size = 0; return; }
      chunks.push(rest); size += rest.length;
    },
    /** 溜めた途中の行を捨てる（つながりが切れたとき） */
    reset() { chunks = []; size = 0; skipping = false; skipped = 0; },
    get pending() { return size; },
    /** 握手の前は小さく、握手の後は広げる */
    set maxBytes(value) { limit = value; },
  };
}
