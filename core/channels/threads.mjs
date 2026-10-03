// スレッドの状態（ThreadState）の保存（S1。ADR 0096）。<data>/channels/threads.json = { version: 1, threads: { [channelId/rootPostId]: ThreadState } }。
// スレッドの本体（投稿）は channels/<channelId>.jsonl。ここにあるのは「どの bot がどの会話で・作業中か・トークン・止めた印」だけ。
//
//   createThreadStore({ dir, now }) → { get, list, update, load }
//     get(channelId, threadId): Promise<ThreadState|null>
//     list(channelId?): Promise<ThreadState[]>
//     update(channelId, threadId, patch | (current) => patch): Promise<ThreadState>
//         … 無ければ空のスレッドから作る。patch の欄: sessions（bot ごとに足す）・state・tokens（欄ごとに足し直す）・calls・stopped。
//           関数で渡すと、直列化された中で今の値（写し）を受け取って patch を返す（トークンの足し算など、読んでから書く更新はこちら）
//   emptyThread(channelId, threadId, now) → ThreadState
// 読めない版・壊れた JSON は、上書きせずに投げる（hooks.json と同じ方針。壊れたまま新しい状態で上書きしない）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';
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
  if (patch.stopped !== undefined) {
    if (patch.stopped !== null && !(isAuthor(patch.stopped?.by) && Number.isFinite(patch.stopped?.at))) throw new Error('stopped must be null or { by: Author, at: number }');
    next.stopped = patch.stopped;
  }
  next.updatedAt = now;
  return next;
}

export function createThreadStore({ dir, now = Date.now } = {}) {
  const file = path.join(dir, 'threads.json');
  let cache = null;
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.then(() => {}, () => {}); return run; };

  async function load() {
    if (cache) return cache;
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e?.code === 'ENOENT') return (cache = { version: 1, threads: {} }); throw e; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`cannot read channels/threads.json (${e.message}); check whether it is damaged: ${file}`); }
    if (data?.version !== 1 || typeof data.threads !== 'object' || !data.threads) throw new Error(`channels/threads.json has version ${data?.version}, which this Pleiad cannot read: ${file}`);
    return (cache = data);
  }

  return {
    load: () => serial(async () => { await load(); }),
    get: (channelId, threadId) => serial(async () => { const t = (await load()).threads[threadKey(channelId, threadId)]; return t ? structuredClone(t) : null; }),
    list: (channelId) => serial(async () => Object.values((await load()).threads).filter((t) => !channelId || t.channelId === channelId).map((t) => structuredClone(t))),
    update: (channelId, threadId, patch) => serial(async () => {
      const data = await load();
      const key = threadKey(channelId, threadId);
      const current = data.threads[key] ?? emptyThread(channelId, threadId, now());
      const resolved = typeof patch === 'function' ? patch(structuredClone(current)) : patch;
      const next = applyThreadPatch(current, resolved ?? {}, now());
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(file, JSON.stringify({ version: 1, threads: { ...data.threads, [key]: next } }, null, 2));
      data.threads[key] = next;
      return structuredClone(next);
    }),
  };
}
