// スレッドの状態（ThreadState）の保存（S1。ADR 0109）。SQLite の channel_threads（キーは channelId/rootPostId、値は ThreadState。1 スレッド 1 行。ADR 0115。以前は channels/threads.json だったが、
// スレッドの数だけ増えて、トークンの足し算のたびに全体を書き直していたので行にした）。
// スレッドの本体（投稿）は channels/<channelId>.jsonl。ここにあるのは「どの bot がどの会話で・作業中か・トークン・止めた印」だけ。
//
//   createThreadStore({ dir, dataDir?, now }) → { get, list, update, load, close }
//     get(channelId, threadId): Promise<ThreadState|null>
//     list(channelId?): Promise<ThreadState[]>
//     update(channelId, threadId, patch | (current) => patch): Promise<ThreadState>
//         … 無ければ空のスレッドから作る。patch の欄: sessions（bot ごとに足す）・state・live（動いている bot ごとの状態 { [botId]: 'working'|'waiting' }。丸ごと置き換える。空で外す）・tokens（欄ごとに足し直す）・calls・spend（{ day: 'YYYY-MM-DD', percent }。チャンネルの予算に数えた、その日に使った分。ADR 0119）・stopped・origin（{ channelId, threadId }。bot が自分のスレッドから起こして新しくできたスレッドの、起こした元。null で外す）。
//           関数で渡すと、直列化された中で今の値（写し）を受け取って patch を返す（トークンの足し算など、読んでから書く更新はこちら）
//   emptyThread(channelId, threadId, now) → ThreadState
import path from 'node:path';
import { openData } from '../data-schema.mjs';
import { threadTable } from '../db.mjs';
import { THREAD_STATES, isAuthor } from './types.mjs';
import { DAY_RX } from './budget.mjs';

export const threadKey = (channelId, threadId) => `${channelId}/${threadId}`;

/** スレッドの状態の名前の字数の上限（会話の状態と同じ） */
export const THREAD_STATUS_MAX = 60;
/** 人が付けるスレッドの題の字数の上限（根の投稿から作る題と同じ） */
export const THREAD_TITLE_MAX = 120;

/** スレッドの題: 根の投稿の最初の行（先頭の @ の呼びかけは外す）。web/channels/thread.mjs の titleOf と同じ決まり */
export function threadTitle(text) {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const plain = line.replace(/\s+/g, ' ').trim();
  const stripped = plain.replace(/^(?:@\S+\s*)+/, '').trim();
  return (stripped || plain).slice(0, 120);
}

export function emptyThread(channelId, threadId, now = Date.now()) {
  return { channelId, threadId, sessions: {}, state: 'idle', tokens: { input: 0, output: 0, cached: 0 }, calls: 0, stopped: null, updatedAt: now };
}

const num = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback);

