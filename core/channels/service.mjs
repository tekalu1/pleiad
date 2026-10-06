// チャンネルの保存と操作（S1。ADR 0108）。core/ops/channels.mjs の handler は `ctx.channels` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs。保存は store.mjs（index.json・<channelId>.jsonl）と threads.mjs（SQLite の channel_threads。ADR 0115）。
//
// createChannelService({ dir, emit, hooks, now, listBots }) → ChannelService
//   dir      … <data>/channels
//   emit     … (event) => void。channelsChanged・channelPost・channelReaction・channelThread・channelRead を出す（core/protocol.mjs の EVENTS。sessionId は付けなくてよい）
//   hooks    … 他のモジュールへの逆向きの口。host が bots-host.mjs で配線する（呼ぶだけ。無ければ何もしない）
//     posted(post, channel, extra) … 投稿を保存した後（待たない）。誰を起こすかは S4（dispatch.onPosted）が決める。extra は post の hold・origin
//                                    （hold があれば「承認の要る宛先を ops が決め済み」＝ checked。hold に入れた bot は起こさない）。
//                                    botPost が返したターンの投稿に返事を入れたときも呼ぶ（extra.filled: true）
//     edited(post, channel)     … 人の本文の編集後。送れる会話の参照を解決する（bot は起こさない）
//     removed(post, channel)    … 投稿の削除後。エピソード要約を更新する（bot は起こさない）
//     reacted(post, channel, { emoji, on, by }) … リアクションを付けた・外した後（待たない）。bot の投稿なら、その bot へ渡すか・起こすかを S4（dispatch.onReacted）が決める
//     stopThread(args, author)    … [止める]（待つ。投げたら stopThread も投げる）。走っているターンを止めるのは S4（dispatch.stopThread）
//     botPost({ channelId, threadId, botId, sessionId }) → { postId } | undefined
//                                 … bot の post の前（同期）。postId があればその投稿（ターンの投稿）の本文に入れ、null なら新しい投稿。undefined なら下の既定（S4 の dispatch.claimPost）
//   now      … テストで時計を差し替える
//   listBots … async () => Bot[]。@ の解析（mentions.mjs）が名前を突き合わせるのに使う。無ければ bot の @ は解かない（'you' だけ）
//
// ChannelService（author は types.mjs の Author。操作の主体から ops が決めて渡す）:
//   start(): Promise<void>・stop(): void・close(): Promise<void>（stop と、スレッドの状態の DB の接続の解放）
//   list(): Promise<(Channel & { unread: number, mentions: number, threadsWorking: number })[]>   … archived も含む（archivedAt で見分ける）。
//        unread = 既読の後の、人以外の発言者の投稿。mentions = そのうち `@あなた` を含むもの。threadsWorking = state が working のスレッドの数
//   get({ channelId }): Promise<Channel>
//        … list・get・channelsChanged のチャンネル（kind: 'channel'）は、budget に既定を埋め、spentToday（今日スレッドが予算に数えた % の合計）を付けて返す
//   getPost({ channelId, postId }): Promise<Post|null>
//   read({ channelId, threadId?, before?, limit }): Promise<{ posts: Post[], threads: ThreadState[], summaries, nextBefore: string|null }>
//        … 新しい方から limit 件（時間順に並べて返す）。before = その投稿より前。nextBefore = まだ前があるとき、返した先頭の投稿の id。
//          threadId があれば、その根の投稿（最初のページ = before なしのとき先頭に付く）と返信。threads はそのスレッド 1 件（状態が無ければ空の状態）。
//          無ければチャンネルの流れ（threadId が null の投稿）。threads はその根のうち状態を持つもの、summaries は返信のある根ごとの { count, lastAt, authors }
//        削除した投稿は deletedAt 付きの空の本文で残る（スレッドの形を保つため）
//   search({ query, channelId?, limit }): Promise<{ hits: { channelId, channelName, postId, threadId, author, at, snippet }[] }>
//   create({ name, purpose?, cwd?, members? }, author): Promise<Channel>
//   createDm({ bot }): Promise<Channel>                         … bot を作ったとき（S2 の bots.create が呼ぶ）。同じ bot の DM があればそれを返す
//   update({ channelId, name?, purpose?, cwd?, members?, memo?, budget? }, author): Promise<Channel>   … budget は { daily?, perThread? }（渡した欄だけ。core/channels/budget.mjs。ADR 0119）
//   archive({ channelId, on }, author): Promise<Channel>
//   post({ channelId, threadId?, text, new?, state?, presents?, attachments?, turn?, taint?, routine?, mentions?, hold?, origin?, bySession? }, author): Promise<Post>
//        … attachments: 人（と AI）が付けたファイル { path, name?, kind?, mime?, size?, origin? }[]（上限 LIMITS.attachments）。実物の確かめは ops（core/ops/channels.mjs）が済ませる。
//          本文の `[添付] パス` の行と対で、bot へは本文の印のまま渡る。印だけの本文でも投稿できる（ADR 0116）
//        … hold: 起こさない bot の id の配列（ops の channels.post が、動くモードが投稿の主体より強い宛先を入れる。空でも渡せば「確認済み」）。
//          origin: { channelId, threadId }（bot が自分のスレッドからチャンネルの流れへ書いた投稿。起こして新しくできるスレッドの ThreadState.origin になる）。どちらも保存せず、posted の extra へ渡すだけ
//          bySession: 操作を呼んだ会話の id（ops が渡す。保存しない）。hooks.botPost と posted の extra へ渡す（別のスレッドへ書いた自分への @ の判断）
//        … mentions を渡さなければ text から解く。author が bot なら、hooks.botPost が返す投稿（その会話のターンの投稿。ターンで最初の 1 件だけ）の本文に入れる（ADR 0117）。
//          hooks.botPost が決めない（undefined）ときは、new が無く、同じスレッド・会話（bySession があれば一致）にその bot の作業中の投稿があれば置き換える。人の投稿は、そのスレッドの stopped を外す
//   edit({ channelId, postId, text?, state?, presents?, mentions? }, author): Promise<Post>      … 自分の投稿だけ（検査は ops）。text を変えたら mentions も解き直す
//   remove({ channelId, postId }, author): Promise<void>
//   react({ channelId, postId, emoji, on }, author): Promise<{ reactions: Post['reactions'] }>   … bot の投稿なら hooks.reacted へ渡す
//   markRead({ channelId, at }): Promise<{ readAt: number }>      … 進める向きにだけ動く（別の端末が先に進めていたら戻さない）
//   stopThread({ channelId, threadId }, author): Promise<ThreadState>
//        … stopped: { by, at } を残して channelThread を出し、hooks.stopThread へ渡す（ターンを止める・システムの投稿は S4）
//   mentionsOf(text, author?): Promise<string[]>                          … text の @ を解いた bot の id（'you' も入る）。post の mentions と同じ解き方
//   threads: { get(channelId, threadId): Promise<ThreadState|null>, list(channelId?): Promise<ThreadState[]>, update(channelId, threadId, patch | fn): Promise<ThreadState> }
//        … update は threads.mjs と同じ。channelThread を出す
//
// 失敗は ChannelError（code と params）。ops が OpError に直す（辞書 agent:ops.errors.<code>）。
import path from 'node:path';
import { EMOJI_RE } from '../../web/emoji.mjs';
import { authorKey, isAuthor, isId, newId, POST_STATES } from './types.mjs';
import { createChannelStore } from './store.mjs';
import { createThreadStore, emptyThread, threadTitle } from './threads.mjs';
import { parseMentions } from './mentions.mjs';
import { budgetOf, normalizeBudget, spentToday, dayOf } from './budget.mjs';

