// 審査の招待（ADR 0172 の決定 3）。Play の審査員に渡す、長く使えて人の承認なしで通るペアリングのコード。
//
// ここは「招待の記録」と「通すかどうかの判定」だけの部品で、WebSocket にも中継にも触れない（試験しやすいよう純粋に保つ）。
//   - 記録: 秘密の置き場（core/secret-store.mjs）の reviewInvite に 1 件だけ。CLI（core/review-invite.mjs）とサーバーのプロセスが
//     同じファイルを読むので、ホストを起動し直しても、別のプロセスが取り消しても、同じ招待が続く・切れる
//   - 入場券と psk は記録の秘密から導く（derivePairing）。同じ秘密からは同じ入場券になるので、中継へ何度でも置き直せる
//   - 審査の招待は審査モードでしか作らない・使わない。判定は isReviewMode だけにまとめる（審査モードの関所ができたら、そちらの関数へ差し替える）
import crypto from 'node:crypto';
import { derivePairing } from './noise.mjs';

export const INVITE_KEY = 'reviewInvite';
export const INVITE_DEFAULT_DAYS = 90;
export const INVITE_MAX_DAYS = 180;
/** その招待で入って生きている端末の上限（中継の 1 ホスト 16 台の半分）。 */
export const INVITE_MAX_DEVICES = 8;
/** 自動で通す端末の数（1 時間あたり）。 */
export const INVITE_MAX_PER_HOUR = 4;
export const INVITE_RATE_WINDOW_MS = 60 * 60 * 1000;
/** 入場券を中継へ置き直す間隔。中継の入場券の寿命（5 分）より短い。 */
export const INVITE_REPLACE_MS = 4 * 60 * 1000;
/** ホストが記録を読み直す間隔。CLI の作り直し・取り消しがここまでに効く。 */
export const INVITE_POLL_MS = 10 * 1000;
export const INVITE_LOG_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 審査モードか（AGENT_HOST_REVIEW=1）。招待の作成・使用の入口はこの関数だけを見る。
 * 審査モードの関所（起動の条件・許可の一覧）を入れるときは、この中身をその関所の判定へ差し替える。
 */
export function isReviewMode(env = process.env) {
  return env?.AGENT_HOST_REVIEW === '1';
}

/** --days の値を日数にする。空なら既定。整数で 1〜180 以外は投げる。 */
export function parseInviteDays(value) {
  if (value === undefined || value === null || value === '') return INVITE_DEFAULT_DAYS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > INVITE_MAX_DAYS) throw new Error(`days must be a whole number from 1 to ${INVITE_MAX_DAYS}`);
  return n;
}

/** 新しい招待の記録。秘密は 32 バイトの乱数。 */
export function newInviteRecord({ now = Date.now(), days = INVITE_DEFAULT_DAYS } = {}) {
  return {
    version: 1,
    id: crypto.randomBytes(9).toString('base64url'),
    secret: crypto.randomBytes(32).toString('base64url'),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + parseInviteDays(days) * DAY_MS).toISOString(),
  };
}

/**
 * 記録を使える形にする。記録が無い・壊れていれば null。期限が過ぎていれば expired: true（入場券は持たせる。表示のため）。
 * 返す secret（Buffer）は QR に入れるもの、psk と ticketHash は Noise と中継に使うもの。
 */
export function loadInvite(record, now = Date.now()) {
  if (!record || record.version !== 1 || typeof record.id !== 'string') return null;
  const secret = Buffer.from(String(record.secret ?? ''), 'base64url');
  const expiresAt = Date.parse(record.expiresAt);
  const createdAt = Date.parse(record.createdAt);
  if (secret.length !== 32 || !Number.isFinite(expiresAt) || !Number.isFinite(createdAt)) return null;
  const { psk, ticketHash } = derivePairing(secret);
  return { id: record.id, secret, psk, ticketHash, createdAt, expiresAt, expired: expiresAt <= now };
}

/** 残りの日数（切り上げ。切れていれば 0）。 */
export function inviteDaysLeft(invite, now = Date.now()) {
  return Math.max(0, Math.ceil((invite.expiresAt - now) / DAY_MS));
}

/**
 * 自動で通してよいか。
 *   live    その招待で入って今も生きている端末の数
 *   recent  直近 1 時間に通した数
 * 戻り値: { ok: true } か { ok: false, reason: 'devices' | 'rate' }
 */
export function checkAdmission({ live, recent, maxDevices = INVITE_MAX_DEVICES, perHour = INVITE_MAX_PER_HOUR }) {
  if (live >= maxDevices) return { ok: false, reason: 'devices' };
  if (recent >= perHour) return { ok: false, reason: 'rate' };
  return { ok: true };
}

/** 招待の記録の置き場（秘密の置き場の 1 項目）。招待は同時に 1 つだけ。 */
export function createInviteStore(secrets) {
  return {
    /** 記録そのもの（無ければ null）。 */
    get: () => secrets.get(INVITE_KEY).then(v => v ?? null),
    /** 作る。今ある招待は置き換わる（入っていた端末はホストが切る）。 */
    async create({ now = Date.now(), days = INVITE_DEFAULT_DAYS } = {}) {
      const record = newInviteRecord({ now, days });
      await secrets.set(INVITE_KEY, record);
      return record;
    },
    /** 取り消す。あったかどうかを返す。 */
    async revoke() {
      const had = await secrets.get(INVITE_KEY).then(v => v != null);
      await secrets.delete(INVITE_KEY);
      return had;
    },
  };
}
