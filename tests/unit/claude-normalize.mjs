// SDK メッセージ -> 正規化イベントの変換（core/backends/claude-normalize.mjs）。
//
// ここが v1 で唯一かつ致命的だった境界の穴を塞いでいる部分。
// v1 は `{type:"sdk", message}` で生の SDK メッセージを web まで素通ししていたので、
// web/client.mjs が Anthropic の API ストリーム型を直接パースしていた。
//
// フィクスチャは実際に流れてくる形をそのまま写している
// （temporary/inv-agent-host.md §1.3 が実データから起こした表が元）。
// ※ core/backends/claude-normalize.mjs を変えたら、ここも合わせて変えること。
import { normalizeSdkMessage, transcriptToMessages, mergeQueuedCommands, subagentEntries } from "../../core/backends/claude-normalize.mjs";

export const name = "claude-normalize";
export const title = "SDK メッセージが正規化イベントになる";

const one = (m) => normalizeSdkMessage(m);
const types = (m) => one(m).map((e) => e.type).join(",");

export default function (t) {
  // ---- 部分メッセージ
  t.ok("thinking の開始が thinking.start + activity になる",
    types({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } })
      === "thinking.start,activity");

  const think = one({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "", estimated_tokens: 42 } } });
  t.ok("平文の無い thinking_delta は estimatedTokens だけになる",
    think.length === 1 && think[0].type === "thinking.delta"
      && think[0].estimatedTokens === 42 && think[0].text === undefined,
    "このモデルの thinking は署名だけで平文が入らない");

  const thinkText = one({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "うーん" } } });
  t.ok("平文が来たときは text が乗る", thinkText[0].text === "うーん");

  const text = one({ type: "stream_event", event: { delta: { type: "text_delta", text: "こん" } } });
  t.ok("text_delta が text.delta になる",
    text.length === 1 && text[0].type === "text.delta" && text[0].text === "こん");

  t.ok("知らない delta は何も出さない",
    one({ type: "stream_event", event: { delta: { type: "input_json_delta", partial_json: "{" } } }).length === 0,
    "ツール入力の部分 JSON は表示に使わない");

  // ---- 確定メッセージ
  const assistant = one({
    type: "assistant",
    message: { content: [
      { type: "text", text: "やります" },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ] },
  });
  t.ok("assistant は text.end のあとに tool.start が並ぶ",
    assistant.map((e) => e.type).join(",") === "text.end,tool.start");
  t.ok("tool.start が id / name / input を運ぶ",
    assistant[1].id === "tu_1" && assistant[1].name === "Bash" && assistant[1].input.command === "ls");

  t.ok("input が無いツールでも input は object になる",
    one({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Foo" }] } })[1].input
      && typeof one({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Foo" }] } })[1].input === "object",
    "render 側が Object.keys を呼ぶので null を渡せない");

  // ---- サブエージェント側（parent_tool_use_id 付き）は本流に出さない
  const childLive = [
    { type: "assistant", parent_tool_use_id: "tu_agent", uuid: "s1", message: { content: [{ type: "tool_use", id: "tu_s", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", parent_tool_use_id: "tu_agent", message: { content: [{ type: "tool_result", tool_use_id: "tu_s", content: "a" }] } },
    { type: "stream_event", parent_tool_use_id: "tu_agent", event: { delta: { type: "text_delta", text: "子" } } },
  ];
  t.ok("サブエージェント側のメッセージは何も出さない",
    childLive.every((m) => one(m).length === 0),
    "履歴（transcriptToMessages）も落としている。ライブと読み直しで会話が変わらないように揃える");
  t.ok("本流の Agent の戻り（parent_tool_use_id: null）は tool.result になる",
    types({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu_agent", content: "done" }] } }) === "tool.result");

  const res = one({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a\nb", is_error: false }] },
  });
  t.ok("tool_result が tool.result になる",
    res.length === 1 && res[0].type === "tool.result" && res[0].id === "tu_1" && res[0].text === "a\nb");
  t.ok("ライブのツール結果は切らない", res[0].truncated === false,
       "v1 は生の SDK メッセージを素通ししていたので、同じ見た目を保つ");

  t.ok("tool_result の content が配列でも文字列に均される",
    one({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] },
    ] } })[0].text === "x\ny");

  t.ok("エラーの tool_result は isError が立つ",
    one({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t", content: "boom", is_error: true },
    ] } })[0].isError === true);

  t.ok("ただの発言（tool_result を含まない user）は何も出さない",
    one({ type: "user", message: { content: [{ type: "text", text: "やって" }] } }).length === 0);

  // ---- 稼働状態
  const act = (m) => one(m)[0];
  t.ok("compacting が activity になる",
    act({ type: "system", subtype: "status", status: "compacting" }).state === "compacting");
  t.ok("requesting は考えている扱い",
    act({ type: "system", subtype: "status", status: "requesting" }).state === "thinking");
  t.ok("requires_action は waiting",
    act({ type: "system", subtype: "session_state_changed", state: "requires_action" }).state === "waiting");
  t.ok("running は running",
    act({ type: "system", subtype: "session_state_changed", state: "running" }).state === "running");
  t.ok("init メッセージ自体は何も出さない（model は session イベントで運ぶ）",
    one({ type: "system", subtype: "init", model: "claude-haiku-4-5" }).length === 0);

  // ---- 終了
  const ok = one({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.0125 }).find(e => e.type === 'turnResult');
  t.ok("result/success が turnResult ok になる",
    ok.type === "turnResult" && ok.outcome === "ok" && ok.turns === 3 && ok.costUsd === 0.0125);

  const bad = act({ type: "result", subtype: "error_max_turns", num_turns: 9 });
  t.ok("result のエラーは outcome=error と理由になる",
    bad.outcome === "error" && bad.error === "error_max_turns");

  t.ok("知らないメッセージは黙って落とす", one({ type: "なにか" }).length === 0 && one(null).length === 0);

  // ---- 履歴（transcript -> NormalizedMessage）
  const msgs = transcriptToMessages([
    { type: "user", uuid: "u1", timestamp: "2026-09-11T00:00:00Z", message: { content: "作って" } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "thinking", thinking: "考え" }] } },
    { type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } },
    { type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] } },
    { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "user", uuid: "u3", isMeta: true, message: { content: "注入されたメモ" } },
    { type: "assistant", uuid: "n1", parent_tool_use_id: "t2", message: { content: [{ type: "text", text: "子" }] } },
  ]);

  t.ok("CLI 由来の文字列 content が発言になる", msgs[0]?.role === "user" && msgs[0]?.text === "作って");
  t.ok("thinking は本文と分けて持つ", msgs[1]?.thinking === "考え");
  t.ok("連続する tool_use は1件にまとまる",
    msgs[2]?.toolCalls?.length === 2, `${msgs[2]?.toolCalls?.length} 件`);
  t.ok("tool_result は対応する呼び出しへ畳み込まれる", msgs[2]?.toolCalls?.[0]?.result?.text === "ok");
  t.ok("結果の来ていない呼び出しは result が null", msgs[2]?.toolCalls?.[1]?.result === null);
  t.ok("isMeta は出さない", !msgs.some((m) => m.text === "注入されたメモ"));
  t.ok("サブエージェントのメッセージは本流に出さない", !msgs.some((m) => m.text === "子"));
  t.ok("tools（旧形）も並ぶ", msgs[2]?.tools?.join(",") === "Write,Bash");

  const nested = transcriptToMessages(
    [{ type: "assistant", uuid: "n1", parent_tool_use_id: "t2", message: { content: [{ type: "text", text: "子" }] } }],
    { includeNested: true },
  );
  t.ok("サブエージェントを読むときだけ拾う", nested.length === 1 && nested[0].text === "子");

  // 裏の subagent が終わると、CLI は main を再開させるために完了通知を user として積む（2026-09 実測）。
  // getSessionMessages は origin（task-notification）を落とすので、中身で見分けて発言にしない
  const notice = transcriptToMessages([
    { type: "user", uuid: "u1", message: { content: "調べて" } },
    { type: "user", uuid: "n1", message: { content: "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>" } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "終わった" }] } },
  ]);
  t.ok("裏の完了通知は人の発言として出さない", notice.map((m) => m.role).join(",") === "user,assistant" && notice[0].text === "調べて",
    JSON.stringify(notice.map((m) => m.text)));

  const long = "x".repeat(3000);
  const cut = transcriptToMessages([
    { type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    { type: "user", uuid: "u", message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] } },
  ]);
  t.ok("履歴のツール結果は保存の時点で切る",
    cut[0].toolCalls[0].result.truncated === true && cut[0].toolCalls[0].result.text.length < 2100,
    "表示に要るのは行数・件数・成否と先頭だけ");
  const full = transcriptToMessages([
    { type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    { type: "user", uuid: "u", message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] } },
  ], { fullResults: true });
  t.ok("引き継ぎ用の結果は全文を保つ", full[0].toolCalls[0].result.text === long && !full[0].toolCalls[0].result.truncated);

  // ---- 途中送信（queued_command）の差し戻し
  // 並びは実物の transcript（2026-09 実測）から写した。折り込まれた発言は
  // user 行としては残らず、tool_result の user 行の子孫に attachment として積まれる
  const entries = [
    { type: "user", uuid: "u1", message: { role: "user", content: "note.txt に書いて" } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } },
    { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "DONE" }] } },
  ];
  const rows = [
    { type: "attachment", uuid: "x1", parentUuid: "u2", attachment: { type: "prompt_snapshot" } },
    { type: "attachment", uuid: "x2", parentUuid: "x1", attachment: { type: "deferred_tools_record" } },
    { type: "attachment", uuid: "q1", parentUuid: "x2", timestamp: "2026-09-17T00:00:00.000Z",
      attachment: { type: "queued_command", prompt: "ちなみに 1+1 は？", commandMode: "prompt" } },
    { type: "attachment", uuid: "x3", parentUuid: "q1", attachment: { type: "total_tokens_reminder" } },
  ];
  const merged = mergeQueuedCommands(entries, rows);
  t.ok("折り込まれた発言が、区切りになった行の直後に戻る",
    merged.map((e) => e.uuid).join(",") === "u1,a1,u2,q1,a2", merged.map((e) => e.uuid).join(","));
  t.ok("戻した行は普通の user 発言として読める",
    transcriptToMessages(merged).map((m) => `${m.role}:${m.text}`).join("|")
      === "user:note.txt に書いて|assistant:|user:ちなみに 1+1 は？|assistant:DONE",
    JSON.stringify(transcriptToMessages(merged).map((m) => [m.role, m.text])));

  t.ok("スラッシュコマンドの待ち行列は発言にしない",
    mergeQueuedCommands(entries, [{ type: "attachment", uuid: "q2", parentUuid: "u2",
      attachment: { type: "queued_command", prompt: "/compact", commandMode: "slash" } }]).length === entries.length);
  t.ok("祖先まで辿り着けない行は落とす（見当違いの場所へ差さない）",
    mergeQueuedCommands(entries, [{ type: "attachment", uuid: "q3", parentUuid: "どこでもない",
      attachment: { type: "queued_command", prompt: "迷子", commandMode: "prompt" } }]).length === entries.length);
  t.ok("差し込みが無ければ元の配列をそのまま返す", mergeQueuedCommands(entries, []) === entries);

  // ---- サブエージェントの transcript。CLI は鎖の間に attachment 行を挟む（2026-09-18 の実データの形）
  const row = (type, uuid, parentUuid, content) => JSON.stringify({ type, uuid, parentUuid, isSidechain: true,
    sessionId: "s1", timestamp: `2026-09-18T00:00:0${uuid.slice(1)}Z`,
    ...(type === "attachment" ? { attachment: { type: content } } : { message: { role: type, content } }) });
  const transcript = [
    row("user", "r1", null, "調べて"),
    row("attachment", "r2", "r1", "hook_success"),
    row("assistant", "r3", "r2", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }]),
    row("attachment", "r4", "r3", "hook_success"),
    row("attachment", "r5", "r4", "total_tokens_reminder"),
    row("user", "r6", "r5", [{ type: "tool_result", tool_use_id: "tu1", content: "a.txt" }]),
    row("assistant", "r7", "r6", [{ type: "text", text: "a.txt がありました" }]),
    '{"type":"assistant","uuid":"r8","parentUuid":"r7","mess',   // 書きかけの最後の行
  ].join("\n");
  const sub = subagentEntries(transcript, { toolUseId: "toolu_parent" });
  t.ok("attachment を挟んだ鎖を最後まで遡り、user / assistant だけを順に返す",
    sub.map((e) => e.uuid).join(",") === "r1,r3,r6,r7", JSON.stringify(sub.map((e) => e.uuid)));
  t.ok("生んだ委譲ツールの id を各エントリに載せる", sub.every((e) => e.parent_tool_use_id === "toolu_parent" && e.session_id === "s1"));
  const shown = transcriptToMessages(sub, { includeNested: true });
  t.ok("ツールの入力と結果が会話として読める",
    shown.length === 3 && shown[1].toolCalls[0].input.command === "ls" && shown[1].toolCalls[0].result?.text === "a.txt" && shown[2].text === "a.txt がありました",
    JSON.stringify(shown));
  t.ok("上限を超えたら依頼文と末尾を残す",
    subagentEntries(transcript, { limit: 2 }).map((e) => e.uuid).join(",") === "r1,r7");
  t.ok("空の transcript は空", subagentEntries("").length === 0 && subagentEntries(null).length === 0);
}
