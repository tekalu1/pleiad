// 離れた端末（スマホ）への通知を決めて送る部品（ADR 0086）。ホストの出来事を受け、端末ごとの設定で絞り、
// 端末ごとの通知鍵で暗号化して、中継の通知の線へ渡す。出ている通知を消す取り消しも同じ線で送る。
//
// 判定は policy.mjs（種類・見ている会話・古さ・短さ）。束ねる・上書きする・文面は端末が作る（ホストは構造化した中身を送る）。
import { sealNotice } from './crypto.mjs';
import { decideSend, ttlFor } from './policy.mjs';

const OUTSTANDING_MAX = 200;   // 端末ごとに覚える会話の数

/**
 * @param devices   () => [{ id, platform, key: Buffer, settings, muted }]  通知を受けられる端末
 * @param presence  core/notify/presence.mjs
 * @param send      (deviceId, blob, ttlMs) => boolean  中継の通知の線へ渡す。渡せなかったら false
 * @param host      () => ({ hostId, hostName })
 * @param onSent    (deviceId, at) => void  最後に送った時刻の記録
 */
export function createPushNotifier({ devices, presence, send, host, now = Date.now, onSent = () => {}, log = () => {}, shortTurnMs }) {
  let seq = 0;
  /** deviceId -> sessionId -> { approvals: Set<id>, seen: boolean }。出ているはずの通知（取り消しを送る相手を絞る）。 */
  const outstanding = new Map();

  const nextSeq = () => { seq = Math.max(seq + 1, now()); return seq; };

  function slot(deviceId, sessionId) {
    let sessions = outstanding.get(deviceId);
    if (!sessions) outstanding.set(deviceId, sessions = new Map());
    let entry = sessions.get(sessionId);
    if (!entry) {
      if (sessions.size >= OUTSTANDING_MAX) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionId, entry = { approvals: new Set(), seen: false });
    }
    return entry;
  }

  function deliver(device, notice) {
    const info = host();
    if (!info?.hostId) return false;   // 中継につなぐ前（鍵も hostId も無い）
    const { hostId, hostName } = info;
    const full = { seq: nextSeq(), at: now(), hostId, host: hostName, ...notice };
    try {
      const blob = sealNotice(device.key, { hostId, deviceId: device.id }, full);
      const ok = send(device.id, blob, ttlFor(notice.kind));
      if (ok) onSent(device.id, full.at);
      return ok;
    } catch (e) {
      log(`push notice: ${e.message}`);
      return false;
    }
  }

  function toEach(kind, input, fn) {
    const t = now();
    const sent = [];
    for (const device of devices()) {
      const verdict = decideSend({ kind, device, sessionId: input.sessionId, completedAt: input.completedAt, durationMs: input.durationMs, presence: presence.entries(), now: t, shortTurnMs });
      if (!verdict.send) continue;
      if (fn(device)) sent.push(device.id);
    }
    return sent;
  }

  function cancelTo(device, notice) {
    if (!device.settings?.enabled || device.muted) return false;
    return deliver(device, { kind: 'cancel', ...notice });
  }

  return {
    /** 承認・質問を求めた。title は会話名（無ければ空）。 */
    approval({ id, sessionId, kind, title }) {
      if (!sessionId || !id) return [];
      const noticeKind = kind === 'question' ? 'question' : 'approval';
      return toEach(noticeKind, { sessionId }, device => {
        const ok = deliver(device, { kind: noticeKind, session: sessionId, title, id });
        if (ok) slot(device.id, sessionId).approvals.add(id);
        return ok;
      });
    },

    /** 承認・質問が決着した（どの端末で答えても、ターンが終わっても）。出ている通知を消す。 */
    approvalResolved({ id, sessionId }) {
      if (!sessionId || !id) return [];
      const sent = [];
      for (const device of devices()) {
        const entry = outstanding.get(device.id)?.get(sessionId);
        if (!entry?.approvals.delete(id)) continue;
        if (!entry.approvals.size && !entry.seen) outstanding.get(device.id).delete(sessionId);
        if (cancelTo(device, { session: sessionId, cancel: 'approval', id })) sent.push(device.id);
      }
      return sent;
    },

    /** ターンが終わって落ち着いた（子の作業も終わった）。outcome は ok か error。中断は呼ばない。 */
    finished({ sessionId, outcome, completedAt, startedAt, title }) {
      if (!sessionId || (outcome !== 'ok' && outcome !== 'error')) return [];
      const kind = outcome === 'ok' ? 'done' : 'failed';
      const durationMs = Number.isFinite(startedAt) && Number.isFinite(completedAt) ? completedAt - startedAt : undefined;
      return toEach(kind, { sessionId, completedAt, durationMs }, device => {
        const ok = deliver(device, { kind, session: sessionId, title });
        if (ok) slot(device.id, sessionId).seen = true;
        return ok;
      });
    },

    /** 送信予定の時刻に Pleiad が動いていなかったので、送らずに確かめを待っている。 */
    scheduleMissed({ sessionId, title }) {
      if (!sessionId) return [];
      return toEach('scheduleMissed', { sessionId }, device => {
        const ok = deliver(device, { kind: 'scheduleMissed', session: sessionId, title });
        if (ok) slot(device.id, sessionId).seen = true;
        return ok;
      });
    },

    /** どこかでその会話を見た（既読にした・開いた）。出ている完了・失敗の通知を消す。 */
    viewed(sessionId) {
      if (!sessionId) return [];
      const sent = [];
      for (const device of devices()) {
        const entry = outstanding.get(device.id)?.get(sessionId);
        if (!entry?.seen) continue;
        entry.seen = false;
        if (!entry.approvals.size) outstanding.get(device.id).delete(sessionId);
        if (cancelTo(device, { session: sessionId, cancel: 'seen' })) sent.push(device.id);
      }
      return sent;
    },

    /** 試験用。 */
    outstanding: () => outstanding,
  };
}
