// loadSession の差分（web/history-sync.mjs・ADR 0062）: 画面が頼み、サーバーが切り、画面がつなぐ。
//   - 差分でつないだ結果は、全量と同じ。合わない・古い相手・壊れた頼みは全量に戻る
//   - 画面の syncHistory（ターンの終わり）と静かな読み直しが、持っている履歴の続きだけを頼む
// サーバーを起動して量を測る確認は tests/unit/server-history-diff.mjs
import fs from "node:fs/promises";
import vm from "node:vm";
import { syncRequest, serveFrom, joinReply, messageSig, presentSig, TAIL, WINDOW_MESSAGES, WINDOW_BYTES } from "../../web/history-sync.mjs";

export const name = "history-sync";
export const title = "loadSession の差分: 合うときだけ続きを返し、つないだ結果は全量と同じ。合わなければ全量";

const at = n => new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString();
const conversation = n => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? { uuid: `u${i}`, role: "user", text: `質問 ${i}`, at: at(i) }
  : { uuid: `a${i}`, role: "assistant", text: `答え ${i}`, at: at(i), toolCalls: [{ id: `t${i}`, name: "Read", input: { file: `f${i}` }, result: { text: `結果 ${i}`, isError: false } }] });
const presentsOf = n => Array.from({ length: n }, (_, i) => ({ kind: "visualization", id: `v${i}`, at: at(100 + i), content: `<p>${"x".repeat(100)}${i}</p>`, reference: `visualize{"path":"/tmp/${i}.html"}`, by: "ai" }));
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async function (t) {
  // ---------------------------------------------------------------- 署名
  const m = conversation(4);
  t.ok("発言の署名は、中身が同じなら別のオブジェクトでも同じ・ツールの結果が違えば違う",
    messageSig(m[1]) === messageSig(clone(m[1])) && messageSig(m[1]) !== messageSig({ ...clone(m[1]), toolCalls: [{ ...m[1].toolCalls[0], result: { text: "変わった", isError: false } }] }));
  const p = presentsOf(1)[0];
  t.ok("提示の署名は、中身の長さと結び付き（messageId）が変わると違う",
    presentSig(p) === presentSig(clone(p)) && presentSig(p) !== presentSig({ ...p, messageId: "u0" }) && presentSig(p) !== presentSig({ ...p, content: p.content + "y" }));

  // ---------------------------------------------------------------- 頼み・切り出し・つなぎ
  const server = { messages: conversation(2000), presents: presentsOf(20), completedAt: 5, draft: null };
  /** 画面が n 件・提示 k 件まで持っているところから、差分でつないだ結果（サーバーは server の全量を持つ） */
  const roundTrip = (n, k, edit = x => x) => {
    const prev = { messages: clone(server.messages.slice(0, n)), presents: clone(server.presents.slice(0, k)) };
    const request = syncRequest(prev.messages, prev.presents);
    const body = serveFrom(edit(clone(server)), request);
    return { prev, request, body, joined: request ? joinReply(prev, body, request) : null };
  };

  const grown = roundTrip(1980, 18);
  t.ok("頼みは、発言は末尾の TAIL 件を除いた位置から・提示は持っている分の全部", grown.request.from === 1980 - TAIL && grown.request.presentFrom === 18, JSON.stringify({ ...grown.request, check: "…", presentCheck: "…" }));
  t.ok("合えば、続きの発言と提示だけを返す（from・total・presentFrom・presentTotal 付き）",
    grown.body.from === 1978 && grown.body.messages.length === 22 && grown.body.total === 2000
    && grown.body.presentFrom === 18 && grown.body.presents.length === 2 && grown.body.presentTotal === 20
    && grown.body.completedAt === 5, `${grown.body.messages.length} 件・提示 ${grown.body.presents.length} 件`);
  t.ok("差分をつないだ結果は、全量と同じ", grown.joined && same(grown.joined.messages, server.messages) && same(grown.joined.presents, server.presents));
  t.ok("つないだ先頭の要素は、持っていたものをそのまま使う（行の同一性が保てる）",
    grown.joined.messages.slice(0, 1978).every((x, i) => x === grown.prev.messages[i]));

  const nothing = roundTrip(2000, 20);
  t.ok("増えていなければ、発言は末尾の TAIL 件だけ・提示は 0 件を返す", nothing.body.messages.length === TAIL && nothing.body.presents.length === 0 && same(nothing.joined.messages, server.messages));
  const empty = roundTrip(0, 0);
  t.ok("何も持っていなければ、頼まない（全量）", empty.request === null && !("from" in empty.body));
  const few = roundTrip(2, 0);
  t.ok("TAIL 件しか持っていなくて提示も無ければ、頼まない（全量）", few.request === null);

  // 合わないときは全量（差分の印が無い）。画面はそのまま全量として使える
  const full = clone(server);
  const mismatches = {
    "途中の発言の本文が書き換わった": s => { s.messages[500].text = "書き換わった"; return s; },
    "途中の発言のツールの結果が後から変わった": s => { s.messages[1001].toolCalls[0].result.text = "変わった"; return s; },
    "途中の発言の uuid が変わった（枝が変わった）": s => { s.messages[10].uuid = "別の枝"; return s; },
    "先頭に発言が挿し込まれた（圧縮・書き換え）": s => { s.messages.unshift({ uuid: "new", role: "user", text: "先頭", at: at(0) }); return s; },
    "履歴が短くなった（持っている件数に足りない）": s => { s.messages.length = 1000; return s; },
    "途中の提示が変わった（添付の結び付き）": s => { s.presents[3].messageId = "u0"; return s; },
    "提示が減った": s => { s.presents.length = 5; return s; },
  };
  for (const [what, edit] of Object.entries(mismatches)) {
    const r = roundTrip(1980, 18, edit);
    t.ok(`合わなければ全量: ${what}`, r.request && !("from" in r.body) && r.body.messages.length === edit(clone(server)).messages.length && r.joined === null);
  }
  const tailChange = roundTrip(1980, 18, s => { s.messages[1979].toolCalls = [{ id: "z", name: "Read", input: {}, result: { text: "末尾は後から変わる", isError: false } }]; return s; });
  t.ok("末尾の TAIL 件の中の変更は、続きの中で取り直せる（差分のまま合う）",
    tailChange.joined && tailChange.body.from === 1978 && tailChange.joined.messages[1979].toolCalls[0].id === "z");

  // 壊れた頼み・古い相手
  for (const [what, args] of Object.entries({
    "頼みが無い（古い画面）": {}, "from だけ（presentFrom が無い）": { from: 5, check: 1 },
    "from が文字列": { from: "5", check: 1, presentFrom: 0, presentCheck: 1 }, "from が負": { from: -1, check: 1, presentFrom: 0, presentCheck: 1 },
    "from が小数": { from: 1.5, check: 1, presentFrom: 0, presentCheck: 1 }, "check が違う": { from: 5, check: 1, presentFrom: 0, presentCheck: 1 },
    "件数より大きい from": { from: 999999, check: 1, presentFrom: 0, presentCheck: 1 },
  })) {
    const r = serveFrom(clone(server), args);
    t.ok(`全量を返す: ${what}`, !("from" in r) && r.messages.length === 2000);
  }

  // 画面: 差分の印が無い（古いサーバー）→ null、印と件数が食い違う → false
  const request = syncRequest(server.messages.slice(0, 1990), server.presents);
  const prev = { messages: server.messages.slice(0, 1990), presents: server.presents };
  const answer = serveFrom(clone(server), request);
  t.ok("古いサーバー（差分の印が無い）の全量は、そのまま使う", joinReply(prev, clone(server), request) === null);
  t.ok("件数が食い違う差分は使わない（全量を取り直す）",
    joinReply(prev, { ...answer, total: answer.total + 1 }, request) === false
    && joinReply(prev, { ...answer, from: answer.from - 1 }, request) === false
    && joinReply(prev, { ...answer, presentTotal: 0 }, request) === false
    && joinReply({ messages: prev.messages.slice(0, 100), presents: prev.presents }, answer, request) === false);

  // ---------------------------------------------------------------- 画面の頼み方（loadHistory・syncHistory）
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const cut = name => {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`client.mjs に ${name} が無い`);
    if (source.slice(start - 6, start) === "async ") start -= 6;
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  const noop = () => {};
  /** 画面の身代わり。cmd はサーバー（serveFrom）で応え、届いた引数と応答の大きさを残す */
  const screen = ({ remote = server, serve = serveFrom } = {}) => {
    const calls = [];
    let reloaded = 0;
    const state = { current: "s", busy: false, base: 0, presentBase: 0, messages: clone(server.messages.slice(0, 1990)), presents: clone(server.presents.slice(0, 19)) };
    const thread = { querySelectorAll: () => [] };
    const context = vm.createContext({
      state, thread, syncRequest, joinReply, WINDOW_MESSAGES, WINDOW_BYTES, select: async () => { reloaded++; }, restorePastSubagents: noop, setUuid: noop, placeJunctions: noop,
      branches: { update: noop, has: () => true, load: async () => {} }, pendingHistorySync: false, pendingBranchReload: false,
      cmd: async (command, args) => {
        calls.push({ command, args });
        return serve(clone(remote), args);
      },
    });
    vm.runInContext(`${cut("loadHistory")}\n${cut("syncHistory")}\nthis.syncHistory = syncHistory; this.loadHistory = loadHistory;`, context);
    return { state, calls, context, reloaded: () => reloaded };
  };

  let s = screen();
  await s.context.syncHistory();
  t.ok("syncHistory は持っている履歴の続きだけを頼む（from・check・presentFrom・presentCheck）。長い会話の窓の頼み（lazy・tail）も添える",
    s.calls.length === 1 && s.calls[0].args.lazy === true && s.calls[0].args.tail === WINDOW_MESSAGES && s.calls[0].args.from === 1988 && s.calls[0].args.presentFrom === 19 && typeof s.calls[0].args.check === "number" && typeof s.calls[0].args.presentCheck === "number");
  t.ok("差分でつないだ結果は、全量と同じ（発言・提示）", same(s.state.messages, server.messages) && same(s.state.presents, server.presents));

  s = screen({ serve: (body) => body });   // 古いサーバー: 頼みを知らず、いつも全量
  await s.context.syncHistory();
  t.ok("古いサーバーの全量も、そのまま履歴になる", same(s.state.messages, server.messages) && same(s.state.presents, server.presents) && s.calls.length === 1);

  s = screen({ serve: (body, args) => { const r = serveFrom(body, args); return "from" in r ? { ...r, total: r.total + 5 } : r; } });   // 食い違う差分
  await s.context.syncHistory();
  t.ok("差分の件数が食い違うときは、全量を取り直す（2 回目は頼みなし）",
    s.calls.length === 2 && !("from" in s.calls[1].args) && same(s.state.messages, server.messages));

  s = screen();
  s.state.messages[300] = { ...s.state.messages[300], text: "手元だけ違う" };
  await s.context.syncHistory();
  t.ok("手元の先頭がサーバーと違えば、サーバーは全量を返し、画面は全量に置き換える", same(s.state.messages, server.messages));

  // 静かな読み直しの経路も同じ関数を通る（loadAndPaint は quiet のときだけ prev を渡す。tests/unit/session-stream.mjs が全量の経路を見ている）
  t.ok("loadAndPaint は静かな読み直しのときだけ、持っている履歴を渡して頼む",
    /loadHistory\(\{ sessionId: id, live: true, watch: true \},\n\s+quiet && state\.messages\.length \? \{ messages: state\.messages, presents: state\.presents, base: state\.base, presentBase: state\.presentBase \} : null, \{ window: true \}\)/.test(source));
}
