// 会話を開く速さ（ADR 0182）の純粋な部分。
//   - 窓（末尾の発言だけ）の切り方・提示の本文の印・遡り（older）・窓の差分。つないだ結果は全量と同じ。古い相手とは今までの形でやりとりする
//   - 画面の描き方: 末尾を先に描き、手前を idle に足す（splitFirstPaint・backfillChunk ほか。vm で client.mjs から切り出して動かす）
// サーバーを起動して量と本文の取り方を確かめる試験は tests/unit/server-history-window.mjs。ブラウザーでの位置のずれは tests/browser/history-window.cjs
import fs from "node:fs/promises";
import vm from "node:vm";
import { buildItems, inlineAttachments } from "../../web/timeline.mjs";
import {
  serveHistory, serveFrom, serveOlder, joinReply, joinOlder, syncRequest, windowStart, presentBaseFor, stubPresent, messageSig, anchorSig, presentSig, subagentCalls,
  WINDOW_MESSAGES, WINDOW_BYTES, LAZY_MIN,
} from "../../web/history-sync.mjs";

export const name = "history-window";
export const title = "会話の窓: 末尾だけ運び、本文は印、遡りでつなぐと全量と同じ。古い相手とは今までの形。手前は後から足す";

const at = n => new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString();
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 人と AI が交互に並ぶ n 件 */
const conversation = n => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? { uuid: `u${i}`, role: "user", text: `質問 ${i}`, at: at(i) }
  : { uuid: `a${i}`, role: "assistant", text: `答え ${i}`, at: at(i), toolCalls: [{ id: `t${i}`, name: "Read", input: { file: `f${i}` }, result: { text: `結果 ${i}`, isError: false } }] });
const bigHtml = i => `<div>${`図の中身 ${i} `.repeat(400)}</div>`;
/** 時刻で並ぶ（どの発言にも結び付かない）大きい提示 k 件 */
const presentsOf = (k, every = 17) => Array.from({ length: k }, (_, i) => ({ kind: "visualization", id: `v${i}`, at: at(i * every + 1), content: i % 5 === 4 ? "<p>小</p>" : bigHtml(i), reference: `visualize{"path":"/tmp/${i}.html"}`, by: "ai" }));

