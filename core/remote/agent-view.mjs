// 端末の画面が、ホストに任せた子の会話の経過を読むための部品（docs/remote.md §4.5「経過の読み出し」、ADR 0146）。純粋な関数だけ。
// ホスト（core/server.mjs の remoteAgentView）が、読んだ会話を「運ぶ前に絞る」ために使う。端末は messageSig（web/history-sync.mjs）で続きの位置を確かめる。
import { messageSig } from '../../web/history-sync.mjs';

/** 運ぶ量の上限（提案値ではなく、決めた値。docs/remote.md §4.5）。1 通は口の上限（AGENT_LIMITS.messageBytes）の内側に収める */
export const VIEW_LIMITS = Object.freeze({
  tail: 40,                 // 初回に運ぶ末尾の発言数（これより古い分は省く）
  resend: 3,                // 続きの読み出しで、持っている末尾のうち取り直す発言数（末尾の発言は後から中身が変わる）
  bodyBytes: 192 * 1024,    // 1 通の大きさ
  text: 16 * 1024,          // 発言の本文
  thinking: 4 * 1024,       // 考えた内容
  field: 2 * 1024,          // ツールの入力の 1 つの文字列・ツールの出力
  instruction: 1000,        // 追加の指示 1 件
  instructions: 20,         // 追加の指示の件数
  descendants: 40,          // 子孫の要約の件数
});

const DEPTH_MAX = 6;
const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** ツールの入力などの JSON を、文字列を切り・data URI を落とし・配列と深さを絞って写す */
function bound(value, depth = 0) {
  if (typeof value === 'string') return value.startsWith('data:') ? '' : clip(value, VIEW_LIMITS.field);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= DEPTH_MAX) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => bound(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = bound(v, depth + 1);
  return out;
}

/** 添付・画像は枠（名前と種類）だけ。中身は運ばない */
const frameOf = (list) => (Array.isArray(list) ? list.slice(0, 20).map(x => ({ name: typeof x?.name === 'string' ? clip(x.name, 120) : null, type: typeof x?.mime === 'string' ? x.mime : typeof x?.type === 'string' ? x.type : null, omitted: true })) : []);

/** 発言 1 件を運べる形にする（本文 16 KB・考えた内容 4 KB・ツールの入力と出力は 1 つ 2 KB・画像と添付は枠だけ） */
export function trimViewMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(m)) {
    if (key === 'text') out.text = typeof value === 'string' ? clip(value, VIEW_LIMITS.text) : '';
    else if (key === 'thinking') out.thinking = typeof value === 'string' ? clip(value, VIEW_LIMITS.thinking) : value;
    else if (key === 'toolCalls') {
      out.toolCalls = (Array.isArray(value) ? value : []).slice(0, 60).map(call => {
        const r = call?.result;
        return {
          id: call?.id ?? null, name: String(call?.name ?? ''), input: bound(call?.input ?? null),
          ...(r && typeof r === 'object' ? { result: { text: clip(String(r.text ?? ''), VIEW_LIMITS.field), isError: r.isError === true, ...(r.truncated || String(r.text ?? '').length > VIEW_LIMITS.field ? { truncated: true } : {}) } } : r === null ? { result: null } : {}),
        };
      });
    } else if (key === 'images' || key === 'attachments') out[key] = frameOf(value);
    else out[key] = bound(value);
  }
  return out;
}

/**
 * 読み出しの答えの発言の部分を作る。messages は会話の全部（履歴＋走っているターンの畳み込み）。
 * cursor: { from, check } は端末が持っている発言の続きの位置（from は絶対の位置・check は from の 1 つ前の発言の署名）。
 * 合えば from からの続きだけ、無い・合わない・遠すぎるときは末尾の VIEW_LIMITS.tail 件。1 通が大きすぎれば古い方から省く。
 * 戻りの from は返した発言の最初の絶対の位置、full は端末が持っている分を捨てて置き換えるか、total は発言の総数
 */
export function viewMessages(messages, cursor = null, { limits = VIEW_LIMITS } = {}) {
  const trimmed = messages.map(trimViewMessage).filter(Boolean);
  const total = trimmed.length;
  const tailFrom = Math.max(0, total - limits.tail);
  let from = tailFrom, full = true;
  const c = cursor && Number.isInteger(cursor.from) && cursor.from >= 0 ? cursor : null;
  if (c && c.from >= tailFrom && c.from <= total && (c.from === 0 || (c.from - 1 < total && messageSig(trimmed[c.from - 1]) === c.check))) { from = c.from; full = false; }
  let slice = trimmed.slice(from);
  // 1 通の大きさに収める。古い方から省く（続きの位置が進むだけで、端末は次の読み出しで追いつく）
  let bytes = Buffer.byteLength(JSON.stringify(slice));
  while (slice.length > 1 && bytes > limits.bodyBytes) {
    bytes -= Buffer.byteLength(JSON.stringify(slice[0])) + 1;
    slice = slice.slice(1); from++; full = true;
  }
  return { messages: slice, from, total, full };
}

/** 端末が持っている発言（base から並ぶ list）の、次の読み出しの続きの位置。持っているのが少なければ null（末尾から読み直す） */
export function viewCursor(base, list, sigs = null) {
  const keep = Math.max(0, list.length - VIEW_LIMITS.resend);
  if (!keep) return null;
  return { from: base + keep, check: sigs ? sigs[keep - 1] : messageSig(list[keep - 1]) };
}

/** 追加の指示（端末が AI から受けた分の表示用）。本文を絞る */
export const viewInstructions = (list) => (Array.isArray(list) ? list : []).slice(-VIEW_LIMITS.instructions)
  .map(x => ({ id: String(x.id), at: x.at ?? null, state: String(x.state ?? ''), text: clip(String(x.text ?? ''), VIEW_LIMITS.instruction) }));
