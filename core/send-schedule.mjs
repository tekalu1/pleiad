// 送信予定（schedule.json の kind: 'send'）の取り決め。副作用の無い関数だけ（ADR 0103、docs/design.md「送信予定」）。
//
// 時刻は UTC のミリ秒で持つ。画面が見ている端末の時刻帯で出す。
// 送信予定は送信待ち（outbox）の状態にしない。送信待ちは再起動で保留になり、順番も塞ぐので、
// 時刻が来たときに outbox.accept（ふつうの送信と同じ二重送信防止・順序）へ渡す。
import { t } from './i18n.mjs';

/** 時刻から遅れてもよい長さ。これを超えたら送らず、人に確かめさせる（スリープ・閉じていた間に過ぎた予定） */
export const GRACE_MS = 60 * 60_000;
/** 何日先まで指定できるか */
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
/** 今から指定できる最短（これより近いなら「今すぐ送る」） */
export const MIN_AHEAD_MS = 1_000;
export const MAX_PER_SESSION = 50;
export const MAX_TOTAL = 500;
/** 会話に覚えておく送信予定の記録（遅れて送ったことを履歴の発言に添えるため）の数 */
export const MAX_RECORDS = 30;

const MESSAGE_ID = /^[a-zA-Z0-9-]{8,80}$/;

/** 時刻の指定（ミリ秒・ISO の文字）を数にする。読めなければ NaN */
export function parseAt(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
  return NaN;
}

/**
 * 送信予定の行を作る。会話の存在・枠の数は呼び出し側が確かめる。足りない・おかしい指定は理由つきの Error
 * @returns schedule.json の行（id は送信の messageId から決まるので、同じ指定を送り直しても 1 件）
 */
export function buildSendRow({ sessionId, messageId, prompt, attachments, cwd, mode, at, by = 'human' }, now = Date.now()) {
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw new Error(t('send.messageIdRequired'));
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(t('send.messageRequired'));
  if (attachments !== undefined && !Array.isArray(attachments)) throw new Error(t('send.invalidAttachments'));
  const when = parseAt(at);
  if (!Number.isFinite(when)) throw new Error(t('schedule.invalidTime'));
  if (when < now + MIN_AHEAD_MS) throw new Error(t('schedule.past'));
  if (when - now > MAX_AHEAD_MS) throw new Error(t('schedule.tooFar'));
  const args = { prompt, ...(attachments ? { attachments } : {}), ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}) };
  return { id: `send:${messageId}`, kind: 'send', sessionId, messageId, at: Math.round(when), createdAt: now, by, args };
}

/**
 * スレッドへの投稿の予定の行（kind: 'post'。ADR 0157）。本文は送信予定と同じく args.prompt に置く（画面の予定の行が同じ形で描く）。
 * id は投稿の clientId から決まるので、同じ指定を送り直しても 1 件。チャンネル・スレッドの存在と枠の数は呼び出し側が確かめる
 */
export function buildPostRow({ channelId, threadId, clientId, text, attachments, to, at, by = 'human' }, now = Date.now()) {
  if (typeof clientId !== 'string' || !MESSAGE_ID.test(clientId)) throw new Error(t('send.messageIdRequired'));
  if (typeof text !== 'string' || !text.trim()) throw new Error(t('send.messageRequired'));
  if (attachments !== undefined && !Array.isArray(attachments)) throw new Error(t('send.invalidAttachments'));
  const when = parseAt(at);
  if (!Number.isFinite(when)) throw new Error(t('schedule.invalidTime'));
  if (when < now + MIN_AHEAD_MS) throw new Error(t('schedule.past'));
  if (when - now > MAX_AHEAD_MS) throw new Error(t('schedule.tooFar'));
  const args = { prompt: text, ...(attachments?.length ? { attachments } : {}), ...(to ? { to } : {}) };
  return { id: `post:${clientId}`, kind: 'post', channelId, threadId, clientId, at: Math.round(when), createdAt: now, by, args };
}

/**
 * 時刻が来た送信予定をどうするか。
 * send = 送る（lateMs は遅れ。0 に近ければ時刻どおり）、hold = 遅れすぎているので送らず確かめさせる
 */
export function decideFire(row, now = Date.now()) {
  const lateMs = Math.max(0, now - row.at);
  return lateMs > GRACE_MS ? { action: 'hold', lateMs } : { action: 'send', lateMs };
}

/** outbox に渡す引数。予定の時刻を添えるので、送った発言が「9:00 の予定を 9:32 に送りました」を出せる */
export const sendArgs = (row) => ({ ...row.args, scheduledFor: row.at });

/**
 * 履歴の発言に、送信予定の時刻（scheduledFor）を付ける。records は会話に覚えた { text, planned }（古い順）。
 * 本文が同じで、予定の時刻より後の最初の発言に 1 件ずつ当てる。画面は遅れて送ったものにだけ一言を出す
 */
export function decorateScheduled(messages, records) {
  if (!records?.length) return messages;
  const used = new Set();
  return messages.map(m => {
    if (m?.role !== 'user' || m.kind || typeof m.text !== 'string') return m;
    const at = Date.parse(m.at ?? '');
    if (!Number.isFinite(at)) return m;
    const i = records.findIndex((r, index) => !used.has(index) && at >= r.planned - 1000 && r.text.trim() === m.text.trim());
    if (i < 0) return m;
    used.add(i);
    return { ...m, scheduledFor: records[i].planned };
  });
}

/** 会話に覚える記録を足す（古いものから捨てて MAX_RECORDS 件まで） */
export const addRecord = (records, row) => [...(records ?? []), { text: row.args.prompt, planned: row.at }].slice(-MAX_RECORDS);
