// 履歴を全部読み直さずに済ませるための道具（issue #37 段階 2。ADR 0062）。
//   - retainPlan: 静かな読み直しで、画面に残す行と描き直す行の境目（画面の DOM は client.mjs が触る）
//   - syncRequest / serveFrom / joinReply: loadSession を「今持っている先頭の続きだけ」にする（画面が頼み、サーバーが切り、画面がつなぐ）
// 中身の同じ発言を見分けるのは、発言全体の署名（messageSig）。uuid・本文だけでなく、後から付いたツールの結果・
// 圧縮の印など、行の見た目に効く値が変わっても「違う」になる（web/branches.mjs の commonPrefix は本文とツール名しか見ない）。
import { buildItems, inlineAttachments } from "./timeline.mjs";
import { visualizeReferences } from "./visualize-reference.mjs";

/** 文字列の 53 ビットの署名（cyrb53）。暗号用ではなく、同じ中身かを見分けるだけ */
function hash53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const messageSigs = new WeakMap();
/** 発言 1 件の署名。同じオブジェクトなら 1 度しか数えない */
export function messageSig(message) {
  if (message === null || typeof message !== "object") return hash53(JSON.stringify(message) ?? "");
  let sig = messageSigs.get(message);
  if (sig === undefined) messageSigs.set(message, sig = hash53(JSON.stringify(message)));
  return sig;
}

const presentSigs = new WeakMap();
/**
 * 提示（Visualize の HTML・添付）1 件の署名。中身（content・dataUri）は 1MB を超えることがあるので、長さだけを見る。
 * 記録は追記だけで、後から変わるのは添付を発言へ結んだ messageId（core/history.mjs の anchorAttachments）なので、これで足りる
 */
export function presentSig(present) {
  if (present === null || typeof present !== "object") return hash53(JSON.stringify(present) ?? "");
  let sig = presentSigs.get(present);
  if (sig === undefined) {
    const { content, dataUri, ...rest } = present;
    presentSigs.set(present, sig = hash53(JSON.stringify([rest, content?.length ?? null, dataUri?.length ?? null])));
  }
  return sig;
}

const sameMessage = (a, b) => a === b || messageSig(a) === messageSig(b);
const samePresent = (a, b) => a === b || presentSig(a) === presentSig(b);

/** 描く行の並び（buildItems）の 2 つの項目が、同じ行になるか */
function sameItem(a, b, refsChanged, attachmentsChanged) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "present") return a.pi === b.pi && a.anchorMi === b.anchorMi && samePresent(a.p, b.p);
  if (a.mi !== b.mi || !sameMessage(a.m, b.m)) return false;
  // 発言の本文に取り込んで描く添付（human の提示）が変わった（結び付いた・外れた）
  if (attachmentsChanged(b.mi)) return false;
  // 提示の印（visualize{…}）は、対応する提示が保存されているかで描き方が変わる
  return !(b.m.role === "assistant" && refsChanged(b.m.text));
}

const compactionOf = (entries) => new Map((entries ?? []).filter(e => ["complete", "failed"].includes(e?.phase)).map(e => [e.id, JSON.stringify(e)]));

/**
 * 静かな読み直しで、今の画面の行を先頭から何項目まで残せるか。
 * old が今描いてある側、next が読み直した側（どちらも { messages, presents, compactions }）。
 * 返すのは { keepItems, items }（items は next の描く行の並び）。1 つも残せなければ null（全部描き直す）。
 * 圧縮の区切りが変わったときは、区切りの後ろの最初の発言から描き直す（区切りの直後の行は「続き」の形を変えるので）
 */
