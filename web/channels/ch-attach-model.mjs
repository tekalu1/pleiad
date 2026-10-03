// チャンネル・スレッドの入力欄の添付と下書きの、DOM を触らない決まり（web/channels/ch-attachments.mjs・ch-composer.mjs が使う。
// tests/unit/channels-composer-ui.mjs が直接確かめる）。添付の印・並べ方は Chats の入力欄（web/client.mjs の submit）と同じ。
import { attachmentLine, normalizeAttachmentPath } from '../timeline.mjs';

/** 字の欄の札・添付の実体を引くキー（web/md-editor.mjs の `p:パス` と同じ） */
export const attachedKey = (path) => `p:${normalizeAttachmentPath(path)}`;

/** 添付を字の欄の位置の順に並べる。文中に無いもの（文末に付く）は後ろ。order は editor.attachmentKeys() の並び */
export function orderAttachments(attached, order) {
  const keys = [...order];
  const rank = (a) => { const i = keys.indexOf(attachedKey(a.path)); return i < 0 ? keys.length : i; };
  return attached.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}

/**
 * 送るもの。本文は文中の印（`[添付] パス`）ごとそのまま、文中に無い添付だけ末尾へ印を足す（Chats の submit と同じ）。
 * 印はエージェントが読むので locale（画面の言語）で。attachments は ops の channels.post へ渡す形（パス・名前・種類）
 * @param {string} value 字の欄の値（Markdown）
 * @param {{ path: string, name?: string, mime?: string }[]} attached 添付の実体
 * @param {Iterable<string>} order 字の欄の中の添付のキーの並び（editor.attachmentKeys()）
 * @param {string} locale 'ja' | 'en'
 * @returns {{ text: string, attachments: { path: string, name: string, mime: string }[] }}
 */
export function composeBody(value, attached, order, locale) {
  const inDoc = new Set(order);
  const ordered = orderAttachments(attached, inDoc);
  const tail = ordered.filter((a) => !inDoc.has(attachedKey(a.path)));
  const text = [String(value ?? '').trim(), tail.map((a) => attachmentLine(locale, a.path)).join('\n')].filter(Boolean).join('\n\n');
  return { text, attachments: ordered.map((a) => ({ path: a.path, name: a.name, mime: a.mime ?? '' })) };
}

// ---------------------------------------------------------------- 下書き
// 入力欄ごと（チャンネルの流れ・スレッド）の書きかけ。Chats は会話ごとに保存する（web/client.mjs の saveDraft）。ここは端末の localStorage に持つ
// （再読み込みしても残る）。件数の上限を決め、古いものから捨てる。

export const DRAFT_STORE = 'agent-host-channel-drafts';
export const DRAFT_LIMIT = 60;

/** 下書きの入れ物（key → { text, attached, at }）を保存の形から読む。壊れていれば空 */
export function parseDrafts(raw) {
  let list;
  try { list = JSON.parse(raw ?? '[]'); } catch { return new Map(); }
  if (!Array.isArray(list)) return new Map();
  const out = new Map();
  for (const entry of list) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue;
    const [key, value] = entry;
    out.set(key, {
      text: typeof value.text === 'string' ? value.text : '',
      attached: Array.isArray(value.attached) ? value.attached.filter((a) => a && typeof a.path === 'string') : [],
      at: Number.isFinite(value.at) ? value.at : 0,
    });
  }
  return out;
}

/** 空の下書きは持たない。上限を超えたら古い（at の小さい）ものから捨てる */
export function pruneDrafts(drafts, limit = DRAFT_LIMIT) {
  for (const [key, d] of drafts) if (!d.text.trim() && !d.attached.length) drafts.delete(key);
  if (drafts.size <= limit) return drafts;
  const keep = new Set([...drafts].sort((a, b) => b[1].at - a[1].at).slice(0, limit).map(([key]) => key));
  for (const key of drafts.keys()) if (!keep.has(key)) drafts.delete(key);
  return drafts;
}

export const serializeDrafts = (drafts) => JSON.stringify([...pruneDrafts(drafts)]);

/** 下書きの key。流れはチャンネルごと、スレッドはスレッドごと */
export const feedDraftKey = (channelId) => `ch:${channelId}`;
export const threadDraftKey = (channelId, threadId) => `th:${channelId}:${threadId}`;
