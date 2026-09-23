// ペアリングと中継の URL の取り決め（docs/remote.md §3.3・§5.1）。ホストの接続口と端末（試験の端末・デスクトップ・モバイル）が同じものを使う。
//
// QR の中身: pleiad://pair?v=1&r=<中継の URL>&h=<hostId>&k=<ホストの公開鍵 base64url>&s=<ペアリングの秘密 base64url>&n=<ホスト名>
//
// ペアリングの接続（IKpsk2）の流れ。WebSocket の 1 メッセージ（バイナリ）= Noise の 1 通:
//   端末 → メッセージ 1（payload: JSON { proto: 1, name, platform, app }）
//   ホスト → メッセージ 2（payload: 空）
//   端末 → transport で JSON { type: 'pair' }。psk は IKpsk2 のメッセージ 2 の最後で混ぜるので、
//          ホストはこの 1 通を復号できて初めて「QR を読んだ端末」と分かる。承認のダイアログはここから出す
//   ホスト → transport で JSON { type: 'approved', deviceId, token, hostName } か { type: 'denied' | 'expired' }。そのあと 1000 で閉じる
// 通常の接続（IK）は、メッセージ 1（payload: JSON { proto: 1, name?, app? }）・メッセージ 2（payload: 空）のあと
// channel.mjs の Channel（最初のフレームは HELLO）に移る。
import { hostIdFor } from './noise.mjs';

export const PAIR_SCHEME = 'pleiad://pair';
export const PAIR_VERSION = '1';
/** 入場券とペアリングの秘密の寿命（§3.1「5 分・1 回で失効」）。 */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * 中継の URL を検めて揃える（末尾の / を落とす）。https / wss だけを受け付ける。
 * http / ws は 127.0.0.1 などのループバックだけ（試験と手元の確認用。登録用の秘密を平文で流さない）。
 */
export function normalizeRelayUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { throw new Error('中継の URL の形が違います'); }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const plain = u.protocol === 'http:' || u.protocol === 'ws:';
  if (!secure && !plain) throw new Error('中継の URL は https:// で始めてください');
  if (plain && !LOOPBACK.has(u.hostname)) throw new Error('中継の URL は https:// で始めてください（http はこの PC の中継だけ）');
  if (u.username || u.password) throw new Error('中継の URL に利用者名やパスワードは入れられません');
  if (u.search || u.hash) throw new Error('中継の URL に ? や # は入れられません');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** 中継の口の WebSocket の URL（https → wss、http → ws）。 */
export function relayWsUrl(relayUrl, route) {
  const u = new URL(normalizeRelayUrl(relayUrl));
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  const base = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${base}${route}`;
}

/** QR に入れる文字列。 */
export function pairingPayload({ relayUrl, hostId, publicKey, secret, hostName }) {
  const q = new URLSearchParams({
    v: PAIR_VERSION,
    r: normalizeRelayUrl(relayUrl),
    h: hostId,
    k: Buffer.from(publicKey).toString('base64url'),
    s: Buffer.from(secret).toString('base64url'),
    n: String(hostName ?? ''),
  });
  return `${PAIR_SCHEME}?${q}`;
}

/** QR の文字列を読む。形が違えば投げる。hostId が公開鍵と合うことも確かめる。 */
export function parsePairingPayload(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith(`${PAIR_SCHEME}?`)) throw new Error('ペアリングのコードではありません');
  const q = new URLSearchParams(s.slice(PAIR_SCHEME.length + 1));
  if (q.get('v') !== PAIR_VERSION) throw new Error('対応していない版のペアリングのコードです');
  const publicKey = Buffer.from(q.get('k') ?? '', 'base64url');
  const secret = Buffer.from(q.get('s') ?? '', 'base64url');
  if (publicKey.length !== 32 || secret.length !== 32) throw new Error('ペアリングのコードが壊れています');
  const hostId = String(q.get('h') ?? '').toLowerCase();
  if (hostId !== hostIdFor(publicKey)) throw new Error('ペアリングのコードの hostId が公開鍵と合いません');
  return { relayUrl: normalizeRelayUrl(q.get('r')), hostId, publicKey, secret, hostName: q.get('n') ?? '' };
}

/** 端末から来た名前などを表示できる形に（制御文字を落とし、長さを抑える）。 */
export function cleanLabel(value, max = 64) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
