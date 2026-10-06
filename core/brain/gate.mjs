// 心拍のふるい（ADR 0126）。**モデルを呼ぶ前に** コードで決める純粋な関数（SDK も DB も import しない）。
// 通らなければ安いモデルも呼ばず、思考の流れに「静か」の 1 行だけ残す。コスト（0 円で決まるものはモデルに聞かない）と安全（予算・止めた bot）の両方を持つ。
//
//   gate({ now, paused, allowed, events, loops, reservedAt, drives, sinceMuse, force }) → { pass, reason, loopId?, keepUnread?, museEvery }
//     paused … 人が止めた bot（眠らせた）。allowed … 予算が残っている（0 なら自発は止まる）
//     events … 未読の出来事 [{ threadId, channelId, text, authorKind: 'human'|'bot'|'other', toMe, taint }]（自分の投稿・system は呼ぶ側で除く）
//     loops … 開いている気がかり [{ id, wakeOn: { thread?, word?, at? } | null }]
//     reservedAt … bot が決めた「次に起きたい時刻」（ms。無ければ null）。drives … computeDrives の結果。sinceMuse … 前のぼんやりから何回目か
//     force … 人が［今すぐ］を押した（ふるいは通すが、止めた bot と予算は越えない）
//   reason: 'paused' | 'budget'（止めた。keepUnread: 未読はカーソルを進めず残す）／ 'forced' | 'loop' | 'reserved' | 'human'（新しい投稿。人・他の bot） | 'drive' | 'muse'（通した）／ 'nothing'（止めた）
import { DRIVE_NAMES } from './drives.mjs';

/** 欲求のどれかがこれ以上なら通す */
export const DRIVE_PASS = 0.7;
/** ぼんやりの番（何もなくても 1 回は考える）の間隔のもと。疲れると伸びる */
export const MUSE_BASE = 4;
export const museEvery = (fatigue) => MUSE_BASE + Math.round(Math.max(0, Math.min(1, fatigue ?? 0)) * 8);

const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

/** 気がかりの「起こしてほしい条件」が、この出来事に当たるか。at（時刻）は出来事ではなく時計なので、ここでは見ない（loopDue） */
export function wakeMatches(wakeOn, event) {
  if (!wakeOn || !event) return false;
  if (wakeOn.thread && event.threadId === wakeOn.thread) return true;
  if (wakeOn.word && fold(event.text).includes(fold(wakeOn.word))) return true;
  return false;
}
/** 時刻の条件が来ているか */
export const wakeDue = (wakeOn, now) => Number.isFinite(wakeOn?.at) && wakeOn.at <= now;

export function gate({ now, paused = false, allowed = true, events = [], loops = [], reservedAt = null, drives = {}, sinceMuse = 0, force = false } = {}) {
  const every = museEvery(drives.fatigue);
  if (paused) return { pass: false, reason: 'paused', museEvery: every };
  if (!allowed) return { pass: false, reason: 'budget', keepUnread: true, museEvery: every };
  if (force) return { pass: true, reason: 'forced', museEvery: every };
  for (const loop of loops) {
    if (wakeDue(loop.wakeOn, now) || events.some((e) => wakeMatches(loop.wakeOn, e))) return { pass: true, reason: 'loop', loopId: loop.id, museEvery: every };
  }
  if (Number.isFinite(reservedAt) && reservedAt <= now) return { pass: true, reason: 'reserved', museEvery: every };
  // 新しい投稿（人・他の bot。自分宛てでないもの。自分宛てはふつうの道で賢いモデルが起きる）。書き手が人か bot かでは分けない。
  // reason の名前 'human' は、人の投稿だけを通していた頃のまま（思考の流れの行に残っている）
  if (events.some((e) => (e.authorKind === 'human' || e.authorKind === 'bot') && !e.toMe)) return { pass: true, reason: 'human', museEvery: every };
  const strong = DRIVE_NAMES.filter((name) => (drives[name] ?? 0) >= DRIVE_PASS && name !== 'fatigue');
  if (strong.length) return { pass: true, reason: 'drive', detail: strong[0], museEvery: every };
  if (sinceMuse >= every) return { pass: true, reason: 'muse', museEvery: every };
  return { pass: false, reason: 'nothing', museEvery: every };
}
