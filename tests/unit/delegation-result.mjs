// 委譲の結果にする子の返答（core/agent-tasks.mjs の finalReply）と、その材料になる Claude の印
// （core/backends/claude-normalize.mjs の stopHookFollowUps → transcriptToMessages の stopHookFollowUp）。
// 2026-09-27、委譲の子が報告を書いた後に Stop フック（ナレッジの棚卸しを促す exit 2 の型）で続けさせられ、
// ToolSearch と load_skill を呼んで「ナレッジ化対象なし」と書いて終わり、その一言が依頼元への結果になった。
// その transcript の末尾と同じ行の形（CLI 2.1.282）を組み立てて流す。LLM も CLI も呼ばない
import { stopHookFollowUps, transcriptToMessages } from "../../core/backends/claude-normalize.mjs";
import { finalReply } from "../../core/agent-tasks.mjs";

export const name = "delegation-result";
export const title = "委譲の結果: Stop フックの続きの一言ではなく、子の報告を選ぶ（Claude の印と選び方）";

const SESSION = "1dfa95ec-0000-4000-8000-000000000000";
let seq = 0;
const id = () => `row-${++seq}`;
// transcript の 1 行。isMeta / system / attachment は getSessionMessages に出ない
const user = (content, extra = {}) => ({ type: "user", uuid: id(), message: { role: "user", content }, ...extra });
const assistant = (content) => ({ type: "assistant", uuid: id(), message: { role: "assistant", model: "claude-opus-5-5", content } });
const say = (text) => assistant([{ type: "text", text }]);
const call = (name, toolId = id()) => [assistant([{ type: "tool_use", id: toolId, name, input: {} }]), user([{ type: "tool_result", tool_use_id: toolId, content: "ok" }])];
const HOOK = "[node \"C:\\\\Users\\\\u\\\\.claude\\\\hooks\\\\knowledge-capture.mjs\"]: 【ナレッジ棚卸し / セッション1回のみ】\n残すべきものが無ければ「ナレッジ化対象なし」と1行だけ述べて終了して構いません。\n";
// Stop フックが止めた: フックの出力を運ぶ isMeta の user と、hookErrors の入った stop_hook_summary
const blocked = () => [
  user(`Stop hook feedback:\n${HOOK}`, { isMeta: true }),
  { type: "system", subtype: "stop_hook_summary", uuid: id(), hookCount: 3, hookErrors: [HOOK], hookAdditionalContext: [], preventedContinuation: false, stopReason: "", hasOutput: true, level: "suggestion" },
];
const passed = () => ({ type: "system", subtype: "stop_hook_summary", uuid: id(), hookCount: 3, hookErrors: [], hookAdditionalContext: [], preventedContinuation: false, stopReason: "", hasOutput: true, level: "suggestion" });
const thinking = () => assistant([{ type: "thinking", thinking: "" }]);

/** transcript の行から、Pleiad が getMessages で作る会話を作る（SDK の getSessionMessages が落とす行は落とす） */
function history(rows) {
  const text = rows.map((r) => JSON.stringify({ parentUuid: null, isSidechain: false, sessionId: SESSION, ...r })).join("\n") + "\n";
  const followUps = stopHookFollowUps(text);
  const entries = rows.filter((r) => (r.type === "user" && !r.isMeta) || r.type === "assistant")
    .map((r) => ({ type: r.type, uuid: r.uuid, session_id: SESSION, message: r.message, parent_tool_use_id: null }));
  return { followUps, messages: transcriptToMessages(entries, { followUps }) };
}

const REPORT = "Report: D:/dev/pleiad/temporary/reports/compact-design-check.md\n\n- 6 件を既存の部品に合わせて直した";

