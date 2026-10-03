// bot の記憶（S3。ADR 0110）。正本は store.mjs の markdown、索引は index.mjs、ターンの末尾の文は tail.mjs、出どころの検査は guard.mjs。
// 夜の整理（学習）は P3 の core/memory/learn.mjs。core/ops/memory.mjs の handler は `ctx.memory` としてこれを呼ぶ。
// 形の正本は core/channels/types.mjs の MemoryEntry、置き場は <data>/memory/（types.mjs の冒頭）。
//
// createMemoryService({ dataDir, channels?, emit, now, localeOf?, loadSqlite?, log? }) → MemoryService
//   dataDir … <data>。記憶は <dataDir>/memory/ に置く
//   channels … ChannelService（出どころの投稿を引く）。無ければ post の出どころは確かめられない
//   emit … memoryChanged { layer, rev } を出す
//   localeOf() … 記憶の markdown の見出しの言語（既定 ja。会話の言語ではなく PC の言語）
//   loadSqlite … index.mjs へ（テストで node:sqlite を読み込めない状態を差し込む）
//
// MemoryService（author は types.mjs の Author。ctx は { sessions, sessionId, locale }）:
//   start(): Promise<void>・stop(): void
//   list({ layer }): Promise<MemoryEntry[]>                       … layer は 'user' か botId。ファイルの順。各行に今の強さ strength と faded（核の写しに入らない）を付ける
//   get({ id }): Promise<MemoryEntry|null>
//   search({ query, layer?, layers?, limit }): Promise<MemoryEntry[]>   … 各 150 トークンまで。layer 省略なら layers（無ければ全層）
//   write({ layer, text, why?, sources, kind?, weight?, status? }, author, ctx): Promise<MemoryEntry>   … 出どころの検査（MEMORY_SOURCE・MEMORY_REJECTED）はここ。
//       kind・weight・status は記憶の種類・重み・状態（strength.mjs。ADR 0118）。AI の重み 3 は guard.capWeight が根拠を見て 2 に抑える
//   edit({ id, text?, why?, sources?, kind?, weight?, status? }, author, ctx): Promise<MemoryEntry>・forget({ id }, author, ctx): Promise<MemoryEntry>・unforget({ id }, author, ctx): Promise<MemoryEntry>
//       … 人も AI も使える（edit は write、forget は guarded）。誰がしたかは log.jsonl の by に残す。無い id は MEMORY_NOT_FOUND
//   rev(): number                                                 … log.jsonl の最後の rev
//   turnContext({ bot, session, sessionId?, incomingText, now?, locale? }):
//       Promise<{ notes: string[], memRev: number, delivered: string[], snapshotDue: boolean }>
//       … bot は Bot（id）、session は sidecar の SessionBot（memRev・snapshotDue・delivered）。notes は memoryCoreEnvelope（snapshotDue のときだけ）と
//         turnContextEnvelope（毎ターン）の並び。返りの memRev・delivered・snapshotDue を dispatch が sidecar に書き戻す。dispatch.turnExtras がこれを返す
import path from 'node:path';
import { agentT } from '../i18n.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { createMemoryStore, fingerprintOf, isLayer, oneLine, USER_LAYER } from './store.mjs';
import { createMemoryIndex } from './index.mjs';
import { MemoryError, checkText, checkSources, sourceResolvers, capWeight } from './guard.mjs';
import { strengthOf, FADED_BELOW } from './strength.mjs';
import { foldDelta, pickCore, coreSnapshot, turnContext as turnContextText } from './tail.mjs';

export { MemoryError };

/** memory.search の各件の上限（トークン） */
export const RESULT_TOKENS = 150;
/** 渡し済みの id を覚える数（圧縮で空になるので、普段は届かない上限） */
const DELIVERED_MAX = 400;
/** bot が 1 ターンに user 層へ書ける件数（全 bot が読む層なので、暴走・汚染の幅を抑える。超えたら MEMORY_REJECTED:userWriteLimit） */
export const USER_WRITES_PER_TURN = 5;

/** 外へ出す行に今の強さを付ける（保存はしない。小数 2 桁） */
const withStrength = (entry, at) => {
  const strength = strengthOf(entry, at);
  return { ...entry, strength: Math.round(strength * 100) / 100, faded: strength < FADED_BELOW };
};

/** 150 トークンに収まるまで切る（本文は 300 字までなので、普通は切らない） */
const clip = (entry) => {
  if (estimateTokens(entry.text) <= RESULT_TOKENS) return entry;
  let text = [...entry.text];
  while (text.length > 1 && estimateTokens(`${text.join('')}…`) > RESULT_TOKENS) text = text.slice(0, Math.floor(text.length * 0.9));
  return { ...entry, text: `${text.join('')}…` };
};

