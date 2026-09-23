// ツール表示の監査。毒入りの引数・結果を渡しても、タグや属性の位置には出ないこと。
// あわせて「何をしたか」が文字として読めることも見る（安全だが空、では意味がない）。
//
// DOM シムは tests/run.mjs が入口で入れている。
import { renderToolCall, applyToolResult } from "../../web/render.mjs";
import { audit } from "../lib/audit.mjs";

export const name = "tools-render";
export const title = "ツール表示が毒を通さない / 中身が読める";

const X = '<img src=x onerror=alert(1)><script>alert(1)</script>"onmouseover="a';

const cases = [
  ["Bash", { command: "npm run build && echo done", description: "ビルド" }],
  ["Bash", { command: X, description: X }],
  ["PowerShell", { command: "Get-Process node" }],
  ["Read", { file_path: "D:\\work\\my-app\\core\\server.mjs", offset: 10, limit: 40 }],
  ["Write", { file_path: X, content: "a\nb\nc\n" }],
  ["Edit", { file_path: "web/client.mjs", old_string: "foo\nbar", new_string: "baz" }],
  ["Glob", { pattern: "**/*.mjs", path: "core" }],
  ["Grep", { pattern: "TODO", path: ".", output_mode: "content", "-i": true }],
  ["Task", { description: "調査", subagent_type: "general-purpose", prompt: X }],
  ["WebFetch", { url: "javascript:alert(1)", prompt: "x" }],
  ["WebSearch", { query: X }],
  ["TodoWrite", { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }] }],
  ["mcp__host__present", { kind: "image", path: "a.png", caption: X }],
  ["mcp__host__set_status", { status: X, reason: "r" }],
  ["mcp__other__thing", { a: 1 }],
  ["ナゾのツール", { weird: X }],
  ["Read", null],
];

export default async function (t) {
  let empty = 0;
  for (const [i, [toolName, input]] of cases.entries()) {
    const node = renderToolCall(toolName, input);
    applyToolResult(node, { content: X, isError: toolName === "WebFetch" });
    const problems = audit(node.outerHTML);
    const text = String(node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) empty++;
    const poisoned = JSON.stringify(input ?? "").includes("onerror");
    t.ok(`#${i} ${toolName}${input === null ? "（引数なし）" : poisoned ? "（毒入り）" : ""}`,
         problems.length === 0, problems.join(" / ") || text.slice(0, 74));
  }
  t.ok("どのツールも中身が文字として出る", empty === 0, `空だったもの ${empty} 件`);
}
