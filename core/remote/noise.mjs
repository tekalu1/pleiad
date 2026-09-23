// リモート接続の暗号（docs/remote.md §3）。Node の標準 crypto だけで組む。
//
// - Noise_IK_25519_ChaChaPoly_SHA256（通常の接続）と Noise_IKpsk2_25519_ChaChaPoly_SHA256（ペアリング）。
//   Noise の仕様（rev 34）の HandshakeState / SymmetricState / CipherState をそのまま書く。自作の組み立てはしない。
// - 公式の試験ベクトル（cacophony）を tests/remote/vectors.json に置き、tests/unit/remote-noise.mjs で突き合わせる。
// - 端末（デスクトップ・モバイル）とホストの両方がこれを使う。モバイルの Swift / Kotlin も同じベクトルで確かめる。
//
// 鍵は生の 32 バイトの Buffer で受け渡す（Noise の DH 関数の入出力と同じ形）。
import crypto from 'node:crypto';

export const DHLEN = 32;
export const HASHLEN = 32;
export const TAGLEN = 16;
/** Noise の 1 通の上限。WebSocket の 1 メッセージ = Noise の 1 通。 */
export const MAX_MESSAGE = 65535;
/** 平文の上限（1 通 - 認証タグ）。 */
export const MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN;
/**
 * 1 本の接続で送れる通数の上限（docs/remote.md §3.2「2^32 通を超えたら切って張り直す」）。
 * Noise 自体の上限（2^64-1）より小さく取り、超えたら例外にする。呼び側はチャネルを閉じて張り直す。
 */
export const MAX_NONCE = 2 ** 32;

export const PROTOCOL_IK = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const PROTOCOL_IKPSK2 = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256';

// パターン（Noise の仕様 §7.5 / §9）。pre は応答側の静的鍵を事前に知っていること（IK の「K」）。
const PATTERNS = {
  IK: { name: PROTOCOL_IK, psk: false, messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
  IKpsk2: { name: PROTOCOL_IKPSK2, psk: true, messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se', 'psk']] },
};

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const EMPTY = Buffer.alloc(0);

// ── 基本の関数 ─────────────────────────────────────────────

export function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function hmac(key, ...parts) {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Noise の HKDF（仕様 §4.3。HMAC で書く定義どおり）。n は 2 か 3。 */
export function noiseHkdf(chainingKey, ikm, n) {
  const temp = hmac(chainingKey, ikm);
  const o1 = hmac(temp, Buffer.from([1]));
  const o2 = hmac(temp, o1, Buffer.from([2]));
  if (n === 2) return [o1, o2];
  return [o1, o2, hmac(temp, o2, Buffer.from([3]))];
}

function toBuf(v, what) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  throw new TypeError(`${what} must be bytes`);
}

function key32(v, what) {
  const b = toBuf(v, what);
  if (b.length !== 32) throw new TypeError(`${what} must be 32 bytes`);
  return b;
}

function privateKeyObject(priv) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, key32(priv, 'private key')]), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(pub) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, key32(pub, 'public key')]), format: 'der', type: 'spki' });
}

/** X25519 の鍵の組を作る。`{ publicKey, privateKey }` はどちらも生の 32 バイト。 */
export function generateKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  return keyPairFromPrivate(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
}

/** 秘密鍵（生の 32 バイト）から鍵の組を作り直す。保存した鍵を読み戻すとき・試験ベクトル用。 */
export function keyPairFromPrivate(priv) {
  const privateKey = Buffer.from(key32(priv, 'private key'));
  const publicKey = crypto.createPublicKey(privateKeyObject(privateKey)).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: Buffer.from(publicKey), privateKey };
}

/** X25519。相手の鍵が小位数点などで結果が全部 0 になるときは OpenSSL が失敗させる（念のためこちらでも弾く）。 */
export function dh(privateKey, publicKey) {
  const out = crypto.diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) });
  if (out.every(b => b === 0)) throw new Error('X25519 result is zero (invalid peer key)');
  return out;
}

