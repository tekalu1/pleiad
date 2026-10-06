// スレッドの bot の返事の下に畳んで付ける「作業ログ」（ADR 0117）。独り言・終わりの報告の文と、道具の行（Chats と同じ部品。web/tool-bundle.mjs の Bundle・web/render.mjs の renderToolCall）。
// 材料は bot の会話の履歴（loadSession）。スレッドの投稿は進捗の文と提示だけを持つので、そのターンの道具の呼び出しは会話から引く:
//   ターンの投稿（turn.sessionId）の at から、同じ会話の次のターンの投稿の at までの間の AI の発言の toolCalls。
// 走っているターンは履歴にまだ無いので、出来事（loadSession の live が返す stream.events）を stream-messages.mjs で畳んで後ろに足す。
import { renderToolCall, applyToolResult, isDelegateToolName } from '../render.mjs';
import { Bundle, splitToolCalls, markRunning } from '../tool-bundle.mjs';
import { isComputerTool } from '../computer-use.mjs';
import { streamMessages } from '../stream-messages.mjs';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'collabAgentToolCall', 'subAgentActivity']);
/** 委譲はまとまりの外に 1 件ずつ出す（client.mjs の toolNodes と同じ） */
const isBoundary = (name) => isDelegateToolName(name) || SUBAGENT_TOOLS.has(name);

/** 更新の最短の間隔。走っている間は投稿の更新（1 秒に 1 回まで）のたびに頼まない */
export const REFRESH_MS = 2500;

/**
 * ターンの投稿ごとの「道具の呼び出しを引く範囲」。同じ会話の次のターンの投稿の at まで（最後は終わりまで）。
 * @param {object[]} posts 時間順の投稿
 * @returns {Map<string, { sessionId: string, from: number, to: number }>}
 */
export function turnWindows(posts) {
  const bySession = new Map();
  for (const p of posts) {
    if (!p.turn?.sessionId || p.deletedAt) continue;
    (bySession.get(p.turn.sessionId) ?? bySession.set(p.turn.sessionId, []).get(p.turn.sessionId)).push(p);
  }
  const out = new Map();
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => a.at - b.at);
    list.forEach((p, i) => out.set(p.id, { sessionId, from: p.at, to: list[i + 1]?.at ?? Infinity }));
  }
  return out;
}

/** 窓の中の AI の発言の道具の呼び出し（元の順）。履歴に時刻が無い発言（走っているターンの仮の発言）は最後の窓に入れる */
export function callsInWindow(messages, { from, to }) {
  const calls = [];
  // 発言ごとの時刻で窓に分ける（mergeToolTurns は発言をまたいでつなぐので、窓に分けた後でも使わない。ここは呼び出しを並べるだけ）
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const at = typeof m.at === 'number' ? m.at : Date.parse(m.at);
    if (!Number.isFinite(at)) { if (to !== Infinity) continue; }
    else if (at < from - 1500 || at >= to) continue;
    if (m.toolCalls?.length) calls.push(...m.toolCalls);
    else for (const name of m.tools ?? []) calls.push({ id: null, name, input: null, result: undefined });
  }
  return calls;
}

/** 発言が窓に入るか（callsInWindow と同じ基準。時刻の無い仮の発言は最後の窓だけ） */
function inWindow(m, { from, to }) {
  const at = typeof m.at === 'number' ? m.at : Date.parse(m.at);
  if (!Number.isFinite(at)) return to === Infinity;
  return at >= from - 1500 && at < to;
}

/**
 * 窓の中の作業ログ（ADR 0117。返事の下に畳んで残す）: 返事の本文（reply）以外の AI の文（道具の前の独り言・終わりの報告）と、道具の呼び出しを発言の順に。
 * 発言の文が返事で終わる（Antigravity は 1 ターンの文を 1 つの発言に続けて書く）なら、その前の部分だけを入れる。続く呼び出しは 1 つにまとめる。
 * @returns {({ kind: 'text', text: string } | { kind: 'calls', calls: object[] })[]}
 */
