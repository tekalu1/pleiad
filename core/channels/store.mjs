// チャンネル・DM の定義と既読（index.json）、チャンネルごとの追記だけの操作の記録（<channelId>.jsonl）とその畳み込み（S1。ADR 0108）。
//   <data>/channels/index.json       { version: 1, channels: Channel[], reads: { [channelId]: { readAt, mentionAt } } }
//   <data>/channels/<channelId>.jsonl 1 行 1 操作（ChannelOp。post・edit・delete・react）。読むときに畳んで投稿の並びにする
// index.json は writeAtomic で全体を置き換える（全体で 1 つの直列化キュー）。.jsonl は fs.appendFile（チャンネルごとの直列化キュー）。
// ルーティンが毎日書くチャンネルでも、1 投稿の保存が 1 行の追記で済む。
//
// 壊れた行: 最後の行が途中で切れていても（クラッシュ・書き込み中の電源断）、読めない行を飛ばして続きを読む。次の追記は先に改行を足して、
// 壊れた行を単独の行に隔てる（新しい操作を壊れた行の後ろにつなげない）。飛ばした行の数は stats(channelId).skipped。
// index.json の読めない版・壊れた JSON は、上書きせずに投げる（壊れたまま新しい状態で消さない）。
//
//   createChannelStore({ dir, now }) → ChannelStore
//     channels(): Promise<Channel[]>・channel(id): Promise<Channel|null>
//     saveChannel(channel): Promise<Channel>                 … 追加か置き換え（id が同じ）
//     updateChannel(id, fn): Promise<Channel|null>           … 定義を 1 か所だけ直す（直列化の中で読んで書く。fn は写しを受け取って新しい定義を返す）
//     readState(channelId): Promise<{ readAt, mentionAt }>・allReadStates(): Promise<{ [channelId]: {...} }>
//     setReadState(channelId, { readAt, mentionAt }): Promise<{ readAt, mentionAt }>   … 進める向きにだけ動く
//     append(channelId, op): Promise<Post|null>              … 追記して畳み込みへ反映し、その操作の対象の投稿（写し）を返す
//     snapshot(channelId): Promise<Post[]>                   … 畳んだ投稿の並び（追記の順）。読むだけ（書き換えない）。呼び出し側が返すときは写しを作る
//     stats(channelId): Promise<{ posts: number, skipped: number }>
//   foldOp(posts: Map<string, Post>, op) … 畳み込みの 1 手（テスト用に出す）
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';
import { authorKey, isId } from './types.mjs';

/** 畳み込みの 1 手。投稿の無い id への編集・削除・リアクションは何もしない（先の行が壊れて飛ばされたときも安全） */
export function foldOp(posts, op) {
  if (!op || typeof op !== 'object') return null;
  if (op.op === 'post') {
    const p = op.post;
    if (!p || typeof p.id !== 'string' || posts.has(p.id)) return null;
    const post = { ...p, reactions: p.reactions && typeof p.reactions === 'object' ? p.reactions : {}, mentions: Array.isArray(p.mentions) ? p.mentions : [] };
    posts.set(post.id, post);
    return post;
  }
  const post = posts.get(op.id);
  if (!post) return null;
  if (op.op === 'edit') {
    if (post.deletedAt) return null;
    if (op.text !== undefined) {
      // 「編集済み」は本文が実際に変わったときだけ。同じ本文での書き直し（付帯情報だけの更新）と、bot のターンの投稿が進捗や返答で埋まるのは数えない
      if (op.text !== post.text && !post.turn) post.editedAt = op.at;
      post.text = op.text;
    }
    if (op.taint === 'webhook') post.taint = op.taint;
    if (op.state !== undefined) post.state = op.state;
    if (op.presents !== undefined) post.presents = op.presents;
    if (op.mentions !== undefined) post.mentions = op.mentions;
    return post;
  }
  if (op.op === 'delete') {
    if (post.deletedAt) return post;
    post.deletedAt = op.at;
    post.text = '';
    post.reactions = {};
    delete post.presents;
    return post;
  }
  if (op.op === 'react') {
    if (post.deletedAt || typeof op.emoji !== 'string' || !op.emoji) return null;
    const key = authorKey(op.by);
    if (!key) return null;
    const list = post.reactions[op.emoji] ?? [];
    const at = list.findIndex((a) => authorKey(a) === key);
    if (op.on && at < 0) list.push(op.by);
    else if (!op.on && at >= 0) list.splice(at, 1);
    if (list.length) post.reactions[op.emoji] = list; else delete post.reactions[op.emoji];
    return post;
  }
  return null;
}

/** .jsonl の本文を畳む。読めない行は飛ばして数える */
export function foldLines(text) {
  const posts = new Map();
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let op;
    try { op = JSON.parse(line); } catch { skipped++; continue; }
    if (!op || typeof op !== 'object' || Array.isArray(op)) { skipped++; continue; }
    foldOp(posts, op);
  }
  return { posts, skipped };
}

