// 端末の画面が、ホストに任せた子の会話の経過を読むための部品（docs/remote.md §4.5「経過の読み出し」、ADR 0146）。純粋な関数だけ。
// ホスト（core/server.mjs の remoteAgentView）が、読んだ会話を「運ぶ前に絞る」ために使う。端末は messageSig（web/history-sync.mjs）で続きの位置を確かめる。
import { messageSig } from '../../web/history-sync.mjs';
import { RESEND, hostViewCursor } from '../../web/host-view.mjs';
import { AGENT_LIMITS } from './agent-protocol.mjs';
import { maskOutput } from '../ops/registry.mjs';

/** 運ぶ量の上限（提案値ではなく、決めた値。docs/remote.md §4.5）。答え全体を口の上限（AGENT_LIMITS.messageBytes）の内側に収める */
export const VIEW_LIMITS = Object.freeze({
  tail: 40,                 // 初回に運ぶ末尾の発言数（これより古い分は省く）
  resend: RESEND,           // 続きの読み出しで、持っている末尾のうち取り直す発言数（末尾の発言は後から中身が変わる。端末の画面と同じ数）
  bodyBytes: AGENT_LIMITS.messageBytes - 16 * 1024,  // 答え全体（result）の大きさ。口の上限から、便りの枠（t・id・ok）の余白を引いた値
  messageBytes: 48 * 1024,  // 発言 1 件の大きさ（超えたら、もう一段絞る。それでも超えたら枠だけ）
  text: 16 * 1024,          // 発言の本文
  thinking: 4 * 1024,       // 考えた内容
  field: 2 * 1024,          // ツールの入力の 1 つの文字列・ツールの出力
  keys: 50,                 // ツールの入力の 1 つのオブジェクトのキーの数・配列の長さ
  toolCalls: 60,            // 発言 1 件のツールの呼び出しの数
  instruction: 1000,        // 追加の指示 1 件
  instructions: 20,         // 追加の指示の件数
  descendants: 40,          // 子孫の要約の件数
});

/** 発言 1 件が messageBytes を超えたときの、もう一段の絞り（並列のツールが多い・日本語の入力と出力が長い発言） */
const TIGHT = Object.freeze({ text: 4 * 1024, thinking: 1024, field: 256, keys: 20, toolCalls: 20 });
const DEPTH_MAX = 6;
const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value) ?? '');

/** ツールの入力などの JSON を、文字列を切り・data URI を落とし・キーの数と配列と深さを絞って写す */
function bound(value, lim = VIEW_LIMITS, depth = 0) {
  if (typeof value === 'string') return value.startsWith('data:') ? '' : clip(value, lim.field);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= DEPTH_MAX) return null;
  if (Array.isArray(value)) return value.slice(0, lim.keys).map(v => bound(v, lim, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, lim.keys)) out[k] = bound(v, lim, depth + 1);
  return out;
}

/** 添付・画像は枠（名前と種類）だけ。中身は運ばない */
const frameOf = (list) => (Array.isArray(list) ? list.slice(0, 20).map(x => ({ name: typeof x?.name === 'string' ? clip(x.name, 120) : null, type: typeof x?.mime === 'string' ? x.mime : typeof x?.type === 'string' ? x.type : null, omitted: true })) : []);

function trimWith(m, lim) {
  const out = {};
  for (const [key, value] of Object.entries(m)) {
    if (key === 'text') out.text = typeof value === 'string' ? clip(value, lim.text) : '';
    else if (key === 'thinking') out.thinking = typeof value === 'string' ? clip(value, lim.thinking) : bound(value, lim);
    else if (key === 'toolCalls') {
      out.toolCalls = (Array.isArray(value) ? value : []).slice(0, lim.toolCalls).map(call => {
        const r = call?.result;
        return {
          id: call?.id ?? null, name: String(call?.name ?? ''), input: bound(call?.input ?? null, lim),
          ...(r && typeof r === 'object' ? { result: { text: clip(String(r.text ?? ''), lim.field), isError: r.isError === true, ...(r.truncated || String(r.text ?? '').length > lim.field ? { truncated: true } : {}) } } : r === null ? { result: null } : {}),
        };
      });
    } else if (key === 'images' || key === 'attachments') out[key] = frameOf(value);
    else out[key] = bound(value, lim);
  }
  return out;
}

/** 二段に絞っても大きすぎる発言は枠だけ（本文の頭・ツールの名前と成否。入力と出力は運ばない）。発言の並びと署名は崩さない */
function frameMessage(m, lim) {
  const out = {};
  for (const [key, value] of Object.entries(m)) {
    if (key === 'text') out.text = typeof value === 'string' ? clip(value, 2 * 1024) : '';
    else if (key === 'toolCalls') out.toolCalls = (Array.isArray(value) ? value : []).slice(0, lim.toolCalls)
      .map(call => ({ id: call?.id ?? null, name: clip(String(call?.name ?? ''), 120), input: null, ...(call?.result && typeof call.result === 'object' ? { result: { text: '', isError: call.result.isError === true, truncated: true } } : {}) }));
    else if (key === 'images' || key === 'attachments') out[key] = frameOf(value);
    else if (key !== 'thinking' && (value === null || typeof value !== 'object')) out[key] = typeof value === 'string' ? clip(value, 200) : value;
  }
  out.viewOmitted = true;
  return out;
}

