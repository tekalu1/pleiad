// 離れた端末へ通知を送るかどうかの判定（docs/design.md「通知」、ADR 0086）。副作用のない関数だけ。
//
// 種類: approval / question（返事が要るとき）・failed（失敗したとき）・done（終わったとき）。
// 送らない: 端末がその種類を切っている・その会話を見ている（その端末自身の画面、または設定が許す他の画面）・
//           2 分より古い完了・30 秒未満のターンの完了。委譲の子の完了は呼び出し側が渡さない（依頼元の完了に含む）。

export const SHORT_TURN_MS = 30_000;
export const STALE_DONE_MS = 2 * 60_000;
export const PRESENCE_TTL_MS = 150_000;
/** 中継に溜めておく寿命。完了は古くなると意味が無い。返事待ち・失敗は戻ってから気づけるように少し長く。 */
export const TTL_MS = Object.freeze({ done: STALE_DONE_MS, approval: 10 * 60_000, question: 10 * 60_000, failed: 10 * 60_000, cancel: 10 * 60_000 });

export const DEFAULT_DEVICE_SETTINGS = Object.freeze({ enabled: false, reply: true, failed: true, done: true, lockNames: false, skipPc: true });
export const DEFAULT_PC_SETTINGS = Object.freeze({ done: true, reply: true, failed: true });

const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

/** 端末から届いた設定を形に直す。知らない項目は捨て、無い項目は既定。 */
export function normalizeDeviceSettings(raw, base = DEFAULT_DEVICE_SETTINGS) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: bool(r.enabled, base.enabled),
    reply: bool(r.reply, base.reply),
    failed: bool(r.failed, base.failed),
    done: bool(r.done, base.done),
    lockNames: bool(r.lockNames, base.lockNames),
    skipPc: bool(r.skipPc, base.skipPc),
  };
}

export function normalizePcSettings(raw, base = DEFAULT_PC_SETTINGS) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { done: bool(r.done, base.done), reply: bool(r.reply, base.reply), failed: bool(r.failed, base.failed) };
}

/** 設定の項目名。approval と question はどちらも「返事が要るとき」。 */
export const settingOf = kind => kind === 'approval' || kind === 'question' ? 'reply' : kind === 'failed' ? 'failed' : kind === 'done' ? 'done' : null;

export const ttlFor = kind => TTL_MS[kind] ?? TTL_MS.cancel;

/**
 * その会話を、今だれかが見ているか。presence は { deviceId, visible, sessionId, at } の配列。
 * 端末自身の画面が見ていれば常に true。ほかの画面（PC・別の端末）は skipOthers のときだけ数える。
 */
export function isViewed(presence, { sessionId, deviceId, skipOthers, now }) {
  return presence.some(p => p.visible && p.sessionId === sessionId && now - p.at <= PRESENCE_TTL_MS
    && (p.deviceId === deviceId || skipOthers));
}

/**
 * 1 台の端末へ、この出来事を送るか。
 * @param {{kind:string, device:{id:string, settings:object, muted?:boolean}, sessionId:string, completedAt?:number,
 *          durationMs?:number, presence:object[], now:number, shortTurnMs?:number}} input
 * @returns {{send:true}|{send:false, reason:string}}
 */
export function decideSend({ kind, device, sessionId, completedAt, durationMs, presence, now, shortTurnMs = SHORT_TURN_MS }) {
  const s = device.settings;
  if (!s?.enabled) return { send: false, reason: 'off' };
  if (device.muted) return { send: false, reason: 'muted' };
  const key = settingOf(kind);
  if (!key) return { send: false, reason: 'kind' };
  if (!s[key]) return { send: false, reason: 'kind-off' };
  if (kind === 'done') {
    if (Number.isFinite(completedAt) && now - completedAt > STALE_DONE_MS) return { send: false, reason: 'stale' };
    if (Number.isFinite(durationMs) && durationMs < shortTurnMs) return { send: false, reason: 'short' };
  }
  if (isViewed(presence, { sessionId, deviceId: device.id, skipOthers: s.skipPc, now })) return { send: false, reason: 'viewing' };
  return { send: true };
}
