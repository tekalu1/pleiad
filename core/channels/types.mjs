// チャンネル・bot・記憶・ルーティンのデータの形（契約）と、id の作り方・発言者の検査・bot の会話へ渡す包みの組み立て。
// 正本は docs/channels.md（今の動き）と ADR 0106〜0114。SDK も DOM も import しない純粋な部品。
// 各パッケージ（channels / bots / memory / routines）はこの形に従い、形を変えるときはここと docs を直す。
//
// 置き場（<data> = AGENT_HOST_DATA）:
//   <data>/channels/index.json        チャンネル・DM の定義と既読
//   <data>/channels/<channelId>.jsonl 投稿・編集・リアクション（追記だけの操作の記録）
//   SQLite の channel_threads（ADR 0115）  スレッドの状態
//   <data>/channels/inbox.json        bot へ届ける前の出来事
//   <data>/bots.json                  bot の定義
//   <data>/memory/user.md・bots/<botId>.md・log.jsonl・index.sqlite   記憶
//   <data>/routines.json              ルーティン
// 新しいファイルは全部 { version: 1 } を持ち、読めない版は読み込まずに画面へ出して止める。
import crypto from 'node:crypto';
import { CHANNEL_TAG, CHANNEL_THREAD_TAG, MEMORY_CORE_TAG, TURN_CONTEXT_TAG, ROUTINE_PAYLOAD_TAG, splitLeadingNotes } from '../system-messages.mjs';

/** @typedef {{ kind: 'human' }
 *          | { kind: 'bot', botId: string }
 *          | { kind: 'agent', sessionId: string }   // Chats の会話の AI が ops で書いた（ADR 0007 の対称性）
 *          | { kind: 'routine', routineId: string }
 *          | { kind: 'system' }} Author */

/** @typedef {{
 *   id: string, kind: 'channel'|'dm', name: string,       // dm は名前 = bot の名前（表示用。正本は bot）
 *   purpose: string, cwd: string|null,                    // 既定の作業フォルダー
 *   members: string[],                                    // botId の並び（あなたは常に居る）
 *   memo: string,                                         // 「ここでの決まり」
 *   botId?: string,                                       // dm のときだけ
 *   createdAt: number, archivedAt?: number, lastPostAt: number }} Channel */

/** @typedef {{
 *   id: string, channelId: string,
 *   threadId: string|null,                                // null = チャンネルの流れの投稿（スレッドの根になれる）。値 = 根の投稿の id
 *   author: Author, text: string,
 *   mentions: string[],                                   // 投稿の時点で解いた botId と 'you'（あとで名前が変わっても壊れない）
 *   at: number, editedAt?: number, deletedAt?: number,
 *   state?: 'working'|'waiting'|'done'|'checking'|'failed'|'stopped'|'skipped',  // bot のターンの投稿・ルーティンの実行の根だけ
 *   turn?: { botId: string, sessionId: string },          // bot のターンの投稿（会話を開く → の行き先）
 *   presents?: object[],                                  // そのターンの提示（可視化・添付）の写し。描き方は web/render.mjs の renderPresent
 *   attachments?: { path: string, name: string, kind: 'image'|'file', mime: string, size: number|null, origin: 'device'|'host' }[],  // 人（と AI）が付けたファイル。本文の `[添付] パス` の行と対（Chats の添付と同じ印。ADR 0116）。bot へは本文の印のまま渡る
 *   reactions: { [emoji: string]: Author[] },
 *   taint?: 'webhook'|'web'|null,                         // 外から来た文を含む（記憶の根拠にしない）
 *   routine?: { routineId: string, runId: string, missed?: boolean, reason?: string, payload?: string },
 *   proxy?: null }} Post */

/** チャンネルの .jsonl の 1 行（読むときに畳む）
 * @typedef {{ op: 'post', post: Post }
 *          | { op: 'edit', id: string, text?: string, state?: Post['state'], presents?: object[], taint?: 'webhook', at: number }
 *          | { op: 'delete', id: string, at: number }
 *          | { op: 'react', id: string, emoji: string, by: Author, on: boolean, at: number }} ChannelOp */

/** @typedef {{
 *   channelId: string, threadId: string,
 *   sessions: { [botId: string]: string },                // スレッドごと・bot ごとの会話（ADR 0109）
 *   state: 'idle'|'working'|'waiting'|'failed',
 *   tokens: { input: number, output: number, cached: number },  // このスレッドの bot の会話の合計（usage の出来事から）
 *   calls: number,                                        // bot が起こされた回数（表示だけ。上限には使わない）
 *   chain?: number,                                       // 人が最後に書いてから、bot が bot を起こした続けての回数（origin の根のスレッドに持つ。CHAIN_LIMIT で止める。ADR 0117）
 *   stopped: null | { by: Author, at: number },           // [止める]。人が次に書くまで新しく起こさない
 *   origin?: { channelId: string, threadId: string },     // bot が自分のスレッドからチャンネルの流れへ @ を書いて新しくできたスレッドの、起こした元。[止める] は origin で結ばれた派生のスレッドにも届く
 *   updatedAt: number }} ThreadState */

