// ツール呼び出しのまとまり（web/tool-bundle.mjs）の数え方と、1 行・結果の形（web/render.mjs）、完了通知の読み取り（web/task-notice.mjs）。
// まとまりの組み立て: 本文で切れる・委譲で切れる・件数と内訳・失敗の数・変更したファイル数。
// 承認待ちがまとまりの中に入る、入れ替わり・遡りの動きは実ブラウザーで見る（tests/browser/tool-bundle.cjs）。
//
// DOM シムは tests/run.mjs が入口で入れている。
import { bundleStats, splitToolCalls, clock } from "../../web/tool-bundle.mjs";
import { renderToolCall, applyToolResult, applyToolHints, toolChange, exitCodeOf, failureLine, isDelegateToolName } from "../../web/render.mjs";
import { parseTaskNotice } from "../../web/task-notice.mjs";

export const name = "tool-bundle";
export const title = "ツールのまとまり: 数え方・区切り・1 行の形・完了通知の読み取り";

const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
const item = (verb, extra = {}) => ({ verb, ...extra });

export default async function (t) {
  // ---- 数え方
  {
    const st = bundleStats([
      item("読む"), item("読む"), item("検索"), item("実行"), item("実行"), item("実行", { err: true }), item("編集", { change: { path: "D:/x/a.mjs", add: 3, del: 1 } }),
    ]);
    t.ok("件数と、動詞ごとの内訳（多い順）", st.count === 7 && st.mix[0][0] === "実行" && st.mix[0][1] === 3 && st.mix[1][0] === "読む" && st.mix[1][1] === 2, JSON.stringify(st.mix));
    t.ok("同数なら読む・検索…実行の順", bundleStats([item("実行"), item("読む")]).mix.map((m) => m[0]).join() === "読む,実行");
    t.ok("失敗の数は走り終えたものだけ", st.errors === 1 && bundleStats([item("実行", { err: true, running: true })]).errors === 0);
    t.ok("変更したファイルは 1 件（−1 +3）", st.files.length === 1 && st.files[0].name === "a.mjs" && st.files[0].add === 3 && st.files[0].del === 1);
  }
  {
    const files = bundleStats([
      item("編集", { change: { path: "D:\\x\\a.mjs", add: 2, del: 1 } }),
      item("編集", { change: { path: "D:\\x\\a.mjs", add: 5, del: 0 } }),
      item("書く", { change: { path: "D:/x/b.mjs", add: 12, del: 0 } }),
      item("編集", { change: { path: "D:/x/c.mjs", add: 1, del: 1 }, err: true }),
      item("編集", { change: { path: "D:/x/d.mjs", add: 1, del: 1 }, running: true }),
    ]).files;
    t.ok("同じファイルへの変更は 1 つにまとめ、失敗・実行中の変更は数えない",
      files.length === 2 && files[0].add === 7 && files[0].del === 1 && files[0].name === "a.mjs" && files[1].name === "b.mjs", JSON.stringify(files));
  }
  t.ok("経過は m:ss", clock(71) === "1:11" && clock(0) === "0:00" && clock(9) === "0:09");

  // ---- 区切り
  {
    const isDelegate = (c) => c.delegate === true;
    const seg = splitToolCalls([{ n: 1 }, { n: 2 }, { n: 3, delegate: true }, { n: 4 }, { n: 5, delegate: true }, { n: 6, delegate: true }, { n: 7 }], isDelegate);
    t.ok("委譲はまとまりの外に 1 件ずつ出て、まとまりはそこで切れる",
      seg.map((s) => s.type === "bundle" ? `b${s.calls.length}` : "d").join() === "b2,d,b1,d,d,b1", seg.map((s) => s.type).join());
    t.ok("空なら何も出さない", splitToolCalls([], isDelegate).length === 0);
    t.ok("委譲のツール名の判定（Task・Agent・ply_delegate）", isDelegateToolName("Agent") && isDelegateToolName("Task") && isDelegateToolName("mcp__ply_agents__ply_delegate") && !isDelegateToolName("Bash") && !isDelegateToolName("mcp__x__delegate_all"));
  }

  // ---- 変えた量
  {
    const edit = toolChange("Edit", { file_path: "a.mjs", old_string: "x\ny", new_string: "x\nz\nw" });
    t.ok("編集の量は変わった行だけ（−1 +2）", edit?.del === 1 && edit?.add === 2, JSON.stringify(edit));
    t.ok("書き込みは全部が追加", toolChange("Write", { file_path: "b.mjs", content: "a\nb\nc" })?.add === 3);
    t.ok("読むツールは変更ではない", toolChange("Read", { file_path: "a.mjs" }) === null && toolChange("Bash", { command: "ls" }) === null);
  }

  // ---- Codex・agy の変更（バックエンドが申告した shape で決める）
  {
    applyToolHints({ fileChange: { label: "編集", shape: "edit" }, write_file: { label: "書く", shape: "write" }, edit_file: { label: "編集", shape: "edit" }, commandExecution: { label: "実行", shape: "shell" } });
    const codex = toolChange("fileChange", { files: ["D:/x/a.mjs", "D:/x/b.mjs"] });
    t.ok("Codex の fileChange: パスの一覧からファイル数だけ数える（量は 0）", codex?.paths?.length === 2 && codex.add === 0 && codex.del === 0, JSON.stringify(codex));
    const st = bundleStats([item("編集", { change: codex }), item("編集", { change: { path: "D:/x/a.mjs", add: 3, del: 1 } })]);
    t.ok("同じファイルは量を足して 1 つ、別のファイルは別に数える", st.files.length === 2 && st.files.find((f) => f.name === "a.mjs").add === 3, JSON.stringify(st.files));
    const agyWrite = toolChange("write_file", { TargetFile: "D:/x/n.mjs", CodeContent: "a\nb\nc" });
    t.ok("agy の write_file: 書いた行数", agyWrite?.path === "D:/x/n.mjs" && agyWrite.add === 3, JSON.stringify(agyWrite));
    const agyEdit = toolChange("edit_file", { TargetFile: "D:/x/n.mjs", TargetContent: "a\nb", ReplacementContent: "a\nc\nd" });
    t.ok("agy の edit_file: 変わった行", agyEdit?.del === 1 && agyEdit.add === 2, JSON.stringify(agyEdit));
    t.ok("shell 形のツールは変更ではない", toolChange("commandExecution", { command: "ls" }) === null);
    const card = renderToolCall("fileChange", { files: ["D:/x/a.mjs", "D:/x/b.mjs"] });
    applyToolResult(card, { text: "ok", isError: false });
    t.ok("Codex の fileChange: 主役は最初のファイル、右端は量が分からないので「編集した」", text(card.querySelector(".tc-main")).includes("a.mjs") && text(card.querySelector(".tc-res")) === "編集した", text(card.querySelector(".tc-res")));
  }

  // ---- 押さずに決着した承認: 結果が届いたら承認カードを外して行を戻す
  {
    const row = renderToolCall("Write", { file_path: "D:/x/a.mjs", content: "a" });
    const shell = row.querySelector(".tc-details");
    shell.hidden = true;
    row.classList.add("tc-waiting");
    const box = document.createElement("div"); box.className = "tc-appr";
    row.append(box);
    applyToolResult(row, { text: "ok", isError: false });
    t.ok("結果が届いたら承認カードは外れ、行が戻る", row.querySelector(".tc-appr") === null && shell.hidden === false && !row.classList.contains("tc-waiting") && row.classList.contains("tc-done"));
  }

  // ---- 1 行と結果
  {
    const edit = renderToolCall("Edit", { file_path: "D:/x/a.mjs", old_string: "a\nb", new_string: "c\nd\ne" });
    applyToolResult(edit, { text: "updated", isError: false });
    t.ok("編集: 右端に「−2 +3」、開くと差分", text(edit.querySelector(".tc-res")) === "−2 +3" && edit.querySelector(".tc-diff") != null, text(edit.querySelector(".tc-res")));
    t.ok("編集: 主役は対象ファイル", text(edit.querySelector(".tc-main")).includes("a.mjs"));

    const bash = renderToolCall("Bash", { command: "node tests/run2.mjs", description: "全体のテスト" });
    applyToolResult(bash, { text: "Error: Cannot find module 'x'\n    at Module._resolveFilename\nNode.js v22\nExit code 1", isError: true });
    t.ok("失敗: 「✕ 失敗 · exit 1」と要点の 1 行", text(bash.querySelector(".tc-res")).includes("exit 1") && text(bash.querySelector(".tc-errline")).startsWith("Error: Cannot find module"), text(bash.querySelector(".tc-res")) + " / " + text(bash.querySelector(".tc-errline")));
    t.ok("失敗の行は tc-error", bash.classList.contains("tc-error"));
    t.ok("失敗の再送でも要点は 1 つ", (applyToolResult(bash, { text: "boom", isError: true }), bash.querySelectorAll(".tc-errline").length === 1));

    const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const run = renderToolCall("Bash", { command: "npm test" });
    applyToolResult(run, { text: out, isError: false });
    const tail = run.querySelector(".tc-tail");
    t.ok("実行: 出力は末尾 6 行と「全 30 行を表示」", tail != null && tail.outerHTML.includes("line 30") && !tail.outerHTML.includes("line 20") && tail.querySelector(".tc-more") != null, text(tail).slice(0, 80));
    t.ok("実行: 右端は行数", text(run.querySelector(".tc-res")) === "30 行", text(run.querySelector(".tc-res")));
    t.ok("実行: 生の出力は「入力・出力（JSON）」の奥に残る", run.querySelector(".tc-json").querySelector(".tc-out") != null);

    const glob = renderToolCall("Glob", { pattern: "tests/unit/*login*.mjs" });
    applyToolResult(glob, { text: "tests/unit/login-flow.mjs\ntests/unit/login-retry.mjs", isError: false });
    t.ok("探す: 結果はファイルの一覧、右端は件数", glob.querySelector(".tc-files").querySelectorAll("li").length === 2 && text(glob.querySelector(".tc-res")) === "2 件", text(glob.querySelector(".tc-res")));

    const grep = renderToolCall("Grep", { pattern: "retryLogin\\(" });
    applyToolResult(grep, { text: "No matches found", isError: false });
    t.ok("検索: 0 件と分かる", text(grep.querySelector(".tc-res")) === "0 件");

    const mcp = renderToolCall("mcp__composio__COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "notion" }], session: { generate_id: true } });
    t.ok("MCP: 入力は「キー 値」の格子", mcp.querySelector(".tc-kv") != null && text(mcp.querySelector(".tc-kv")).includes("queries"));
    t.ok("MCP: 生の JSON は奥の折りたたみ", mcp.querySelector(".tc-json").querySelector(".tc-input") != null);

    const delegate = renderToolCall("mcp__ply_agents__ply_delegate", { kind: "implement", title: "設定を直す", task: "…" });
    applyToolResult(delegate, { text: "{\"taskId\":\"ply-task-1\"}", isError: false });
    t.ok("委譲: 結果の要約は出さない（子の状態は client が描く）・出力は JSON の奥", text(delegate.querySelector(".tc-res")) === "" && delegate.querySelector(".tc-json").querySelector(".tc-out") != null);
    t.ok("委譲: キーと値の格子は出さない", delegate.querySelector(".tc-kv") == null);
  }
  t.ok("終了コードを読む", exitCodeOf("...\nExit code 2") === 2 && exitCodeOf("exited with code 127") === 127 && exitCodeOf("ok") === null);
  t.ok("失敗の要点: Error: の行、無ければ最後の行", failureLine("a\nb\nError: x\nc") === "Error: x" && failureLine("a\n\nlast line\n") === "last line" && failureLine("") === "");

  // ---- 完了通知
  {
    const ja = parseTaskNotice("[Pleiad タスク完了通知 / ply-task-3f1c2a9e-7b4d-4e11-9c0a-2d5e8f6a1b37]\n実行先: codex\n状態: completed\n依頼: 設定画面の保存を直す\n結果（子エージェントの報告）:\nsave() を直した。\nテストを足した。\n元の依頼に必要な作業を続けてください。");
    t.ok("完了通知（日本語）: id・実行先・状態・依頼・結果", ja?.taskId === "ply-task-3f1c2a9e-7b4d-4e11-9c0a-2d5e8f6a1b37" && ja.backend === "codex" && ja.status === "completed" && ja.task === "設定画面の保存を直す" && ja.result === "save() を直した。\nテストを足した。", JSON.stringify(ja));
    const en = parseTaskNotice("[Pleiad task completion notice / ply-task-aaaa]\nBackend: claude\nStatus: failed\nTask: Fix it\nResult (the child agent's report):\nCould not.\nContinue the work needed for the original request.");
    t.ok("完了通知（英語）", en?.backend === "claude" && en.status === "failed" && en.result === "Could not.", JSON.stringify(en));
    t.ok("まとめ通知・別の文は読まない", parseTaskNotice("[Pleiad タスク完了通知 / 3 件]\n…") === null && parseTaskNotice("こんにちは") === null && parseTaskNotice("") === null);
  }
}
