// 分岐点の計算（web/branches.mjs）。**本物の Claude の履歴の形**を模す。
//
// 実機で分かったこと（2026-09-11、7420 の fork）:
//   - forkSession は複製した発言に新しい uuid を振る。親子で uuid は 1 つも一致しない
//   - 分岐点は sidecar の parent.atMessage（親の uuid）。子の履歴にはその uuid は無い
//   - thinking だけの entry（本文が空）、ツール呼び出しだけの entry（本文が空、toolCalls あり）が挟まる
// uuid だけで照合すると共通接頭辞が 0 になり、分岐点の印が出ず、戻る経路も無かった。
import { branchOrder, curve, ease } from "../../web/branch-view.mjs";
import { createBranches, commonPrefix, nodeKeys } from "../../web/branches.mjs";
import { t as i18n } from "../../web/i18n.mjs";
import { readFileSync } from "node:fs";

export const name = "branches";
export const title = "uuid が付け直された枝でも分岐点が出て、必ず戻れる";

const msg = (role, text, uuid, extra = {}) => ({ role, text, uuid, at: null, ...extra });
const tool = (name) => ({ id: name, name, input: {}, result: null });

/** 親: user / tool だけ / thinking だけ / 本文。子はそこまでを新しい uuid で複製 + 自分の発言 */
const parent = [
  msg("user", "こんにちは", "p0"),
  msg("assistant", "", "p1", { toolCalls: [tool("Read")] }),
  msg("assistant", "", "p2", { thinking: "考え中" }),
  msg("assistant", "こんにちは！", "p3"),
  msg("user", "続けて", "p4"),
  msg("assistant", "続けます", "p5"),
];
const copy = (m, i) => ({ ...m, uuid: `c${i}` });
const child = [...parent.slice(0, 4).map(copy), msg("user", "別の話", "c4"), msg("assistant", "はい", "c5")];

function fakeCmd(lineage, histories, seen = []) {
  return async (command, args) => {
    if (command === "lineage") return lineage;
    if (command === "loadSession") { seen.push(args); return { messages: histories[args.sessionId] ?? [], presents: [] }; }
    throw new Error(`知らない command: ${command}`);
  };
}