export default async function (t) {
  // ---------------------------------------------------------------- 窓の切り方
  const long = conversation(400);
  const start = windowStart(long, WINDOW_MESSAGES);
  t.ok("窓: 最後の WINDOW_MESSAGES 件が入る範囲で、最初が人の発言", start <= 400 - WINDOW_MESSAGES && 400 - start <= WINDOW_MESSAGES + 20 && long[start].role === "user", `start ${start}`);
  t.ok("窓: 人の発言が続く会話で、窓の最初が AI の発言なら手前の人の発言まで寄せる", windowStart(conversation(11), 4) % 2 === 0);
  t.ok("窓: 短い会話は全部（start = 0）", windowStart(conversation(30), 50) === 0);
  const heavy = long.map((m, i) => i >= 380 ? { ...m, text: "あ".repeat(4000) } : m);
  const byBytes = windowStart(heavy, 50, 20_000);
  t.ok("窓: 大きさの目安（bytes）に当たったら件数に届かなくても止める。ただし最低 6 件は運ぶ", 400 - byBytes < 20 && 400 - byBytes >= 6, `${400 - byBytes} 件`);
  t.ok("窓: 頼みの件数が壊れていても数え切らない（上限）", windowStart(long, 10 ** 9) === 0 && windowStart(long, -5) >= 0);

  // ---------------------------------------------------------------- 提示の本文の印
  const small = { kind: "visualization", content: "<p>x</p>" }, big = { kind: "visualization", content: "x".repeat(LAZY_MIN), caption: "図" };
  t.ok("印: 小さい本文はそのまま（同じオブジェクト）", stubPresent(small, 3) === small);
  const stub = stubPresent(big, 7);
  t.ok("印: 大きい本文は lazy: { i, content: 長さ } に置き換え、ほかの欄は残し、元は変えない",
    !("content" in stub) && same(stub.lazy, { i: 7, content: LAZY_MIN }) && stub.caption === "図" && big.content.length === LAZY_MIN);
  const image = stubPresent({ kind: "image", dataUri: "data:image/png;base64," + "A".repeat(LAZY_MIN) }, 2);
  t.ok("印: 画像（dataUri）も印にする", !("dataUri" in image) && image.lazy.i === 2 && image.lazy.dataUri > LAZY_MIN);
  t.ok("印: 本文でない値（null・数）は触らない", stubPresent(null, 0) === null && stubPresent(5, 0) === 5);
  t.ok("印: 署名は本文の長さで決まるので、印のままでも全文と同じ（差分の照合が合う）",
    presentSig(stub) === presentSig(big) || presentSig(stubPresent(clone(big), 7)) === presentSig(stub));

  // ---------------------------------------------------------------- serveHistory の分かれ道
  const server = { messages: conversation(400), presents: presentsOf(20, 19), completedAt: 5, draft: null };
  const withAnchor = clone(server);
  const winArgs = { lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES };

  t.ok("古い画面（lazy・tail・base が無い）には、今までの形（serveFrom）そのまま", same(serveHistory(clone(server), {}), serveFrom(clone(server), {})) && !("base" in serveHistory(clone(server), {})));
  const oldDiff = syncRequest(server.messages.slice(0, 390), server.presents);
  t.ok("古い画面の差分の頼みも今までの形", same(serveHistory(clone(server), oldDiff), serveFrom(clone(server), oldDiff)) && serveHistory(clone(server), oldDiff).from === 388);

  const win = serveHistory(clone(server), winArgs);
  t.ok("窓: base・total・presentBase・presentTotal が付き、差分の印（from）は付かない",
    win.base > 0 && win.base + win.messages.length === 400 && win.total === 400 && win.presentBase + win.presents.length === 20 && win.presentTotal === 20 && !("from" in win));
  t.ok("窓: 窓の発言は全量の末尾と同じ", same(win.messages, server.messages.slice(win.base)));
  t.ok("窓: 窓より手前の提示は運ばない", win.presentBase > 0 && win.presents.length < 20);
  t.ok("窓: 大きい提示は印・小さい提示は本文のまま。印の i は通し番号",
    win.presents.every((p, k) => p.lazy ? p.lazy.i === win.presentBase + k && p.lazy.content === server.presents[p.lazy.i].content.length : p.content === server.presents[win.presentBase + k].content));
  const full = serveHistory(clone(server), { lazy: true });
  t.ok("lazy だけ（窓なし）: 全量で base は 0、提示は印", full.base === 0 && full.messages.length === 400 && full.presents.length === 20 && full.presents.some(p => p.lazy) && full.presentBase === 0);
  const windowOnly = serveHistory(clone(server), { tail: 50 });
  t.ok("tail だけ（lazy なし）: 窓で、提示は本文のまま", windowOnly.base > 0 && windowOnly.presents.every(p => !p.lazy && typeof p.content === "string"));
  const broken = serveHistory(clone(server), { lazy: true, tail: "x", base: -1, presentBase: 1.5, from: "y" });
  t.ok("壊れた引数でも落ちず、全量（lazy）を返す", broken.messages.length === 400 && broken.base === 0);

  // ---------------------------------------------------------------- 遡り
  let have = { messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase };
  let ok = true, steps = 0;
  while (have.base > 0 && steps < 30) {
    const request = { before: have.base, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(have.messages[0]), presentBefore: have.presentBase };
    const older = serveHistory(clone(server), { lazy: true, older: request });
    const joined = joinOlder(have, older, request);
    if (!joined || joined.base >= have.base) { ok = false; break; }
    have = joined;
    steps++;
  }
  t.ok("遡り: base が 0 になるまで続けて取れる", ok && have.base === 0 && have.presentBase === 0 && steps >= 2 && steps <= 8, `${steps} 回`);
  t.ok("遡り: つないだ発言は全量と同じ・提示は全量の印と同じ", same(have.messages, server.messages) && same(have.presents, server.presents.map((p, i) => stubPresent(p, i))));
  const request = { before: win.base, count: 50, bytes: 0, check: anchorSig(win.messages[0]), presentBefore: win.presentBase };
  t.ok("遡り: 手前の発言が書き換わった（署名が合わない）・件数が減ったなら stale",
    serveOlder({ ...clone(server), messages: server.messages.map((m, i) => i === win.base ? { ...m, text: "書き換わった" } : m) }, request, true).stale === true
    && serveOlder({ messages: server.messages.slice(0, win.base), presents: [] }, request, true).stale === true);
  t.ok("遡り: 壊れた頼みは stale", [{}, { before: 0, presentBefore: 0 }, { before: "5", presentBefore: 0 }, { before: win.base, presentBefore: 999, check: request.check }].every(o => serveOlder(clone(server), o, true).stale === true));
  const older = serveOlder(clone(server), request, true);
  t.ok("遡り: 応答が頼んだ位置とつながらなければ使わない（null）",
    joinOlder({ ...have, base: 5, messages: have.messages.slice(5), presents: have.presents }, older, request) === null
    && joinOlder({ messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase }, { ...older, until: older.until + 1 }, request) === null
    && joinOlder({ messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase }, { stale: true }, request) === null);

  // 照合の署名は、サーバーが後から付ける印（終了コード・渡していない印・予定の時刻）に依らない。
  // 走っているターンで開いた窓は印を付ける前の発言から切られ、遡りは印を付けた発言から切られる
  const marked = m => ({ ...m, exitCode: 0, pending: true, scheduledFor: 1234 });
  t.ok("anchorSig: 印（exitCode・pending・scheduledFor）の有る無しで変わらず、中身が違えば変わる。印の無い発言では messageSig と同じ",
    anchorSig(win.messages[0]) === anchorSig(marked(win.messages[0])) && anchorSig(win.messages[0]) === messageSig(win.messages[0])
    && messageSig(win.messages[0]) !== messageSig(marked(win.messages[0])) && anchorSig(win.messages[0]) !== anchorSig({ ...win.messages[0], text: "別" })
    && anchorSig(null) === messageSig(null));
  const markedServer = (on) => {
    const s = clone(server);
    if (on) s.messages = s.messages.map((m, i) => i === win.base ? marked(m) : m);
    return s;
  };
  const liveWindow = serveHistory(markedServer(false), winArgs);
  const markedRequest = { before: liveWindow.base, count: WINDOW_MESSAGES, bytes: WINDOW_BYTES, check: anchorSig(liveWindow.messages[0]), presentBefore: liveWindow.presentBase };
  const fromMarked = serveOlder(markedServer(true), markedRequest, true);
  t.ok("遡り: 印を付ける前の窓（走っているターン）から、印を付けた履歴で遡っても stale にならない（窓の読み直しにならない）",
    liveWindow.base === win.base && !("stale" in fromMarked) && joinOlder({ messages: liveWindow.messages, presents: liveWindow.presents, base: liveWindow.base, presentBase: liveWindow.presentBase }, fromMarked, markedRequest) !== null);
  t.ok("遡り: 発言の中身が違えば、印があっても stale",
    serveOlder({ ...markedServer(true), messages: markedServer(true).messages.map((m, i) => i === win.base ? { ...m, text: "書き換わった" } : m) }, markedRequest, true).stale === true);

  // reach: 特定の発言まで 1 回で届く
  const reachAt = (uuid, from = win.base, count = WINDOW_MESSAGES, source = server) => serveOlder(clone(source), { before: from, count, bytes: WINDOW_BYTES, check: anchorSig(source.messages[from]), presentBefore: win.presentBase, reach: uuid }, true);
  const normalOlder = reachAt(undefined);
  t.ok("遡り（reach）: 手前の発言を指すと、count を超えてでもそこまでを 1 回で運ぶ", reachAt(server.messages[0].uuid).base === 0 && reachAt(server.messages[0].uuid).messages.length === win.base);
  t.ok("遡り（reach）: 途中の発言を指しても、そこを含む（窓の最初は人の発言に寄る）", (() => { const r = reachAt(server.messages[120].uuid); return r.base <= 120 && r.base > 0 && server.messages[r.base].role === "user"; })());
  t.ok("遡り（reach）: 窓の中・手前に無い・壊れた uuid は、reach の無い頼みと同じ", [win.messages[3].uuid, "no-such", "", 5, null].every(u => reachAt(u).base === normalOlder.base));
  const huge = { messages: conversation(2600), presents: [] };
  const hugeReach = serveOlder(clone(huge), { before: 2600 - 50, count: 50, bytes: WINDOW_BYTES, check: anchorSig(huge.messages[2550]), presentBefore: 0, reach: "u0" }, true);
  t.ok("遡り（reach）: 運ぶ件数には上限がある（2000 件。画面は届くまで繰り返す）", hugeReach.base > 0 && 2550 - hugeReach.base <= 2000 + 20, `base ${hugeReach.base}`);
  const tiny = clone(server);
  tiny.messages = tiny.messages.map((m, i) => i < 5 ? m : { ...m, text: "あ".repeat(60_000) });
  const tinyReach = serveOlder(clone(tiny), { before: 395, count: 50, bytes: WINDOW_BYTES, check: anchorSig(tiny.messages[395]), presentBefore: 0, reach: "u0" }, true);
  t.ok("遡り（reach）: 大きさにも上限がある（REACH_BYTES を超えて運ばない）", tinyReach.base > 0 && JSON.stringify(tinyReach.messages).length < 3 * 1024 * 1024);

  // 窓の手前のサブエージェントの呼び出し（作業ダイアログの過去の一覧は、窓の外の子も引く）
  const callOf = (id, name, input, result) => ({ id, name, input, result });
  const withCalls = clone(server);
  withCalls.messages[1].toolCalls.push(callOf("s1", "Task", { description: "\n窓の外の調査\n詳しい依頼", prompt: "使わない" }, { text: "終わり", isError: false }));
  withCalls.messages[3].toolCalls.push(callOf("s2", "collabAgentToolCall", { prompt: "あ".repeat(300) }, { text: "失敗", isError: true }));
  withCalls.messages[5].toolCalls.push(callOf("s3", "Agent", {}, undefined), callOf("", "Task", { description: "id が無い" }, undefined), callOf("r1", "Read", { description: "子ではない" }, undefined));
  withCalls.messages[withCalls.messages.length - 1].toolCalls = [callOf("s4", "Task", { description: "窓の中" }, undefined)];
  const calls = subagentCalls(withCalls.messages, 0, 6);
  t.ok("subagentCalls: 委譲のツールだけを、id の有るものについて { id, said, done, failed, at } にする",
    calls.map(c => c.id).join() === "s1,s2,s3" && calls[0].said === "窓の外の調査" && calls[0].done && !calls[0].failed && calls[0].at === withCalls.messages[1].at
    && calls[1].said.length === 120 && calls[1].done && calls[1].failed && !calls[2].done && !calls[2].failed && calls[2].said === "");
  const winCalls = serveHistory(clone(withCalls), winArgs);
  t.ok("窓の手前: 窓の応答は、窓より手前の呼び出しを earlierCalls で運ぶ（窓の中の分は messages にあるので含めない）",
    same(winCalls.earlierCalls, calls) && !winCalls.earlierCalls.some(c => c.id === "s4"));
  t.ok("窓の手前: 手前に呼び出しが無ければ付けない・全量（base 0）にも付けない", !("earlierCalls" in win) && !("earlierCalls" in serveHistory(clone(withCalls), { lazy: true })) && !("earlierCalls" in serveFrom(clone(withCalls), {})));
  const callsDiff = serveHistory(clone(withCalls), { ...winArgs, ...syncRequest(winCalls.messages, winCalls.presents, { base: winCalls.base, presentBase: winCalls.presentBase }) });
  t.ok("窓の手前: 窓の差分の応答にも付く", "from" in callsDiff && same(callsDiff.earlierCalls, calls));
  const olderCalls = serveOlder(clone(withCalls), { before: winCalls.base, count: 50, bytes: WINDOW_BYTES, check: anchorSig(withCalls.messages[winCalls.base]), presentBefore: winCalls.presentBase }, true);
  t.ok("窓の手前: 遡りの応答には付けない（画面は最初の窓の分を持ち続ける。遡って読んだ分は messages に入る）", !("earlierCalls" in olderCalls));

  // ---------------------------------------------------------------- 窓の差分
  const mine = { messages: win.messages, presents: win.presents, base: win.base, presentBase: win.presentBase };
  const grown = clone(server);
  grown.messages.push(...conversation(404).slice(400).map((m, i) => ({ ...m, uuid: `n${i}`, at: at(500 + i) })));
  const diffRequest = syncRequest(mine.messages, mine.presents, { base: mine.base, presentBase: mine.presentBase });
  t.ok("窓の差分: 頼みは通し番号の from と base を持つ", diffRequest.base === win.base && diffRequest.from === win.base + win.messages.length - 2 && diffRequest.presentFrom === win.presentBase + win.presents.length);
  const diff = serveHistory(clone(grown), { ...winArgs, ...diffRequest });
  const joined = joinReply(mine, diff, diffRequest);
  t.ok("窓の差分: 増えた分だけ返り、つなぐと窓の末尾が伸びる（base は変わらない）",
    joined && diff.from === diffRequest.from && diff.messages.length === 6 && joined.base === win.base && joined.messages.length === win.messages.length + 4
    && same(joined.messages, grown.messages.slice(win.base)));
  const changedWindow = clone(server);
  changedWindow.messages[win.base + 3].text = "窓の中が書き換わった";
  const changed = serveHistory(clone(changedWindow), { ...winArgs, ...diffRequest });
  t.ok("窓の差分: 窓の中が違えば差分にせず、窓を返す（画面は置き換える）", !("from" in changed) && changed.base === win.base && joinReply(mine, changed, diffRequest) === null);
  const staleBase = serveHistory(clone(server), { ...winArgs, ...syncRequest(mine.messages.slice(0, 20), mine.presents, { base: win.base + 10, presentBase: win.presentBase }) });
  t.ok("窓の差分: 窓の位置がずれた頼み（先頭が合わない）も窓を返す", !("from" in staleBase));

  // 新しい画面 × 古いサーバー: 古いサーバーは base を知らず、窓の頼みの署名（窓の中だけ）は全量の先頭の署名と合わないので、全量が返る。画面は全量を窓なし（base 0）として使う
  const oldHost = serveFrom(clone(server), { ...winArgs, ...diffRequest });
  t.ok("古いサーバー: 窓の差分の頼みは合わず、今までの全量が返る（base・差分の印が無い）", !("from" in oldHost) && !("base" in oldHost) && oldHost.messages.length === 400 && oldHost.presents.every(p => !p.lazy));
  t.ok("古いサーバー: 画面は差分の応答でないものを使わない（joinReply は null）", joinReply(mine, oldHost, diffRequest) === null);
  const opened = (reply) => ({ base: Number.isInteger(reply.base) ? reply.base : 0, presentBase: Number.isInteger(reply.presentBase) ? reply.presentBase : 0 });
  t.ok("古いサーバーの全量を画面が窓なしで受ける（base が無ければ 0）", opened(oldHost).base === 0 && opened(oldHost).presentBase === 0 && opened(win).base === win.base);

  // ---------------------------------------------------------------- 提示の組み分け（presentBaseFor）と通し番号つきの項目
  const items = buildItems(server.messages.slice(win.base), win.presents, win.base, win.presentBase);
  t.ok("項目: mi・pi は通し番号（窓の base・presentBase から数える）",
    items.filter(it => it.kind === "msg").map(it => it.mi).join() === Array.from({ length: win.messages.length }, (_, i) => win.base + i).join()
    && items.filter(it => it.kind === "present").every(it => it.pi >= win.presentBase && it.pi < 20));
  const wholeItems = buildItems(server.messages, server.presents);
  const strip = it => it.kind === "msg" ? `m${it.mi}` : `p${it.pi}`;
  t.ok("項目: 窓の項目の並びは、全量の項目の並びの末尾と同じ", wholeItems.map(strip).join().endsWith(items.map(strip).join()));
  const anchored = clone(server);
  anchored.presents.push({ kind: "image", by: "human", path: "/tmp/a.png", messageId: anchored.messages[10].uuid, at: at(11), dataUri: "data:image/png;base64,AAAA" });
  const anchoredStart = presentBaseFor(anchored.messages, anchored.presents, 300);
  t.ok("窓の提示: 窓より手前の発言に結び付く提示（番号が後ろ）が混じっても、窓の提示の最初の番号は窓の中の分だけ", anchoredStart >= 0 && anchoredStart <= anchored.presents.length - 1);
  const anchoredItems = buildItems(anchored.messages.slice(300), anchored.presents.slice(anchoredStart), 300, anchoredStart);
  t.ok("窓の提示: 結び付き先が窓の手前の提示は、窓の中では結び付かない提示（anchorMi = -1）として出る", anchoredItems.filter(it => it.kind === "present" && it.p.by === "human").every(it => it.anchorMi === -1 || it.anchorMi >= 300));

  // ---------------------------------------------------------------- 画面の描き方（vm で client.mjs から切り出す）
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const cut = name => {
    let from = source.indexOf(`function ${name}(`);
    if (from < 0) throw new Error(`client.mjs に ${name} が無い`);
    return source.slice(from, source.indexOf("\n}", from) + 2);
  };
  const constant = name => { const m = new RegExp(`const ${name} = \\d+;`).exec(source); if (!m) throw new Error(`client.mjs に ${name} が無い`); return m[0]; };

  // 役割: systemHistoryNode の種類と historyRole が揃っている（行を作らずに続きの見出しの判定をするため）
  const systemKinds = new Set([...cut("systemHistoryNode").matchAll(/m\.kind === '(\w+)'/g)].map(m => m[1]));
  const roleKinds = new Set([...cut("historyRole").matchAll(/m\.kind === '(\w+)'/g)].map(m => m[1]));
  t.ok("historyRole: systemHistoryNode が扱う発言の種類（kind）をすべて扱う", [...systemKinds].every(k => roleKinds.has(k)) && roleKinds.size === systemKinds.size, `${[...systemKinds].join()} / ${[...roleKinds].join()}`);
  t.ok("historyRole: internalTaskNotice も扱う", /internalTaskNotice/.test(cut("systemHistoryNode")) && /internalTaskNotice/.test(cut("historyRole")));

  /** 手前を足す仕事の身代わりの画面。paintHistory は呼ばれた範囲を記録する */
  const screen = (messages, presents = [], extra = {}, msPerItem = 12) => {
    const painted = [], idle = [], calls = { compactions: 0, junctions: 0, heights: 0, older: 0, sync: 0 };
    let clock = 0;
    const state = { current: "s", base: 0, presentBase: 0, messages, presents, loadingSession: false, busy: false, ...extra };
    const context = vm.createContext({
      state, buildItems, inlineAttachments,
      thread: { querySelector: () => null }, log: { scrollTop: 0, scrollHeight: 100, style: {} },
      atBottom: () => true, holdReading: () => () => {},
      paintHistory: (_k, _r, older) => { painted.push({ ...older.range, prevRole: older.prevRole, before: context.paintBefore }); clock += msPerItem * (older.range.to - older.range.from); return []; },
      syncEdit: () => { calls.sync++; }, paintCompactions: () => { calls.compactions++; }, placeJunctions: () => { calls.junctions++; },
      prepareHistoryHeights: () => { calls.heights++; }, maybeLoadOlder: () => { calls.older++; },
      requestAnimationFrame: fn => fn(),
      requestIdleCallback: fn => { idle.push(fn); return idle.length; }, cancelIdleCallback: id => { idle[id - 1] = null; },
      performance: { now: () => clock }, Date, Infinity,
    });
    vm.runInContext([
      constant("FIRST_PAINT_ROWS"), constant("BACKFILL_MIN"), constant("BACKFILL_MS"),
      "let backfill = null; let paintBefore = null;",
      ...["historyRole", "roleBefore", "paintedAt", "paintedFloor", "splitFirstPaint", "backfillChunk", "scheduleBackfill", "stopBackfillTimer", "stepBackfill", "finishBackfill", "cancelBackfill", "flushBackfill"].map(cut),
      "this.api = { historyRole, roleBefore, paintedAt, paintedFloor, splitFirstPaint, backfillChunk, stepBackfill, cancelBackfill, flushBackfill, scheduleBackfill, get backfill() { return backfill; }, set backfill(v) { backfill = v; } };",
    ].join("\n"), context);
    /** idle の仕事を 1 つずつ空にする（上限つき）。走らせた回数を返す */
    const drain = (limit = 200) => { let n = 0; while (idle.length && n < limit) { const fn = idle.shift(); if (fn) { fn({ timeRemaining: () => 50 }); n++; } } return n; };
    return { state, api: context.api, painted, idle, calls, drain };
  };

  const roles = [["command", "user"], ["shell", "user"], ["compactSummary", null], ["interrupt", null], ["teammate", null], ["interruptionNote", null], ["channelEvent", null], ["contextNote", null]];
  const probe = screen(conversation(4));
  t.ok("historyRole: コマンドと ! は人の行・ほかのシステム側の行は役割なし・ふつうの発言は role",
    roles.every(([kind, role]) => probe.api.historyRole({ kind, role: "assistant" }) === role)
    && probe.api.historyRole({ internalTaskNotice: true, role: "user" }) === null && probe.api.historyRole({ role: "user" }) === "user" && probe.api.historyRole({ role: "assistant" }) === "assistant");
  const mixed = buildItems([{ role: "user", text: "a", at: at(1) }, { kind: "interrupt", role: "user", at: at(2) }, { role: "assistant", text: "b", at: at(3) }], []);
  t.ok("roleBefore: 直前の発言の役割（先頭は null・システム側の行は null）", probe.api.roleBefore(mixed, 0) === null && probe.api.roleBefore(mixed, 1) === "user" && probe.api.roleBefore(mixed, 2) === null);

  // 分けない: 短い会話・手前が少ない会話
  t.ok("分け方: 短い会話（手前が BACKFILL_MIN 未満）は分けない（null）", screen(conversation(20)).api.splitFirstPaint() === null && screen(conversation(27)).api.splitFirstPaint() === null);

  // 分ける: 末尾の FIRST_PAINT_ROWS 件の発言が先、手前が仕事になる
  const s = screen(conversation(120), [], {});
  const split = s.api.splitFirstPaint();
  const firstEnd = split.job.end;
  const msgsIn = (items, from, to) => items.slice(from, to).filter(it => it.kind === "msg").length;
  t.ok("分け方: 末尾の 16 件の発言が先に描く範囲で、残りが手前の仕事", split && msgsIn(split.job.items, split.tail.range.from, split.tail.range.to) === 16 && split.tail.range.to === split.job.items.length && split.job.end === split.tail.range.from);
  t.ok("分け方: 先に描く範囲の直前の役割（続きの見出しの判定）を渡す", split.tail.prevRole === s.api.roleBefore(split.job.items, split.tail.range.from));
  s.api.backfill = split.job;
  const floor = s.api.paintedFloor();
  t.ok("描いた一番上の発言: 仕事の間は通し番号と時刻が先の範囲の最初の発言（区切り・分岐点はこれより手前に置かない）",
    floor.mi === split.job.items[split.job.end].mi && floor.at === Date.parse(split.job.items[split.job.end].m.at));

  // 記録に時刻を持たない発言が窓や仕事の頭になっても、区切りの置き場所の基準は決まる（NaN にならない）
  const noHead = conversation(120).map((m, i) => i < 3 ? { ...m, at: undefined } : m);
  const headless = screen(noHead, [], { base: 40 });
  t.ok("描いた一番上の発言（窓の会話）: 頭に時刻が無ければ、以降で最初に時刻を持つ発言の時刻を使う",
    headless.api.paintedFloor().mi === 40 && headless.api.paintedFloor().at === Date.parse(at(3)) && headless.api.paintedAt(40) === Date.parse(at(3)) && headless.api.paintedAt(43) === Date.parse(at(3)));
  const noTimes = screen(conversation(10).map(m => ({ ...m, at: undefined })), [], { base: 40 });
  t.ok("描いた一番上の発言: 時刻を持つ発言が 1 つも無ければ NaN（区切りの基準が無いので、全部描く）", Number.isNaN(noTimes.api.paintedFloor().at) && noTimes.api.paintedFloor().mi === 40);
  const sparse = screen(conversation(120).map((m, i) => i < 100 ? { ...m, at: undefined } : m), [], { base: 40 });
  const headlessSplit = sparse.api.splitFirstPaint();
  sparse.api.backfill = headlessSplit.job;
  t.ok("描いた一番上の発言（仕事の間）: 仕事の頭の発言に時刻が無くても、その手前の区切りの基準が決まる",
    headlessSplit && Number.isFinite(sparse.api.paintedFloor().at) && sparse.api.paintedFloor().mi === headlessSplit.job.floorMi);
  t.ok("区切り: 描いた一番上の発言の時刻が NaN のときは、区切りを手前に置く基準が無いので除かない（paintCompactions）",
    /Number\.isFinite\(floor\.at\) && !\(entry\.at > floor\.at\)/.test(cut("paintCompactions")));

  // 手前を足し切る
  s.api.scheduleBackfill(split.job);
  const runs = s.drain();
  const ranges = s.painted;
  t.ok("手前の足し方: idle の仕事を繰り返すと、先の範囲の手前から 0 まで隙間なく重ならずに描く", runs >= 2 && ranges[0].to === firstEnd && ranges.every((r, i) => i === 0 || r.to === ranges[i - 1].from) && ranges.at(-1).from === 0, `${runs} 回`);
  t.ok("手前の足し方: 描き終えたら仕事は無くなり、区切り・分岐点を置き、実寸の確定と手前の読み足しを再開する",
    s.api.backfill === null && s.calls.compactions === 1 && s.calls.junctions === 1 && s.calls.heights === 1 && s.calls.older === 1 && s.api.paintedFloor() === null);
  t.ok("手前の足し方: 1 回の範囲は、かかった時間に合わせて変わる（12ms/件の遅い端末では最初の 8 件から 2 件へ小さくなる）",
    ranges[0].to - ranges[0].from === 8 && ranges[1].to - ranges[1].from === 2 && ranges.length >= 10);
  const quick = screen(conversation(400), [], {}, 0.05);
  const quickSplit = quick.api.splitFirstPaint();
  quick.api.backfill = quickSplit.job;
  quick.api.scheduleBackfill(quickSplit.job);
  quick.drain();
  t.ok("手前の足し方: 速い端末では 1 回の範囲が大きくなる（上限 48 件）",
    quick.painted[1].to - quick.painted[1].from > 8 && quick.painted.every(r => r.to - r.from <= 48) && quick.painted.at(-1).from === 0);
  t.ok("手前の足し方: 各回の直前の役割（prevRole）は、その手前の発言の役割と同じ", ranges.every(r => r.prevRole === s.api.roleBefore(split.job.items, r.from)));

  // 提示は結び付く発言の直後に並ぶので、切れ目は提示の手前にならない
  const msgs = conversation(120);
  const attachments = [20, 40, 60, 80, 100].map((k, i) => ({ kind: "image", by: "human", path: `/tmp/${i}.png`, messageId: msgs[k].uuid, at: at(k + 0.5), dataUri: "data:image/png;base64,AAAA" }));
  const a = screen(msgs, attachments);
  const aSplit = a.api.splitFirstPaint();
  a.api.backfill = aSplit.job;
  a.api.scheduleBackfill(aSplit.job);
  a.drain();
  const anchoredAtCut = a.painted.every(r => !(aSplit.job.items[r.from]?.kind === "present" && aSplit.job.items[r.from].anchorMi >= 0));
  t.ok("手前の足し方: 結び付いた提示は発言から離れない（範囲の最初が結び付いた提示にならない）・全体は隙間なし", anchoredAtCut && a.painted.at(-1).from === 0 && a.painted.every((r, i) => i === 0 || r.to === a.painted[i - 1].from));

  // 途中でやめる・今すぐ全部描く・会話が替わる
  const c = screen(conversation(120));
  const cSplit = c.api.splitFirstPaint();
  c.api.backfill = cSplit.job;
  c.api.scheduleBackfill(cSplit.job);
  c.drain(1);
  const after1 = c.painted.length;
  c.api.cancelBackfill();
  c.drain();
  t.ok("やめる: 仕事が無くなり、予約した idle も外れて、それ以上描かない（終わりの後始末も走らない）", c.api.backfill === null && c.painted.length === after1 && c.calls.compactions === 0);
  const f = screen(conversation(120));
  const fSplit = f.api.splitFirstPaint();
  f.api.backfill = fSplit.job;
  f.api.scheduleBackfill(fSplit.job);
  f.drain(1);
  f.api.flushBackfill();
  t.ok("今すぐ全部: 残りを 1 回で 0 まで描き、終わりの後始末が 1 回だけ走る（idle の予約は外れる）",
    f.api.backfill === null && f.painted.at(-1).from === 0 && f.calls.compactions === 1 && f.calls.junctions === 1 && (f.drain(), f.calls.compactions === 1));
  t.ok("今すぐ全部: 仕事が無ければ何もしない", (() => { const g = screen(conversation(120)); g.api.flushBackfill(); return g.painted.length === 0 && g.calls.compactions === 0; })());
  const h = screen(conversation(120));
  const hSplit = h.api.splitFirstPaint();
  h.api.backfill = hSplit.job;
  h.api.scheduleBackfill(hSplit.job);
  h.state.current = "別の会話";
  h.drain();
  t.ok("会話が替わったら、その仕事は何も描かずにやめる", h.api.backfill === null && h.painted.length === 0 && h.calls.compactions === 0);
  const w = screen(conversation(120), [], { base: 40, presentBase: 3 });
  const wSplit = w.api.splitFirstPaint();
  t.ok("窓の会話（base > 0）: 仕事の項目は通し番号で、一番上の描いた発言は base 以上", wSplit.job.items[0].mi === 40 && wSplit.job.floorMi >= 40);

  // ---------------------------------------------------------------- 画面の配線（ソースの形）
  t.ok("配線: 会話を開く読み込み（loadAndPaint の窓・枝の切り替え・遡り）は bulk を付け、syncHistory と全量の読み込みには付けない",
    /\{ window: true, bulk: true \}\)/.test(cut("loadAndPaint")) && /bulk: true/.test(cut("changeBranch")) && /bulk: true/.test(cut("loadOlder"))
    && !/bulk/.test(cut("syncHistory")));
  t.ok("配線: 窓の頼みは lazy・tail・tailBytes を添える。遡りは older を頼む", /lazy: true, tail: WINDOW_MESSAGES, tailBytes: WINDOW_BYTES/.test(cut("loadHistory")) && /older:/.test(cut("loadOlder")));
  t.ok("配線: 手前の発言が要る操作（遡り・目次・会話の中の検索）は、描いていない手前を先に描き切る", /flushBackfill\(\)/.test(cut("loadOlder")) && /flushBackfill\(\)/.test(cut("loadAllOlder")) && /flushBackfill\(\)/.test(cut("revealMessage")));
  t.ok("配線: 会話を描き直す・替えるときは手前の仕事を捨てる", /cancelBackfill\(\)/.test(cut("clearThread")));
  t.ok("配線: 手前の読み足しは、手前を足している間は始めない", /backfill/.test(cut("maybeLoadOlder")));
  t.ok("配線: 遡りの照合は anchorSig で、検索からの移動（revealMessage）は届かせたい発言を reach で添える（1 回で届く）",
    /check: anchorSig\(/.test(cut("loadOlder")) && /reach/.test(cut("loadOlder")) && /loadOlder\(\{ reach: uuid \}\)/.test(cut("revealMessage")));
  t.ok("配線: 窓の手前の呼び出し（earlierCalls）を受けて覚え、作業ダイアログの過去の一覧が引く",
    /state\.earlierCalls = data\?\.earlierCalls \?\? \[\]/.test(cut("paintSession")) && /state\.earlierCalls/.test(cut("restorePastSubagents")) && /subagentCalls\(/.test(cut("restorePastSubagents")));
  t.ok("配線: 手前を足したとき、時刻だけで並ぶ提示（窓の中では先頭に載せていたもの）も時刻の位置へ描き直す", /firstAt/.test(cut("paintOlder")) && /it\.sortAt < firstAt/.test(cut("paintOlder")));

  // ---------------------------------------------------------------- 起動の先読み（ready の直後に前回の会話を頼む。開くときと同じ窓の形でなければ引き取れない）
  const asked = [];
  const boot = new Function("loadHistory", "sessionLoads", `let bootPrefetch = null; ${cut("startBootPrefetch")}
return { start: startBootPrefetch, get pre() { return bootPrefetch; } };`)(
    (args, prev, options) => { asked.push({ args, prev, options }); return Promise.resolve({ messages: [], presents: [], base: 0, presentBase: 0 }); },
    { begin: (id) => ({ id }) });
  boot.start("前回の会話");
  t.ok("起動の先読み: 前回の会話も、開くときと同じ末尾の窓（loadHistory の window と bulk）で頼む",
    asked.length === 1 && asked[0].args.sessionId === "前回の会話" && asked[0].prev === null && asked[0].options.window === true && asked[0].options.bulk === true);
  t.ok("起動の先読み: 引き取り先（loadAndPaint）が使う args と返事を取り置く", boot.pre.id === "前回の会話" && boot.pre.args === asked[0].args && typeof boot.pre.reply.then === "function");
  t.ok("起動の先読み: 先読みが失敗したときの読み直しも窓の形（loadAndPaint の pre.reply の catch）",
    /pre\.reply\.catch\(\(\) => loadHistory\(pre\.args, null, \{ window: true, bulk: true \}\)\)/.test(cut("loadAndPaint")));
}
