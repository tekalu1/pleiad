// 通知の一覧（受信箱。ADR 9102）。通知ボタンの面に出す「あなたに向けた出来事」を、サーバーの DB（notifications 表。core/db.mjs）に残す。
//
// 載せる種類は 4 つだけ:
//   wait    … あなた待ち（承認・質問）。決着したら resolvedAt が付き、既読になる（「承認済み」と弱く出す）
//   failed  … ターンの失敗
//   done    … ターンの完了
//   mention … 人以外の投稿の @あなた
// チャンネルの新着・ルーティンの結果・委譲の完了は載せない（脇の印・投稿の状態で見える）。
//
// 規則:
//   - 書く側は同じ出来事を何度渡してもよい（dedupeKey が同じなら載せない）。完了は `done:<会話>:<completedAt>`・あなた待ちは `wait:<承認の id>`・メンションは `mention:<投稿の id>`
//   - いま見ている会話で起きたものは、最初から既読で載せる（viewing）
//   - 既読は通知ごと（readAt）。会話の既読（readAt・markRead）とチャンネルの既読（channels.markRead）が進むと、対応する通知も既読になる（markSession・markChannel）
//   - 上限: NOTIFICATION_MAX 件・NOTIFICATION_KEEP_MS（古い方から捨てる。既読を先に）。会話を消す・チャンネルをアーカイブすると、その行も消す
//   - あなた待ちの承認はメモリにしか無く、再起動で消える。起動時に、決着していないあなた待ちを 'cancelled' で決着させる（settleAllWaiting）
//
//   createNotifications({ dataDir, emit, now }) → Notifications
//     add({ kind, dedupeKey, at, sessionId?, channelId?, viewing?, data }): 行 | null     … null は重複・上限外。新しく載せたら notificationsChanged を出す
//     list({ filter?, before?, limit? }): { items, unread, waiting, hasMore }
//     counts(): { unread, waiting }
//     markRead({ ids?, all? }): { changed }
//     markSession(sessionId, upTo, kinds?)・markChannel(channelId, upTo)  … 会話・チャンネルの既読に合わせる
//     settle(dedupeKey, outcome)  … あなた待ちの決着（outcome: allowed | answered | denied | cancelled）
//     settleAllWaiting(outcome)・removeSession(id)・removeChannel(id)・close()
//   emit({ type: 'notificationsChanged', unread, waiting }) … 件数が変わったとき（画面のベルの数。リモートの端末にも届く）
//   行（公開）: { id, seq, kind, at, unread, resolvedAt?, outcome?, target: { sessionId?, uuid?, channelId?, threadId?, postId? },
//                actor?: { kind: 'bot' | 'agent', name, icon? }, ask?: 'approval' | 'question', title?, channelName?, threadTitle? }
import crypto from 'node:crypto';
import { openData } from './data-schema.mjs';
import { notificationTable } from './db.mjs';

const DAY = 86_400_000;
export const NOTIFICATION_KINDS = Object.freeze(['wait', 'failed', 'done', 'mention']);
/** 残す件数の上限（超えたら古い方から。既読を先に捨てる） */
export const NOTIFICATION_MAX = 200;
/** 残す期間（これより古い行は捨てる） */
export const NOTIFICATION_KEEP_MS = 30 * DAY;
export const NOTIFICATION_PAGE = 50;
export const NOTIFICATION_PAGE_MAX = 100;
/** 絞り込み → 種類 */
const FILTERS = { all: null, wait: ['wait'], mention: ['mention'] };

const clip = (s, n) => [...String(s ?? '').replace(/\s+/g, ' ').trim()].slice(0, n).join('');
const DATA_KEYS = ['uuid', 'threadId', 'postId', 'actor', 'ask', 'title', 'channelName', 'threadTitle', 'outcome'];