// ── CipherState ────────────────────────────────────────────

function nonceBytes(n) {
  // 4 バイトの 0 + 64bit 小端の通番（ChaChaPoly の nonce。仕様 §12.3）
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(BigInt(n), 4);
  return b;
}

function aeadEncrypt(k, n, ad, plaintext) {
  const c = crypto.createCipheriv('chacha20-poly1305', k, nonceBytes(n), { authTagLength: TAGLEN });
  c.setAAD(ad, { plaintextLength: plaintext.length });
  const body = c.update(plaintext);
  c.final();
  return Buffer.concat([body, c.getAuthTag()]);
}

function aeadDecrypt(k, n, ad, ciphertext) {
  if (ciphertext.length < TAGLEN) throw new Error('ciphertext too short');
  const d = crypto.createDecipheriv('chacha20-poly1305', k, nonceBytes(n), { authTagLength: TAGLEN });
  d.setAAD(ad, { plaintextLength: ciphertext.length - TAGLEN });
  d.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  const body = d.update(ciphertext.subarray(0, ciphertext.length - TAGLEN));
  try { d.final(); } catch { throw new Error('decryption failed (tampered, wrong key or out of order)'); }
  return body;
}

export class CipherState {
  constructor(k = null) {
    this.k = k;
    this.n = 0;
  }
  hasKey() { return this.k != null; }

  encryptWithAd(ad, plaintext) {
    plaintext = toBuf(plaintext, 'plaintext');
    if (!this.k) return Buffer.from(plaintext);
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted (reconnect)');
    if (plaintext.length > MAX_PLAINTEXT) throw new RangeError(`plaintext is limited to ${MAX_PLAINTEXT} bytes`);
    const out = aeadEncrypt(this.k, this.n, ad, plaintext);
    this.n++;
    return out;
  }

  /** 失敗しても n は進めない（仕様 §5.1）。ただし呼び側は失敗したら接続ごと捨てる。 */
  decryptWithAd(ad, ciphertext) {
    ciphertext = toBuf(ciphertext, 'ciphertext');
    if (!this.k) return Buffer.from(ciphertext);
    if (this.n >= MAX_NONCE) throw new Error('nonce exhausted (reconnect)');
    const out = aeadDecrypt(this.k, this.n, ad, ciphertext);
    this.n++;
    return out;
  }
}

// ── SymmetricState ─────────────────────────────────────────