export function retainPlan(old, next) {
  if (!old.messages?.length) return null;
  const oldItems = buildItems(old.messages, old.presents ?? []);
  const items = buildItems(next.messages ?? [], next.presents ?? []);
  const oldRefs = new Set((old.presents ?? []).map(p => p?.reference).filter(Boolean));
  const newRefs = new Set((next.presents ?? []).map(p => p?.reference).filter(Boolean));
  const refsChanged = (text) => typeof text === "string" && text.includes("visualize")
    && visualizeReferences(text).some(ref => oldRefs.has(ref.raw) !== newRefs.has(ref.raw));
  const oldAttached = inlineAttachments(oldItems), newAttached = inlineAttachments(items);
  const attachedSig = (list) => (list ?? []).map(presentSig).join(",");
  const attachmentsChanged = (mi) => attachedSig(oldAttached.get(mi)) !== attachedSig(newAttached.get(mi));
  let keepItems = 0;
  while (keepItems < oldItems.length && keepItems < items.length && sameItem(oldItems[keepItems], items[keepItems], refsChanged, attachmentsChanged)) keepItems++;

  const before = compactionOf(old.compactions), after = compactionOf(next.compactions);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(id => before.get(id) !== after.get(id));
  if (changed.length) {
    const entries = [...(next.compactions ?? []), ...(old.compactions ?? [])];
    const at = Math.min(...changed.map(id => Number(entries.find(e => e?.id === id)?.at) || 0));
    const first = items.findIndex(it => it.kind === "msg" && Date.parse(it.m.at ?? "") > at);
    keepItems = Math.min(keepItems, first < 0 ? items.length : first);
  }
  return keepItems > 0 ? { keepItems, items } : null;
}

// ---------------------------------------------------------------- loadSession の差分

/**
 * 差分の頼みで、画面が持っている発言の末尾のうち取り直す件数。末尾の発言は後から中身が変わることがある（結果の付き足し）。
 * 提示は取り直さない（1 件が 1MB を超えることがある）。中身が変わる（添付の結び付き）と署名が合わず、全量に戻る
 */
export const TAIL = 2;

/** 先頭 n 件の署名の並びを 1 つにまとめた値 */
function digestOf(list, n, sigOf) {
  let text = "";
  for (let i = 0; i < n; i++) text += `${sigOf(list[i])},`;
  return hash53(text);
}

/**
 * 画面が持っている履歴（messages・presents）の続きだけを頼む引数。先頭が変わっていないかを、サーバーが同じ計算で確かめられるよう、
 * 先頭（発言は末尾の TAIL 件を除く。提示は全部）の署名の並びの値（check・presentCheck）を付ける。頼めるほど持っていなければ null（全量）
 */
export function syncRequest(messages, presents) {
  const from = Math.max(0, messages.length - TAIL), presentFrom = presents.length;
  if (!from && !presentFrom) return null;
  return { from, check: digestOf(messages, from, messageSig), presentFrom, presentCheck: digestOf(presents, presentFrom, presentSig) };
}

/**
 * サーバー側。loadSession の応答（messages・presents を持つ）を、頼みの先頭が今の履歴と同じなら続きだけに切る。
 * 合わない（途中の発言が書き換わった・圧縮・Codex の書き換え・枝が変わった・件数が足りない）・頼みが無い・壊れているときは、そのまま全量を返す。
 * 差分のときは from・total（発言）と presentFrom・presentTotal（提示）を足す。画面はこの印があるときだけ差分として扱う
 */
export function serveFrom(body, args) {
  const from = args?.from, presentFrom = args?.presentFrom;
  if (!Number.isInteger(from) || !Number.isInteger(presentFrom) || from < 0 || presentFrom < 0) return body;
  const messages = body.messages ?? [], presents = body.presents ?? [];
  if (from > messages.length || presentFrom > presents.length) return body;
  if (digestOf(messages, from, messageSig) !== args.check || digestOf(presents, presentFrom, presentSig) !== args.presentCheck) return body;
  return { ...body, messages: messages.slice(from), presents: presents.slice(presentFrom), from, total: messages.length, presentFrom, presentTotal: presents.length };
}

/**
 * 画面側。差分の応答を、持っていた履歴（prev）の先頭につないで全量にする。
 * 差分の印が無ければ（全量。古いサーバー・合わなかったとき）null、印はあるが頼んだ位置・件数と食い違うときは false（全量を取り直す）。
 * 先頭の要素は prev のものをそのまま使うので、続きの行だけが新しい
 */
export function joinReply(prev, data, request) {
  if (!Number.isInteger(data?.from)) return null;
  const messages = data.messages ?? [], presents = data.presents ?? [];
  if (data.from !== request.from || data.presentFrom !== request.presentFrom
    || data.total !== data.from + messages.length || data.presentTotal !== data.presentFrom + presents.length
    || data.from > prev.messages.length || data.presentFrom > prev.presents.length) return false;
  return { messages: [...prev.messages.slice(0, data.from), ...messages], presents: [...prev.presents.slice(0, data.presentFrom), ...presents] };
}
