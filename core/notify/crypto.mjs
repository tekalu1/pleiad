// 離れた端末への通知の暗号（docs/remote.md §11-5、ADR 0086）。
//
// ホストは通知の中身（種類・ホスト名・会話 ID・会話名・時刻・通し番号）を、端末ごとの通知鍵（端末が作った 32 バイト。
// ペアリング済みの E2E の線でホストへ登録する）で暗号化し、中継へ渡す。中継は deviceId 宛てに流すだけで、中身は読めない。
//
//   blob = base64url( nonce(12) || AES-256-GCM(平文 512 バイト) || tag(16) )
//   平文 = u16(BE の JSON の長さ) || JSON(UTF-8) || 0 埋め          ← 種類によらず同じ大きさ（中継に種類を漏らさない）
//   AAD  = "pleiad-notify/1\n" + hostId + "\n" + deviceId           ← 別のホスト・別の端末への付け替えを防ぐ
//
// 鍵と AEAD は Noise の線（docs/remote.md §3.2）と同じ系統（AES-256-GCM）。Android の `javax.crypto` で同じ形が開ける。
import crypto from 'node:crypto';

export const NOTICE_VERSION = 1;
export const PLAIN_BYTES = 512;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** 暗号文の大きさ（nonce + 平文 + タグ）。固定。 */
export const BLOB_BYTES = NONCE_BYTES + PLAIN_BYTES + TAG_BYTES;
export const KEY_BYTES = 32;
const AAD_PREFIX = 'pleiad-notify/1\n';

/** 通知の種類。cancel は出ている通知を消す（取り消しも同じ線で送る）。 */
export const KINDS = Object.freeze(['approval', 'question', 'failed', 'done', 'limitReady', 'limitGuarded', 'scheduleMissed', 'cancel']);
/** cancel の対象: approval = 承認・質問が決着した（id 指定可）、seen = 完了・失敗をどこかで見た。 */
export const CANCELS = Object.freeze(['approval', 'seen']);

const TITLE_MAX = 120;
const HOST_MAX = 48;

export function generateNotifyKey() { return crypto.randomBytes(KEY_BYTES); }

const aad = ({ hostId, deviceId }) => Buffer.from(`${AAD_PREFIX}${hostId}\n${deviceId}`, 'utf8');
const clip = (value, max) => [...String(value ?? '')].slice(0, max).join('');

/** 平文に入れる形に整える。形の違うものは投げる。 */
export function normalizeNotice(notice) {
  if (!notice || typeof notice !== 'object') throw new Error('notice');
  if (!KINDS.includes(notice.kind)) throw new Error(`kind: ${notice.kind}`);
  if (!Number.isSafeInteger(notice.seq) || notice.seq <= 0) throw new Error('seq');
  const out = {
    v: NOTICE_VERSION,
    seq: notice.seq,
    at: Number.isFinite(notice.at) ? Math.floor(notice.at) : 0,
    kind: notice.kind,
    hostId: String(notice.hostId ?? ''),
    host: clip(notice.host, HOST_MAX),
    session: String(notice.session ?? '').slice(0, 80),
    title: clip(notice.title, TITLE_MAX),
  };
  if (notice.id) out.id = String(notice.id).slice(0, 80);
  if (notice.kind === 'cancel') {
    if (!CANCELS.includes(notice.cancel)) throw new Error('cancel');
    out.cancel = notice.cancel;
  }
  return out;
}

function pack(notice) {
  let n = normalizeNotice(notice);
  let json = Buffer.from(JSON.stringify(n), 'utf8');
  // 長い会話名・ホスト名は、収まるまで詰める（大きさは固定長）
  while (json.length > PLAIN_BYTES - 2 && (n.title.length > 0 || n.host.length > 0)) {
    if (n.title.length) n = { ...n, title: [...n.title].slice(0, Math.max(0, [...n.title].length - 8)).join('') };
    else n = { ...n, host: [...n.host].slice(0, Math.max(0, [...n.host].length - 8)).join('') };
    json = Buffer.from(JSON.stringify(n), 'utf8');
  }
  if (json.length > PLAIN_BYTES - 2) throw new Error('too long');
  const plain = Buffer.alloc(PLAIN_BYTES);
  plain.writeUInt16BE(json.length, 0);
  json.copy(plain, 2);
  return plain;
}

/** 暗号化。nonce は試験で固定するときだけ渡す。base64url の文字列を返す。 */
export function sealNotice(key, ids, notice, { nonce = crypto.randomBytes(NONCE_BYTES) } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('key');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(ids));
  const body = Buffer.concat([cipher.update(pack(notice)), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

/** 復号（試験と、端末の代わりのクライアント用）。開けない・形が違うものは null。 */
export function openNotice(key, ids, blob) {
  try {
    const raw = Buffer.from(String(blob), 'base64url');
    if (raw.length !== BLOB_BYTES) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(ids));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    const len = plain.readUInt16BE(0);
    if (len < 2 || len > PLAIN_BYTES - 2) return null;
    const notice = JSON.parse(plain.subarray(2, 2 + len).toString('utf8'));
    return notice?.v === NOTICE_VERSION ? notice : null;
  } catch { return null; }
}

/** 登録で受け取る通知鍵（base64url の 32 バイト）を Buffer に。形が違えば null。 */
export function parseNotifyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === KEY_BYTES ? raw : null;
}
