// 履歴のシステム側のメッセージの見分けと置き換え（core/system-messages.mjs・claude-normalize.mjs の transcriptSystemMarks・
// compaction-history.mjs の attachCompactSummaries・web/system-messages.mjs）。ADR 0053。
// 材料は temporary/reports/system-messages-as-user.md の伏せ字の例から作った。実データは入れていない。
import { classifySystemMessages, stripInjectedContext, parseTeammate, splitInterruptionNotes } from "../../core/system-messages.mjs";
import { interruptionNote } from "../../core/interrupt-stops.mjs";
import { transcriptSystemMarks, transcriptToMessages } from "../../core/backends/claude-normalize.mjs";
import { attachCompactSummaries } from "../../core/compaction-history.mjs";
import { commandParts, teammateNode } from "../../web/system-messages.mjs";
import fs from "node:fs/promises";

export const name = "system-messages";
export const title = "システム側のメッセージを見分けて、発言の吹き出しにしない";

const u = (uuid, text, at = "2026-09-28T06:43:00.000Z") => ({ role: "user", text, uuid, at });
const a = (uuid, text) => ({ role: "assistant", text, uuid, at: "2026-09-28T06:44:00.000Z" });
const SUMMARY = "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nAnalysis:\n…";

export default async function (t) {
  // ---- スラッシュコマンド（文面）
  {
    const out = classifySystemMessages([
      u("c1", "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
      u("o1", "<local-command-stdout>Set model to \u001b[1mopus (claude-opus-5-5)\u001b[22m</local-command-stdout>"),
      u("c2", "<command-message>daily-report</command-message>\n<command-name>/daily-report</command-name>\n<command-args>今日の分</command-args>"),
      a("a1", "今日の日報の下書きを作ります。"),
    ]);
    t.ok("コマンドの行は kind: command の 1 件になり、出力はその下にまとまる（色の指定は外す）",
      out.length === 3 && out[0].kind === "command" && out[0].command === "/model opus" && out[0].output === "Set model to opus (claude-opus-5-5)");
    t.ok("分岐点は出力の行の uuid", out[0].uuid === "o1");
    t.ok("Skill のコマンドは名前と引数（出力なし）", out[1].kind === "command" && out[1].command === "/daily-report 今日の分" && out[1].output === null);
  }
  // ---- 手動の圧縮（Pleiad の /compact）の行と出力は出さない。要約は compactSummary
  {
    const out = classifySystemMessages([
      a("a0", "残りの失敗は 2 件です。"),
      u("s1", SUMMARY),
      u("c1", "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"),
      u("o1", "<local-command-stdout>Compacted PreCompact [callback] completed successfully\nPostCompact [callback] completed successfully</local-command-stdout>"),
      u("h1", "続けて、残りの 2 件も直して"),
    ]);
    t.ok("/compact の行とその出力は落ち、要約は compactSummary（role: system、本文は summary）になる",
      out.map((m) => m.kind ?? m.role).join(",") === "assistant,compactSummary,user" && out[1].summary.startsWith("This session is being continued") && out[1].text === "" && out[1].role === "system");
    const orphan = classifySystemMessages([u("o2", "<local-command-stdout>Compacted PreCompact [callback] completed successfully</local-command-stdout>")]);
    t.ok("親の分からない \"Compacted …\" の出力も落とす（文面）", orphan.length === 0);
  }
  // ---- 印（transcript）がある: 要約は印だけで見る。出力は親の uuid で結ぶ
  {
    const marks = { summaries: new Map([["s1", "b1"]]), outputs: new Map([["o1", "c1"], ["o9", "other"]]) };
    const out = classifySystemMessages([
      u("s1", SUMMARY),
      u("p1", SUMMARY),
      u("c1", "<command-name>/model</command-name><command-args>opus</command-args>"),
      u("o1", "<local-command-stdout>Set model to opus</local-command-stdout>"),
      u("c2", "<command-name>/cost</command-name>"),
      u("o9", "<local-command-stdout>unrelated</local-command-stdout>"),
    ], marks);
    t.ok("印がある要約は区切りの uuid を持つ", out[0].kind === "compactSummary" && out[0].boundary === "b1");
    t.ok("印の無い、要約と同じ文面の発言（人が貼ったもの）は人の発言のまま", !out[1].kind && out[1].text === SUMMARY);
    t.ok("印の親が合う出力はコマンドにまとまる", out[2].output === "Set model to opus" && out[2].uuid === "o1");
    t.ok("印の親が違う出力はまとめない（親の分からない出力として出す）", out[3].kind === "command" && out[3].output === null && out[4].kind === "command" && out[4].command === "" && out[4].output === "unrelated");
  }
  // ---- ! モード
  {
    const out = classifySystemMessages([
      u("i1", "<bash-input> git status</bash-input>"),
      u("r1", "<bash-stdout>On branch main\nYour branch is up to date.\n</bash-stdout><bash-stderr></bash-stderr>"),
      u("i2", "<bash-input>git switch feature/x</bash-input>"),
      u("r2", "<bash-stdout></bash-stdout><bash-stderr>Switched to branch 'feature/x'\r\n</bash-stderr>"),
      u("i3", "<bash-input>mkdir -p out</bash-input>"),
      u("r3", "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>"),
    ]);
    t.ok("入力と出力が kind: shell の 1 件になる（頭の空白は落とす・分岐点は出力の行）",
      out.length === 3 && out[0].kind === "shell" && out[0].command === "git status" && out[0].text === "! git status" && out[0].uuid === "r1");
    t.ok("stdout と stderr は分けて持つ（stderr は失敗扱いにしない・\\r\\n は \\n）",
      out[0].stdout === "On branch main\nYour branch is up to date." && out[0].stderr === null && out[1].stdout === null && out[1].stderr === "Switched to branch 'feature/x'");
    t.ok("両方空なら両方 null", out[2].stdout === null && out[2].stderr === null && !("exitCode" in out[2]));
  }
  // ---- Pleiad の `!`: Claude の SDK が shouldQuery: false の行を `\n` でつないで 1 行に残した形（本物で確認 2026-09-28）
  {
    const out = classifySystemMessages([
      u("j1", "<bash-input>ls no-such-dir</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>ls: cannot access 'no-such-dir'\n</bash-stderr>\n<bash-input>echo second-run</bash-input>\n<bash-stdout>second-run\n</bash-stdout><bash-stderr></bash-stderr>"),
      u("h", "直前の 2 つは？"),
      u("j2", "<bash-input>echo one</bash-input>\n<bash-stdout>one\n</bash-stdout><bash-stderr></bash-stderr>"),
      u("r9", "<bash-stdout>stray</bash-stdout><bash-stderr></bash-stderr>"),
    ]);
    t.ok("つながった行は、入力と出力の組ごとに kind: shell の行になる",
      out.length === 5 && out[0].kind === "shell" && out[0].command === "ls no-such-dir" && out[0].stdout === null && out[0].stderr === "ls: cannot access 'no-such-dir'"
      && out[1].kind === "shell" && out[1].command === "echo second-run" && out[1].stdout === "second-run" && out[1].stderr === null, JSON.stringify(out));
    t.ok("uuid（分岐点）は最後の組だけが持つ", !("uuid" in out[0]) && out[1].uuid === "j1");
    t.ok("人の発言は混ざらない", !out[2].kind && out[2].text === "直前の 2 つは？");
    t.ok("出力を持った行の後の出力の行は、その行にまとめない", out[3].stdout === "one" && out[3].uuid === "j2" && out[4].kind === "shell" && out[4].command === "" && out[4].stdout === "stray");
  }
  // ---- 中断
  {
    const out = classifySystemMessages([u("h", "テストを全部流して"), a("a", "実行します。"), u("x1", "[Request interrupted by user]"), u("x2", "[Request interrupted by user for tool use]")]);
    t.ok("中断の固定の文字列は kind: interrupt（role: system）に置き換わる", out[2].kind === "interrupt" && out[2].role === "system" && out[3].kind === "interrupt" && out[2].at);
    t.ok("文中に含むだけの発言は人の発言のまま", !classifySystemMessages([u("h", "[Request interrupted by user] と出た")])[0].kind);
  }
  // ---- teammate
  {
    const idle = 'Another Claude session sent a message: <teammate-message teammate_id="core-B" color="green">\n{"type":"idle_notification","from":"core-B","timestamp":"2026-09-2xT16:05:11Z"}\n</teammate-message>';
    const said = 'Another Claude session sent a message: <teammate-message teammate_id="core-B" color="green" summary="API の修正が終わった">\nAPI の型の修正が終わりました。\n</teammate-message>';
    const out = classifySystemMessages([u("t1", idle), u("t2", said)]);
    t.ok("待機だけの知らせは落とす", out.length === 1);
    t.ok("知らせは kind: teammate で、送り手と本文（タグと書き出しを外したもの）を持つ", out[0].kind === "teammate" && out[0].from === "core-B" && out[0].body === "API の型の修正が終わりました。");
    t.ok("teammate の形でない発言は undefined", parseTeammate("Another Claude session sent a message: hello") === undefined);
  }
  // ---- 文脈のタグ
  {
    t.ok("先頭の <ide_opened_file> を外す（保存分。つないだ後の本文）",
      stripInjectedContext("<ide_opened_file>The user opened the file d:\\dev\\<project>\\src\\<file>.ts in the IDE.</ide_opened_file>前者で行きましょう") === "前者で行きましょう");
    t.ok("先頭の <in-app-browser-context> を外す（Codex Desktop。同じ text の先頭）",
      stripInjectedContext('<in-app-browser-context source="ambient-ui-state">\nURL: http://localhost:5173/<page>\nTitle: <app>\n</in-app-browser-context>\nこのボタンの色を直して') === "このボタンの色を直して");
    t.ok("文中のタグは外さない", stripInjectedContext("例: <ide_opened_file>x</ide_opened_file>") === "例: <ide_opened_file>x</ide_opened_file>");
    const out = classifySystemMessages([u("h", "<ide_opened_file>x</ide_opened_file>"), u("h2", "<ide_selection>y</ide_selection>本文")]);
    t.ok("文脈だけの発言は落とし、残りは人の発言のまま", out.length === 1 && out[0].text === "本文" && !out[0].kind);
    const claude = transcriptToMessages([{ type: "user", uuid: "v1", timestamp: "2026-09-28T08:40:00Z",
      message: { role: "user", content: [{ type: "text", text: "<ide_opened_file>The user opened the file d:\\dev\\x.ts in the IDE.</ide_opened_file>" }, { type: "text", text: "前者で行きましょう" }] } }]);
    t.ok("Claude の transcript では <ide_opened_file> の text ブロックごと外す", claude.length === 1 && claude[0].text === "前者で行きましょう");
  }
  // ---- 保存分（切り替え済みの会話）: uuid に接頭辞、完了通知・kind 付きはそのまま、何度かけても同じ
  {
    const saved = [
      { ...u("claude:n1:c1", "<command-name>/model</command-name><command-args>opus</command-args>"), backend: "claude" },
      { ...u("claude:n1:o1", "<local-command-stdout>Set model to opus</local-command-stdout>"), backend: "claude" },
      { ...u("claude:n1:t1", "<task-notification> <task-id>x</task-id></task-notification>"), backend: "claude" },
      { ...u("claude:n1:s1", SUMMARY), backend: "claude" },
      { ...u("claude:n1:p1", "[Pleiad タスク完了通知 / ply-task-<id>]"), backend: "claude" },
      { ...u("claude:n1:x1", "[Request interrupted by user]"), backend: "claude" },
      { role: "user", kind: "command", text: "/cost", command: "/cost", output: null, uuid: "k1" },
    ];
    const once = classifySystemMessages(saved);
    const twice = classifySystemMessages(once);
    t.ok("保存分も文面で見分ける（コマンド・裏の通知を落とす・要約・中断）",
      once.map((m) => m.kind ?? "human").join(",") === "command,compactSummary,human,interrupt,command" && once[0].backend === "claude" && once[3].backend === "claude");
    t.ok("何度かけても同じ", JSON.stringify(once) === JSON.stringify(twice));
    t.ok("Pleiad の完了通知（ハッシュで見分ける）は触らない", once[2].text === "[Pleiad タスク完了通知 / ply-task-<id>]");
  }
  // ---- transcript の印
  {
    const rows = [
      { type: "attachment", uuid: "h0", parentUuid: "p0", attachment: { type: "hook_success" } },
      { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "h0", timestamp: "2026-09-28T06:43:00.000Z",
        compactMetadata: { trigger: "manual", preTokens: 182000, postTokens: 21000 } },
      { type: "user", uuid: "s1", parentUuid: "b1", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: SUMMARY }, timestamp: "2026-09-28T06:43:01.000Z" },
      { type: "user", uuid: "cv", parentUuid: "h0", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: …</local-command-caveat>" } },
      { type: "user", uuid: "c1", parentUuid: "cv", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" } },
      { type: "user", uuid: "o1", parentUuid: "c1", message: { role: "user", content: "<local-command-stdout>Compacted …</local-command-stdout>" } },
      { type: "system", subtype: "compact_boundary", uuid: "b2", parentUuid: null, timestamp: "2026-09-28T10:13:00.000Z", compactMetadata: { trigger: "auto", preTokens: 996780 } },
      { type: "attachment", uuid: "d2", parentUuid: "b2", attachment: { type: "date_change" } },
      { type: "user", uuid: "s2", parentUuid: "d2", isCompactSummary: true, message: { role: "user", content: [{ type: "text", text: SUMMARY }] } },
      { type: "user", uuid: "i1", parentUuid: "x", message: { role: "user", content: "<bash-input>git status</bash-input>" } },
      { type: "user", uuid: "r1", parentUuid: "i1", message: { role: "user", content: "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>" } },
      { type: "user", uuid: "r9", parentUuid: "zz", message: { role: "user", content: "<bash-stdout>stray</bash-stdout>" } },
      { type: "assistant", uuid: "q1", parentUuid: "r1", message: { role: "assistant", content: [{ type: "text", text: 'transcript の "compact_boundary" と <command-name> の話' }] } },
    ];
    const marks = transcriptSystemMarks(rows.map((r) => JSON.stringify(r)).join("\n") + "\n{壊れた行");
    t.ok("区切りを transcript の compact_boundary から読む（uuid・trigger・前後のトークン数）",
      marks.compactions.length === 2 && marks.compactions[0].nativeId === "b1" && marks.compactions[0].trigger === "manual"
      && marks.compactions[0].beforeTokens === 182000 && marks.compactions[0].afterTokens === 21000 && marks.compactions[1].trigger === "auto" && !("afterTokens" in marks.compactions[1]));
    t.ok("要約は親が区切りでも、attachment を挟んだ区切りでも、区切りに付く", marks.summaries.get("s1") === "b1" && marks.summaries.get("s2") === "b2"
      && marks.compactions[0].summary === SUMMARY && marks.compactions[1].summary === SUMMARY);
    t.ok("出力の行は親がコマンド・シェルの行のものだけ", marks.outputs.get("o1") === "c1" && marks.outputs.get("r1") === "i1" && !marks.outputs.has("r9"));
    t.ok("印になる文字列が無ければ何も parse しない（空）", transcriptSystemMarks('{"type":"user","uuid":"x"}').compactions.length === 0);
  }
  // ---- 区切りへの要約の付け方
  {
    const at = Date.parse("2026-09-28T06:43:00.000Z");
    const summaries = [
      { kind: "compactSummary", summary: "S1", boundary: "b1", uuid: "s1", at: "2026-09-28T06:43:01.000Z" },
      { kind: "compactSummary", summary: "S2", boundary: null, uuid: "s2", at: "2026-09-28T09:00:30.000Z" },
      { kind: "compactSummary", summary: "S3", boundary: null, uuid: "s3", at: "2026-09-28T12:00:00.000Z" },
    ];
    const list = attachCompactSummaries(summaries, [
      { id: "native:b1", nativeId: "b1", phase: "complete", trigger: "manual", at },
      { id: "saved", phase: "complete", trigger: "manual", at: Date.parse("2026-09-28T09:00:00.000Z"), summary: "PostCompact の要約" },
    ]);
    t.ok("区切りの uuid が合えばそれに付く", list[0].summary === "S1");
    t.ok("uuid が分からなければ 2 分以内の区切り。既に要約があればそちらを残す", list[1].id === "saved" && list[1].summary === "PostCompact の要約");
    t.ok("合う区切りが無ければ要約から自動の区切りを作る", list.length === 3 && list[2].trigger === "auto" && list[2].summary === "S3" && list[2].phase === "complete");
  }
  // ---- 画面の部品
  {
    const text = (n) => n.textContent ?? "";
    const cmd = commandParts({ kind: "command", command: "/model opus", output: "Set model to opus" });
    t.ok("コマンドは「コマンド」のラベルと本文、出力は閉じた折りたたみ", cmd.length === 2 && text(cmd[0]).includes("コマンド") && text(cmd[0]).includes("/model opus")
      && cmd[1].tagName?.toLowerCase() === "details" && !cmd[1].open);
    const shell = commandParts({ kind: "shell", command: "git switch feature/x", stdout: "a\nb\nc", stderr: "Switched to branch 'feature/x'\nmore" });
    t.ok("シェルは「! コマンド」、出力は「出力 · N 行」、stderr は「エラー出力 · 1 行目」（横スクロールの形）",
      text(shell[0]).includes("! git switch feature/x") && text(shell[1]).includes("出力 · 3 行") && text(shell[2]).includes("エラー出力")
      && text(shell[2]).includes("Switched to branch 'feature/x'") && String(shell[1].querySelector?.("pre")?.className ?? "").includes("wide"));
    const empty = commandParts({ kind: "shell", command: "mkdir -p out", stdout: null, stderr: null });
    t.ok("出力が両方空なら折りたたみを出さず「出力なし」。終了コードは書かない", empty.length === 1 && text(empty[0]).includes("出力なし") && !text(empty[0]).includes("exit"));
    const mate = teammateNode({ kind: "teammate", from: "core-B", body: "API の型の修正が終わりました。" }, "16:18");
    t.ok("teammate は「別のセッションからのメッセージ（core-B）」の閉じた折りたたみ", text(mate).includes("別のセッションからのメッセージ（core-B）") && !mate.querySelector?.("details")?.open);
  }
  // ---- 中断で止めたものを Pleiad が伝えた文（<pleiad-interruption>。core/interrupt-stops.mjs）
  {
    const stops = { tasks: [{ key: "task:t1", taskId: "ply-task-1", title: "Build", status: "running", unread: false },
      { key: "task:t2", taskId: "ply-task-2", title: "Docs", status: "completed", unread: true }],
      background: [{ key: "bg:b1", id: "b1", kind: "shell", label: "npm run dev" }], approvals: [{ key: "ap:x", tool: "Bash", target: "rm -rf out" }] };
    const ja = interruptionNote("ja", stops, "update");
    const en = interruptionNote("en", stops, "update");
    t.ok("止めたものが無ければ文を作らない", interruptionNote("ja", null) === null && interruptionNote("ja", { tasks: [] }) === null);
    t.ok("文は会話の言語で、止めたものを全部載せ、伝えた項目の key を返す",
      ja.text.includes("Pleiad を更新するために中断した") && ["ply-task-1", "ply-task-2", "npm run dev", "Bash: rm -rf out", "ply_task_status"].every(s => ja.text.includes(s))
      && en.text.includes("stopped to update Pleiad") && en.text.includes("read the results with ply_task_status") && ja.keys.join() === "task:t1,task:t2,bg:b1,ap:x", ja.text);
    // Claude・Codex は別のブロック・入力、agy は本文の前。履歴ではどれも 1 行の先頭に来る
    const out = classifySystemMessages([u("n1", ja.text + "続けてください"), u("n2", ja.text)]);
    t.ok("発言の前の文はシステム側の 1 行に分け、続く発言は元の文のまま（分岐点は発言に残す）",
      out.length === 3 && out[0].kind === "interruptionNote" && out[0].role === "system" && out[0].body === ja.body && !out[0].uuid
      && out[1].role === "user" && out[1].text === "続けてください" && out[1].uuid === "n1", JSON.stringify(out));
    t.ok("続きが空なら、文の行が分岐点を持つ", out[2].kind === "interruptionNote" && out[2].uuid === "n2");
    t.ok("何度かけても同じ", JSON.stringify(splitInterruptionNotes(out)) === JSON.stringify(out));
    t.ok("文の途中の印は切り分けない（人が貼った文）", splitInterruptionNotes([u("n3", "見て: " + ja.text)])[0].role === "user");
  }
  // ---- 画面に出ない修正（ソースの形で見る。SDK も LLM も呼ばない）
  {
    const claude = await fs.readFile(new URL("../../core/backends/claude.mjs", import.meta.url), "utf8");
    const title = claude.slice(claude.indexOf("async suggestTitle("), claude.indexOf("async suggestTitle(") + 2000);
    t.ok("タイトル生成の問い合わせは会話として残さない（persistSession: false）", /persistSession:\s*false/.test(title));
    const server = await fs.readFile(new URL("../../core/server.mjs", import.meta.url), "utf8");
    t.ok("完了通知のライブのイベントは本文を載せる", /emit\(\{ type: 'taskNotice', text: /.test(server));
  }
}
