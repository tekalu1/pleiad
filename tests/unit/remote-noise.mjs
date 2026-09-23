// リモート接続の暗号（core/remote/noise.mjs）。公式の試験ベクトルと、往復・失敗・改ざんの検出。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Handshake, CipherState, MAX_NONCE, keyPairFromPrivate, generateKeyPair, dh,
  prologueFor, hostIdFor, derivePairing, confirmationCode, formatConfirmationCode, base32,
  AEAD_CIPHER, PROTOCOL_IK, PROTOCOL_IKPSK2,
} from '../../core/remote/noise.mjs';

export const name = 'remote-noise';
export const title = 'リモート: Noise IK / IKpsk2 の試験ベクトル・往復・鍵違い・改ざん';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'remote', 'vectors.json'), 'utf8'));
const H = x => Buffer.from(x, 'hex');

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

function runVector(v) {
  const pattern = v.protocol_name.includes('psk2') ? 'IKpsk2' : 'IK';
  const init = new Handshake({
    pattern, initiator: true, prologue: H(v.init_prologue), staticKey: keyPairFromPrivate(H(v.init_static)),
    remoteStatic: H(v.init_remote_static), psk: v.init_psks ? H(v.init_psks[0]) : null, ephemeral: H(v.init_ephemeral),
  });
  const resp = new Handshake({
    pattern, initiator: false, prologue: H(v.resp_prologue), staticKey: keyPairFromPrivate(H(v.resp_static)),
    psk: v.resp_psks ? H(v.resp_psks[0]) : null, ephemeral: H(v.resp_ephemeral),
  });
  const bad = [];
  let ti, tr;
  v.messages.forEach((m, k) => {
    const fromInit = k % 2 === 0;
    let ct, pt;
    if (k < 2) {
      ct = (fromInit ? init : resp).writeMessage(H(m.payload));
      pt = (fromInit ? resp : init).readMessage(ct);
      if (k === 1) { ti = init.split(); tr = resp.split(); }
    } else {
      ct = (fromInit ? ti : tr).encrypt(H(m.payload));
      pt = (fromInit ? tr : ti).decrypt(ct);
    }
    if (ct.toString('hex') !== m.ciphertext) bad.push(`message ${k} の暗号文`);
    if (pt.toString('hex') !== m.payload) bad.push(`message ${k} の平文`);
  });
  if (init.handshakeHash.toString('hex') !== v.handshake_hash) bad.push('開始側の handshake_hash');
  if (resp.handshakeHash.toString('hex') !== v.handshake_hash) bad.push('応答側の handshake_hash');
  if (!resp.remoteStatic.equals(keyPairFromPrivate(H(v.init_static)).publicKey)) bad.push('応答側が知った静的鍵');
  return bad;
}

/** 端末とホストの 1 回のハンドシェイク。失敗はそのまま投げる。 */
function handshake({ pattern = 'IK', device, host, hostPublicSeenByDevice = host.publicKey, hostId = 'h', devicePsk, hostPsk, tamper }) {
  const d = new Handshake({ pattern, initiator: true, prologue: prologueFor(hostId), staticKey: device, remoteStatic: hostPublicSeenByDevice, psk: devicePsk });
  const h = new Handshake({ pattern, initiator: false, prologue: prologueFor(hostId.hostSide ?? hostId), staticKey: host, psk: hostPsk });
  let m1 = d.writeMessage(Buffer.from(JSON.stringify({ proto: 1, name: 'Pixel 9' })));
  if (tamper === 1) m1 = flip(m1, m1.length - 1);
  const p1 = JSON.parse(h.readMessage(m1));
  let m2 = h.writeMessage();
  if (tamper === 2) m2 = flip(m2, 40);
  d.readMessage(m2);
  return { d, h, p1, td: d.split(), th: h.split() };
}

function flip(buf, i) {
  const b = Buffer.from(buf);
  b[i] ^= 0x01;
  return b;
}