/** patch を検査して現在の値へ重ねる（知らない欄は捨てる） */
export function applyThreadPatch(current, patch, now) {
  const next = structuredClone(current);
  if (patch.sessions && typeof patch.sessions === 'object') {
    for (const [botId, sessionId] of Object.entries(patch.sessions)) {
      if (typeof sessionId === 'string' && sessionId) next.sessions[botId] = sessionId;
      else if (sessionId === null) delete next.sessions[botId];
    }
  }
  if (patch.state !== undefined) {
    if (!THREAD_STATES.includes(patch.state)) throw new Error(`thread state must be one of ${THREAD_STATES.join(' / ')}: ${patch.state}`);
    next.state = patch.state;
  }
  if (patch.live !== undefined) {
    if (!patch.live || typeof patch.live !== 'object' || Array.isArray(patch.live)) throw new Error('live must be an object');
    const live = {};
    for (const [botId, state] of Object.entries(patch.live)) {
      if (state !== 'working' && state !== 'waiting') throw new Error('live state must be working or waiting');
      live[botId] = state;
    }
    if (Object.keys(live).length) next.live = live; else delete next.live;
  }
  if (patch.tokens && typeof patch.tokens === 'object') {
    for (const k of ['input', 'output', 'cached']) next.tokens[k] = num(patch.tokens[k], next.tokens[k]);
  }
  if (patch.calls !== undefined) next.calls = num(patch.calls, next.calls);
  if (patch.spend !== undefined) {
    if (!(typeof patch.spend?.day === 'string' && DAY_RX.test(patch.spend.day) && Number.isFinite(patch.spend?.percent) && patch.spend.percent >= 0)) throw new Error('spend must be { day: YYYY-MM-DD, percent: number }');
    next.spend = { day: patch.spend.day, percent: patch.spend.percent };
  }
  if (patch.digest !== undefined) {
    if (!patch.digest || typeof patch.digest !== 'object' || Array.isArray(patch.digest)) throw new Error('digest must be an object');
    next.digest ??= {};
    for (const [botId, entry] of Object.entries(patch.digest)) {
      if (entry === null) { delete next.digest[botId]; continue; }
      if (typeof entry?.text !== 'string' || [...entry.text].length > 500 || !Number.isFinite(entry.at) || !Number.isFinite(entry.lastAt) || typeof entry.fingerprint !== 'string') throw new Error('invalid thread digest');
      next.digest[botId] = { text: entry.text, at: entry.at, lastAt: entry.lastAt, fingerprint: entry.fingerprint };
    }
  }
  if (patch.origin !== undefined) {
    if (patch.origin !== null && !(typeof patch.origin?.channelId === 'string' && patch.origin.channelId && typeof patch.origin?.threadId === 'string' && patch.origin.threadId)) throw new Error('origin must be null or { channelId: string, threadId: string }');
    if (patch.origin === null) delete next.origin; else next.origin = { channelId: patch.origin.channelId, threadId: patch.origin.threadId };
  }
  if (patch.status !== undefined) {
    // 利用者の状態（脇の「状態」の並べ方のグループ。会話の status と同じ名前の器）。空・null は外す
    if (patch.status !== null && !(typeof patch.status === 'string' && [...patch.status.trim()].length <= THREAD_STATUS_MAX)) throw new Error(`status must be null or a string up to ${THREAD_STATUS_MAX} characters`);
    const status = patch.status === null ? '' : patch.status.trim();
    if (status) next.status = status; else delete next.status;
  }
  if (patch.title !== undefined) {
    // 人が付けたスレッドの題（根の投稿は変えない）。空・null は外す（根の投稿の最初の行に戻る）
    if (patch.title !== null && !(typeof patch.title === 'string' && [...patch.title.trim()].length <= THREAD_TITLE_MAX)) throw new Error(`title must be null or a string up to ${THREAD_TITLE_MAX} characters`);
    const title = patch.title === null ? '' : patch.title.replace(/\s+/g, ' ').trim();
    if (title) next.title = title; else delete next.title;
  }
  if (patch.readAt !== undefined) {
    // このスレッドを読んだ時刻（進める向きにだけ動く）
    if (!(Number.isFinite(patch.readAt) && patch.readAt >= 0)) throw new Error('readAt must be a number');
    next.readAt = Math.max(next.readAt ?? 0, patch.readAt);
  }
  if (patch.stopped !== undefined) {
    if (patch.stopped !== null && !(isAuthor(patch.stopped?.by) && Number.isFinite(patch.stopped?.at))) throw new Error('stopped must be null or { by: Author, at: number }');
    next.stopped = patch.stopped;
  }
  next.updatedAt = now;
  return next;
}

export function createThreadStore({ dir, dataDir = path.dirname(dir), now = Date.now } = {}) {
  // 保存は SQLite の channel_threads（1 スレッド 1 行。core/db.mjs、ADR 0115）。更新したスレッドの行だけを書き、DB を先に書いてからメモリへ反映する
  // （書けなければ投げて、メモリは変えない）。読みは最初の 1 回で全部をメモリへ持つ。dataDir は DB のあるデータ置き場（既定は dir の 1 つ上）
  let handle = null;
  let table = null;
  let cache = null;
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.then(() => {}, () => {}); return run; };

  function load() {
    if (cache) return cache;
    handle = openData(dataDir);
    table = threadTable(handle.db);
    return (cache = table.loadAll());
  }

  return {
    load: () => serial(async () => { load(); }),
    get: (channelId, threadId) => serial(async () => { const t = load()[threadKey(channelId, threadId)]; return t ? structuredClone(t) : null; }),
    list: (channelId) => serial(async () => Object.values(load()).filter((t) => !channelId || t.channelId === channelId).map((t) => structuredClone(t))),
    update: (channelId, threadId, patch) => serial(async () => {
      const data = load();
      const key = threadKey(channelId, threadId);
      const current = data[key] ?? emptyThread(channelId, threadId, now());
      const resolved = typeof patch === 'function' ? patch(structuredClone(current)) : patch;
      const next = applyThreadPatch(current, resolved ?? {}, now());
      table.put(key, channelId, JSON.stringify(next));
      data[key] = next;
      return structuredClone(next);
    }),
    /** DB の接続を離す（データ置き場を消す前。以後に呼べば開き直す） */
    close: () => serial(async () => { handle?.release(); handle = null; table = null; cache = null; }),
  };
}
