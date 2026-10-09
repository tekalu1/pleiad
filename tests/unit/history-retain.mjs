// つなぎ直したときの静かな読み直しで、履歴から描いた行を残し、変わった所から後ろだけ描く（issue #37 段階 2）。
// 今は全部消して描き直すので、長い会話（2000 発言・スマホで 24 秒）が固まり、読み返していた位置も末尾近くへ飛ぶ。
//   - web/history-sync.mjs の retainPlan: 残せる項目の数。行の見た目に効く値（ツールの結果・本文・圧縮の印・提示）が変わったら、その添字から後ろを描き直す
//   - web/client.mjs の retainThread・paintHistory・holdReading: 同じ発言の行が同じ要素のまま残り、増えた分だけ足される。
//     履歴の外にある行（ライブの行・稼働表示）は捨てて履歴から描き直し、読み返していた位置は基準の行で保つ
// 時間ではなく、要素の同一性（===）と行の並びで判定する。
import fs from "node:fs/promises";
import vm from "node:vm";
import { N } from "../lib/dom-stub.mjs";
import { buildItems, inlineAttachments, showsAsCard } from "../../web/timeline.mjs";
import { retainPlan } from "../../web/history-sync.mjs";
import { commonPrefix } from "../../web/branches.mjs";

export const name = "history-retain";
export const title = "静かな読み直しは、同じ発言の行を残して変わった所から後ろだけ描く（読み返している位置も保つ）";

