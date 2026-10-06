// bot へ届ける前の出来事の保存（S4。ADR 0109）。<data>/channels/inbox.json = { version: 1, items: InboxItem[] }。
// 投稿から bot を起こすとき、まずここへ `pending` で保存してから会話へ渡す（保存できなければ受け付けない。委譲のタスクと同じ）。
// 状態: pending（未送）→ delivering（渡している最中）→ sent（渡った）/ unknown（結果が分からない。自動では送り直さない）。
// 起動時は delivering を unknown にして、pending だけを配り直す（recover）。
//
//   createInboxStore({ dir, now }) → { load, add, list, mark, remove, recover }
//     add({ sessionId, botId, channelId, threadId, postId, caller?, reply?, inner?, heard?, heardTo?, reaction? }): Promise<InboxItem>
//       heard = @ の無い人の投稿を、宛先でない bot に聞こえた投稿として届ける（包みに heard="true"。返事をするかは bot が決める。ADR 0128）
//       heardTo = 聞こえた投稿が誰との話の続きか（bot の id。包みに to="<bot の名前>"。heard のときだけ。ADR 0128 の追記）
//       reaction = bot の投稿（postId）に付いたリアクション { emoji, by: Author, byKey, at, quiet? }。quiet なら配らず、次に起きたときに一緒に渡す（ADR 0109 の追記）
//       caller = 起こした投稿を書いた bot の id（その会話のターンが終わったとき返事を返す相手）、reply = 呼んだ bot への返事として届ける投稿を書いた bot の id、
//       inner = 自分の心拍から起きた出来事（postId は null。{ why, text, actSeq?, homeChannelId, taint? }。途中送信せず、新しいターンで <pleiad-inner> として渡す。ADR 0126）
//     list({ sessionId?, status?, channelId?, threadId? }): Promise<InboxItem[]>      … 保存順
//     mark(ids, status, extra?): Promise<InboxItem[]>                                  … 変わったもの
//     remove(ids): Promise<number>
//     recover(): Promise<{ demoted: number, sessions: string[] }>                     … delivering → unknown。pending の会話の id を返す
// InboxItem: { id: 'i_…', sessionId, botId, channelId, threadId: string|null, postId: string|null, caller?, reply?, inner?, heard?, heardTo?, reaction?, status, at, updatedAt, error? }
// 読めない版・壊れた JSON は上書きせずに投げる（threads.json と同じ方針）。送り終えた（sent）・結果不明のものは新しい 100 件だけ残す。
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';
import { newId } from '../channels/types.mjs';

export const INBOX_STATUSES = Object.freeze(['pending', 'delivering', 'sent', 'unknown']);
const KEEP_DONE = 100;

export function createInboxStore({ dir, now = Date.now } = {}) {
  const file = path.join(dir, 'inbox.json');
  let cache = null;
  let queue = Promise.resolve();
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.then(() => {}, () => {}); return run; };

  async function load() {
    if (cache) return cache;
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e?.code === 'ENOENT') return (cache = { version: 1, items: [] }); throw e; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`cannot read channels/inbox.json (${e.message}); check whether it is damaged: ${file}`); }
    if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error(`channels/inbox.json has version ${data?.version}, which this Pleiad cannot read: ${file}`);
    return (cache = data);
  }

  /** 送り終えたものが増えすぎたら古い方から捨てて書く。書けなければ元に戻す */
  async function persist(data, before) {
    const done = data.items.filter((i) => i.status === 'sent' || i.status === 'unknown');
    const drop = new Set(done.slice(0, Math.max(0, done.length - KEEP_DONE)).map((i) => i.id));
    const next = { version: 1, items: data.items.filter((i) => !drop.has(i.id)) };
    try {
      await fs.mkdir(dir, { recursive: true });
      await writeAtomic(file, JSON.stringify(next, null, 2));
    } catch (e) { cache = before; throw e; }
    cache = next;
  }

  const clone = (v) => structuredClone(v);
  const mutate = (fn) => serial(async () => {
    const data = await load();
    const before = { version: 1, items: data.items.map(clone) };
    const out = fn(data);
    await persist(data, before);
    return out;
  });

  return {
    file,
    load: () => serial(async () => { await load(); }),
    add: ({ sessionId, botId, channelId, threadId = null, postId = null, caller, reply, inner, heard, heardTo, reaction }) => mutate((data) => {
      const at = now();
      const item = { id: newId('inbox', at), sessionId, botId, channelId, threadId, postId, ...(caller ? { caller } : {}), ...(reply ? { reply } : {}), ...(inner ? { inner } : {}), ...(heard ? { heard: true } : {}), ...(heard && heardTo ? { heardTo } : {}), ...(reaction ? { reaction } : {}), status: 'pending', at, updatedAt: at };
      data.items.push(item);
      return clone(item);
    }),
    list: ({ sessionId, status, channelId, threadId } = {}) => serial(async () => (await load()).items
      .filter((i) => (!sessionId || i.sessionId === sessionId) && (!status || i.status === status)
        && (!channelId || i.channelId === channelId) && (threadId === undefined || i.threadId === threadId))
      .map(clone)),
    mark: (ids, status, extra = {}) => mutate((data) => {
      if (!INBOX_STATUSES.includes(status)) throw new Error(`inbox status must be one of ${INBOX_STATUSES.join(' / ')}: ${status}`);
      const wanted = new Set(ids);
      const changed = [];
      for (const item of data.items) {
        if (!wanted.has(item.id) || item.status === status) continue;
        Object.assign(item, extra, { status, updatedAt: now() });
        changed.push(clone(item));
      }
      return changed;
    }),
    remove: (ids) => mutate((data) => {
      const wanted = new Set(ids);
      const before = data.items.length;
      data.items = data.items.filter((i) => !wanted.has(i.id));
      return before - data.items.length;
    }),
    recover: () => mutate((data) => {
      let demoted = 0;
      for (const item of data.items) if (item.status === 'delivering') { item.status = 'unknown'; item.updatedAt = now(); demoted++; }
      return { demoted, sessions: [...new Set(data.items.filter((i) => i.status === 'pending').map((i) => i.sessionId))] };
    }),
  };
}
