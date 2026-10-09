// 履歴を全部読み直さずに済ませるための道具（issue #37 段階 2。ADR 0062・ADR 0902）。
//   - retainPlan: 静かな読み直しで、画面に残す行と描き直す行の境目（画面の DOM は client.mjs が触る）
//   - syncRequest / serveFrom / joinReply: loadSession を「今持っている先頭の続きだけ」にする（画面が頼み、サーバーが切り、画面がつなぐ）
//   - serveHistory / windowStart / presentBaseFor / stubPresent: 会話を開くときに末尾の窓だけを運び（base = 窓の最初の発言の通し番号）、
//     大きい提示の本文（Visualize の HTML・画像）は印（lazy）だけにする。古い側は serveOlder で遡って運ぶ（ADR 0902）
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
 * 本文を印（lazy。stubPresent）に置き換えた提示は、印が持っている元の長さで数える。全文の提示と印の提示は同じ署名になる
 * （画面が本文を取り直しても、持っている提示とサーバーの提示を見比べる計算が変わらない）。
 * 記録は追記だけで、後から変わるのは添付を発言へ結んだ messageId（core/history.mjs の anchorAttachments）なので、これで足りる
 */
export function presentSig(present) {
  if (present === null || typeof present !== "object") return hash53(JSON.stringify(present) ?? "");
  let sig = presentSigs.get(present);
  if (sig === undefined) {
    const { content, dataUri, lazy, ...rest } = present;
    presentSigs.set(present, sig = hash53(JSON.stringify([rest, content?.length ?? lazy?.content ?? null, dataUri?.length ?? lazy?.dataUri ?? null])));
  }
  return sig;
}

/**
 * 遡り（older）の照合に使う署名。サーバーが後から付ける印（`!` の終了コード・渡していない印・予定の時刻）を除く。
 * 会話を開く窓は走っているターンの途中だと印を付ける前の発言から切られ、遡りは印を付けた発言から切られるので、
 * 印を含めると同じ発言でも署名が合わず、遡るたびに読み直しになる
 */
