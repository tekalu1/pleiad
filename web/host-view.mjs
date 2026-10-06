// ホストに任せた子の経過（docs/remote.md §4.5「経過の読み出し」、ADR 0146）を、端末の画面が持って育てるための純粋な部品。
// ホストの答え（core/remote/agent-view.mjs）は末尾の数発言を取り直す続きの形で届き、画面は持っている分につなぐ。
// core の読み出し（agent-view.mjs）も、続きの位置の計算にこのファイルの RESEND を使う（同じ数でないと署名が合わない）。
import { messageSig } from "./history-sync.mjs";

/** 続きの読み出しで、持っている末尾のうち取り直す発言の数（末尾の発言は後から中身が変わる） */
export const RESEND = 3;

/** 持っている発言（held: { base, messages, sigs }。base は最初の発言の絶対の位置）の続きの位置。持っているのが少なければ null（末尾から読み直す） */
export function hostViewCursor(held) {
  const list = held?.messages ?? [];
  const keep = Math.max(0, list.length - RESEND);
  if (!keep) return null;
  return { from: held.base + keep, check: held.sigs?.[keep - 1] ?? messageSig(list[keep - 1]) };
}

/**
 * ホストの答え（data: { messages, from, total, full }）を、持っている分（held）につなぐ。full か、位置が合わなければ置き換える。
 * 署名は届いたときに計算しておく（描く側が発言の中身を書き換えても、次の続きの位置がずれない）
 */
export function joinHostView(held, data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const sigs = messages.map(messageSig);
  const from = Number.isInteger(data?.from) ? data.from : 0;
  const whole = data?.full === true || !held?.messages?.length;
  const keep = from - (held?.base ?? 0);
  const consistent = !whole && keep >= 0 && keep <= held.messages.length && data.total === from + messages.length;
  if (!consistent) return { base: from, messages, sigs, total: Number.isInteger(data?.total) ? data.total : from + messages.length };
  return { base: held.base, messages: [...held.messages.slice(0, keep), ...messages], sigs: [...held.sigs.slice(0, keep), ...sigs], total: data.total };
}

/**
 * 読み出しで知ったホストの子孫の要約（rows: { taskId, parentTaskId, sessionId, title, rawStatus, status, … }）を、根の下の字下げの並びにする。
 * 親が先・兄弟は新しい順。返すのは { row, depth, parentKey, childCount }。keyOf は会話の ID から行の親子の印を作る（client.mjs の hostChildKey）。
 * 親が見つからない行は根の直下に置く。回り続けないよう、同じ行は 1 度だけ通る
 */
export function hostTreeRows(rootTaskId, rootSessionId, rows, keyOf) {
  const byParent = new Map();
  for (const row of rows ?? []) {
    const parent = row.parentTaskId ?? rootTaskId;
    (byParent.get(parent) ?? byParent.set(parent, []).get(parent)).push(row);
  }
  const known = new Set((rows ?? []).map(r => r.taskId));
  // 親が行の中にも根にも無い行は、根の直下へ
  for (const [parent, list] of [...byParent]) if (parent !== rootTaskId && !known.has(parent)) { byParent.delete(parent); (byParent.get(rootTaskId) ?? byParent.set(rootTaskId, []).get(rootTaskId)).push(...list); }
  const newer = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  const out = [], seen = new Set();
  const visit = (taskId, parentKey, depth) => {
    const list = (byParent.get(taskId) ?? []).slice().sort(newer);
    for (const row of list) {
      if (seen.has(row.taskId)) continue;
      seen.add(row.taskId);
      out.push({ row, depth, parentKey, childCount: (byParent.get(row.taskId) ?? []).length });
      visit(row.taskId, row.sessionId ? keyOf(row.sessionId) : `ht:${row.taskId}`, depth + 1);
    }
  };
  visit(rootTaskId, rootSessionId ? keyOf(rootSessionId) : `ht:${rootTaskId}`, 1);
  return out;
}

/** 根の下の子孫の要約へ、別の詳細を読んだ答えの子孫（descendants）を混ぜる（同じ taskId は新しい方で置き換える）。根を読んだときは置き換える（消えた行を残さない） */
export function mergeHostTree(rows, descendants, { replace = false } = {}) {
  const next = replace ? new Map() : new Map((rows ?? []).map(r => [r.taskId, r]));
  for (const d of descendants ?? []) if (d && typeof d.taskId === "string") next.set(d.taskId, d);
  return [...next.values()];
}

const LIVE = new Set(["queued", "running", "cancelling", "waiting"]);
/** 子孫の行を、読めていないまま「動いている」と見なさない長さ（詳細を開いている間の読み直しは 2.5〜4 秒） */
export const HOST_ROW_STALE_MS = 20_000;
/**
 * 子孫の行が古いか: 走っている印のまま、HOST_ROW_STALE_MS より長く読めていない（seenAt はその行が最後に読み出しの答えに入った時刻）。
 * 詳細を閉じると読み出しは止まるので、その後にホストで終わった子孫は印が古いまま残る。古い行は「動いている」に数えず、読んだ時刻を添えて出す
 */
export function hostRowStale(row, seenAt, now, ms = HOST_ROW_STALE_MS) {
  return LIVE.has(row?.rawStatus ?? row?.status) && !(seenAt && now - seenAt <= ms);
}
/** 子孫の行の状態が走っている（ホストの最後の答えで） */
export const hostRowRunning = (row) => LIVE.has(row?.rawStatus ?? row?.status);