export const LIMITS = Object.freeze({ name: 60, purpose: 300, memo: 4000, cwd: 1000, text: 20000, attachments: 50, members: 50, reactionKinds: 30, readDefault: 50, readMax: 100, searchDefault: 20, searchMax: 50 });
/** 作業中の投稿の更新を全接続へ配る間隔（ms。ADR 0108。リモートの端末の通信量のため） */
export const WORKING_EDIT_INTERVAL_MS = 1000;
/** スレッドの索引（threads）の、チャンネルごとの既定の件数と上限（脇の「最近のスレッド」） */
export const THREADS_PER_CHANNEL = 5;
/** 一時チャットの、op での呼び名（channelId: 'home'）と保存の名前 */
export const HOME_ALIAS = 'home';
const HOME_NAME = 'home';
export const THREADS_PER_CHANNEL_MAX = 50;

export class ChannelError extends Error {
  constructor(code, params = {}, message) {
    super(message ?? `${code} ${JSON.stringify(params)}`);
    this.name = 'ChannelError';
    this.code = code;
    this.params = params;
  }
}
const invalid = (detail) => new ChannelError('INVALID', { detail }, `INVALID ${detail}`);

const foldName = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
const clone = (v) => (v === undefined ? v : structuredClone(v));

/** チャンネルの名前の整え方: 前後の空白と先頭の # を除く。空・改行入り・長すぎるものは断る */
export function normalizeChannelName(name) {
  const n = String(name ?? '').trim().replace(/^#+\s*/, '').trim();
  if (!n) throw invalid('name is empty');
  if (/[\r\n]/.test(n)) throw invalid('name must be a single line');
  if (Array.from(n).length > LIMITS.name) throw invalid(`name is longer than ${LIMITS.name} characters`);
  return n;
}

/** 絵文字 1 つ（web/emoji.mjs の EMOJI_RE と同じ規則）か。前後の空白は許さない */
export function isSingleEmoji(value) {
  if (typeof value !== 'string' || !value) return false;
  const found = value.match(new RegExp(EMOJI_RE.source, EMOJI_RE.flags.includes('g') ? EMOJI_RE.flags : `${EMOJI_RE.flags}g`));
  return found?.length === 1 && found[0] === value;
}

/** 添付の記録の形にそろえる（知らない欄は持たない）。パスの無いものは断る */
export function normalizeAttachments(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw invalid('attachments must be an array');
  if (list.length > LIMITS.attachments) throw invalid(`attachments has more than ${LIMITS.attachments} files`);
  return list.map((a) => {
    const file = typeof a?.path === 'string' ? a.path : '';
    if (!file) throw invalid('an attachment needs a path');
    return {
      path: file,
      name: typeof a.name === 'string' && a.name ? a.name : file.split(/[\\/]/).pop(),
      kind: a.kind === 'image' ? 'image' : 'file',
      mime: typeof a.mime === 'string' ? a.mime : '',
      size: Number.isFinite(a.size) ? a.size : null,
      origin: a.origin === 'device' ? 'device' : 'host',
    };
  });
}

function checkText(text, { allowEmpty = false } = {}) {
  if (typeof text !== 'string') throw invalid('text must be a string');
  if (!allowEmpty && !text.trim()) throw invalid('text is empty');
  if (text.length > LIMITS.text) throw invalid(`text is longer than ${LIMITS.text} characters`);
  return text;
}

export function createChannelService({ dir, emit = () => {}, hooks = {}, now = Date.now, listBots = null } = {}) {
  const store = createChannelStore({ dir, now });
  const threadStore = createThreadStore({ dir, now });
  const timers = new Set();

  const bots = async () => { try { return (await listBots?.()) ?? []; } catch { return []; } };
  // bot の投稿は、bot を呼ぶのが行頭の半角の @ だけ（strict。ADR 0117）。人は全角の ＠ も文中も数える
  const resolveMentions = async (text, author) => parseMentions(text, await bots(), { strict: author?.kind === 'bot' }).mentions;

  async function need(channelId) {
    const channel = typeof channelId === 'string' ? await store.channel(channelId) : null;
    if (!channel) throw new ChannelError('CHANNEL_NOT_FOUND', { id: String(channelId) });
    return channel;
  }
  async function needPost(channelId, postId) {
    await need(channelId);
    const post = (await store.snapshot(channelId)).find((p) => p.id === postId);
    if (!post) throw new ChannelError('POST_NOT_FOUND', { id: String(postId) });
    return post;
  }
  const emitThread = (thread) => emit({ type: 'channelThread', channelId: thread.channelId, threadId: thread.threadId, thread });

  function validateMembers(members) {
    if (!Array.isArray(members)) throw invalid('members must be an array');
    const ids = [...new Set(members.map(String))];
    if (ids.length > LIMITS.members) throw invalid(`members has more than ${LIMITS.members} bots`);
    return ids;
  }
  async function checkMembers(ids) {
    if (!ids.length || !listBots) return;
    const known = new Set((await bots()).map((b) => b.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw invalid(`unknown bot: ${unknown.join(', ')}`);
  }
  function checkCwd(cwd) {
    if (cwd === null || cwd === undefined || cwd === '') return null;
    if (typeof cwd !== 'string' || cwd.length > LIMITS.cwd) throw invalid('cwd must be a path string');
    if (!path.isAbsolute(cwd) && !path.win32.isAbsolute(cwd) && !path.posix.isAbsolute(cwd)) throw invalid('cwd must be an absolute path');
    return cwd;
  }
  async function checkNameFree(name, exceptId) {
    // 一時チャット（home: true）の保存の名前 home は、人の作るチャンネルの名前とぶつからない（画面では「一時チャット」）
    const taken = (await store.channels()).some((c) => c.kind === 'channel' && !c.home && !c.archivedAt && c.id !== exceptId && foldName(c.name) === foldName(name));
    if (taken) throw new ChannelError('CHANNEL_NAME_TAKEN', { name });
  }
  /** 外へ返すチャンネル: 予算は既定を埋め、今日使った分を付ける（ADR 0119）。DM は予算を持たない。threads は読み済みならそれを使う */
  async function shown(channel, threads) {
    if (!channel || channel.kind !== 'channel') return channel;
    return { ...channel, budget: budgetOf(channel), spentToday: spentToday(threads ?? await threadStore.list(channel.id), channel.id, dayOf(now())) };
  }
  async function saveChannel(channel) {
    const saved = await shown(await store.saveChannel(channel));
    emit({ type: 'channelsChanged', channel: saved });
    return saved;
  }
  async function patchChannel(channelId, fn) {
    const raw = await store.updateChannel(channelId, fn);
    if (!raw) throw new ChannelError('CHANNEL_NOT_FOUND', { id: String(channelId) });
    const saved = await shown(raw);
    emit({ type: 'channelsChanged', channel: saved });
    return saved;
  }

  // ---- 作業中の投稿の更新は 1 秒に 1 回まで配る（先頭は即、続きは最後の 1 件）。確定した（working でない）更新は待たずに配る
  const edits = new Map(); // postId → { last: number, timer, post }
  function emitEdit(channelId, post) {
    const slot = edits.get(post.id);
    if (post.state !== 'working') {
      if (slot?.timer) { clearTimeout(slot.timer); timers.delete(slot.timer); }
      edits.delete(post.id);
      emit({ type: 'channelPost', channelId, op: 'edit', post });
      return;
    }
    const t = now();
    if (!slot || t - slot.last >= WORKING_EDIT_INTERVAL_MS) {
      if (slot?.timer) { clearTimeout(slot.timer); timers.delete(slot.timer); }
      edits.set(post.id, { last: t, timer: null, post });
      emit({ type: 'channelPost', channelId, op: 'edit', post });
      return;
    }
    slot.post = post;
    if (slot.timer) return;
    slot.timer = setTimeout(() => {
      timers.delete(slot.timer);
      slot.timer = null;
      slot.last = now();
      emit({ type: 'channelPost', channelId, op: 'edit', post: slot.post });
    }, Math.max(0, WORKING_EDIT_INTERVAL_MS - (t - slot.last)));
    slot.timer.unref?.();
    timers.add(slot.timer);
  }

  const summariesOf = (all, rootIds) => {
    const wanted = new Set(rootIds);
    const out = {};
    for (const p of all) {
      if (!p.threadId || !wanted.has(p.threadId) || p.deletedAt) continue;
      const s = (out[p.threadId] ??= { count: 0, lastAt: 0, authors: [] });
      s.count++;
      s.lastAt = Math.max(s.lastAt, p.at);
      const key = authorKey(p.author);
      if (key && s.authors.length < 5 && !s.authors.some((a) => authorKey(a) === key)) s.authors.push(clone(p.author));
    }
    return out;
  };

  // ---- 一時チャット（ADR 9101）: 今の Chats の会話の置き場。会話（session）はここに記録を持たず、bot に話しかけた投稿だけがここの投稿になる。
  // 実体は home: true の普通のチャンネル（kind は channel）。最初に bot へ話しかけたとき（投稿のとき）に作る。op の channelId 'home' はこれの id へ解く
  const findHome = async () => (await store.channels()).find((c) => c.home) ?? null;
  async function ensureHome() {
    const known = await findHome();
    if (known) return known;
    const t = now();
    return saveChannel({ id: newId('channel', t), kind: 'channel', home: true, name: HOME_NAME, purpose: '', cwd: null, members: [], memo: '', createdAt: t, lastPostAt: t });
  }

  const service = {
    dir, emit, hooks, now,
    /** 一時チャットのチャンネル（無ければ作る） */
    ensureHome,
    /** 一時チャットのチャンネル（無ければ null） */
    home: findHome,
    async start() { await store.channels(); await threadStore.load(); },
    stop() { for (const timer of timers) clearTimeout(timer); timers.clear(); edits.clear(); },
    /** stop に加えて、スレッドの状態の DB の接続を離す（データ置き場を消す前。テストの後片付け用） */
    async close() { this.stop(); await threadStore.close(); },

    async list() {
      const [channels, reads, threads] = await Promise.all([store.channels(), store.allReadStates(), threadStore.list()]);
      return Promise.all(channels.map(async (channel) => {
        const read = { readAt: 0, mentionAt: 0, ...reads[channel.id] };
        let unread = 0, mentions = 0;
        for (const p of await store.snapshot(channel.id)) {
          if (p.deletedAt || p.author?.kind === 'human') continue;
          if (p.at > read.readAt) unread++;
          if (p.at > read.mentionAt && p.mentions?.includes('you')) mentions++;
        }
        return { ...(await shown(channel, threads)), unread, mentions, threadsWorking: threads.filter((t) => t.channelId === channel.id && t.state === 'working').length };
      }));
    },
    get: async ({ channelId }) => shown(await need(channelId)),
    async getPost({ channelId, postId }) {
      await need(channelId);
      return clone((await store.snapshot(channelId)).find((p) => p.id === postId) ?? null);
    },

    async read({ channelId, threadId, before, limit = LIMITS.readDefault }) {
      await need(channelId);
      const max = Math.min(Math.max(1, Math.floor(limit) || LIMITS.readDefault), LIMITS.readMax);
      const all = await store.snapshot(channelId);
      if (threadId) {
        const root = all.find((p) => p.id === threadId && p.threadId === null);
        if (!root) throw new ChannelError('POST_NOT_FOUND', { id: String(threadId) });
        const replies = all.filter((p) => p.threadId === threadId);
        const end = before === undefined ? replies.length : replies.findIndex((p) => p.id === before);
        if (before !== undefined && end < 0) throw new ChannelError('POST_NOT_FOUND', { id: String(before) });
        const start = Math.max(0, end - max);
        const page = replies.slice(start, end);
        const thread = (await threadStore.get(channelId, threadId)) ?? emptyThread(channelId, threadId, now());
        return { posts: clone([...(before === undefined ? [root] : []), ...page]), threads: [thread], summaries: {}, nextBefore: start > 0 ? page[0].id : null };
      }
      const feed = all.filter((p) => p.threadId === null);
      const end = before === undefined ? feed.length : feed.findIndex((p) => p.id === before);
      if (before !== undefined && end < 0) throw new ChannelError('POST_NOT_FOUND', { id: String(before) });
      const start = Math.max(0, end - max);
      const page = feed.slice(start, end);
      const ids = new Set(page.map((p) => p.id));
      const threads = (await threadStore.list(channelId)).filter((th) => ids.has(th.threadId));
      return { posts: clone(page), threads, summaries: summariesOf(all, ids), nextBefore: start > 0 ? page[0].id : null };
    },

    /**
     * スレッドの索引（脇の 2 つの並べ方の材料）。チャンネル（DM・アーカイブを除く。channelId を渡せばそのチャンネルだけ）ごとに、
     * 返信があるか状態を持つ根を、最後の動きの新しい順に perChannel 件（all なら全部）。total はそのチャンネルのスレッドの数
     */
    async threadIndex({ channelId, perChannel = THREADS_PER_CHANNEL, all = false } = {}) {
      if (channelId) await need(channelId);
      const channels = (await store.channels()).filter((c) => (channelId ? c.id === channelId : c.kind === 'channel' && !c.archivedAt));
      const [reads, states] = await Promise.all([store.allReadStates(), threadStore.list()]);
      const byKey = new Map(states.map((th) => [`${th.channelId}\n${th.threadId}`, th]));
      const per = Math.min(Math.max(1, Math.floor(perChannel) || THREADS_PER_CHANNEL), THREADS_PER_CHANNEL_MAX);
      const threads = [], totals = {};
      for (const channel of channels) {
        const all_ = await store.snapshot(channel.id);
        const replies = new Map();
        for (const p of all_) {
          if (!p.threadId || p.deletedAt) continue;
          const r = replies.get(p.threadId) ?? { count: 0, lastAt: 0, mentions: 0 };
          r.count++;
          r.lastAt = Math.max(r.lastAt, p.at);
          replies.set(p.threadId, r);
        }
        const channelRead = reads[channel.id]?.readAt ?? 0;
        const rows = [];
        for (const root of all_) {
          if (root.threadId !== null || root.deletedAt) continue;
          const th = byKey.get(`${channel.id}\n${root.id}`) ?? null;
          const r = replies.get(root.id);
          if (!r && !th) continue;
          const lastAt = Math.max(root.at, r?.lastAt ?? 0);
          const readAt = Math.max(channelRead, th?.readAt ?? 0);
          rows.push({
            channelId: channel.id, threadId: root.id, title: th?.title || threadTitle(root.text), rootAt: root.at, lastAt, count: r?.count ?? 0,
            unread: lastAt > readAt && (r?.lastAt ?? 0) > readAt, state: th?.state ?? 'idle', ...(th?.live ? { live: clone(th.live) } : {}),
            ...(th?.status ? { status: th.status } : {}), bots: Object.keys(th?.sessions ?? {}), ...(th?.origin ? { origin: clone(th.origin) } : {}),
            ...(th?.stopped ? { stopped: true } : {}),
          });
        }
        rows.sort((a, b) => b.lastAt - a.lastAt);
        totals[channel.id] = rows.length;
        threads.push(...(all ? rows : rows.slice(0, per)));
      }
      return { threads, totals };
    },

    /** スレッドの題を付ける・外す（空にすると根の投稿の最初の行に戻る）。根の投稿は変えない */
    async setThreadTitle({ channelId, threadId, title }, _author) {
      const root = await needPost(channelId, threadId);
      if (root.threadId !== null) throw new ChannelError('POST_NOT_FOUND', { id: String(threadId) });
      const thread = await threadStore.update(channelId, threadId, { title: title ? String(title) : null });
      emitThread(thread);
      return { channelId, threadId, title: thread.title || threadTitle(root.text) };
    },

    /** スレッドの状態（脇の「状態」の並べ方のグループ）を付ける・外す（空にすると外す） */
    async setThreadStatus({ channelId, threadId, status }, _author) {
      await needPost(channelId, threadId);
      const thread = await threadStore.update(channelId, threadId, { status: status ? String(status) : null });
      emitThread(thread);
      return { channelId, threadId, status: thread.status ?? '' };
    },

    async search({ query, channelId, limit = LIMITS.searchDefault }) {
      const q = foldName(query).trim();
      if (!q) return { hits: [] };
      const max = Math.min(Math.max(1, Math.floor(limit) || LIMITS.searchDefault), LIMITS.searchMax);
      if (channelId) await need(channelId);
      const channels = (await store.channels()).filter((c) => !channelId || c.id === channelId);
      const hits = [];
      for (const channel of channels) {
        for (const p of await store.snapshot(channel.id)) {
          if (p.deletedAt || !p.text) continue;
          const at = foldName(p.text).indexOf(q);
          if (at < 0) continue;
          const from = Math.max(0, at - 40);
          const snippet = `${from > 0 ? '…' : ''}${p.text.slice(from, at + q.length + 80)}${at + q.length + 80 < p.text.length ? '…' : ''}`;
          hits.push({ channelId: channel.id, channelName: channel.name, postId: p.id, threadId: p.threadId, author: clone(p.author), at: p.at, snippet });
        }
      }
      return { hits: hits.sort((a, b) => b.at - a.at).slice(0, max) };
    },

    async create({ name, purpose = '', cwd = null, members = [] }, _author) {
      const n = normalizeChannelName(name);
      if (typeof purpose !== 'string' || purpose.length > LIMITS.purpose) throw invalid(`purpose is longer than ${LIMITS.purpose} characters`);
      const ids = validateMembers(members);
      await checkMembers(ids);
      await checkNameFree(n);
      const t = now();
      return saveChannel({ id: newId('channel', t), kind: 'channel', name: n, purpose, cwd: checkCwd(cwd), members: ids, memo: '', createdAt: t, lastPostAt: t });
    },
    async createDm({ bot }) {
      if (!bot?.id) throw invalid('bot is required');
      const existing = (await store.channels()).find((c) => c.kind === 'dm' && c.botId === bot.id);
      if (existing) return existing.name === bot.name ? existing : saveChannel({ ...existing, name: bot.name });
      const t = now();
      return saveChannel({ id: isId(bot.dmChannelId, 'channel') ? bot.dmChannelId : newId('channel', t), kind: 'dm', name: bot.name, purpose: '', cwd: null, members: [bot.id], memo: '', botId: bot.id, createdAt: t, lastPostAt: t });
    },
    async update({ channelId, name, purpose, cwd, members, memo, budget }, _author) {
      const channel = await need(channelId);
      if (channel.home && name !== undefined) throw invalid('the Quick chats channel cannot be renamed');
      const patch = {};
      if (name !== undefined) {
        patch.name = channel.kind === 'dm' ? String(name).trim() : normalizeChannelName(name);
        if (!patch.name) throw invalid('name is empty');
        if (channel.kind === 'channel' && foldName(patch.name) !== foldName(channel.name)) await checkNameFree(patch.name, channel.id);
      }
      if (purpose !== undefined) { if (typeof purpose !== 'string' || purpose.length > LIMITS.purpose) throw invalid(`purpose is longer than ${LIMITS.purpose} characters`); patch.purpose = purpose; }
      if (memo !== undefined) { if (typeof memo !== 'string' || memo.length > LIMITS.memo) throw invalid(`memo is longer than ${LIMITS.memo} characters`); patch.memo = memo; }
      if (cwd !== undefined) patch.cwd = checkCwd(cwd);
      if (members !== undefined) { patch.members = validateMembers(members); await checkMembers(patch.members); }
      if (budget !== undefined) {
        if (channel.kind !== 'channel') throw invalid('a DM has no budget');
        try { patch.budget = normalizeBudget(budget, channel.budget); } catch (e) { throw invalid(e.message); }
      }
      return patchChannel(channelId, (c) => ({ ...c, ...patch }));
    },
    async archive({ channelId, on }, _author) {
      const channel = await need(channelId);
      if (channel.home) throw invalid('the Quick chats channel cannot be archived');
      if (!on && channel.kind === 'channel') await checkNameFree(channel.name, channel.id);
      return patchChannel(channelId, (c) => {
        const next = { ...c };
        if (on) next.archivedAt = c.archivedAt ?? now(); else delete next.archivedAt;
        return next;
      });
    },

    async post({ channelId, threadId = null, text, new: forceNew = false, state, presents, attachments, turn, taint, routine, mentions, hold, origin, bySession, to, clientId }, author) {
      if (!isAuthor(author)) throw invalid('author is invalid');
      const channel = await need(channelId);
      if (channel.archivedAt) throw new ChannelError('CHANNEL_ARCHIVED', { id: channel.id });
      const files = normalizeAttachments(attachments);
      checkText(text, { allowEmpty: (Array.isArray(presents) && presents.length > 0) || files.length > 0 });
      if (state !== undefined && !POST_STATES.includes(state)) throw invalid(`state must be one of ${POST_STATES.join(' / ')}`);
      // 宛先（入力欄の宛先のチップで選んだ bot。人の投稿だけ）。本文の @ が先に効き、@ が無いときの宛先になる
      if (to !== undefined && to !== null && !(author.kind === 'human' && typeof to === 'string' && to)) throw invalid('to must be a bot id on a human post');
      const all = await store.snapshot(channelId);
      // 同じ clientId（入力欄が送るたびに作る id。応答が届かず送り直した・予定が送った）の人の投稿はもうある: 二重に投稿しない
      if (clientId !== undefined) {
        if (!(author.kind === 'human' && typeof clientId === 'string' && /^[a-zA-Z0-9:_-]{8,100}$/.test(clientId))) throw invalid('clientId must be 8-100 id characters on a human post');
        const known = [...all].reverse().find((p) => p.clientId === clientId);
        if (known) return clone(known);
      }
      if (threadId !== null) {
        const root = all.find((p) => p.id === threadId);
        if (!root) throw new ChannelError('POST_NOT_FOUND', { id: String(threadId) });
        if (root.taint) taint = root.taint;
        if (root.threadId !== null) throw invalid('threadId must be the id of a post in the channel flow (a thread root)');
      }
      const resolved = mentions ?? await resolveMentions(text, author);

      // bot がターンの中で書く: 返事をターンの投稿に入れるかは、その会話のターンを持つ dispatch が決める（最初の 1 件だけ。ADR 0117）。
      // hook が決めないときも、投稿元の会話が分かれば別の会話の作業中の投稿には触れない
      if (author.kind === 'bot' && !turn) {
        const claim = hooks.botPost?.({ channelId, threadId, botId: author.botId, sessionId: bySession ?? null });
        const fill = claim !== undefined ? claim.postId
          : forceNew ? null : [...all].reverse().find((p) => p.threadId === threadId && p.state === 'working' && p.turn?.botId === author.botId && (!bySession || p.turn.sessionId === bySession) && !p.deletedAt)?.id;
        if (fill) {
          const saved = await service.edit({ channelId, postId: fill, text, taint, ...(state !== undefined ? { state } : {}), ...(presents !== undefined ? { presents } : {}), ...(attachments !== undefined ? { attachments: files } : {}), mentions: resolved }, author);
          // ターンの投稿に入った返事も、新しい投稿と同じく posted へ渡す（@ をここで解く。extra.filled）。決めたのが dispatch でない置き換え（進捗）は渡さない
          if (claim !== undefined) {
            const extra = { filled: true, ...(Array.isArray(hold) ? { hold: [...hold], checked: true } : {}), ...(origin ? { origin: clone(origin) } : {}), ...(bySession ? { bySession } : {}) };
            Promise.resolve().then(() => hooks.posted?.(clone(saved), clone(channel), extra)).catch((e) => console.error('  channels: posted の後処理に失敗:', String(e?.message ?? e)));
          }
          return saved;
        }
      }

      const at = now();
      // 一時チャットで宛先に選んだ bot は、メンバーに足す（@ の候補・流れの頭の並びに出る）
      if (channel.home && to && !(channel.members ?? []).includes(to)) {
        if (!(await bots()).some((b) => b.id === to)) throw invalid('to must be a bot id');
        await patchChannel(channelId, (c) => ({ ...c, members: [...(c.members ?? []), to] }));
      }
      const post = {
        id: newId('post', at), channelId, threadId, author: clone(author), text, mentions: resolved, at,
        ...(state !== undefined ? { state } : {}), ...(turn ? { turn: clone(turn) } : {}), ...(presents ? { presents: clone(presents) } : {}),
        ...(files.length ? { attachments: files } : {}), reactions: {}, ...(taint ? { taint } : {}), ...(routine ? { routine: clone(routine) } : {}), proxy: null,
        ...(to ? { to } : {}), ...(clientId ? { clientId } : {}),
      };
      const saved = await store.append(channelId, { op: 'post', post });
      const updated = await store.updateChannel(channelId, (c) => ({ ...c, lastPostAt: Math.max(c.lastPostAt ?? 0, at) })) ?? channel;
      emit({ type: 'channelPost', channelId, op: 'add', post: saved });
      // 人が書いたら、止めていたスレッドをまた起こせるようにする
      if (author.kind === 'human' && threadId) {
        const th = await threadStore.get(channelId, threadId);
        if (th?.stopped) emitThread(await threadStore.update(channelId, threadId, { stopped: null }));
      }
      const extra = { ...(Array.isArray(hold) ? { hold: [...hold], checked: true } : {}), ...(origin ? { origin: clone(origin) } : {}), ...(bySession ? { bySession } : {}) };
      Promise.resolve().then(() => hooks.posted?.(clone(saved), clone(updated), extra)).catch((e) => console.error('  channels: posted の後処理に失敗:', String(e?.message ?? e)));
      return saved;
    },

    /**
     * スレッドを、ある投稿（atPostId）のところで分ける（channels.branchThread。ADR 9101）。根から atPostId までの投稿を新しい id で黙って写す
     * （hooks.posted を呼ばない＝写した @ で bot を起こさない）。author・at・text・添付・提示・mentions・ターンは残し、ターンの会話は sessions で付け替える。
     * 新しい根に branchOf、写した投稿に copyOf（元の投稿の id）。作業中だった投稿は stopped で写す。返り: { root, idMap }
     */
    async branchCopy({ channelId, threadId, atPostId, sessions = {} }) {
      const channel = await need(channelId);
      if (channel.kind === 'dm') throw invalid('a DM has no threads to branch');
      const all = (await store.snapshot(channelId)).filter((p) => p.id === threadId || p.threadId === threadId);
      if (!all.length || all[0].id !== threadId) throw new ChannelError('POST_NOT_FOUND', { id: String(threadId) });
      const at = all.findIndex((p) => p.id === atPostId);
      if (at < 0) throw new ChannelError('POST_NOT_FOUND', { id: String(atPostId) });
      const idMap = new Map();
      let root = null;
      for (const p of all.slice(0, at + 1)) {
        if (p.deletedAt && p.id !== threadId) continue;
        const id = newId('post', now());
        idMap.set(p.id, id);
        const state = p.state === undefined ? undefined : ['working', 'waiting', 'checking'].includes(p.state) ? 'stopped' : p.state;
        const copy = {
          id, channelId, threadId: root ? root.id : null, author: clone(p.author), text: p.text, mentions: clone(p.mentions ?? []), at: p.at,
          reactions: {}, proxy: null, copyOf: p.id,
          ...(state !== undefined ? { state } : {}),
          ...(p.attachments ? { attachments: clone(p.attachments) } : {}), ...(p.presents ? { presents: clone(p.presents) } : {}),
          ...(p.turn ? { turn: { ...clone(p.turn), ...(sessions[p.turn.sessionId] ? { sessionId: sessions[p.turn.sessionId] } : {}) } } : {}),
          ...(p.taint ? { taint: p.taint } : {}), ...(p.routine ? { routine: clone(p.routine) } : {}), ...(p.to ? { to: p.to } : {}),
          ...(root ? {} : { branchOf: { channelId, threadId, postId: atPostId } }),
        };
        const saved = await store.append(channelId, { op: 'post', post: copy });
        if (!root) root = saved;
        emit({ type: 'channelPost', channelId, op: 'add', post: saved });
      }
      return { root: clone(root), idMap };
    },

    async edit({ channelId, postId, text, state, presents, attachments, mentions, taint, failedWithBody }, _author) {
      const post = await needPost(channelId, postId);
      if (post.deletedAt) throw new ChannelError('POST_NOT_FOUND', { id: String(postId) });
      const op = { op: 'edit', id: postId, at: now() };
      if (taint === 'webhook') op.taint = taint;
      if (text !== undefined) {
        checkText(text, { allowEmpty: Boolean(presents?.length || post.presents?.length || attachments?.length || post.attachments?.length) });
        op.text = text;
        op.mentions = mentions ?? await resolveMentions(text, post.author);
      } else if (mentions !== undefined) op.mentions = mentions;
      if (state !== undefined) {
        if (!POST_STATES.includes(state)) throw invalid(`state must be one of ${POST_STATES.join(' / ')}`);
        op.state = state;
      }
      if (presents !== undefined) op.presents = clone(presents);
      if (attachments !== undefined) op.attachments = normalizeAttachments(attachments);
      if (failedWithBody === true && post.turn) op.failedWithBody = true;
      const saved = await store.append(channelId, op);
      emitEdit(channelId, saved);
      if (text !== undefined && saved.author.kind === 'human') await hooks.edited?.(clone(saved), clone(await need(channelId)));
      return saved;
    },
    /** 投稿を取り下げる（送り直し。channels.resend）。出来事は op 'withdraw'（画面は消す） */
    async withdraw({ channelId, postIds }) {
      await need(channelId);
      for (const id of postIds) {
        const saved = await store.append(channelId, { op: 'withdraw', id, at: now() });
        if (saved) emit({ type: 'channelPost', channelId, op: 'withdraw', post: { ...clone(saved), withdrawnAt: saved.withdrawnAt } });
      }
    },

    async remove({ channelId, postId }, _author) {
      const post = await needPost(channelId, postId);
      if (post.deletedAt) return;
      const saved = await store.append(channelId, { op: 'delete', id: postId, at: now() });
      edits.delete(postId);
      emit({ type: 'channelPost', channelId, op: 'delete', post: saved });
      Promise.resolve().then(async () => hooks.removed?.(clone(saved), clone(await need(channelId)))).catch((e) => console.error('  channels: removed の後処理に失敗:', String(e?.message ?? e)));
    },

    async react({ channelId, postId, emoji, on }, author) {
      if (!isAuthor(author)) throw invalid('author is invalid');
      if (!isSingleEmoji(emoji)) throw invalid('emoji must be exactly one emoji');
      const post = await needPost(channelId, postId);
      if (post.deletedAt) throw new ChannelError('POST_NOT_FOUND', { id: String(postId) });
      if (on && !post.reactions[emoji] && Object.keys(post.reactions).length >= LIMITS.reactionKinds) throw invalid(`a post can have at most ${LIMITS.reactionKinds} kinds of reactions`);
      const saved = await store.append(channelId, { op: 'react', id: postId, emoji, by: clone(author), on: Boolean(on), at: now() });
      emit({ type: 'channelReaction', channelId, postId, reactions: saved.reactions });
      if (saved.author?.kind === 'bot') {
        const change = { emoji, on: Boolean(on), by: clone(author) };
        Promise.resolve().then(async () => hooks.reacted?.(clone(saved), clone(await need(channelId)), change)).catch((e) => console.error('  channels: reacted の後処理に失敗:', String(e?.message ?? e)));
      }
      return { reactions: saved.reactions };
    },

    async markRead({ channelId, threadId, at }) {
      await need(channelId);
      if (!Number.isFinite(at)) throw invalid('at must be a number');
      // スレッドを読んだ: そのスレッドの既読も進める（脇の行の未読。チャンネルの既読は今までどおり同じ値を進める）
      if (threadId) {
        await needPost(channelId, threadId);
        emitThread(await threadStore.update(channelId, threadId, { readAt: at }));
      }
      const state = await store.setReadState(channelId, { readAt: at, mentionAt: at });
      emit({ type: 'channelRead', channelId, readAt: state.readAt });
      return { readAt: state.readAt };
    },

    async stopThread({ channelId, threadId }, author) {
      if (!isAuthor(author)) throw invalid('author is invalid');
      await need(channelId);
      const root = (await store.snapshot(channelId)).find((p) => p.id === threadId && p.threadId === null);
      if (!root) throw new ChannelError('POST_NOT_FOUND', { id: String(threadId) });
      emitThread(await threadStore.update(channelId, threadId, { stopped: { by: clone(author), at: now() } }));
      await hooks.stopThread?.({ channelId, threadId }, clone(author));
      return (await threadStore.get(channelId, threadId));
    },

    mentionsOf: (text, author) => resolveMentions(String(text ?? ''), author),

    threads: {
      get: (channelId, threadId) => threadStore.get(channelId, threadId),
      list: (channelId) => threadStore.list(channelId),
      async update(channelId, threadId, patch) {
        const thread = await threadStore.update(channelId, threadId, patch);
        emitThread(thread);
        return thread;
      },
    },
  };
  return service;
}
