// 記憶に書く内容と出どころの検査（ADR 0097）。AI が書く記憶は、人が承認する段を持たない代わりに、ここでコードが断る。
//   本文: 300 字まで・1 行・URL・コマンドらしい文・「前の指示を無視」型・包みの開閉タグ・忘れた記憶と同じ内容（墓石）は断る（MEMORY_REJECTED）
//   出どころ: 人の発言を 1 つ以上含むこと。チャンネルの人の投稿（taint の無いもの）か、Chats の user の行（完了通知・代理の送信・包みの行でないもの）。
//     AI の出力（bot・agent の投稿、assistant の発言）は、それを採用した人の発言を一緒に挙げたときだけ根拠にできる。
//     webhook・Web の文を含む投稿（taint）や、本文に quote が無い出どころは根拠にならない（MEMORY_SOURCE）
// 人（Author.kind === 'human'）が自分で書く記憶は、出どころ・墓石・URL などの規則を掛けない（長さと 1 行だけ）。
import { isId } from '../channels/types.mjs';
import { MEMORY_TEXT_MAX, oneLine } from './store.mjs';

export const MEMORY_CODES = Object.freeze(['MEMORY_SOURCE', 'MEMORY_REJECTED', 'MEMORY_NOT_FOUND']);
export const SOURCES_MAX = 8;
export const QUOTE_MAX = 300;