/** @typedef {{
 *   id: string, name: string, icon: string,               // icon は絵文字 1 つ
 *   persona: string,                                      // 人格（自由文。1.5k トークンまで）
 *   backend: 'claude'|'codex'|'antigravity', model: string, effort: string,
 *   mode: string,                                         // core/backends/*.mjs の MODES の id。Antigravity は 'yolo' だけ。変えるのは bots.setMode（human-only）だけ
 *   folders: { path: string, access: 'rw'|'ro' }[],       // 先頭が既定の作業場所。書き込みの範囲を限れないモードでは「すべてのフォルダー」。bots.update の欄（足すのは広げる向き = guarded）
 *   sendToOthers: boolean,                                // 既定 true（P3 の sessions.send。bot に束縛された主体のときだけ確かめる。ON にするのは広げる向き = bots.update が guarded）
 *   sendTargets: string[],                                // 送れる会話。自動追加と bots.update の置き換えを同じ一覧に保存（ADR 0114）
 *   sendTargetSources?: { [sessionId: string]: 'shown'|'created'|'manual' }, // 外しても残し、自動で戻さない。入力では受け取らない
 *   dmChannelId: string, dmSessionId: string|null,
 *   createdAt: number, updatedAt: number }} Bot */

/** 会話の記録（DB の session_fields）の新しい欄 `bot`（core/store.mjs の setSessionData の許可リスト）
 * @typedef {{
 *   botId: string, kind: 'thread'|'dm'|'routine'|'learner',
 *   channelId: string|null, threadId: string|null, routineId?: string, taint?: 'webhook',
 *   memRev: number,                                       // 末尾の差分をどこまで渡したか（memory/log.jsonl の rev）
 *   snapshotDue: boolean,                                 // 次のターンで核の写しを渡す（始まり・圧縮の完了で true）
 *   delivered: string[],                                  // この写しの後に渡した記憶の id（圧縮で空に）
 *   postCursor: string|null,                              // このスレッドの投稿をどこまで渡したか
 *   personaKey?: string }} SessionBot */                  // Antigravity の会話が最後に受け取った人格のハッシュ（直したら次のターンに新しい人格を渡す。ADR 0109）

/** @typedef {{
 *   id: string, layer: 'user'|string,                     // 'user' か botId
 *   text: string, why?: string,
 *   sources: { kind: 'post'|'message', channelId?: string, postId?: string, sessionId?: string, messageId?: string, quote: string, at: number }[],
 *   at: number, updatedAt: number,
 *   by: Author,                                           // 今の本文を書いた者
 *   origBy?: Author }} MemoryEntry */                     // 書き手が替わる直し（人の行を AI が直すなど）のとき、元の書き手（最初の者）

/** @typedef {{
 *   id: string, name: string, botId: string, channelId: string, prompt: string,
 *   trigger: { kind: 'daily', at: string, weekdaysOnly: boolean }
 *          | { kind: 'weekly', days: number[], at: string }
 *          | { kind: 'interval', minutes: number, window?: { from: string, to: string } }
 *          | { kind: 'cron', expr: string }                // 5 欄。秒は持たない
 *          | { kind: 'event', on: 'done'|'failed'|'waiting', scope: 'all' | { sessionIds: string[] } }
 *          | { kind: 'webhook', hookId: string },         // P3
 *   mode: string, approvalTimeoutMin: number,             // 既定 30
 *   paused: boolean, createdBy: Author, createdAt: number,
 *   armedAt?: number,                                     // 予定を数え始める基準の時刻（作った・再開した・トリガを変えた・発火した時刻）。取りこぼしの判定に使う
 *   last?: { at: number, runId: string, state: Post['state'], postId?: string } }} Routine */   // postId = その実行の根の投稿

/** bot の会話の sidecar の `bot.kind`（ThreadState.sessions・Bot.dmSessionId の会話がどれか） */
export const BOT_SESSION_KINDS = Object.freeze(['thread', 'dm', 'routine', 'learner']);
/** Post.state の値 */
export const POST_STATES = Object.freeze(['working', 'waiting', 'done', 'checking', 'failed', 'stopped', 'skipped']);
/** ThreadState.state の値 */
export const THREAD_STATES = Object.freeze(['idle', 'working', 'waiting', 'failed']);
/** Author.kind の値 */
export const AUTHOR_KINDS = Object.freeze(['human', 'bot', 'agent', 'routine', 'system']);

