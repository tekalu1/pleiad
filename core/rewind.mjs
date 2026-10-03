// 同じ会話の中で、ある発言の手前まで巻き戻して送り直す（docs/message-fork.md「同じ会話で巻き戻す」、ADR 0091）。
// ここは形だけを扱う純粋な関数。ディスクにもバックエンドにも触れない。
import { buildItems } from "../web/timeline.mjs";
import { t } from "./i18n.mjs";

/**
 * 保留の巻き戻し（sidecar の rewind）を履歴に当てる。Claude は巻き戻しが次のターンまで JSONL に出ない
 * （resume + resumeSessionAt で、次のターンが葉を付け替える）ので、それまでの間は見かけ上切って返す。
 * mark: { nativeId, at, drops }。drops は捨てる発言（ユーザーの発言）の uuid。
 * 捨てる発言がまだ鎖にある間だけ切る（次のターンが葉を移せば鎖から消え、印は自然に効かなくなる）
 */
export function applyRewindMark(messages, mark) {
  if (!mark?.drops) return messages;
  const at = messages.findIndex(m => m.uuid === mark.drops);
  return at < 0 ? messages : messages.slice(0, at);
}

/** 保留の巻き戻しがまだ効いているか（捨てる発言が鎖に残っている） */
export const markIsLive = (messages, mark) => Boolean(mark?.drops) && messages.some(m => m.uuid === mark.drops);

/**
 * ネイティブの uuid に直す。ホスト記録のある会話の uuid は `<backend>:<nativeId>:<uuid>` に接頭辞が付く（conversations.mjs の mergeMessages）。
 * 今のネイティブの区間の発言でなければ null
 */
export function nativeUuid(uuid, backendId, nativeId) {
  if (typeof uuid !== "string" || !uuid) return null;
  if (!nativeId) return null;
  const prefix = `${backendId}:${nativeId}:`;
  return uuid.startsWith(prefix) ? uuid.slice(prefix.length) : null;
}

/**
 * 切り口（at。残す最後の発言の添字。-1 は何も残さない）より後の提示（添付・可視化・git の行）を落とした残りの添字の集合。
 * 選び方は「ここから分岐」（conversations.mjs の fork）と同じ: 画面と同じ並べ方（buildItems）で、
 * 残す発言より前に並ぶものと、残す発言に結び付いたものを残す。
 * AI の提示に時刻がなく境界を決められないときは、欠落させずに断る
 */
export function keptPresentIndexes(messages, presents, at) {
  if (at < 0 || !presents.length) return new Set();
  if (at >= messages.length - 1) return new Set(presents.keys());
  for (const p of presents) {
    if (p.by === "ai" && (!p.at || !messages[at].at)) throw new Error(t("conversations.presentNoTime"));
  }
  const items = buildItems(messages, presents);
  const end = items.findIndex(item => item.kind === "msg" && item.mi === at);
  return new Set(items.filter((item, i) => item.kind === "present" && (i < end || item.anchorMi === at)).map(item => item.pi));
}

/**
 * 巻き戻しで消える範囲の要約（画面の帯の件数と、サーバーの返答）。
 * target はやり直す発言の添字。人の発言（スラッシュコマンド・! の行・システム側の行を除く）の数と、
 * ファイルを変えたツールを呼んだ返答があるか
 */
export function removedSummary(messages, target) {
  const removed = messages.slice(target);
  return {
    messages: removed.length,
    // やり直す発言そのものは数えない（「この後のやり取り（あなたの発言 N 件と返答）」）
    userMessages: removed.slice(1).filter(m => m.role === "user" && !m.kind).length,
    replies: removed.filter(m => m.role === "assistant").length,
  };
}