export function logInWindow(messages, w, reply = '') {
  const answer = String(reply ?? '').trim();
  const items = [];
  const push = (item) => { const last = items.at(-1); if (item.kind === 'calls' && last?.kind === 'calls') last.calls.push(...item.calls); else items.push(item); };
  for (const m of messages ?? []) {
    if (m.role !== 'assistant' || !inWindow(m, w)) continue;
    let text = String(m.text ?? '').trim();
    if (answer && text.endsWith(answer)) text = text.slice(0, text.length - answer.length).trim();
    if (text) push({ kind: 'text', text });
    const calls = m.toolCalls?.length ? m.toolCalls : (m.tools ?? []).map((name) => ({ id: null, name, input: null, result: undefined }));
    if (calls.length) push({ kind: 'calls', calls: [...calls] });
  }
  return items;
}

/** 呼び出しの並びの印。同じなら描き直さない（開いている行・まとまりを保つ） */
export const signatureOf = (calls) => calls.map((c) => `${c.id ?? c.name}:${c.result ? (c.result.isError ? 'e' : 'r') : 'p'}`).join('|');

/**
 * 呼び出しの並びを、まとまり（1 件だけなら行のまま）と委譲に分けた要素にする。走っている最後の呼び出し（結果が無い）は走っている印。
 * link(card, call) は、カードを作るたびに呼ぶ（委譲のカードを Chats と同じ形に仕上げる口。client.mjs の linkDelegateCard）
 * @returns {{ nodes: HTMLElement[], bundles: Bundle[] }}
 */
export function toolNodes(calls, { running = false, link = null } = {}) {
  const cards = calls.map((c, i) => {
    const card = renderToolCall(c.name, c.input, { id: c.id ?? undefined });
    if (c.result) applyToolResult(card, c.result);
    else if (running && i === calls.length - 1 && c.id) markRunning(card);
    if (link && isBoundary(card.dataset.tool)) link(card, c);
    return card;
  });
  const nodes = [], bundles = [];
  const segments = splitToolCalls(cards, (card) => isBoundary(card.dataset.tool),
    (card) => (isComputerTool(card.dataset.tool) ? 'computer' : 'tools'));
  for (const seg of segments) {
    if (seg.type === 'delegate') { nodes.push(seg.call); continue; }
    if (seg.calls.length === 1 && seg.kind !== 'computer') { nodes.push(seg.calls[0]); continue; }
    const bundle = new Bundle({ kind: seg.kind });
    bundle.addAll(seg.calls);
    nodes.push(bundle.el);
    bundles.push(bundle);
  }
  return { nodes, bundles };
}

/**
 * 会話ごとの履歴を持ち、ターンの投稿に付ける行を作る。
 * @param {object} o
 * @param {(command: string, args?: object) => Promise<any>} o.cmd
 * @param {(backend: string|null) => string|null} [o.modelOf]
 */
export function createToolSource({ cmd }) {
  const sessions = new Map();   // sessionId -> { messages, at, busy, queued }
  const listeners = new Set();

  async function read(sessionId) {
    const data = await cmd('loadSession', { sessionId, live: true });
    const live = streamMessages(data?.stream?.events, { initialMessageId: data?.initialMessageId ?? null });
    // 仮の発言には時刻が無い。読んだ時刻を入れて、いちばん後ろの窓に入れる
    const now = Date.now();
    return [...(data?.messages ?? []), ...live.messages.map((m) => ({ ...m, at: m.at ?? now }))];
  }

  /** 会話を（まだ読んでいなければ）読む。間隔を空けて、まとめて 1 回にする。読み終えたら listeners へ */
  async function refresh(sessionId, { force = false } = {}) {
    const cur = sessions.get(sessionId) ?? { messages: null, at: 0, busy: false, queued: false };
    sessions.set(sessionId, cur);
    if (cur.busy) { cur.queued = true; return; }
    if (!force && cur.messages && Date.now() - cur.at < REFRESH_MS) return;
    cur.busy = true;
    try {
      cur.messages = await read(sessionId);
      cur.at = Date.now();
      for (const fn of listeners) fn(sessionId);
    } catch { /* 道具の行が無いだけ。投稿は読める */ } finally {
      cur.busy = false;
      if (cur.queued) { cur.queued = false; setTimeout(() => refresh(sessionId, { force: true }), REFRESH_MS); }
    }
  }

  return {
    refresh,
    onLoaded: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    messagesOf: (sessionId) => sessions.get(sessionId)?.messages ?? null,
    forget: () => sessions.clear(),
  };
}
