// スレッドの状態（ThreadState）の保存（S1。ADR 0109）。SQLite の channel_threads（キーは channelId/rootPostId、値は ThreadState。1 スレッド 1 行。ADR 0115。以前は channels/threads.json だったが、
// スレッドの数だけ増えて、トークンの足し算のたびに全体を書き直していたので行にした）。
// スレッドの本体（投稿）は channels/<channelId>.jsonl。ここにあるのは「どの bot がどの会話で・作業中か・トークン・止めた印」だけ。
//
//   createThreadStore({ dir, dataDir?, now }) → { get, list, update, load, close }
//     get(channelId, threadId): Promise<ThreadState|null>
//     list(channelId?): Promise<ThreadState[]>
//     update(channelId, threadId, patch | (current) => patch): Promise<ThreadState>
//         … 無ければ空のスレッドから作る。patch の欄: sessions（bot ごとに足す）・state・tokens（欄ごとに足し直す）・calls・stopped・origin（{ channelId, threadId }。bot が自分のスレッドから起こして新しくできたスレッドの、起こした元。null で外す）。
//           関数で渡すと、直列化された中で今の値（写し）を受け取って patch を返す（トークンの足し算など、読んでから書く更新はこちら）
//   emptyThread(channelId, threadId, now) → ThreadState
import path from 'node:path';
import { openData } from '../data-schema.mjs';
import { threadTable } from '../db.mjs';
import { THREAD_STATES, isAuthor } from './types.mjs';

export const threadKey = (channelId, threadId) => `${channelId}/${threadId}`;

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
  if (patch.tokens && typeof patch.tokens === 'object') {
    for (const k of ['input', 'output', 'cached']) next.tokens[k] = num(patch.tokens[k], next.tokens[k]);
  }
  if (patch.calls !== undefined) next.calls = num(patch.calls, next.calls);
  if (patch.origin !== undefined) {
    if (patch.origin !== null && !(typeof patch.origin?.channelId === 'string' && patch.origin.channelId && typeof patch.origin?.threadId === 'string' && patch.origin.threadId)) throw new Error('origin must be null or { channelId: string, threadId: string }');
    if (patch.origin === null) delete next.origin; else next.origin = { channelId: patch.origin.channelId, threadId: patch.origin.threadId };
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