/**
 * 発言 1 件を運べる形にする（本文 16 KB・考えた内容 4 KB・ツールの入力と出力は 1 つ 2 KB・画像と添付は枠だけ・1 件 48 KB まで）。
 * 秘密らしい名前の欄は、端末の画面へ返す前の伏せ字（core/ops/registry.mjs の maskOutput）と同じく伏せてから運ぶ
 * （端末は伏せた後の発言で続きの位置の署名を作る。ホストも同じ形で照合しないと、続きが合わずに末尾を読み直す）
 */
export function trimViewMessage(m, limits = VIEW_LIMITS) {
  if (!m || typeof m !== 'object') return null;
  for (const lim of [limits, { ...limits, ...TIGHT }]) {
    const out = maskOutput(trimWith(m, lim));
    if (bytesOf(out) <= limits.messageBytes) return out;
  }
  return maskOutput(frameMessage(m, limits));
}

/**
 * 読み出しの答えの発言の部分を作る。messages は会話の全部（履歴＋走っているターンの畳み込み）。
 * cursor: { from, check } は端末が持っている発言の続きの位置（from は絶対の位置・check は from の 1 つ前の発言の署名）。
 * 合えば from からの続きだけ、無い・合わない・遠すぎるときは末尾の VIEW_LIMITS.tail 件。答え全体（発言の外の reserve バイトを含む）が
 * bodyBytes を超えれば古い方から省く。戻りの from は返した発言の最初の絶対の位置、full は端末が持っている分を捨てて置き換えるか、
 * total は発言の総数、userCount は利用者の発言（依頼・追加の指示）の総数（省いた分も数える。差し込み中の指示の判定に使う）
 */
export function viewMessages(messages, cursor = null, { limits = VIEW_LIMITS, reserve = 0 } = {}) {
  const trimmed = messages.map(m => trimViewMessage(m, limits)).filter(Boolean);
  const total = trimmed.length;
  const userCount = trimmed.filter(m => m.role === 'user' && !m.internalTaskNotice).length;
  const tailFrom = Math.max(0, total - limits.tail);
  let from = tailFrom, full = true;
  const c = cursor && Number.isInteger(cursor.from) && cursor.from >= 0 ? cursor : null;
  if (c && c.from >= tailFrom && c.from <= total && (c.from === 0 || (c.from - 1 < total && messageSig(trimmed[c.from - 1]) === c.check))) { from = c.from; full = false; }
  let slice = trimmed.slice(from);
  // 答え全体の大きさに収める。古い方から省く（続きの位置が進むだけで、端末は次の読み出しで追いつく）
  const budget = limits.bodyBytes - reserve;
  let bytes = bytesOf(slice);
  while (slice.length && bytes > budget) {
    bytes -= bytesOf(slice[0]) + 1;
    slice = slice.slice(1); from++; full = true;
  }
  return { messages: slice, from, total, full, userCount };
}

/** 端末が持っている発言（held: { base, messages, sigs }）の、次の読み出しの続きの位置（端末の画面の計算と同じもの） */
export const viewCursor = (base, list, sigs = null) => hostViewCursor({ base, messages: list, sigs });

/** 追加の指示（端末が AI から受けた分の表示用）。本文を絞る */
export const viewInstructions = (list) => (Array.isArray(list) ? list : []).slice(-VIEW_LIMITS.instructions)
  .map(x => ({ id: String(x.id), at: x.at ?? null, state: String(x.state ?? ''), text: clip(String(x.text ?? ''), VIEW_LIMITS.instruction) }));

/**
 * 子孫の要約に載せる行を選ぶ。走っているもの、次に新しいもの（更新の新しい順）を優先して VIEW_LIMITS.descendants 件まで。
 * 並びは元の順（記録の順）のまま。omitted は省いた件数（端末は「ほか N 件」と出す）
 */
export function pickDescendants(rows, { isLive = () => false, limit = VIEW_LIMITS.descendants } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= limit) return { rows: list, omitted: 0 };
  const rank = list.map((row, i) => ({ row, i, live: isLive(row) ? 1 : 0, at: Number(row?.updatedAt ?? row?.createdAt ?? 0) || 0 }))
    .sort((a, b) => b.live - a.live || b.at - a.at || b.i - a.i);
  const keep = new Set(rank.slice(0, limit).map(x => x.i));
  return { rows: list.filter((_, i) => keep.has(i)), omitted: list.length - keep.size };
}

/**
 * 読み出しの答え全体。extras（task・sessionId・instructions・descendants など、発言の外の部分）の大きさを先に測り、
 * 残りの予算で発言を収める（答え全体を VIEW_LIMITS.bodyBytes の内側に）
 */
export function viewAnswer(all, cursor, extras, { limits = VIEW_LIMITS } = {}) {
  // 発言の外の部分と、messages・from・total・full・userCount の枠の分
  const reserve = bytesOf(extras) + 128;
  return { ...extras, ...viewMessages(all, cursor, { limits, reserve }) };
}