export function anchorSig(message) {
  if (message === null || typeof message !== "object") return messageSig(message);
  const { exitCode, pending, scheduledFor, ...rest } = message;
  return hash53(JSON.stringify(rest));
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
 * old が今描いてある側、next が読み直した側（どちらも { messages, presents, compactions, base?, presentBase? }。base は窓の最初の通し番号）。
 * 返すのは { keepItems, items }（items は next の描く行の並び）。1 つも残せなければ null（全部描き直す）。
 * 圧縮の区切りが変わったときは、区切りの後ろの最初の発言から描き直す（区切りの直後の行は「続き」の形を変えるので）
 */
export function retainPlan(old, next) {
  if (!old.messages?.length) return null;
  const oldItems = buildItems(old.messages, old.presents ?? [], old.base ?? 0, old.presentBase ?? 0);
  const items = buildItems(next.messages ?? [], next.presents ?? [], next.base ?? 0, next.presentBase ?? 0);
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

/** list の [a, b) の署名の並びを 1 つにまとめた値。a = 0 は先頭 b 件（窓が無いときの、これまでの値と同じ） */
function digestOf(list, b, sigOf, a = 0) {
  let text = "";
  for (let i = a; i < b; i++) text += `${sigOf(list[i])},`;
  return hash53(text);
}

/**
 * 画面が持っている履歴（messages・presents）の続きだけを頼む引数。先頭が変わっていないかを、サーバーが同じ計算で確かめられるよう、
 * 先頭（発言は末尾の TAIL 件を除く。提示は全部）の署名の並びの値（check・presentCheck）を付ける。頼めるほど持っていなければ null（全量）。
 * 持っているのが末尾の窓のとき（opts.base = 窓の最初の発言の通し番号、opts.presentBase = 窓の最初の提示の通し番号）は、
 * from・presentFrom を通し番号で書き、base・presentBase を添える。check は窓の中の分だけの値
 */
export function syncRequest(messages, presents, { base = 0, presentBase = 0 } = {}) {
  const from = base + Math.max(0, messages.length - TAIL), presentFrom = presentBase + presents.length;
  if (from === base && presentFrom === presentBase) return null;
  return {
    from, check: digestOf(messages, from - base, messageSig), presentFrom, presentCheck: digestOf(presents, presents.length, presentSig),
    ...(base || presentBase ? { base, presentBase } : {}),
  };
}

/**
 * サーバー側。loadSession の応答（messages・presents を持つ）を、頼みの先頭が今の履歴と同じなら続きだけに切る。
 * 合わない（途中の発言が書き換わった・圧縮・Codex の書き換え・枝が変わった・件数が足りない）・頼みが無い・壊れているときは、そのまま全量を返す。
 * 差分のときは from・total（発言）と presentFrom・presentTotal（提示）を足す。画面はこの印があるときだけ差分として扱う。
 * 窓の頼み（base・presentBase）は serveHistory が扱う
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
 * 画面側。差分の応答を、持っていた履歴（prev。{ messages, presents, base?, presentBase? }）の先頭につないで全量（窓）にする。
 * 差分の印が無ければ（全量。古いサーバー・合わなかったとき）null、印はあるが頼んだ位置・件数と食い違うときは false（全量を取り直す）。
 * 先頭の要素は prev のものをそのまま使うので、続きの行だけが新しい
 */
export function joinReply(prev, data, request) {
  if (!Number.isInteger(data?.from)) return null;
  const messages = data.messages ?? [], presents = data.presents ?? [];
  const base = prev.base ?? 0, presentBase = prev.presentBase ?? 0;
  if (data.from !== request.from || data.presentFrom !== request.presentFrom
    || data.total !== data.from + messages.length || data.presentTotal !== data.presentFrom + presents.length
    || data.from > base + prev.messages.length || data.presentFrom > presentBase + prev.presents.length
    || (data.base ?? 0) !== base || (data.presentBase ?? 0) !== presentBase) return false;
  return { messages: [...prev.messages.slice(0, data.from - base), ...messages], presents: [...prev.presents.slice(0, data.presentFrom - presentBase), ...presents], base, presentBase };
}

// ---------------------------------------------------------------- 窓と本文の遅延（ADR 0902）

/** 委譲先のエージェント（サブエージェント）を呼ぶツール。作業ダイアログの過去の一覧は、この呼び出しから子を引き直す */
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'collabAgentToolCall', 'subAgentActivity']);

/**
 * messages の [from, to) にあるサブエージェントの呼び出しの要約 { id, said, done, failed, at }。
 * said は依頼の最初の行（120 字まで）、done は結果が付いているか、failed は結果がエラーか。窓の手前の分は、サーバーがこれで運ぶ
 */
export function subagentCalls(messages, from = 0, to = messages.length) {
  const out = [];
  for (let i = from; i < to; i++) for (const call of messages[i]?.toolCalls ?? []) {
    if (!SUBAGENT_TOOLS.has(call?.name) || !call.id) continue;
    const said = call.input?.description || call.input?.task || call.input?.prompt;
    out.push({ id: call.id, said: String(said ?? '').split(/\r?\n/).find(Boolean)?.slice(0, 120) ?? '', done: Boolean(call.result), failed: Boolean(call.result?.isError), at: messages[i].at ?? null });
  }
  return out;
}
const earlierOf = (messages, start) => {
  const calls = start > 0 ? subagentCalls(messages, 0, start) : [];
  return calls.length ? { earlierCalls: calls } : {};
};

/** 会話を開くときに運ぶ発言の件数・大きさの目安（画面が頼み、サーバーが丸める） */
export const WINDOW_MESSAGES = 50;
export const WINDOW_BYTES = 256 * 1024;
/** 窓の発言は、大きさの上限に当たっても最低これだけは運ぶ */
const MIN_WINDOW = 6;
/** 頼みの上限（壊れた・悪意のある引数でも全部を数えない） */
const MAX_WINDOW_MESSAGES = 2000;
/** 遡りで特定の発言まで届かせる（reach）ときの大きさの目安。ふつうの遡り（WINDOW_BYTES）より大きい */
const REACH_BYTES = 2 * 1024 * 1024;
/** 本文をこの長さ以上の提示は印だけにする（小さい本文は印にするより直に運んだほうが速い） */
export const LAZY_MIN = 2048;