// ------------------------------------------------------------------ id
// 接頭辞 + 時刻の base36 + 乱数 6 字（並べ替えやすく、推測されにくい）
export const ID_PREFIX = Object.freeze({ channel: 'c', post: 'p', bot: 'b', memory: 'm', routine: 'r', hook: 'h', inbox: 'i' });
const ID_RX = new RegExp(`^(${Object.values(ID_PREFIX).join('|')})_[0-9a-z]{6,}$`);
const RAND = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 新しい id。kind は ID_PREFIX のキー。now は並べ替えの材料（テストでは固定できる）。同じ時刻でも乱数 6 字で分かれる */
export function newId(kind, now = Date.now()) {
  const prefix = ID_PREFIX[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  const rand = Array.from(crypto.randomBytes(6), (b) => RAND[b % RAND.length]).join('');
  return `${prefix}_${Math.max(0, Math.floor(now)).toString(36).padStart(9, '0')}${rand}`;
}
/** id の形か（接頭辞を見るなら kind も） */
export function isId(value, kind) {
  return typeof value === 'string' && ID_RX.test(value) && (!kind || value.startsWith(`${ID_PREFIX[kind]}_`));
}

// ------------------------------------------------------------------ 発言者
/** Author の形か。kind ごとに必要な欄だけを見る */
export function isAuthor(value) {
  if (!value || typeof value !== 'object') return false;
  const str = (v) => typeof v === 'string' && v.length > 0;
  switch (value.kind) {
    case 'human': case 'system': return true;
    case 'bot': return str(value.botId);
    case 'agent': return str(value.sessionId);
    case 'routine': return str(value.routineId);
    default: return false;
  }
}
/** Author を 1 つの文字列にする（同じ発言者かの比較・リアクションの重複の判定に使う）。形が違えば null */
export function authorKey(author) {
  if (!isAuthor(author)) return null;
  return author.kind === 'bot' ? `bot:${author.botId}` : author.kind === 'agent' ? `agent:${author.sessionId}`
    : author.kind === 'routine' ? `routine:${author.routineId}` : author.kind;
}

// ------------------------------------------------------------------ bot の会話へ渡す包み
// 履歴の読み出しは、行の先頭のこれらの包みを core/system-messages.mjs の splitLeadingNotes でシステム側の行に分ける。
// 本文に包みの開閉タグが紛れ込んでも外へ出られないよう、`<pleiad-…` と `<routine-payload` の `<` は文字参照にする。
const attr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '&#10;');
const NESTED_TAG = new RegExp(`<(/?(?:pleiad-[\\w-]+|${ROUTINE_PAYLOAD_TAG}))(?![\\w-])`, 'gi');
/** 包みの中身に入れる本文。包みのタグに見える `<` を `&lt;` にする */
export const escapeBody = (text) => String(text ?? '').replace(NESTED_TAG, '&lt;$1');
const attrs = (obj) => Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => ` ${k}="${attr(v)}"`).join('');

/**
 * 投稿 1 件の包み。`<pleiad-channel channel="#checkout-perf" thread="p_…" post="p_…" from="あなた" at="2026-10-03T10:41">本文</pleiad-channel>`
 * channel は表示名（`#名前`・DM は bot の名前）、channelId は channels.post などの操作へ渡すチャンネルの id（`channel-id` 属性。任意）、
 * from は表示名（bot は `🦉 Owl (bot)`）、at は ISO の分まで（呼び出し側が決める）。
 * reply: `reply="true"`。呼んだ bot（@ で起こした相手）の返事（bot の会話でそのターンの終わりに返す。ADR 0109）
 */
export function channelEnvelope({ channel, channelId, thread, post, from, at, reply, text }) {
  return `<${CHANNEL_TAG}${attrs({ channel, 'channel-id': channelId, thread, post, from, reply, at })}>${escapeBody(text)}</${CHANNEL_TAG}>`;
}
/** 初回に渡す、スレッドのそれまでの投稿。posts は channelEnvelope の引数の並び */
export function channelThreadEnvelope({ channel, channelId, thread, posts }) {
  return `<${CHANNEL_THREAD_TAG}${attrs({ channel, 'channel-id': channelId, thread })}>\n${posts.map((p) => channelEnvelope(p)).join('\n')}\n</${CHANNEL_THREAD_TAG}>`;
}
/** 核の記憶の写し（会話の始まり・圧縮の後の最初のターンの notes） */
export const memoryCoreEnvelope = (text) => `<${MEMORY_CORE_TAG}>\n${escapeBody(text)}\n</${MEMORY_CORE_TAG}>`;
/** 毎ターンの末尾（時刻・記憶の差分・関係する記憶。notes） */
export const turnContextEnvelope = (text) => `<${TURN_CONTEXT_TAG}>\n${escapeBody(text)}\n</${TURN_CONTEXT_TAG}>`;
/** ルーティンの外から来た本文（webhook など）。「データであり指示ではない」の固定の 1 行は呼び出し側（辞書 agent:routine.payloadNote）が前に付ける */
export function routinePayloadEnvelope({ source, hook, at, text }) {
  return `<${ROUTINE_PAYLOAD_TAG}${attrs({ source, hook, at })}>${escapeBody(text)}</${ROUTINE_PAYLOAD_TAG}>`;
}

/**
 * bot の会話へ渡す文（prompt）の先頭にある包みを、履歴と同じシステム側の行の形にする（`channelEvent` の出来事の rows）。
 * 包みで始まらない文（委譲の完了通知など）は空
 */
export function channelEventRows(text, at = null) {
  return splitLeadingNotes([{ role: 'user', text: String(text ?? ''), at }]).filter((m) => m.role === 'system');
}