export function createNotifications({ dataDir, emit = () => {}, now = Date.now } = {}) {
  let handle = null, table = null;
  const open = () => { if (!table) { handle = openData(dataDir); table = notificationTable(handle.db); } return table; };
  const changed = () => {
    try { emit({ type: 'notificationsChanged', ...counts() }); } catch { /* 画面への知らせの失敗で保存を戻さない */ }
  };
  function counts() { const { unread, waiting } = open().counts(); return { unread, waiting }; }

  const publicRow = (r) => ({
    id: r.id, seq: r.seq, kind: r.kind, at: r.at, unread: r.readAt == null,
    ...(r.resolvedAt != null ? { resolvedAt: r.resolvedAt } : {}),
    ...(r.data.outcome ? { outcome: r.data.outcome } : {}),
    target: {
      ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.data.uuid ? { uuid: r.data.uuid } : {}),
      ...(r.channelId ? { channelId: r.channelId } : {}), ...(r.data.threadId ? { threadId: r.data.threadId } : {}), ...(r.data.postId ? { postId: r.data.postId } : {}),
    },
    ...(r.data.actor ? { actor: r.data.actor } : {}), ...(r.data.ask ? { ask: r.data.ask } : {}),
    ...(r.data.title ? { title: r.data.title } : {}), ...(r.data.channelName ? { channelName: r.data.channelName } : {}), ...(r.data.threadTitle ? { threadTitle: r.data.threadTitle } : {}),
  });

  const api = {
    add({ kind, dedupeKey, at, sessionId = null, channelId = null, viewing = false, data = {} }) {
      if (!NOTIFICATION_KINDS.includes(kind) || typeof dedupeKey !== 'string' || !dedupeKey) throw new Error('notification needs a kind and a dedupeKey');
      const t = now();
      const when = Number.isFinite(at) ? at : t;
      if (when < t - NOTIFICATION_KEEP_MS) return null;
      const kept = {};
      for (const key of DATA_KEYS) if (data[key] !== undefined && data[key] !== null && data[key] !== '') kept[key] = data[key];
      for (const key of ['title', 'channelName', 'threadTitle']) if (kept[key]) kept[key] = clip(kept[key], 120);
      if (kept.actor) kept.actor = { kind: kept.actor.kind, name: clip(kept.actor.name, 60), ...(kept.actor.icon ? { icon: clip(kept.actor.icon, 16) } : {}) };
      const row = { id: `n_${crypto.randomBytes(6).toString('hex')}`, dedupeKey, kind, at: when, sessionId, channelId, readAt: viewing ? t : null, data: kept };
      const added = open().insert(row);
      if (!added) return null;
      open().prune(t - NOTIFICATION_KEEP_MS, NOTIFICATION_MAX);
      changed();
      return publicRow({ ...row, seq: 0, resolvedAt: null });
    },

    list({ filter = 'all', before = null, limit = NOTIFICATION_PAGE } = {}) {
      const kinds = Object.hasOwn(FILTERS, filter) ? FILTERS[filter] : null;
      const size = Math.min(Math.max(Math.trunc(limit) || NOTIFICATION_PAGE, 1), NOTIFICATION_PAGE_MAX);
      const rows = open().list({ kinds, before: Number.isFinite(before) ? before : null, limit: size + 1 });
      return { items: rows.slice(0, size).map(publicRow), hasMore: rows.length > size, ...counts() };
    },
    counts,

    markRead({ ids = null, all = false } = {}) {
      const t = now();
      const n = all ? open().markAll(t) : open().markIds(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [], t);
      if (n) changed();
      return { changed: n };
    },
    /** 会話の既読（readAt）が upTo まで進んだ。その会話の完了・失敗の通知（at = completedAt）を既読にする。kinds を渡せば種類を絞る */
    markSession(sessionId, upTo, kinds = ['done', 'failed']) {
      if (typeof sessionId !== 'string' || !Number.isFinite(upTo)) return 0;
      const n = open().markSession(sessionId, upTo, now(), kinds);
      if (n) changed();
      return n;
    },
    /** その会話を見た（presence）。承認・質問・完了・失敗・メンションを、いまの時刻までまとめて既読にする */
    viewSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return 0;
      const n = open().markSession(sessionId, Number.MAX_SAFE_INTEGER, now(), null);
      if (n) changed();
      return n;
    },
    /** チャンネルの既読（channels.markRead の readAt）が進んだ。そのチャンネルの通知を upTo まで既読にする */
    markChannel(channelId, upTo) {
      if (typeof channelId !== 'string' || !Number.isFinite(upTo)) return 0;
      const n = open().markChannel(channelId, upTo, now());
      if (n) changed();
      return n;
    },

    settle(dedupeKey, outcome) {
      if (!open().resolve(dedupeKey, now(), outcome)) return false;
      changed();
      return true;
    },
    settleAllWaiting(outcome = 'cancelled') {
      const n = open().resolveAllWaiting(now(), outcome);
      if (n) changed();
      return n;
    },
    removeSession(sessionId) { const n = open().removeSession(sessionId); if (n) changed(); return n; },
    removeChannel(channelId) { const n = open().removeChannel(channelId); if (n) changed(); return n; },
    /** DB の接続を離す（データ置き場を消す前。以後に呼べば開き直す） */
    close() { handle?.release(); handle = null; table = null; },
  };
  return api;
}

/**
 * ターンの終わりを会話の状態から作る材料。bot の会話は完了を載せず（失敗だけ）、隠れた会話・委譲の子は載せない（今の通知の規則。ADR 0109・0127）。
 * 載せるなら 'done' | 'failed'、載せないなら null
 */
export function completionKind({ outcome, bot = null, delegation = null, hiddenKinds = new Set() }) {
  if (delegation) return null;
  if (bot && hiddenKinds.has(bot.kind)) return null;
  if (outcome === 'error') return 'failed';
  if (outcome === 'ok') return bot ? null : 'done';
  return null;
}

/** 承認の決着（settle に渡された答え）→ 通知の outcome */
export function permissionOutcome(answer, { kind = 'tool' } = {}) {
  if (answer?.messageKey) return 'cancelled';   // ターンの終了・中断・取り下げ（aborted・turnEnded など）
  if (answer?.allow !== true) return 'denied';
  return kind === 'question' ? 'answered' : 'allowed';
}