export function createMemoryService({ dataDir, channels = null, emit = () => {}, now = Date.now, localeOf = () => 'ja', loadSqlite, log = () => {} } = {}) {
  const dir = path.join(dataDir, 'memory');
  const titleOf = (layer) => (layer === USER_LAYER ? agentT(localeOf(), 'memory.title.user') : agentT(localeOf(), 'memory.title.bot'));
  const store = createMemoryStore({ dir, now, titleOf });
  const index = createMemoryIndex({ file: path.join(dir, 'index.sqlite'), ...(loadSqlite ? { loadSqlite } : {}), log });
  let started = false;
  let indexed = null;   // 索引に渡した正本の印（store.hash）
  const userWrites = new Map();   // bot の会話の sessionId（会話の外なら bot:<id>）→ このターンに user 層へ書いた件数。ターンの始まり（turnContext）で 0 に戻す

  const announce = (layer) => emit({ type: 'memoryChanged', layer, rev: store.rev() });

  /** 人が markdown を直接直していたら記録に足して配る。変わった層の数 */
  async function catchUp() {
    if (!started) { await store.init(); started = true; }
    const changed = await store.sync();
    for (const layer of changed) announce(layer);
    return changed.length;
  }
  async function ensureIndex() {
    await catchUp();
    const hash = store.hash();
    if (hash === indexed) return;
    await index.sync(store.entries(), hash);
    indexed = hash;
  }

  const notFound = (id) => new MemoryError('MEMORY_NOT_FOUND', 'notFound', id);
  const needLayer = (layer) => { if (!isLayer(layer)) throw new MemoryError('MEMORY_REJECTED', 'layer', String(layer)); };
  const isHuman = (author) => author?.kind === 'human';

  /** 出どころの検査（人でなければ必須）。返りは { sources: 確かめた出どころ, humanQuotes: そのうち人の発言の引用 } */
  async function verified(sources, author, ctx) {
    const resolvers = sourceResolvers({ channels, sessions: ctx?.sessions, botOfSession: ctx?.botOfSession });
    const human = isHuman(author);
    if (human && !sources?.length) return { sources: [], humanQuotes: [] };
    const out = await checkSources(sources, resolvers, { required: !human });
    return { sources: out.sources, humanQuotes: out.humanQuotes };
  }

  /** bot が user 層へ書く（本文を変える）ときの 1 ターンの上限。数えるのは書けたときだけ（ensure → bump の順） */
  const budgetKey = (author, ctx) => (author?.kind === 'bot' && ctx?.sessionId ? ctx.sessionId : author?.kind === 'bot' ? `bot:${author.botId}` : null);
  const ensureBudget = (layer, author, ctx) => {
    const key = layer === USER_LAYER ? budgetKey(author, ctx) : null;
    if (key && (userWrites.get(key) ?? 0) >= USER_WRITES_PER_TURN) throw new MemoryError('MEMORY_REJECTED', 'userWriteLimit', String(USER_WRITES_PER_TURN));
    return key;
  };
  const bump = (key) => { if (key) userWrites.set(key, (userWrites.get(key) ?? 0) + 1); };

  return {
    dataDir, emit, now,
    store, index,
    // 起動では正本を読むだけ（索引は最初の検索・末尾の組み立てで作る。bot を使わない人の置き場に索引のファイルを作らない）
    async start() { await catchUp(); },
    stop() { index.close(); started = false; indexed = null; },

    async list({ layer } = {}) {
      await catchUp();
      const at = now();
      return (layer ? store.entries(layer) : store.entries()).map((e) => withStrength(e, at));
    },
    async get({ id } = {}) {
      await catchUp();
      return store.get(id);
    },
    async search({ query, layer, layers, limit = 5 } = {}) {
      await ensureIndex();
      const scope = layer ? [layer] : layers?.length ? layers : null;
      const at = now();
      return (await index.search({ query, ...(scope ? { layers: scope } : {}), limit })).map((e) => withStrength(clip(e), at));
    },

    async write({ layer, text, why, sources, kind, weight, status } = {}, author, ctx = {}) {
      needLayer(layer);
      await catchUp();
      const human = isHuman(author);
      const budget = ensureBudget(layer, author, ctx);
      const clean = checkText(text, { human, isTombstoned: store.isTombstoned, fingerprint: fingerprintOf });
      const note = why == null || why === '' ? undefined : checkText(why, { human, isTombstoned: null }).slice(0, 300);
      const proven = await verified(sources, author, ctx);
      const fp = fingerprintOf(clean);
      if (store.entries(layer).some((e) => fingerprintOf(e.text) === fp)) throw new MemoryError('MEMORY_REJECTED', 'duplicate');
      const tags = { kind, weight: capWeight(weight, { human, kind, humanQuotes: proven.humanQuotes }), status };
      const added = await store.add({ layer, text: clean, why: note, sources: proven.sources, by: author, via: ctx.sessionId, unique: true, ...tags });
      if (added.duplicate) throw new MemoryError('MEMORY_REJECTED', 'duplicate');
      const { entry } = added;
      bump(budget);
      announce(layer);
      return entry;
    },

    async edit({ id, text, why, sources, kind, weight, status } = {}, author, ctx = {}) {
      await catchUp();
      const old = store.get(id);
      if (!old) throw notFound(id);
      const human = isHuman(author);
      const changing = text !== undefined && oneLine(text) !== old.text;
      const budget = changing ? ensureBudget(old.layer, author, ctx) : null;
      const clean = text === undefined ? undefined : checkText(text, { human, isTombstoned: store.isTombstoned, fingerprint: fingerprintOf });
      const note = why === undefined ? undefined : why === '' ? '' : checkText(why, { human, isTombstoned: null }).slice(0, 300);
      // AI が本文を変えるときは、新しく書くときと同じく人の発言の根拠が要る
      const proven = clean !== undefined && clean !== old.text ? await verified(sources, author, ctx) : { sources: [], humanQuotes: [] };
      if (clean !== undefined && clean !== old.text) {
        const fp = fingerprintOf(clean);
        if (store.entries(old.layer).some((e) => e.id !== id && fingerprintOf(e.text) === fp)) throw new MemoryError('MEMORY_REJECTED', 'duplicate');
      }
      const cappedWeight = capWeight(weight, { human, kind: kind ?? old.kind ?? null, humanQuotes: proven.humanQuotes });
      const done = await store.edit({ id, text: clean, why: note, sources: proven.sources.length ? proven.sources : undefined, by: author, via: ctx.sessionId,
        kind, weight: cappedWeight, status });
      if (!done) throw notFound(id);
      bump(budget);
      announce(done.entry.layer);
      return done.entry;
    },

    async forget({ id } = {}, author, ctx = {}) {
      await catchUp();
      const done = await store.forget({ id, by: author, via: ctx.sessionId });
      if (!done) throw notFound(id);
      announce(done.entry.layer);
      return done.entry;
    },

    /** 忘れた直後で戻せる記憶の写し（無ければ null）。unforget の前に、見える層か確かめるのに使う */
    async forgotten({ id } = {}) {
      await catchUp();
      return store.forgottenEntry(id);
    },

    async unforget({ id } = {}, author, ctx = {}) {
      await catchUp();
      const done = await store.unforget({ id, by: author, via: ctx.sessionId });
      if (!done) throw notFound(id);
      announce(done.entry.layer);
      return done.entry;
    },

    rev: () => store.rev(),

    async turnContext({ bot, session = {}, sessionId = null, incomingText = '', now: at = now(), locale } = {}) {
      await ensureIndex();
      if (sessionId) userWrites.delete(sessionId);   // 新しいターンの始まり: user 層への書き込みの数え直し
      const layers = bot?.id ? [USER_LAYER, bot.id] : [USER_LAYER];
      const rev = store.rev();
      const due = session.snapshotDue === true;
      let delivered = due ? [] : [...(session.delivered ?? [])];
      const notes = [];
      let delta = [];
      if (due) {
        // 核の写しが今の全体を含むので、差分は要らない
        const core = pickCore(store.entries(USER_LAYER), bot?.id ? store.entries(bot.id) : [], { now: at });
        const snapshot = coreSnapshot({ core, locale });
        if (snapshot) notes.push(snapshot);
        delivered = core.ids;
      } else {
        const folded = foldDelta(store.recordsSince(Number.isInteger(session.memRev) ? session.memRev : 0), { layers, skipVia: sessionId });
        delta = folded.items;
        delivered = [...delivered, ...folded.skipped, ...delta.filter((d) => d.kind !== 'forget').map((d) => d.id)];
      }
      const related = incomingText
        ? (await index.related({ text: incomingText, layers, exclude: delivered, limit: 5 })).map((r) => r.entry)
        : [];
      delivered = [...new Set([...delivered, ...related.map((e) => e.id)])].slice(-DELIVERED_MAX);
      notes.push(turnContextText({ now: at, delta, related, locale }));
      return { notes, memRev: rev, delivered, snapshotDue: false };
    },
  };
}