const emptyRead = () => ({ readAt: 0, mentionAt: 0 });

export function createChannelStore({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error('createChannelStore: dir is required');
  const indexFile = path.join(dir, 'index.json');
  const chains = new Map();
  /** key ごとの直列化。前の失敗は次を止めない */
  const serial = (key, fn) => {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(key, run.then(() => {}, () => {}));
    return run;
  };

  let index = null;
  async function loadIndex() {
    if (index) return index;
    let raw;
    try { raw = await fs.readFile(indexFile, 'utf8'); }
    catch (e) { if (e?.code === 'ENOENT') return (index = { version: 1, channels: [], reads: {} }); throw e; }
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error(`cannot read channels/index.json (${e.message}); check whether it is damaged: ${indexFile}`); }
    if (data?.version !== 1 || !Array.isArray(data.channels)) throw new Error(`channels/index.json has version ${data?.version}, which this Pleiad cannot read: ${indexFile}`);
    return (index = { version: 1, channels: data.channels, reads: data.reads && typeof data.reads === 'object' ? data.reads : {} });
  }
  async function saveIndex(next) {
    await fs.mkdir(dir, { recursive: true });
    await writeAtomic(indexFile, JSON.stringify(next, null, 2));
    index = next;
  }
  /** index.json の読み → 変更 → 保存。fn は index の写しを受け取って新しい index を返す */
  const mutateIndex = (fn) => serial('index', async () => {
    const current = await loadIndex();
    const next = fn(structuredClone(current));
    await saveIndex(next);
    return next;
  });

  const logFile = (channelId) => {
    if (!isId(channelId, 'channel')) throw new Error(`invalid channel id: ${channelId}`);
    return path.join(dir, `${channelId}.jsonl`);
  };
  const folded = new Map(); // channelId → { posts: Map, skipped }
  async function loadLog(channelId) {
    let entry = folded.get(channelId);
    if (entry) return entry;
    let text = '';
    try { text = await fs.readFile(logFile(channelId), 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    entry = foldLines(text);
    folded.set(channelId, entry);
    return entry;
  }
  async function endsWithNewline(file) {
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.size === 0) return true;
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, st.size - 1);
      return buf[0] === 0x0a;
    } finally { await fh.close(); }
  }

  return {
    channels: () => serial('index', async () => structuredClone((await loadIndex()).channels)),
    channel: (id) => serial('index', async () => { const c = (await loadIndex()).channels.find((x) => x.id === id); return c ? structuredClone(c) : null; }),
    async saveChannel(channel) {
      await mutateIndex((idx) => {
        const at = idx.channels.findIndex((c) => c.id === channel.id);
        if (at >= 0) idx.channels[at] = channel; else idx.channels.push(channel);
        return idx;
      });
      return structuredClone(channel);
    },
    /** 定義を 1 か所だけ直す（読み → 変更 → 保存を 1 つの直列化の中で）。fn は写しを受け取って新しい定義を返す。無ければ null */
    async updateChannel(id, fn) {
      let result = null;
      await mutateIndex((idx) => {
        const at = idx.channels.findIndex((c) => c.id === id);
        if (at >= 0) { idx.channels[at] = fn(idx.channels[at]); result = idx.channels[at]; }
        return idx;
      });
      return result ? structuredClone(result) : null;
    },
    allReadStates: () => serial('index', async () => structuredClone((await loadIndex()).reads)),
    readState: (channelId) => serial('index', async () => ({ ...emptyRead(), ...(await loadIndex()).reads[channelId] })),
    async setReadState(channelId, { readAt, mentionAt }) {
      let result;
      await mutateIndex((idx) => {
        const cur = { ...emptyRead(), ...idx.reads[channelId] };
        result = { readAt: Math.max(cur.readAt, readAt ?? 0), mentionAt: Math.max(cur.mentionAt, mentionAt ?? 0) };
        idx.reads[channelId] = result;
        return idx;
      });
      return result;
    },

    append: (channelId, op) => serial(`log:${channelId}`, async () => {
      const entry = await loadLog(channelId);
      const file = logFile(channelId);
      await fs.mkdir(dir, { recursive: true });
      const prefix = (await endsWithNewline(file)) ? '' : '\n';
      await fs.appendFile(file, `${prefix}${JSON.stringify(op)}\n`, 'utf8');
      const post = foldOp(entry.posts, op);
      return post ? structuredClone(post) : null;
    }),
    snapshot: (channelId) => serial(`log:${channelId}`, async () => [...(await loadLog(channelId)).posts.values()]),
    stats: (channelId) => serial(`log:${channelId}`, async () => { const e = await loadLog(channelId); return { posts: e.posts.size, skipped: e.skipped }; }),
    now,
  };
}