export default function (t) {
  // ---- 1. 2026-09-27 の並び: 報告 → Stop フックが止める → ToolSearch・load_skill → 「ナレッジ化対象なし」
  {
    const rows = [
      user("圧縮 UI のデザインを確かめて直してほしい"),
      ...call("Bash"), ...call("Write"),
      say(REPORT),
      ...blocked(),
      thinking(), ...call("ToolSearch"), ...call("mcp__ply_context__load_skill"),
      thinking(), say("ナレッジ化対象なし"),
      passed(),
    ];
    const { followUps, messages } = history(rows);
    const last = messages.at(-1);
    t.ok("Stop フックの続きの assistant 行に印が付く（調べものだけの続き）", followUps.size === 5 && last.text === "ナレッジ化対象なし" && last.stopHookFollowUp === true,
      JSON.stringify({ size: followUps.size, last }));
    t.ok("報告には印が付かない", messages.find((m) => m.text === REPORT)?.stopHookFollowUp === undefined);
    t.ok("続きのツール呼び出しにも印が付く", messages.find((m) => m.tools?.includes("ToolSearch"))?.stopHookFollowUp === true);
    t.ok("委譲の結果は報告（「ナレッジ化対象なし」ではない）", finalReply(messages) === REPORT, JSON.stringify(finalReply(messages)));

    // 同じ会話の次の回（ply_task_send）: 新しい依頼の後の返答には印が付かず、そのまま結果になる
    const next = history([...rows, user("続きもお願い"), ...call("Edit"), say("続きの報告")]);
    t.ok("次の人の発言で続きは切れる（次の回の返答には印が付かない）", next.messages.at(-1).stopHookFollowUp === undefined && finalReply(next.messages) === "続きの報告");
  }

  // ---- 2. 続きで中身の仕事をした（ファイルを直して報告し直した）なら、続きの返答を選ぶ
  {
    const { followUps, messages } = history([
      user("直して"), ...call("Edit"), say("直した"),
      ...blocked(),
      ...call("Read"), ...call("Edit"), say("フックの指摘どおり直して報告し直した"),
      passed(),
    ]);
    t.ok("続きで Edit を呼んだら印を付けない", followUps.size === 0, String(followUps.size));
    t.ok("結果は続きの返答", finalReply(messages) === "フックの指摘どおり直して報告し直した");
  }
  {
    const { followUps } = history([user("x"), say("済んだ"), ...blocked(), ...call("Bash"), say("コミットした"), passed()]);
    t.ok("Bash は変更したか見分けられないので中身の仕事に数える", followUps.size === 0);
  }

  // ---- 3. 区切り
  {
    const { messages } = history([
      user("x"), say("先に済ませた分"), ...blocked(), ...call("ToolSearch"), say("フックの一言"),
      // 裏の作業の完了通知で main が再開した分は、フックの続きではない
      user("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"),
      say("テストが通ったので報告する"),
    ]);
    t.ok("裏の作業の完了通知で再開した返答には印を付けない（task-notification で続きが切れる）",
      messages.at(-1).stopHookFollowUp === undefined && messages.find((m) => m.text === "フックの一言")?.stopHookFollowUp === true
      && finalReply(messages) === "テストが通ったので報告する", JSON.stringify(messages.map((m) => [m.text, m.stopHookFollowUp])));
  }
  {
    const { followUps } = history([user("x"), say("済んだ"), { ...blocked()[1], preventedContinuation: true }, say("書かれないはずの続き")]);
    t.ok("続きを止めた（preventedContinuation）フックは区切りにしない", followUps.size === 0);
  }
  {
    const { followUps } = history([user("x"), say("済んだ"), passed(), user("次"), say("返答")]);
    t.ok("止めなかったフック（hookErrors が空）は区切りにしない", followUps.size === 0);
  }
  {
    const { messages } = history([user("x"), ...blocked(), ...call("ToolSearch"), say("フックの一言だけ")]);
    t.ok("この回に印の無い返答が無ければ、今までどおり最後の返答", finalReply(messages) === "フックの一言だけ");
  }
  t.ok("フックの行が無い transcript では何も印を付けない", stopHookFollowUps('{"type":"user"}\n{"type":"assistant"}').size === 0 && stopHookFollowUps(null).size === 0);
  t.ok("finalReply: 印の無い会話は最後の返答（今までと同じ）",
    finalReply([{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "assistant", text: "" }, { role: "assistant", text: "c" }]) === "c"
    && finalReply([]) === "" && finalReply(null) === "");
}