export default async function (t) {
  // ── 公式ベクトル ──
  t.ok('vectors.json に IK と IKpsk2 の 2 本だけがある',
    VECTORS.noise.length === 2 && VECTORS.noise.map(v => v.protocol_name).sort().join() ===
      'Noise_IK_25519_AESGCM_SHA256,Noise_IKpsk2_25519_AESGCM_SHA256');
  // Electron の Node（BoringSSL）には chacha20-poly1305 が無かった。どちらの crypto にもある AEAD を使っていることを落とせる形で見る
  t.ok(`AEAD（${AEAD_CIPHER}）が crypto.getCiphers() にある（Electron の BoringSSL にもある組）`,
    crypto.getCiphers().includes(AEAD_CIPHER) && PROTOCOL_IK.includes('_AESGCM_') && PROTOCOL_IKPSK2.includes('_AESGCM_'));
  for (const v of VECTORS.noise) {
    const bad = runVector(v);
    t.ok(`${v.protocol_name}: cacophony のベクトルと一致（ハンドシェイク 2 通 + transport 4 通・h）`, bad.length === 0, bad.join(', '));
  }

  // ── 鍵 ──
  const a = generateKeyPair(), b = generateKeyPair();
  t.ok('X25519: 両側の DH が一致し、秘密鍵から公開鍵を作り直せる',
    dh(a.privateKey, b.publicKey).equals(dh(b.privateKey, a.publicKey)) && keyPairFromPrivate(a.privateKey).publicKey.equals(a.publicKey));
  t.ok('X25519: 位数の小さい点（全部 0）は弾く', throws(() => dh(a.privateKey, Buffer.alloc(32))));

  // ── IK の往復 ──
  const host = generateKeyPair(), device = generateKeyPair();
  const hostId = hostIdFor(host.publicKey);
  {
    const { d, h, p1, td, th } = handshake({ device, host, hostId });
    t.ok('IK: 両側が完了し、ホストは端末の静的鍵と最初のメッセージの中身を知る',
      d.isComplete && h.isComplete && h.remoteStatic.equals(device.publicKey) && p1.name === 'Pixel 9');
    t.ok('IK: ハンドシェイクのハッシュが一致し、確認コードも一致する（6 桁）',
      d.handshakeHash.equals(h.handshakeHash) && confirmationCode(d.handshakeHash) === confirmationCode(h.handshakeHash) &&
      /^\d{6}$/.test(confirmationCode(d.handshakeHash)));
    const x = th.decrypt(td.encrypt(Buffer.from('to host')));
    const y = td.decrypt(th.encrypt(Buffer.from('to device')));
    t.ok('IK: 確立後は両方向に送れる', x.toString() === 'to host' && y.toString() === 'to device');

    // 改ざん・再送・順序の入れ替え
    const c1 = td.encrypt(Buffer.from('one')), c2 = td.encrypt(Buffer.from('two'));
    t.ok('transport: 1 ビットの改ざんで復号に失敗する', throws(() => th.decrypt(flip(c1, 0))));
    t.ok('transport: 失敗しても nonce は進まず、正しい通は読める', th.decrypt(c1).toString() === 'one');
    t.ok('transport: 同じ通の再送は失敗する', throws(() => th.decrypt(c1)));
    const c3 = td.encrypt(Buffer.from('three'));
    t.ok('transport: 順序の入れ替え（飛ばし）は失敗する', throws(() => th.decrypt(c3)) && th.decrypt(c2).toString() === 'two');
    t.ok('transport: タグより短いものは失敗する', throws(() => th.decrypt(Buffer.alloc(5))));
  }
  t.ok('IK: 別のホストの公開鍵を覚えている端末はホストで弾かれる',
    throws(() => handshake({ device, host, hostId, hostPublicSeenByDevice: generateKeyPair().publicKey })));
  t.ok('IK: ホストになりすました別の鍵の持ち主は、端末が覚えた鍵と合わないのでメッセージ 1 を読めない',
    throws(() => handshake({ device, host: generateKeyPair(), hostId, hostPublicSeenByDevice: host.publicKey })));
  t.ok('IK: prologue（hostId）が違うと失敗する', throws(() => {
    const d = new Handshake({ pattern: 'IK', initiator: true, prologue: prologueFor(hostId), staticKey: device, remoteStatic: host.publicKey });
    const h = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor('other'), staticKey: host });
    h.readMessage(d.writeMessage());
  }));
  t.ok('IK: メッセージ 1 の改ざんはホストが検出する', throws(() => handshake({ device, host, hostId, tamper: 1 })));
  t.ok('IK: メッセージ 2 の改ざんは端末が検出する', throws(() => handshake({ device, host, hostId, tamper: 2 })));
  {
    // 端末一覧に無い静的鍵: 暗号としては通るので、ホストは remoteStatic を一覧と照合して弾く
    const stranger = generateKeyPair();
    const h = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor(hostId), staticKey: host });
    h.readMessage(new Handshake({ pattern: 'IK', initiator: true, prologue: prologueFor(hostId), staticKey: stranger, remoteStatic: host.publicKey }).writeMessage());
    t.ok('IK: 応答前に相手の静的鍵が分かる（一覧に無ければ返さずに閉じられる）', h.remoteStatic.equals(stranger.publicKey) && !h.isComplete);
  }

  // ── IKpsk2（ペアリング） ──
  const secret = crypto.randomBytes(32);
  const { psk } = derivePairing(secret);
  {
    const { d, h, td, th } = handshake({ pattern: 'IKpsk2', device, host, hostId, devicePsk: psk, hostPsk: psk });
    t.ok('IKpsk2: 同じ psk なら完了し、確認コードが両側で一致する',
      confirmationCode(d.handshakeHash) === confirmationCode(h.handshakeHash) && th.decrypt(td.encrypt(Buffer.from('ok'))).toString() === 'ok');
  }
  t.ok('IKpsk2: psk が違う（QR を読んでいない）と端末がメッセージ 2 を読めない',
    throws(() => handshake({ pattern: 'IKpsk2', device, host, hostId, devicePsk: derivePairing(crypto.randomBytes(32)).psk, hostPsk: psk })));
  t.ok('IKpsk2: psk が無いと始められない', throws(() => new Handshake({ pattern: 'IKpsk2', initiator: true, staticKey: device, remoteStatic: host.publicKey })));
  t.ok('IK と IKpsk2 は混ざらない', throws(() => {
    const d = new Handshake({ pattern: 'IKpsk2', initiator: true, prologue: prologueFor(hostId), staticKey: device, remoteStatic: host.publicKey, psk });
    const h = new Handshake({ pattern: 'IK', initiator: false, prologue: prologueFor(hostId), staticKey: host });
    h.readMessage(d.writeMessage());
  }));

  // ── 取り決め ──
  const P = VECTORS.pleiad;
  const pair = derivePairing(H(P.pairing.secret));
  // HKDF（RFC 5869、salt 空）を HMAC で書き直して突き合わせる
  const hkdf = (ikm, info) => {
    const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(ikm).digest();
    return crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
  };
  t.ok('ペアリング: psk・入場券・入場券のハッシュがベクトルと一致し、HKDF の定義どおり',
    pair.psk.toString('hex') === P.pairing.psk && pair.ticket.toString('hex') === P.pairing.ticket &&
    pair.ticketHash.toString('hex') === P.pairing.ticketHash &&
    pair.psk.equals(hkdf(H(P.pairing.secret), 'pleiad pair psk')) && !pair.psk.equals(pair.ticket));
  t.ok('hostId: base32(SHA-256(公開鍵)) の先頭 26 字で、ベクトルと一致',
    hostIdFor(H(P.host.publicKey)) === P.host.hostId && /^[a-z2-7]{26}$/.test(P.host.hostId) &&
    base32(Buffer.from('foobar')) === 'mzxw6ytboi');
  t.ok('prologue: "pleiad-remote/1" || hostId', prologueFor(P.host.hostId).toString('hex') === P.host.prologue);
  t.ok('確認コード: ベクトルと一致し、3 桁ずつ区切って出せる',
    P.confirmation.every(c => confirmationCode(H(c.handshakeHash)) === c.code) && formatConfirmationCode('482193') === '482 193');

  // ── nonce の上限 ──
  const cs = new CipherState(crypto.randomBytes(32));
  cs.n = MAX_NONCE;
  t.ok('nonce: 2^32 通に達したら暗号化も復号も断る（張り直す）',
    throws(() => cs.encryptWithAd(Buffer.alloc(0), Buffer.from('x'))) && throws(() => cs.decryptWithAd(Buffer.alloc(0), Buffer.alloc(17))));
}