class SymmetricState {
  constructor(protocolName) {
    const name = Buffer.from(protocolName, 'ascii');
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : sha256(name);
    this.ck = Buffer.from(this.h);
    this.cs = new CipherState();
  }
  mixKey(ikm) {
    const [ck, k] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs = new CipherState(k);
  }
  mixHash(data) { this.h = sha256(this.h, data); }
  mixKeyAndHash(ikm) {
    const [ck, th, k] = noiseHkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(th);
    this.cs = new CipherState(k);
  }
  encryptAndHash(plaintext) {
    const c = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(c);
    return c;
  }
  decryptAndHash(ciphertext) {
    const p = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return p;
  }
  split() {
    const [k1, k2] = noiseHkdf(this.ck, EMPTY, 2);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

// ── HandshakeState ─────────────────────────────────────────

/**
 * IK / IKpsk2 のハンドシェイク。
 *
 *   const hs = new Handshake({ pattern: 'IK', initiator: true, prologue, staticKey, remoteStatic });
 *   const m1 = hs.writeMessage(payload);   // 端末 → ホスト
 *   const p2 = hs.readMessage(m2);         // ホスト → 端末。これで完了
 *   const transport = hs.split();          // 以後は transport.encrypt / decrypt
 *
 * 応答側（ホスト）は readMessage(m1) のあと `remoteStatic`（端末の静的公開鍵）を端末一覧と照合してから
 * writeMessage で返す。照合に落ちたら何も返さずに接続を閉じる。
 *
 * ephemeral は試験ベクトル用（普段は渡さない。毎回新しく作る）。
 */
export class Handshake {
  constructor({ pattern = 'IK', initiator, prologue = EMPTY, staticKey, remoteStatic = null, psk = null, ephemeral = null }) {
    const p = PATTERNS[pattern];
    if (!p) throw new Error(`unknown pattern: ${pattern}`);
    if (typeof initiator !== 'boolean') throw new TypeError('initiator must be true or false');
    if (!staticKey?.privateKey || !staticKey?.publicKey) throw new TypeError('staticKey (own static key pair) is required');
    if (initiator && !remoteStatic) throw new TypeError('the IK initiator requires the remote (host) static public key');
    if (p.psk && !psk) throw new TypeError(`${pattern} requires a psk`);
    if (!p.psk && psk) throw new TypeError(`${pattern} does not use a psk`);
    this.pattern = pattern;
    this.protocolName = p.name;
    this.initiator = initiator;
    this.messages = p.messages;
    this.s = { publicKey: key32(staticKey.publicKey, 'static public key'), privateKey: key32(staticKey.privateKey, 'static private key') };
    this.rs = remoteStatic ? Buffer.from(key32(remoteStatic, 'remote static public key')) : null;
    this.psk = psk ? key32(psk, 'psk') : null;
    this.hasPsk = p.psk;
    this.fixedE = ephemeral ? keyPairFromPrivate(ephemeral.privateKey ?? ephemeral) : null;
    this.e = null;
    this.re = null;
    this.index = 0;
    this.ss = new SymmetricState(p.name);
    this.ss.mixHash(toBuf(prologue, 'prologue'));
    // 事前メッセージ: <- s（応答側の静的鍵）
    this.ss.mixHash(initiator ? this.rs : this.s.publicKey);
  }

  /** 次に書く番か。 */
  get isMyTurn() { return !this.isComplete && (this.index % 2 === 0) === this.initiator; }
  get isComplete() { return this.index >= this.messages.length; }
  /** 相手の静的公開鍵（応答側はメッセージ 1 を読んだあとに分かる）。 */
  get remoteStatic() { return this.rs ? Buffer.from(this.rs) : null; }
  /** ハンドシェイクのハッシュ h。完了後はチャネルを識別する値として使える（確認コードの元）。 */
  get handshakeHash() { return Buffer.from(this.ss.h); }

  #dhToken(token) {
    // es: 開始側 DH(e, rs) / 応答側 DH(s, re)。se はその逆。ee・ss は対称。
    const i = this.initiator;
    switch (token) {
      case 'ee': return dh(this.e.privateKey, this.re);
      case 'ss': return dh(this.s.privateKey, this.rs);
      case 'es': return i ? dh(this.e.privateKey, this.rs) : dh(this.s.privateKey, this.re);
      case 'se': return i ? dh(this.s.privateKey, this.re) : dh(this.e.privateKey, this.rs);
    }
    throw new Error(`unknown token: ${token}`);
  }

  writeMessage(payload = EMPTY) {
    if (!this.isMyTurn) throw new Error('not our turn to write');
    const out = [];
    for (const token of this.messages[this.index]) {
      if (token === 'e') {
        this.e = this.fixedE ?? generateKeyPair();
        out.push(this.e.publicKey);
        this.ss.mixHash(this.e.publicKey);
        if (this.hasPsk) this.ss.mixKey(this.e.publicKey);
      } else if (token === 's') {
        out.push(this.ss.encryptAndHash(this.s.publicKey));
      } else if (token === 'psk') {
        this.ss.mixKeyAndHash(this.psk);
      } else {
        this.ss.mixKey(this.#dhToken(token));
      }
    }
    out.push(this.ss.encryptAndHash(toBuf(payload, 'payload')));
    this.index++;
    const msg = Buffer.concat(out);
    if (msg.length > MAX_MESSAGE) throw new RangeError('handshake message too large');
    return msg;
  }

  readMessage(message) {
    if (this.isComplete || this.isMyTurn) throw new Error("not the peer's turn to write");
    message = toBuf(message, 'message');
    if (message.length > MAX_MESSAGE) throw new RangeError('handshake message too large');
    let off = 0;
    const take = n => {
      if (message.length - off < n) throw new Error('handshake message too short');
      const b = message.subarray(off, off + n);
      off += n;
      return b;
    };
    for (const token of this.messages[this.index]) {
      if (token === 'e') {
        this.re = Buffer.from(take(DHLEN));
        this.ss.mixHash(this.re);
        if (this.hasPsk) this.ss.mixKey(this.re);
      } else if (token === 's') {
        const len = this.ss.cs.hasKey() ? DHLEN + TAGLEN : DHLEN;
        this.rs = Buffer.from(this.ss.decryptAndHash(take(len)));
      } else if (token === 'psk') {
        this.ss.mixKeyAndHash(this.psk);
      } else {
        this.ss.mixKey(this.#dhToken(token));
      }
    }
    const payload = this.ss.decryptAndHash(message.subarray(off));
    this.index++;
    return payload;
  }

  /** 完了後に transport の暗号の組を返す。 */
  split() {
    if (!this.isComplete) throw new Error('handshake not complete');
    const [c1, c2] = this.ss.split();
    return new Transport(this.initiator ? c1 : c2, this.initiator ? c2 : c1, this.handshakeHash);
  }
}

/** 確立後の暗号。1 通ごとに nonce を進める（順序の入れ替え・欠落・再送は復号の失敗になる）。 */
export class Transport {
  constructor(sendCs, recvCs, handshakeHash) {
    this.sendCs = sendCs;
    this.recvCs = recvCs;
    this.handshakeHash = handshakeHash;
  }
  encrypt(plaintext) { return this.sendCs.encryptWithAd(EMPTY, plaintext); }
  decrypt(ciphertext) { return this.recvCs.decryptWithAd(EMPTY, ciphertext); }
}

// ── Pleiad の取り決め（docs/remote.md §3） ────────────────────

export const PROLOGUE_PREFIX = 'pleiad-remote/1';

/** prologue = "pleiad-remote/1" || hostId。別のホスト・別の版への付け替えを防ぐ。 */
export function prologueFor(hostId) {
  return Buffer.concat([Buffer.from(PROLOGUE_PREFIX, 'ascii'), Buffer.from(String(hostId), 'utf8')]);
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** RFC 4648 の base32（小文字・埋めなし）。 */
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** hostId = base32(SHA-256(ホストの公開鍵)) の先頭 26 字（小文字）。 */
export function hostIdFor(hostPublicKey) {
  return base32(sha256(key32(hostPublicKey, 'host public key'))).slice(0, 26);
}

/** RFC 5869 の HKDF-SHA256（salt は空、info は札、32 バイト）。 */
export function hkdfLabel(secret, label) {
  return Buffer.from(crypto.hkdfSync('sha256', toBuf(secret, 'secret'), EMPTY, Buffer.from(label, 'utf8'), 32));
}

/**
 * ペアリングの秘密（256bit）から、Noise の psk と中継の入場券を**別々の札で**導く。
 * 中継は ticketHash だけを知る。psk は QR の外に出ない。
 */
export function derivePairing(secret) {
  const s = key32(secret, 'pairing secret');
  const psk = hkdfLabel(s, 'pleiad pair psk');
  const ticket = hkdfLabel(s, 'pleiad pair ticket');
  return { psk, ticket, ticketHash: sha256(ticket) };
}

/**
 * 確認コード（6 桁）。両側がハンドシェイクのハッシュから同じ値を出し、承認する人が見比べる。
 * HMAC-SHA256(key = h, "pleiad pair code") の先頭 4 バイト（BE）を 10^6 で割った余り、0 埋め 6 桁。
 */
export function confirmationCode(handshakeHash) {
  const v = hmac(key32(handshakeHash, 'handshake hash'), Buffer.from('pleiad pair code', 'utf8')).readUInt32BE(0);
  return String(v % 1_000_000).padStart(6, '0');
}

/** 表示用に 3 桁ずつ区切る（"482 193"）。 */
export function formatConfirmationCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