// dom-stub の N に、このテストが要る複合セレクターと子孫の探索を足す
class Node extends N {
  matches(sel) { return compound(this, sel.trim()); }
  querySelectorAll(sel) {
    const parts = sel.replace(/^:scope\s*>?\s*/, "").trim().split(/\s+/);
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (compound(c, parts.at(-1))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
function compound(node, sel) {
  const tokens = sel.match(/:not\([^)]*\)|\.[\w-]+|\[[\w-]+\]|[a-z]+/gi) ?? [];
  return tokens.every(tok => {
    if (tok.startsWith(":not(")) return !compound(node, tok.slice(5, -1));
    if (tok.startsWith(".")) return node._classes().includes(tok.slice(1));
    if (tok.startsWith("[")) return tok.slice(1, -1) in node.attrs;
    return node.tagName === tok.toUpperCase();
  });
}

const at = n => new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString();
/** 人と AI が交互に並ぶ n 件。AI の発言にはツールの呼び出し（結果つき）が付く */
const conversation = n => Array.from({ length: n }, (_, i) => i % 2 === 0
  ? { uuid: `u${i}`, role: "user", text: `質問 ${i}`, at: at(i) }
  : { uuid: `a${i}`, role: "assistant", text: `答え ${i}`, at: at(i), toolCalls: [{ id: `t${i}`, name: "Read", input: { file: `f${i}` }, result: { text: `結果 ${i}`, isError: false } }] });
const clone = x => JSON.parse(JSON.stringify(x));

export default async function (t) {
  // ---------------------------------------------------------------- 残す行数の判定（retainPlan）
  const base = conversation(30);
  const plan = (oldSide, newSide) => retainPlan({ presents: [], compactions: [], ...oldSide }, { presents: [], compactions: [], ...newSide });
  const same = plan({ messages: base }, { messages: clone(base) });
  t.ok("全部同じなら、全部残す", same?.keepItems === 30, `${same?.keepItems}`);
  const grown = plan({ messages: base }, { messages: [...clone(base), ...conversation(34).slice(30)] });
  t.ok("増えただけなら、元の件数まで残す", grown?.keepItems === 30 && grown.items.length === 34, `${grown?.keepItems}`);

  const late = clone(base);
  late[13].toolCalls[0].result = { text: "後から変わった結果", isError: false };
  const lateToolResult = plan({ messages: base }, { messages: late });
  t.ok("途中の発言のツールの結果だけが後から変わっても、その添字から描き直す", lateToolResult?.keepItems === 13, `${lateToolResult?.keepItems}`);
  t.ok("（前提）系譜の照合の commonPrefix は本文とツール名しか見ないので、この違いを拾えない", commonPrefix(base, late) === 30);

  const edited = clone(base);
  edited[7].text = "書き換わった";
  t.ok("途中の本文が書き換わったら、その添字から描き直す", plan({ messages: base }, { messages: edited })?.keepItems === 7);
  const swapped = clone(base);
  swapped[20].uuid = "別の uuid";
  t.ok("uuid だけが違っても、その添字から描き直す", plan({ messages: base }, { messages: swapped })?.keepItems === 20);
  const shrunk = plan({ messages: base }, { messages: clone(base).slice(0, 25) });
  t.ok("短くなった（履歴が書き換わった）ときも、残るのは共通の先頭まで", shrunk?.keepItems === 25);
  const headEdited = clone(base);
  headEdited[0].text = "先頭が違う";
  t.ok("先頭から違えば、残せない（全部描き直す）", plan({ messages: base }, { messages: headEdited }) === null);
  t.ok("何も描いていない画面は、残せない", plan({ messages: [] }, { messages: base }) === null);

  // 圧縮の区切り: 新しく付いたら、区切りの後ろの最初の発言から描き直す（区切りの直後の行は「続き」の形を変える）
  const compacted = plan({ messages: base }, { messages: clone(base), compactions: [{ id: "c1", phase: "complete", at: Date.parse(at(9)) + 1000 }] });
  t.ok("圧縮の区切りが増えたら、その後ろの最初の発言から描き直す", compacted?.keepItems === 10, `${compacted?.keepItems}`);
  const compactionKept = plan({ messages: base, compactions: [{ id: "c1", phase: "complete", at: Date.parse(at(9)) + 1000 }] },
    { messages: clone(base), compactions: [{ id: "c1", phase: "complete", at: Date.parse(at(9)) + 1000 }] });
  t.ok("区切りが変わらなければ全部残す", compactionKept?.keepItems === 30);
  const compactionRewritten = plan({ messages: base, compactions: [{ id: "c1", phase: "complete", at: Date.parse(at(9)) + 1000, summary: "古い要約" }] },
    { messages: clone(base), compactions: [{ id: "c1", phase: "complete", at: Date.parse(at(9)) + 1000, summary: "新しい要約" }] });
  t.ok("区切りの中身が変わったら、その後ろから描き直す", compactionRewritten?.keepItems === 10);

  // 提示: 増えた分は末尾に足す。発言の中の visualize の印は、提示が保存されたかで描き方が変わるので描き直す
  const present = { kind: "visualization", id: "v1", at: at(40), content: "<p>x</p>", reference: "visualize{\"path\":\"/tmp/a.html\"}" };
  const withPresent = plan({ messages: base }, { messages: clone(base), presents: [present] });
  t.ok("提示が増えても、発言の行は全部残す（提示は末尾に足す）", withPresent?.keepItems === 30 && withPresent.items.length === 31);
  const referencing = clone(base);
  referencing[11].text = `結果です\nvisualize{"path":"/tmp/a.html"}`;
  const referenceSaved = plan({ messages: referencing }, { messages: clone(referencing), presents: [{ ...present, at: at(11) }] });
  t.ok("visualize の印を含む発言は、対応する提示が届いたら描き直す", referenceSaved?.keepItems === 11, `${referenceSaved?.keepItems}`);
  const presentsSame = plan({ messages: referencing, presents: [{ ...present, at: at(11) }] }, { messages: clone(referencing), presents: [{ ...present, at: at(11) }] });
  t.ok("提示も同じなら全部残す", presentsSame?.keepItems === 31);
  const anchoredLater = plan({ messages: base, presents: [{ by: "human", kind: "image", path: "/tmp/a.png", at: at(2) }] },
    { messages: clone(base), presents: [{ by: "human", kind: "image", path: "/tmp/a.png", at: at(2), messageId: "u4" }] });
  t.ok("添付が発言へ結ばれた（messageId が付いた）ら、その位置から描き直す", anchoredLater && anchoredLater.keepItems < 30, `${anchoredLater?.keepItems}`);

  // ---------------------------------------------------------------- 画面の行（retainThread・paintHistory）
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const cut = name => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`client.mjs に ${name} が無い`);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  const functions = ["wrap", "place", "append", "resetLiveTurn", "rowRole", "retainThread", "paintHistory", "paintHistoryRows", "paintable"].map(cut).join("\n");
  const el = (tag, cls, text) => { const n = new Node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // 履歴の 1 行。本物の historyRow（web/client.mjs）は発言 1 件から行を作る。ここでは中身が決まる作りものにして、行の並びと続きの見出しだけを見る
  // 人の発言には、結び付いた添付（presents）を本文の位置に取り込み、AI の発言はツールをまとまり（.bundle）にして持つ（main の historyRow と同じ形）
  const historyRow = (m, { cont, presents = [] }) => {
    const node = el("div", `m ${m.role === "user" ? "user" : "ai"}${cont ? " cont" : ""}`);
    node.dataset.role = m.role;
    node.append(el("div", "body", `${m.uuid}|${m.text}|${JSON.stringify(m.toolCalls?.[0]?.result ?? null)}`));
    if (m.toolCalls?.length) { const bundle = el("div", "bundle"); bundle.bundle = { of: m.uuid }; node.append(bundle); }
    if (m.role === "user" && presents.length) node.append(el("div", "attached", presents.map(p => p.path).join(",")));
    return { node, role: m.role };
  };
  const build = () => {
    const thread = el("div", "thread");
    thread.append(el("svg", "spine"));
    const state = { messages: [], presents: [], base: 0, presentBase: 0, busy: true, toolCards: new Map(), streamEl: "s", thinkEl: "t", turnEl: "u", turnClosed: true, bundle: { live: true } };
    let cancelled = 0, hidden = 0;
    const activity = { el: null, hide: () => { hidden++; activity.el?.closest?.(".mw")?.remove(); activity.el = null; } };
    const context = vm.createContext({
      thread, state, activity, el, buildItems, inlineAttachments, showsAsCard, historyRow, log: { scrollTop: 0 }, atBottom: () => false, relayoutBranches() {}, paintDelegateStates() {},
      renderPresent: p => el("div", "m card", `提示 ${p.id ?? p.path}`), savedEvent: p => p,
      cancelStream: () => { cancelled++; },
    });
    vm.runInContext(`let paintingHistory = false;\nlet paintBefore = null;\n${functions}`, context);
    return {
      thread, state, activity, context,
      counts: () => ({ cancelled, hidden }),
      paint(messages, presents = []) {
        state.messages = messages; state.presents = presents;
        return context.paintHistory(0);
      },
      /** 静かな読み直し: 今の画面と読み直した履歴から残す行を決め、後ろだけ描く */
      reload(messages, presents = [], compactions = []) {
        const planned = retainPlan({ messages: state.messages, presents: state.presents, compactions: [] }, { messages, presents, compactions });
        state.messages = messages; state.presents = presents;
        const retained = planned ? context.retainThread(planned) : null;
        if (!retained) { thread.replaceChildren(el("svg", "spine")); return { retained: null, added: context.paintHistory(0) }; }
        return { retained, added: context.paintHistory(0, retained) };
      },
      rows: () => thread.children.filter(c => !c.classList.contains("spine")),
    };
  };
  const keys = rows => rows.map(r => r.dataset.key).join(" ");
  const rowsHtml = rows => rows.map(r => r.outerHTML).join("\n");

  // 増えた分だけ: 同じ発言の行は同じ要素のまま、続きだけ足される
  let s = build();
  s.paint(conversation(30));
  const first = s.rows();
  t.ok("（前提）30 件を描いた", first.length === 30 && first.every(r => r.dataset.h) && keys(first).startsWith("m:0 m:1 m:2"));
  const more = s.reload(conversation(34));
  const after = s.rows();
  t.ok("増えただけなら、既に描いた 30 行は同じ要素のまま残る", first.every((r, i) => after[i] === r));
  t.ok("増えた 4 件だけを足す", more.added.length === 4 && after.length === 34 && more.added.every((r, i) => after[30 + i] === r), `足した ${more.added.length}`);
  s = build(); s.paint(conversation(34));
  t.ok("差分で描いた結果は、全部描いた結果と同じ（並び・キー・見出し）", rowsHtml(after) === rowsHtml(s.rows()));

  // 何も変わらなければ、何も描かない
  s = build(); s.paint(conversation(30));
  const untouched = s.rows();
  const nothing = s.reload(conversation(30));
  t.ok("全部同じなら、行は 1 つも作り直されない", nothing.added.length === 0 && untouched.every((r, i) => s.rows()[i] === r) && s.rows().length === 30);

  // 途中の発言が変わったら、その添字から後ろだけ描き直す
  s = build(); s.paint(conversation(30));
  const beforeEdit = s.rows();
  const changed = conversation(30);
  changed[13].toolCalls[0].result = { text: "後から変わった結果", isError: false };
  const redo = s.reload(changed);
  const afterEdit = s.rows();
  t.ok("途中の発言の結果が変わったら、その前の 13 行は同じ要素のまま", beforeEdit.slice(0, 13).every((r, i) => afterEdit[i] === r));
  t.ok("変わった発言から後ろ 17 行は描き直す（前の要素は残らない）", redo.added.length === 17 && afterEdit.slice(13).every((r, i) => !beforeEdit.includes(r)), `${redo.added.length}`);
  s = build(); s.paint(changed);
  t.ok("描き直した結果は、全部描いた結果と同じ", rowsHtml(afterEdit) === rowsHtml(s.rows()));
  t.ok("変わった発言の行には新しい結果が入る", afterEdit[13].outerHTML.includes("後から変わった結果"));

  // 先頭が違えば全部描き直す
  s = build(); s.paint(conversation(30));
  const beforeHead = s.rows();
  const headChanged = conversation(30); headChanged[0].text = "先頭が変わった";
  const wholly = s.reload(headChanged);
  t.ok("先頭が違えば、全部描き直す", wholly.retained === null && s.rows().length === 30 && s.rows().every(r => !beforeHead.includes(r)));

  // 続きの見出し: 残した行の直後の AI の発言は、直前が AI なら続き（.cont）
  s = build();
  const ai = [{ uuid: "u0", role: "user", text: "q", at: at(0) }, { uuid: "a1", role: "assistant", text: "1", at: at(1) }];
  s.paint(ai);
  s.reload([...ai, { uuid: "a2", role: "assistant", text: "2", at: at(2) }]);
  t.ok("残した AI の発言のすぐ後ろへ足した AI の発言は、続きの形（.cont）になる", s.rows()[2].outerHTML.includes("m ai cont"));

  // 履歴の外の行: ライブで描いた行・稼働表示は捨てて履歴から描き直す。履歴の添字を付けただけの行は境目にしない
  s = build();
  s.paint(conversation(30));
  const liveRow = (key) => { const w = el("div", "mw"); w.dataset.key = key; w.append(el("div", "m ai", "ライブ")); return w; };
  // ターンが終わった直後の形: 履歴を描いた後にライブで 2 行、履歴の添字（m:30・m:31）を付けてある
  s.thread.append(liveRow("m:30"), liveRow("m:31"));
  const liveRows = s.rows().slice(30);
  const activityRow = liveRow("activity");
  s.thread.append(activityRow);
  s.activity.el = { closest: () => activityRow, isConnected: true };
  s.state.streamEl = "残り"; s.state.turnEl = "残り"; s.state.toolCards.set("gone", { isConnected: false }); s.state.toolCards.set("kept", { isConnected: true });
  const turnEnd = s.reload(conversation(32));
  t.ok("ライブで描いて添字を付けた行は外し、履歴から 2 行描き直す（重複しない）", turnEnd.added.length === 2 && s.rows().length === 32 && liveRows.every(r => !s.rows().includes(r)), keys(s.rows()).slice(-20));
  t.ok("稼働表示の行も外れる", !s.thread.children.includes(activityRow));
  t.ok("描きかけの本文・発言の入れ物を捨て、外した行のツールカードの登録も消す",
    s.state.streamEl === null && s.state.turnEl === null && s.state.thinkEl === null && s.counts().cancelled === 1
    && !s.state.toolCards.has("gone") && s.state.toolCards.has("kept"));
  const afterTurnEnd = rowsHtml(s.rows());
  s = build(); s.paint(conversation(32));
  t.ok("この形でも、全部描いた結果と同じ", afterTurnEnd === rowsHtml(s.rows()) && keys(s.rows()) === Array.from({ length: 32 }, (_, i) => `m:${i}`).join(" "));

  // 圧縮の区切り・分岐点の行は、残す範囲の中でも外す（区切りは paintCompactions・分岐点は placeJunctions が付け直す）
  s = build(); s.paint(conversation(30));
  const boundary = el("div", "mw compaction-boundary"); boundary.dataset.compactionId = "c1"; boundary.dataset.key = "compaction:c1";
  const branch = el("div", "mw branch-row"); branch.dataset.key = "m:5";
  boundary.parent = branch.parent = s.thread;
  s.thread.children.splice(10, 0, boundary); s.thread.children.splice(20, 0, branch);
  const kept = s.rows().filter(r => r.dataset.h);
  s.reload(conversation(31));
  t.ok("区切りと分岐点の行は外し、発言の行は全部そのまま残す", !s.thread.children.includes(boundary) && !s.thread.children.includes(branch)
    && kept.every(r => s.thread.children.includes(r)) && s.rows().length === 31);

  // 提示の行（p:）も同じ。提示が増えても発言の行は残る
  s = build(); s.paint(conversation(30), [present]);
  const withCard = s.rows();
  s.reload(conversation(30), [present, { ...present, id: "v2", at: at(50), reference: "visualize{\"path\":\"/tmp/b.html\"}" }]);
  t.ok("提示が増えても、描いた行は同じ要素のまま、提示の行だけが足される",
    withCard.every((r, i) => s.rows()[i] === r) && s.rows().length === withCard.length + 1 && s.rows().at(-1).dataset.key === "p:1", keys(s.rows()).slice(-20));

  // ---------------------------------------------------------------- ツールのまとまり・取り込んだ添付（main の web/tool-bundle.mjs・inlineAttachments）
  // 履歴の行は発言 1 件につき 1 行で、ツールのまとまり（.bundle）はその行の中にある。残した行のまとまりは同じ要素のまま
  s = build(); s.paint(conversation(30));
  const bundlesBefore = s.rows().map(r => r.querySelector(".bundle")).filter(Boolean);
  s.reload(conversation(34));
  const bundlesAfter = s.thread.querySelectorAll(".bundle");
  t.ok("残した行の中のツールのまとまりは、同じ要素のまま残る（増えた分だけ足される）",
    bundlesBefore.length === 15 && bundlesBefore.every(b => bundlesAfter.includes(b)) && bundlesAfter.length === 17, `${bundlesBefore.length} → ${bundlesAfter.length}`);
  // 走っているまとまり（state.bundle）を持つライブの行は、外して履歴から描き直す
  s = build(); s.paint(conversation(30));
  const liveTurn = liveRow("live:1"); const liveBundle = el("div", "bundle"); liveTurn.append(liveBundle);
  liveTurn.parent = s.thread; s.thread.children.push(liveTurn);
  s.reload(conversation(30));
  t.ok("ライブのまとまりを持つ行は外れ、走っているまとまり（state.bundle）の参照も捨てる", !s.thread.children.includes(liveTurn) && s.state.bundle === null && s.rows().length === 30);

  // 発言に結び付いた人の添付は、発言の本文の位置に取り込み、後ろに別の行を出さない。取り込みの有無が変わったら、その発言から描き直す
  const attach = (extra = {}) => ({ by: "human", kind: "image", path: "/tmp/a.png", at: at(4), ...extra });
  const paintedRows = (messages, presents) => { const f = build(); f.paint(messages, presents); return f; };
  const same2 = (a, b) => rowsHtml(a.rows()) === rowsHtml(b.rows());
  {
    const bound = [attach({ messageId: "u4" })];
    s = paintedRows(conversation(30), bound);
    t.ok("（前提）結び付いた添付は発言の行に取り込まれ、別の行は出ない", s.rows()[4].outerHTML.includes("/tmp/a.png") && !s.rows().some(r => r.dataset.key === "p:0") && s.rows().length === 30);
    const before = s.rows();
    const nothing2 = s.reload(conversation(30), bound);
    t.ok("添付が変わらなければ、全部残る（取り込んだ発言の行も同じ要素）", nothing2.added.length === 0 && before.every((r, i) => s.rows()[i] === r));
    const grown2 = s.reload(conversation(34), bound);
    t.ok("増えたときも、取り込んだ添付を二重の行にしない（発言の行 34 だけ）", s.rows().length === 34 && !s.rows().some(r => r.dataset.key === "p:0") && before.every((r, i) => s.rows()[i] === r) && grown2.added.length === 4);
    t.ok("その結果は全量で描いた結果と同じ", same2(s, paintedRows(conversation(34), bound)));

    // 添付が発言に結ばれた（それまでは別のカード）→ 発言の行に取り込まれ、カードが消える
    s = paintedRows(conversation(30), [attach()]);
    t.ok("（前提）結び付いていない添付は別のカードの行", s.rows().some(r => r.dataset.key === "p:0"));
    const early = s.rows();
    s.reload(conversation(30), bound);
    t.ok("添付が発言に結ばれたら、その発言から描き直し、カードの行は消える（前の行は同じ要素）",
      !s.rows().some(r => r.dataset.key === "p:0") && s.rows()[4].outerHTML.includes("/tmp/a.png") && early.slice(0, 4).every((r, i) => s.rows()[i] === r));
    t.ok("その結果は全量で描いた結果と同じ", same2(s, paintedRows(conversation(30), bound)));

    // 逆: 結び付きが外れた
    s = paintedRows(conversation(30), bound);
    s.reload(conversation(30), [attach()]);
    t.ok("結び付きが外れたら、発言の行から添付が消え、カードの行が出る", !s.rows()[4].outerHTML.includes("/tmp/a.png") && s.rows().some(r => r.dataset.key === "p:0") && same2(s, paintedRows(conversation(30), [attach()])));

    // 古い発言に後から添付が結ばれた（提示が増えた）
    s = paintedRows(conversation(30), []);
    const old = s.rows();
    s.reload(conversation(30), bound);
    t.ok("残した古い発言に添付が後から結ばれたら、その発言を描き直して取り込む（カードにしない）",
      s.rows()[4].outerHTML.includes("/tmp/a.png") && !s.rows().some(r => r.dataset.key === "p:0") && old.slice(0, 4).every((r, i) => s.rows()[i] === r) && same2(s, paintedRows(conversation(30), bound)));

    // 描き直しの始まりが、取り込み済みの添付の項目に当たっても、その添付を別の行にしない
    s = paintedRows(conversation(30), bound);
    const items = buildItems(conversation(30), bound);
    const at4 = items.findIndex(it => it.kind === "msg" && it.mi === 4);
    const retained = s.context.retainThread({ keepItems: at4 + 1, items });
    s.context.paintHistory(0, retained);
    t.ok("描き直しが取り込み済みの添付の項目から始まっても、別の行を出さない", retained.from === at4 + 1 && !s.rows().some(r => r.dataset.key === "p:0") && same2(s, paintedRows(conversation(30), bound)));
  }

  // ---------------------------------------------------------------- 読み返している位置（holdReading）
  // 行の高さと #log のスクロールだけを持つ画面（tests/unit/history-heights.mjs と同じ作り）
  const LOG_TOP = 50, VIEW = 900;
  const PLACEHOLDER = 160;
  const screen = () => {
    const rows = [];
    let scrollTop = 0;
    const log = {
      clientHeight: VIEW,
      get scrollHeight() { return rows.filter(r => r.isConnected).reduce((s, r) => s + r.height, 0); },
      get scrollTop() { return scrollTop; },
      set scrollTop(v) { scrollTop = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
      getBoundingClientRect: () => ({ top: LOG_TOP, height: VIEW }),
    };
    const makeRow = (key, height, ready) => {
      const row = {
        dataset: { key }, isConnected: true, height: ready ? height : PLACEHOLDER,
        getBoundingClientRect() {
          let y = 0;
          for (const r of rows) { if (r === row) break; if (r.isConnected) y += r.height; }
          const top = LOG_TOP + y - scrollTop;
          return { top, bottom: top + row.height };
        },
      };
      rows.push(row);
      return row;
    };
    const thread = {
      get children() { return rows.filter(r => r.isConnected); },
      querySelectorAll: () => rows.filter(r => r.isConnected),
    };
    return { rows, log, thread, makeRow };
  };
  const hold = (view) => {
    const context = vm.createContext({ log: view.log, thread: view.thread });
    vm.runInContext(`${cut("historyAnchor")}\n${cut("holdReading")}\nthis.holdReading = holdReading;`, context);
    return context.holdReading;
  };
  const heights = Array.from({ length: 60 }, (_, i) => [90, 420, 1600, 60, 240, 300, 130, 760][i % 8]);
  const setup = () => {
    const view = screen();
    heights.forEach((h, i) => view.makeRow(`m:${i}`, h, true));
    view.log.scrollTop = Math.round(view.log.scrollHeight * 0.4);
    return view;
  };
  // 見えている行より後ろだけを描き直す（増えた分を足す）: 基準の行は残る
  let view = setup();
  const anchorAt = () => view.rows.find(r => r.isConnected && r.getBoundingClientRect().bottom > LOG_TOP + 80);
  let watched = anchorAt(), top = watched.getBoundingClientRect().top;
  const restoreFn = hold(view)();
  for (const r of view.rows.slice(-10)) r.isConnected = false;   // 末尾の 10 行を外し、描き直す
  for (let i = 50; i < 64; i++) view.makeRow(`m:${i}`, 500, false);
  restoreFn();
  t.ok("読み返し中: 後ろだけ描き直しても、基準の行は同じ高さに残る", watched.isConnected && Math.abs(watched.getBoundingClientRect().top - top) < 1, `${watched.getBoundingClientRect().top - top}px`);

  // 基準の行より前の行の高さが変わっても（実寸に伸びるなど）基準の行の位置は保つ
  view = setup();
  watched = anchorAt(); top = watched.getBoundingClientRect().top;
  const restoreShift = hold(view)();
  for (const r of view.rows.slice(0, 5)) r.height += 333;
  restoreShift();
  t.ok("読み返し中: 前の行の高さが変わっても、基準の行は同じ高さに戻る", Math.abs(watched.getBoundingClientRect().top - top) < 1, `${watched.getBoundingClientRect().top - top}px`);

  // 基準の行が描き直されて別の要素になっても、同じ添字の行を基準にする
  view = setup();
  watched = anchorAt(); top = watched.getBoundingClientRect().top;
  const restoreKey = hold(view)();
  const index = view.rows.indexOf(watched);
  watched.isConnected = false;
  const replaced = view.makeRow(watched.dataset.key, 300, true);
  view.rows.splice(index, 0, view.rows.pop());
  restoreKey();
  t.ok("読み返し中: 基準の行が描き直されても、同じ添字の行が同じ高さに来る", Math.abs(replaced.getBoundingClientRect().top - top) < 1, `${replaced.getBoundingClientRect().top - top}px`);
}
