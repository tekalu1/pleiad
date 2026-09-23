// 「動いているもの」がどの画面に属するかの判定。
//
// 実機で二度間違えた箇所なので、規則を単体で固定しておく。
//  1度目: running の形が turn(単数) -> turns(配列) に変わったのに追従していなかった
//  2度目: id が未確定のターンを「新規セッション」の分として数えていたため、
//         新規へ移った先でも自分の分に見えた
//  3度目: ボタンの数はこのセッションの分なのに、押して開く一覧が全セッションのターン・承認待ち・
//         サブエージェントを並べていた
export const name = "work-attribution";
export const title = "動いているものの帰属";

// client.mjs の belongsHere と同じ規則
function belongsHere(state, x) {
  if (state.current) return x.sessionId === state.current;
  return state.submitting && !x.sessionId;
}
// client.mjs の subagentsHere と同じ規則。ボタンの数と一覧はこれで数える
const subagentsHere = (state, work) => (work.subagents ?? []).filter((x) => belongsHere(state, x));
const ids = (list) => list.map((x) => x.id).join(",");
const countFor = (state, work) =>
  [...(work.turns ?? []), ...(work.permissions ?? []), ...(work.subagents ?? [])]
    .filter((x) => belongsHere(state, x)).length;

export default function (t) {
  const A = "sess-A";
  const work = { turns: [{ sessionId: A }], permissions: [], subagents: [] };
  const unnamed = { turns: [{ sessionId: null }], permissions: [], subagents: [] };

  t.ok("開いているセッションのものは自分の分",
    countFor({ current: A, submitting: false }, work) === 1);

  t.ok("別のセッションのものは自分の分にしない",
    countFor({ current: "sess-B", submitting: false }, work) === 0);

  t.ok("新規セッションに移ったら、他所のものは数えない",
    countFor({ current: null, submitting: false }, work) === 0);

  t.ok("新規セッションに移ったら、id 未確定のものも数えない",
    countFor({ current: null, submitting: false }, unnamed) === 0,
    "ここを数えると『送っていないのに動いている』になる");

  t.ok("自分が送った直後は id 未確定でも自分の分",
    countFor({ current: null, submitting: true }, unnamed) === 1);

  t.ok("自分が送った直後でも、他所の id 付きは数えない",
    countFor({ current: null, submitting: true }, work) === 0);

  const mixed = {
    turns: [{ sessionId: A }, { sessionId: null }],
    permissions: [{ sessionId: A }],
    subagents: [{ sessionId: "sess-B" }],
  };
  t.ok("混在していても開いているセッションの分だけ数える",
    countFor({ current: A, submitting: false }, mixed) === 2);

  const dialog = {
    turns: [{ sessionId: A }, { sessionId: "sess-B" }],
    permissions: [{ id: "p1", sessionId: A }],
    subagents: [{ id: "a1", sessionId: A }, { id: "b1", sessionId: "sess-B" }, { id: "n1", sessionId: null }, { id: "a2", sessionId: A }],
  };
  t.ok("一覧はこのセッションのサブエージェントだけ。ターンと承認待ちは載せない",
    ids(subagentsHere({ current: A, submitting: false }, dialog)) === "a1,a2",
    ids(subagentsHere({ current: A, submitting: false }, dialog)));
  t.ok("自分が送った直後の一覧は id 未確定のサブエージェントだけ",
    ids(subagentsHere({ current: null, submitting: true }, dialog)) === "n1");
  t.ok("新規セッションに移ったら一覧は空",
    subagentsHere({ current: null, submitting: false }, dialog).length === 0);
}