export default async function (t) {
  t.ok("uuid が全部違っても役割・本文・ツール名で接頭辞が取れる", commonPrefix(parent, child) === 4, String(commonPrefix(parent, child)));
  t.ok("本文が違えばそこで止まる", commonPrefix(parent, [parent[0], msg("assistant", "違う", "x")]) === 1);
  t.ok("ツール名が違えば同じ発言とは見ない",
    commonPrefix([msg("assistant", "", "a", { toolCalls: [tool("Read")] })], [msg("assistant", "", "b", { toolCalls: [tool("Write")] })]) === 0);

  t.ok("選んだ枝がメインになり他の枝の順は維持", branchOrder(['P','A','B','C'], 'B', ['P','A','B','C']).join() === 'B,A,P,C');
  t.ok("fork が増えても既存ノードの順を維持", branchOrder(['B','A','P','C','D'], 'B', ['B','A','P','C']).join() === 'B,A,P,C,D');
  t.ok("消えたセッションを並びから除く", branchOrder(['P','C'], 'P', ['C','A','P']).join() === 'P,C');
  const lower = curve({x:200,y:96},{x:20,y:176});
  t.ok("下のエッジも縦の接線を持つ曲線", lower === 'M200,96 C200,134.4 20,137.6 20,176', lower);
  const easing = Array.from({length:101},(_,i)=>ease(i/100));
  t.ok("加減速は端点を保ち逆行・オーバーシュートしない", easing[0] === 0 && easing[100] === 1 && easing.every((v,i)=>v>=0 && v<=1 && (!i||v>=easing[i-1])));

  // ---- head / tail を印を付ける発言の添字にまとめる。同じ発言に集まれば 1 つの .jx
  const nk = nodeKeys(new Map([[3, [{ id: "a" }]], ["head", [{ id: "b" }]], ["tail", [{ id: "c" }]], [0, [{ id: "d" }]]]), 6);
  t.ok("head は最初の発言、tail は最後の発言", nk.get(0)?.map((e) => e.id).join(",") === "b,d" && nk.get(5)?.[0]?.id === "c" && nk.get(3)?.[0]?.id === "a",
       JSON.stringify([...nk].map(([k, v]) => [k, v.map((e) => e.id)])));
  t.ok("発言が無ければ印も無い", nodeKeys(new Map([["head", [{ id: "b" }]]]), 0).size === 0);
  t.ok("範囲を超えた添字は最後の発言に", nodeKeys(new Map([[9, [{ id: "z" }]]]), 4).get(3)?.[0]?.id === "z");
  t.ok('空の分岐でも根の操作を表示', nodeKeys(new Map([[-1, [{ id: 'root' }]]]), 0).get(-1)?.[0]?.id === 'root');
  const rootLineage = { rootId: 'P', sessions: [
    { id: 'P', parent: null }, { id: 'R', parent: { sessionId: 'P', atMessage: null, beforeMessage: 'p0' } },
  ] };
  const rootBranch = createBranches({ cmd: fakeCmd(rootLineage, { P: parent, R: parent.map(copy) }) });
  await rootBranch.load('R', parent.map(copy));
  t.ok('同じ本文を再送しても根の分岐位置が動かない', rootBranch.boundary('P', 'R') === -1 && rootBranch.junctions('R').has(-1));

  const lineage = {
    rootId: "P",
    sessions: [
      { id: "P", title: "親", parent: null, createdAt: "2026-01-01T00:00:00Z", lastModified: 1 },
      { id: "C", title: "親 (fork)", parent: { sessionId: "P", atMessage: "p3" }, createdAt: "2026-01-02T00:00:00Z", lastModified: 2 },
    ],
  };
  const titles = { P: "親", C: "親 (fork)" };

  // 子を開いている
  const loads = [];
  let b = createBranches({ cmd: fakeCmd(lineage, { P: parent, C: child }, loads), onSwitch: () => {}, titleOf: (id) => titles[id] });
  let fam = await b.load("C", child);
  t.ok("家族の読み直しは outline で頼む（全文を運ばない）",
    loads.length > 0 && loads.every((a) => a.outline === true), JSON.stringify(loads));
  t.ok("atMessage から分岐点が決まる（親の添字 3）", fam?.rows.get("C")?.k === 3, String(fam?.rows.get("C")?.k));
  let j = b.junctions("C");
  t.ok("子から見て、分岐点の後に親の残り 2 件の印", j.get(3)?.[0]?.id === "P" && j.get(3)?.[0]?.n === 2 && j.get(3)?.[0]?.back === true,
       JSON.stringify([...j]));

  // 親を開いている
  b = createBranches({ cmd: fakeCmd(lineage, { P: parent, C: child }), onSwitch: () => {}, titleOf: (id) => titles[id] });
  await b.load("P", parent);
  j = b.junctions("P");
  t.ok("親から見て、分岐点の後に子の 2 件の印", j.get(3)?.[0]?.id === "C" && j.get(3)?.[0]?.n === 2, JSON.stringify([...j]));

  // atMessage が無い（AI が末尾から分けた・古い記録）→ 接頭辞から
  const noAt = { ...lineage, sessions: lineage.sessions.map((s) => s.id === "C" ? { ...s, parent: { sessionId: "P", atMessage: null } } : s) };
  b = createBranches({ cmd: fakeCmd(noAt, { P: parent, C: child }), onSwitch: () => {}, titleOf: (id) => titles[id] });
  fam = await b.load("C", child);
  t.ok("atMessage が無ければ接頭辞から（同じ 3）", fam?.rows.get("C")?.k === 3, String(fam?.rows.get("C")?.k));

  // 本文まで違って接頭辞が取れない → それでも戻る札は出る（祖先は頭、それ以外は末尾）
  const alien = [msg("user", "全く別", "z0"), msg("assistant", "別の返事", "z1")];
  b = createBranches({ cmd: fakeCmd(noAt, { P: parent, C: alien }), onSwitch: () => {}, titleOf: (id) => titles[id] });
  await b.load("C", alien);
  j = b.junctions("C");
  t.ok("接頭辞が 0 でも親へ戻る札が頭に出る", j.get("head")?.[0]?.id === "P" && j.get("head")?.[0]?.back === true, JSON.stringify([...j]));
  b = createBranches({ cmd: fakeCmd(noAt, { P: parent, C: alien }), onSwitch: () => {}, titleOf: (id) => titles[id] });
  await b.load("P", parent);
  j = b.junctions("P");
  t.ok("親から見た子は末尾に出る", j.get("tail")?.[0]?.id === "C" && j.get("tail")?.[0]?.n === 2, JSON.stringify([...j]));

  // 孫: 祖先はどれも「戻る」
  const three = {
    rootId: "P",
    sessions: [...lineage.sessions, { id: "G", title: "孫", parent: { sessionId: "C", atMessage: null }, createdAt: "2026-01-03T00:00:00Z", lastModified: 3 }],
  };
  const grand = [...child.map((m, i) => ({ ...m, uuid: `g${i}` })), msg("user", "孫の話", "g6")];
  b = createBranches({ cmd: fakeCmd(three, { P: parent, C: child, G: grand }), onSwitch: () => {}, titleOf: (id) => ({ ...titles, G: "孫" })[id] });
  await b.load("G", grand);
  j = b.junctions("G");
  const flat = [...j.values()].flat();
  t.ok("孫から見て親と祖父母は両方 back", flat.filter((e) => e.back).map((e) => e.id).sort().join(",") === "C,P", JSON.stringify([...j]));
  t.ok("孫から見た親（C）の印は分岐点 5 の後", j.get(5)?.some((e) => e.id === "C"), JSON.stringify([...j]));

  const siblings = { ...lineage, sessions: [...lineage.sessions, {id:'D',title:'もう一つ',parent:{sessionId:'P',atMessage:'p3'},lastModified:3}] };
  b = createBranches({cmd:fakeCmd(siblings,{P:parent,C:child,D:child.map((m,i)=>({...m,uuid:`d${i}`}))})});
  await b.load('C',child);
  t.ok('同じ続きを書いた兄弟 fork も同じ分岐点に並ぶ', b.junctions('C').get(3)?.some(e=>e.id==='D') && b.boundary('C','D') === 3);

  // A late lineage reply must not overwrite a more recent selection or reset.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const raced = createBranches({ cmd: async(command, args) => {
    if (command === 'lineage') { if (++requests === 1) await gate; return lineage; }
    return {messages: args.sessionId === 'P' ? parent : child};
  }});
  const stale = raced.load('P', parent);
  await raced.load('C', child);
  raced.reset();
  release(); await stale;
  t.ok("遅い系譜の応答でリセットを巻き戻さない", raced.family === null);

  let fail = true;
  const retry = createBranches({ cmd: async(command, args) => {
    if (command === 'lineage') return lineage;
    if (fail) throw Error('offline');
    return {messages: args.sessionId === 'P' ? parent : child};
  }});
  await retry.load('P', parent); fail = false;
  await retry.load('P', parent);
  t.ok("失敗した履歴取得を空の成功としてキャッシュしない", retry.family.rows.get('C').messages.length === child.length);

  // ---- 分岐点の札: 兄弟と名前がぶつかるときだけ、分岐後の最初の自分の発言と「枝 N」（docs/design-system.md §7）
  const same = { rootId: "P", sessions: [
    { id: "P", title: "同じ題", parent: null, createdAt: "2026-01-01T00:00:00Z", lastModified: 1 },
    { id: "C", title: "同じ題", parent: { sessionId: "P", atMessage: "p3" }, createdAt: "2026-01-02T00:00:00Z", lastModified: 2 },
    { id: "D", title: "同じ題", parent: { sessionId: "P", atMessage: "p3" }, createdAt: "2026-01-03T00:00:00Z", lastModified: 3 },
    { id: "E", title: "別の題", parent: { sessionId: "P", atMessage: "p3" }, createdAt: "2026-01-04T00:00:00Z", lastModified: 4 },
  ] };
  const said = (who, text) => [...parent.slice(0, 4).map((m, i) => ({ ...m, uuid: `${who}${i}` })), msg("user", text, `${who}u`), msg("assistant", "はい", `${who}a`)];
  const hist = { P: parent, C: said("c", "React のまま\n  直して"), D: said("d", "Vue で書き直して"), E: said("e", "テストから") };
  b = createBranches({ cmd: fakeCmd(same, hist), titleOf: (id) => same.sessions.find((s) => s.id === id)?.title });
  await b.load("C", hist.C);
  const cut = b.junctions("C").get(3) ?? [];
  const tips = b.distinguish([{ id: "C", name: b.nameOf("C"), n: 2 }, ...cut], { id: "C", messages: hist.C });
  const tip = (id) => tips.find((e) => e.id === id);
  t.ok("ぶつかる枝は分岐後の最初の自分の発言を 1 行に畳んで持つ",
    tip("C")?.excerpt === "React のまま 直して" && tip("D")?.excerpt === "Vue で書き直して", JSON.stringify(tips));
  t.ok("ぶつかる枝の番号は仮の名前（根はオリジナル、他は並び順の枝 N）",
    tip("C")?.label === i18n("timeline.branch.numbered", { n: 2 }) && tip("D")?.label === i18n("timeline.branch.numbered", { n: 3 })
      && tip("P")?.label === i18n("timeline.branch.root"), JSON.stringify(tips));
  t.ok("親の札も分岐後の自分の発言を持つ", tip("P")?.excerpt === "続けて", JSON.stringify(tip("P")));
  t.ok("名前がぶつからない枝はそのまま（抜粋も番号も足さない）", tip("E") && !("label" in tip("E")) && !("excerpt" in tip("E")), JSON.stringify(tip("E")));
  const fresh = b.distinguish([{ id: "C", name: "同じ題", n: 0 }, { id: "D", name: "同じ題", n: 0 }]);
  t.ok("分岐後に発言がまだ無ければ抜粋は無く、仮の名前だけ", fresh.every((e) => e.excerpt === null && e.label), JSON.stringify(fresh));
  const ja = JSON.parse(readFileSync(new URL("../../web/locales/ja/ui.json", import.meta.url), "utf8")).timeline.branch;
  t.ok("根の枝の既定名は「オリジナル」", ja.root === "オリジナル", ja.root);
}