const sizeOf = (m) => JSON.stringify(m)?.length ?? 0;
const intArg = (v, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= 0 && v <= max ? v : null;

/**
 * 末尾の窓の最初の発言の通し番号。最後の count 件・およそ bytes（0 なら件数だけ）までを運び、最低 MIN_WINDOW 件は運ぶ。
 * 窓の最初が AI の発言なら、手前の人の発言（20 件まで）に寄せる（連続する AI の発言の「続き」の形が窓の頭で変わらないように）
 */
export function windowStart(messages, count, bytes = 0, end = messages.length) {
  const limit = Math.min(count, MAX_WINDOW_MESSAGES);
  let i = end, size = 0;
  while (i > 0 && end - i < limit) {
    if (bytes > 0 && end - i >= MIN_WINDOW && size >= bytes) break;
    i--;
    if (bytes > 0) size += sizeOf(messages[i]);
  }
  for (let k = 0; i > 0 && messages[i]?.role !== "user" && k < 20; k++) i--;
  return i;
}

/**
 * 窓（start 以降の発言）といっしょに運ぶ提示の最初の通し番号。窓の発言に結び付いた提示と、窓の最初の発言より後の時刻の提示（結び付かないもの）、
 * 時刻の無い提示のうち、いちばん小さい通し番号。窓より前に結び付く提示が後ろの番号に混じったときは、窓の中では結び付かない提示として出る
 */
export function presentBaseFor(messages, presents, start) {
  if (start <= 0) return 0;
  const items = buildItems(messages, presents);
  const first = items.find(it => it.kind === "msg" && it.mi === start);
  const firstAt = first?.sortAt ?? 0;
  let min = presents.length;
  for (const it of items) {
    if (it.kind !== "present" || it.pi >= min) continue;
    if (it.anchorMi >= start || (it.anchorMi < 0 && (!it.p?.at || it.sortAt >= firstAt))) min = it.pi;
  }
  return min;
}

/**
 * 大きい本文（content・dataUri）を印（lazy）に置き換えた提示。元は変えない。index = 提示の通し番号（本文を取りに行く URL が使う）。
 * lazy = { i, content?: 元の長さ, dataUri?: 元の長さ }。小さい本文はそのまま運ぶ
 */
export function stubPresent(present, index) {
  if (present === null || typeof present !== "object") return present;
  const big = (v) => typeof v === "string" && v.length >= LAZY_MIN;
  if (!big(present.content) && !big(present.dataUri)) return present;
  const { content, dataUri, ...rest } = present;
  const lazy = { i: index };
  if (big(content)) lazy.content = content.length; else if (content !== undefined) rest.content = content;
  if (big(dataUri)) lazy.dataUri = dataUri.length; else if (dataUri !== undefined) rest.dataUri = dataUri;
  return { ...rest, lazy };
}

const stubAll = (presents, from, lazy) => lazy ? presents.map((p, k) => stubPresent(p, from + k)) : presents;

/**
 * サーバー側。loadSession の応答を、頼みに合わせた形にする。
 *   - 窓・遅延の頼みが無い（古い画面）: serveFrom（これまでの形そのまま）
 *   - older（遡り）: 手前の発言と提示だけ（serveOlder）
 *   - from・check（差分。窓があれば base 付き）が合う: 続きだけ。lazy なら提示は印にする
 *   - tail（件数）: 末尾の窓。応答に base・total・presentBase・presentTotal を足す（差分の印 from は無い）
 *   - それ以外: 全量（lazy なら提示は印）
 * 応答の base の有無が、この仕組みを知っているサーバーの印になる（画面は base が無ければ窓なし・提示は全文として扱う）
 */
export function serveHistory(body, args) {
  if (args?.older && typeof args.older === "object") return serveOlder(body, args.older, args.lazy === true);
  const lazy = args?.lazy === true;
  const tail = intArg(args?.tail), windowed = tail !== null && tail > 0;
  const base = intArg(args?.base) ?? 0, presentBase = intArg(args?.presentBase) ?? 0;
  if (!lazy && !windowed && !base && !presentBase) return serveFrom(body, args);
  const messages = body.messages ?? [], presents = body.presents ?? [];
  const from = intArg(args?.from), presentFrom = intArg(args?.presentFrom);
  if (from !== null && presentFrom !== null && base <= from && presentBase <= presentFrom && from <= messages.length && presentFrom <= presents.length
    && digestOf(messages, from, messageSig, base) === args.check && digestOf(presents, presentFrom, presentSig, presentBase) === args.presentCheck) {
    return { ...body, messages: messages.slice(from), presents: stubAll(presents.slice(presentFrom), presentFrom, lazy), from, total: messages.length, base, presentFrom, presentTotal: presents.length, presentBase, ...earlierOf(messages, base) };
  }
  if (!windowed) return { ...body, presents: stubAll(presents, 0, lazy), base: 0, total: messages.length, presentBase: 0, presentTotal: presents.length };
  const start = windowStart(messages, tail, intArg(args?.tailBytes) ?? 0);
  const pb = presentBaseFor(messages, presents, start);
  return { ...body, messages: messages.slice(start), presents: stubAll(presents.slice(pb), pb, lazy), base: start, total: messages.length, presentBase: pb, presentTotal: presents.length, ...earlierOf(messages, start) };
}

/**
 * 画面が窓の手前をさらに頼んだときの応答。older = { before: 窓の最初の通し番号, count, bytes, check: その発言の署名（anchorSig）, presentBefore: 窓の最初の提示の通し番号, reach?: 届かせたい発言の uuid }。
 * reach の発言が窓の手前にあるときは、count・bytes を超えてでもそこまでを 1 回で運ぶ（検索の抜粋から古い発言へ飛ぶとき。2000 件・REACH_BYTES が上限）。
 * before の発言の署名が合わない（手前が書き換わった・圧縮・件数が減った）ときは { stale: true } を返し、画面は読み直す。
 * 合うときは { older: true, messages, presents, base, presentBase } （手前の分だけ。画面は窓の前につなぐ）
 */
export function serveOlder(body, older, lazy) {
  const messages = body.messages ?? [], presents = body.presents ?? [];
  const before = intArg(older.before), presentBefore = intArg(older.presentBefore);
  if (before === null || presentBefore === null || before <= 0 || before >= messages.length || presentBefore > presents.length || anchorSig(messages[before]) !== older.check) return { stale: true };
  let count = intArg(older.count) || WINDOW_MESSAGES, bytes = intArg(older.bytes) ?? 0;
  if (typeof older.reach === "string" && older.reach) {
    const at = messages.findIndex((m, i) => i < before && m?.uuid === older.reach);
    if (at >= 0 && before - at > count) { count = before - at; bytes = Math.max(bytes, REACH_BYTES); }
  }
  const start = windowStart(messages, count, bytes, before);
  const pb = Math.min(presentBefore, presentBaseFor(messages, presents, start));
  return { older: true, messages: messages.slice(start, before), presents: stubAll(presents.slice(pb, presentBefore), pb, lazy), base: start, presentBase: pb, until: before, presentUntil: presentBefore, total: messages.length };
}

/**
 * 画面側。遡りの応答（serveOlder）を、持っている窓（prev）の前につなぐ。応答が頼んだ位置とつながらないとき（stale・食い違い）は null。
 * 返すのは { messages, presents, base, presentBase }
 */
export function joinOlder(prev, data, request) {
  if (!data?.older || data.until !== request.before || data.presentUntil !== request.presentBefore) return null;
  const messages = data.messages ?? [], presents = data.presents ?? [];
  if (data.base + messages.length !== request.before || data.presentBase + presents.length !== request.presentBefore) return null;
  if (request.before !== (prev.base ?? 0) || request.presentBefore !== (prev.presentBase ?? 0)) return null;
  return { messages: [...messages, ...prev.messages], presents: [...presents, ...prev.presents], base: data.base, presentBase: data.presentBase };
}