/** 記憶の操作の失敗。code は ops の失敗の code（辞書 agent:ops.errors.<code>）、reason は短い理由の印（辞書 agent:memory.reason.<reason>） */
export class MemoryError extends Error {
  constructor(code, reason, detail) {
    super(`${code}: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'MemoryError';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

const URL_RX = /\b(?:https?|ftp|file|wss?|data|javascript):\/?\/?\S|\bwww\.\S/i;
const MARKUP_RX = /<!--|-->|<\/?\s*(?:pleiad-|routine-payload|system|assistant|tool)/i;
const COMMAND_RX = [
  /^\s*(?:\$|#|>|ps>)\s/i,                                                             // プロンプト記号で始まる
  /^\s*(?:sudo|rm|del|curl|wget|chmod|chown|powershell|pwsh|cmd|bash|sh|npx|pnpm|yarn|npm|pip|git|node|python3?|docker|kubectl)\s+[-\w./\\]/i, // コマンド名で始まる
  /```/,                                                                              // コードの囲み
  /\|\s*(?:sh|bash|zsh|iex|powershell)\b/i,                                           // パイプでシェルへ
  /\b(?:invoke-expression|invoke-webrequest|eval\s*\(|exec\s*\()/i,
];
const INJECTION_RX = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|prior|above|earlier|all|any|system)\b.{0,40}\b(?:instructions?|prompts?|rules?|messages?)\b/i,
  /\b(?:you are now|from now on,? you|new instructions?:|system prompt|developer message)\b/i,
  /(?:前|以前|これまで|上記|今まで)の(?:指示|命令|ルール|プロンプト)を?(?:全て|すべて)?(?:無視|忘れ|破棄|上書き)/,
  /(?:システム|開発者)(?:プロンプト|メッセージ|指示)/,
  /(?:新しい|次の)(?:指示|命令)\s*[:：]/,
];

/**
 * 本文の検査。human なら長さと 1 行だけ。返りは 1 行にそろえた本文（投げるのは MemoryError）。
 * isTombstoned(fp) は墓石の照会（呼び出し側が store を渡す）。fp は store.fingerprintOf
 */
export function checkText(raw, { human = false, isTombstoned = null, fingerprint = null } = {}) {
  const text = oneLine(raw);
  if (!text) throw new MemoryError('MEMORY_REJECTED', 'empty');
  if ([...text].length > MEMORY_TEXT_MAX) throw new MemoryError('MEMORY_REJECTED', 'tooLong');
  if (human) return text;
  if (MARKUP_RX.test(text)) throw new MemoryError('MEMORY_REJECTED', 'markup');
  if (URL_RX.test(text)) throw new MemoryError('MEMORY_REJECTED', 'url');
  if (COMMAND_RX.some((rx) => rx.test(text))) throw new MemoryError('MEMORY_REJECTED', 'command');
  if (INJECTION_RX.some((rx) => rx.test(text))) throw new MemoryError('MEMORY_REJECTED', 'injection');
  if (isTombstoned && fingerprint && isTombstoned(fingerprint(text))) throw new MemoryError('MEMORY_REJECTED', 'tombstone');
  return text;
}

/** 空白・全角半角・大小の違いを無視して照合する（quote が本文に含まれるか。日本語は空白の有無が揺れる） */
export const includesQuote = (body, quote) => {
  const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const q = fold(quote);
  return q.length > 0 && fold(body).includes(q);
};

/** 出どころの 1 件を、投稿・発言の実物と照らす。返りは { kind: 'human'|'ai', source } か { problem } */
async function verifyOne(src, resolvers) {
  const quote = oneLine(src.quote);
  if (!quote) return { problem: 'quote' };
  if (src.kind === 'post') {
    if (!src.channelId || !src.postId || !resolvers?.post) return { problem: 'unresolved' };
    const post = await resolvers.post({ channelId: src.channelId, postId: src.postId, threadId: src.threadId ?? null }).catch(() => null);
    if (!post || post.deletedAt) return { problem: 'notFound' };
    if (!includesQuote(post.text, quote)) return { problem: 'quote' };
    const channelId = post.channelId ?? src.channelId;
    const stored = { kind: 'post', channelId, postId: post.id ?? src.postId, ...(src.threadId ? { threadId: src.threadId } : {}), quote, at: Number.isFinite(post.at) ? post.at : 0 };
    const by = post.author?.kind;
    if (by === 'human') return post.taint ? { problem: 'tainted' } : { kind: 'human', source: stored };
    if (by === 'bot' || by === 'agent' || by === 'routine') return { kind: 'ai', source: stored };
    return { problem: 'notHuman' };
  }
  if (src.kind === 'message') {
    if (!src.sessionId || !src.messageId || !resolvers?.message) return { problem: 'unresolved' };
    const msg = await resolvers.message({ sessionId: src.sessionId, messageId: src.messageId }).catch(() => null);
    if (!msg) return { problem: 'notFound' };
    if (!includesQuote(msg.text, quote)) return { problem: 'quote' };
    const at = typeof msg.at === 'number' ? msg.at : Date.parse(msg.at ?? '');
    const stored = { kind: 'message', sessionId: src.sessionId, messageId: src.messageId, quote, at: Number.isFinite(at) ? at : 0 };
    if (msg.role === 'user' && !msg.kind && !msg.internalTaskNotice && !msg.proxyBy && !msg.proxy) return { kind: 'human', source: stored };
    if (msg.role === 'assistant' && !msg.kind) return { kind: 'ai', source: stored };
    return { problem: 'notHuman' };
  }
  return { problem: 'unresolved' };
}

/**
 * 出どころの検査。sources は入力（{ kind, channelId?, postId?, threadId?, sessionId?, messageId?, quote }）。
 * 返りは { sources: 確かめられたものの正規形（at は実物の時刻）, grounded: 人の発言を含むか, problems }。
 * required が真で人の発言が無ければ MEMORY_SOURCE を投げる（reason は一番最初の問題）
 */
export async function checkSources(sources, resolvers, { required = true } = {}) {
  const list = Array.isArray(sources) ? sources.slice(0, SOURCES_MAX) : [];
  const results = [];
  for (const src of list) results.push(await verifyOne(src ?? {}, resolvers));
  const verified = results.filter((r) => r.source);
  const grounded = verified.some((r) => r.kind === 'human');
  const problems = results.filter((r) => r.problem).map((r) => r.problem);
  if (required && !grounded) throw new MemoryError('MEMORY_SOURCE', problems[0] ?? 'noHuman');
  return { sources: verified.map((r) => r.source), grounded, problems };
}

/**
 * 出どころの実物を引く口（checkSources の resolvers）を、チャンネルのサービスと会話の読み出しから作る。
 *   channels … ChannelService（list・read。投稿は read を nextBefore でさかのぼって探す）
 *   sessions … ops の ctx.sessions（read(sessionId) → 発言の並び。uuid が messageId）
 * bot の会話に渡る包みの channel は表示名（#名前）なので、channelId には表示名も使える
 */
export function sourceResolvers({ channels, sessions } = {}) {
  const PAGES = 10;
  const channelIdOf = async (ref) => {
    if (isId(ref, 'channel')) return ref;
    const name = String(ref ?? '').replace(/^#/, '');
    const list = (await channels?.list?.().catch(() => [])) ?? [];
    return list.find((c) => c.name === name || c.id === ref)?.id ?? null;
  };
  return {
    async post({ channelId, postId, threadId }) {
      if (!channels?.read) return null;
      const id = await channelIdOf(channelId);
      if (!id) return null;
      let before;
      for (let page = 0; page < PAGES; page++) {
        const out = await channels.read({ channelId: id, ...(threadId ? { threadId } : {}), ...(before ? { before } : {}), limit: 100 });
        const hit = out?.posts?.find((p) => p.id === postId);
        if (hit) return { ...hit, channelId: id };
        before = out?.nextBefore;
        if (!before) break;
      }
      return null;
    },
    async message({ sessionId, messageId }) {
      const messages = await sessions?.read?.(sessionId);
      return Array.isArray(messages) ? messages.find((m) => m.uuid === messageId) ?? null : null;
    },
  };
}
