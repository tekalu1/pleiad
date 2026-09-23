// 多言語対応の agent 段階（docs/design.md「多言語対応」）。エージェント（LLM）に渡す文は会話の言語で引く。
// 会話の言語は会話を始めたときの画面の言語で決めて保存し、途中で画面の言語を変えても変えない。委譲の子は親の言語を継ぐ。
// en は以前の英語の固定文と同じ、ja は以前の日本語の文と同じ（今の利用者の挙動を変えない）。LLM は呼ばない
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { agentT, agentLocaleOf } from "../../core/i18n.mjs";
import { createAgentBridge, agentInstructions, agentTools } from "../../core/agent-bridge.mjs";
import { contextTools, resolveRuntime } from "../../core/context-runtime.mjs";
import { DEFAULT_SCAN } from "../../core/context-settings.mjs";
import { visualizeInstructions } from "../../core/visualize.mjs";
import { agentDefinition } from "../../core/backends/antigravity-context.mjs";
import { ATTACHMENT_LINE, attachmentLine, attachmentMessageIndex } from "../../web/timeline.mjs";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

export const name = "i18n-agent";
export const title = "エージェントに渡す文（指示・ツールの説明・通知・タイトル生成）が会話の言語になる";

const JP = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const ply = (name, args) => "ply:" + JSON.stringify({ name, arguments: args });

export default async function (t) {
  // ---- agentT: 画面の言語（t）と別。会話の言語を明示して引き、持たなければ英語
  t.ok("agentT は会話の言語で引く", agentT("ja", "approval.aborted") === "中断された" && agentT("en", "approval.aborted") === "Interrupted");
  t.ok("会話の言語が無い・知らない言語なら英語", agentT(undefined, "approval.aborted") === "Interrupted" && agentT("fr", "approval.aborted") === "Interrupted");
  t.ok("agentLocaleOf は ja / en だけを通す", agentLocaleOf("ja") === "ja" && agentLocaleOf("en") === "en" && agentLocaleOf("fr") === null && agentLocaleOf(undefined) === null);
  t.ok("差し込む値の中の {{…}} や $t(…) は展開しない（依頼・結果の本文をそのまま渡す）",
    agentT("en", "title.request", { text: "{{text}} $t(approval.aborted)" }) === "Request: {{text}} $t(approval.aborted)");

  // ---- ply_agents の instructions とツールの説明
  const en = agentInstructions("en"), ja = agentInstructions("ja");
  t.ok("en の instructions は以前の英語の文", en.startsWith("Pleiad delegation tools (ply_agents MCP): use ply_delegate with an explicit backend (claude, codex, antigravity)")
    && en.endsWith("Use delegation only when authorized by the user's task and applicable instructions.") && !JP.test(en), en.slice(0, 80));
  t.ok("ja の instructions は日本語で、ツール名・ID の形は訳さない", ja.startsWith("Pleiad の委譲ツール（ply_agents MCP）") && ["ply_delegate", "ply_task_*", "ply-task-", "status: waiting", "ply_usage"].every(s => ja.includes(s)), ja.slice(0, 80));
  const toolsEn = agentTools("en"), toolsJa = agentTools("ja");
  t.ok("ツールの名前と引数は言語に依らない", JSON.stringify(toolsEn.map(x => [x.name, x.inputSchema])) === JSON.stringify(toolsJa.map(x => [x.name, x.inputSchema])));
  t.ok("en のツールの説明は以前の英語", toolsEn.find(x => x.name === "ply_delegate").description.startsWith("Start a Pleiad-managed task using the explicitly selected backend.") && toolsEn.every(x => !JP.test(x.description)));
  t.ok("ja のツールの説明は日本語", toolsJa.every(x => JP.test(x.description)), toolsJa.map(x => x.description.slice(0, 20)).join(" / "));

  // 橋は会話ごとに開く。接続した会話の言語で instructions・一覧・エラーを返す
  const bridge = createAgentBridge({ call: async (_owner, _name, _args, { locale } = {}) => { throw new Error(agentT(locale, "delegation.notRunning")); } });
  const server = http.createServer(bridge.handle);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const rpc = async (c, method, params = {}) => (await (await fetch(c.url, { method: "POST", headers: { ...c.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
    for (const [lng, check] of [["en", s => !JP.test(s)], ["ja", s => JP.test(s)]]) {
      const c = bridge.open({ origin, owner: () => "owner", locale: lng });
      const init = await rpc(c, "initialize");
      const list = await rpc(c, "tools/list");
      const bad = await rpc(c, "tools/call", { name: "nope", arguments: {} });
      const failed = await rpc(c, "tools/call", { name: "ply_task_list", arguments: {} });
      t.ok(`${lng} の会話の橋: instructions・ツールの説明・エラーがその言語`, c.instructions === agentInstructions(lng) && init.instructions === agentInstructions(lng)
        && list.tools.every(x => check(x.description)) && bad.content[0].text === agentT(lng, "bridge.invalidTool") && failed.content[0].text === agentT(lng, "delegation.notRunning"),
        `${bad.content[0].text} / ${failed.content[0].text}`);
      c.close();
    }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }

  // ---- ply_context: 指示の前置き・Skills の案内・ツールの説明・返り
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ply-agent-i18n-"));
  try {
    const cwd = path.join(tmp, "repo");
    await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
    await fs.writeFile(path.join(cwd, "AGENTS.md"), "ROOT_SENTINEL");
    await fs.mkdir(path.join(cwd, ".agents/skills/demo"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".agents/skills/demo/SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\nDEMO_BODY");
    const policy = { version: 1, cwd, owners: { instruction: "ply", skill: "ply", mcp: "native" }, user: { ...DEFAULT_SCAN, sources: [] }, directory: { ...DEFAULT_SCAN, sources: ["common"] } };
    for (const lng of ["en", "ja"]) {
      const runtime = await resolveRuntime(policy, { locale: lng });
      const helpers = contextTools(runtime);
      const skillId = runtime.skills[0]?.id;
      const first = (await helpers.call("load_skill", { id: skillId })).content[0].text;
      const again = (await helpers.call("load_skill", { id: skillId })).content[0].text;
      const bad = await helpers.call("instructions_for_path", { id: "relative/path" }).then(() => "", e => e.message);
      if (lng === "en") {
        t.ok("en: 指示の前置き・Skills の案内・ツールの説明は以前の英語", runtime.prompt.startsWith(`Instructions from ${path.join(cwd, "AGENTS.md")} (scope: `)
          && helpers.prompt.includes("Available Skills (use ply_context load_skill with the id before following a skill; load only when relevant):\n- demo: demo skill (id: ")
          && helpers.prompt.includes("Before reading or editing a file under a descendant directory, call the ply_context instructions_for_path tool")
          && helpers.tools.every(x => !JP.test(x.description)), helpers.prompt.slice(0, 200));
        t.ok("en: load_skill の返り・渡し済みの一行・エラー", first.startsWith("Skill directory: ") && first.includes("DEMO_BODY")
          && again.startsWith("Already provided in this conversation: Skill demo (scope: directory ") && bad === "Specify an absolute path.", `${again} / ${bad}`);
      } else {
        t.ok("ja: 指示の前置き・Skills の案内・ツールの説明は日本語", runtime.prompt.startsWith(`${path.join(cwd, "AGENTS.md")} の指示（適用範囲: `)
          && helpers.prompt.includes("使える Skills（") && helpers.prompt.includes("- demo: demo skill（id: ")
          && helpers.prompt.includes("instructions_for_path ツールを呼ぶこと") && helpers.tools.every(x => JP.test(x.description)), helpers.prompt.slice(0, 200));
        t.ok("ja: load_skill の返り・渡し済みの一行・エラー", first.startsWith("Skill のディレクトリ: ") && first.includes("DEMO_BODY")
          && again.startsWith("この会話で渡し済み: Skill「demo」（適用範囲: ディレクトリ ") && bad === "絶対パスを指定してください", `${again} / ${bad}`);
      }
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }

  // ---- Visualize の案内・agy のエージェント定義
  const vizEn = visualizeInstructions("en"), vizJa = visualizeInstructions("ja");
  const skillFile = (await fs.readFile(path.join(ROOT, "skills/visualize/SKILL.md"), "utf8")).replace(/^---[\s\S]*?---\s*/, "");
  const native = [...vizEn.matchAll(/`([^`]*visualize[^`]*)`/g)].map(m => m[1]).find(s => /[\uE000-\uF8FF]/.test(s));
  t.ok("Visualize の案内: en は SKILL.md の本文、ja は日本語で、参照の形式（特殊な印を含む）は同じ", vizEn === skillFile && vizEn.startsWith("# Visualize in Pleiad")
    && vizJa.startsWith("# Pleiad での可視化") && Boolean(native) && vizJa.includes(native) && visualizeInstructions(undefined) === vizEn);
  const defEn = agentDefinition({ owners: { instruction: "ply", skill: "ply", mcp: "ply" }, prompt: "P", cwd: "C:/w", home: "C:/h", locale: "en" });
  const defJa = agentDefinition({ owners: { instruction: "ply", skill: "ply", mcp: "ply" }, prompt: "P", cwd: "C:/w", home: "C:/h", locale: "ja" });
  t.ok("agy のエージェント定義の説明・見出し・注意書きが会話の言語", defEn.includes("# Pleiad context") && defEn.includes("Pleiad created this agent definition in C:/h.") && /description: "An agent/.test(defEn)
    && defJa.includes("# Pleiad のコンテキスト") && defJa.includes("Pleiad はこのエージェント定義を C:/h に作った。") && /description: "Pleiad がこの会話のために作ったエージェント/.test(defJa));

  // ---- タイトル生成のプロンプト（claude・codex は LLM を呼ぶので文だけを見る）
  t.ok("タイトル生成: ja は以前の文（日本語のタイトル）、en は英語のタイトルを求める",
    agentT("ja", "title.claude") === "次は作業ログの冒頭です。この作業を表す短い日本語のタイトルを1つだけ返してください。\n20文字以内。記号や引用符で囲まず、タイトルだけを返すこと。"
    && agentT("ja", "title.codex").startsWith("次の作業ログを表す短い日本語タイトルを1つだけ返してください。")
    && /English title/.test(agentT("en", "title.claude")) && /English title/.test(agentT("en", "title.codex")));

  // ---- 添付の印（web/timeline.mjs）。付けるのは会話の言語、読み戻しはどちらも
  t.ok("添付の印は会話の言語で付け、どちらの印も読み戻す", attachmentLine("ja", "C:/a.png") === "[添付] C:/a.png" && attachmentLine("en", "C:/a.png") === "[Attachment] C:/a.png"
    && ATTACHMENT_LINE.exec("[Attachment] C:/a.png")?.[1] === "C:/a.png" && ATTACHMENT_LINE.exec("[添付] C:/a.png")?.[1] === "C:/a.png"
    && attachmentMessageIndex([{ role: "user", text: "see\n\n[Attachment] C:/a.png" }], { by: "human", path: "C:/a.png" }) === 0);

  // ---- サーバー（fake）: 会話の言語の決め方・保存・継承、完了通知・タイトル・承認の拒否の理由
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ply-agent-locale-"));
  // 強制（AGENT_HOST_LOCALE）を外し、設定の locale で画面の言語を切り替える
  const srv = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_LOCALE: "", AGENT_HOST_SYSTEM_LOCALE: "en-US" } });
  const c = await open({ port: srv.port, token: srv.token, onEvent: async (ev, api) => {
    if (ev.type === "permission") await api.cmd("resolvePermission", { id: ev.id, allow: false, messageKey: "userDenied" }).catch(() => {});
  } });
  const sessions = async () => await c.cmd("listSessions");
  const rowOf = async id => (await sessions()).find(s => s.id === id);
  const awaitTasks = async fn => {
    const deadline = Date.now() + 60_000;
    let rows;
    while (Date.now() < deadline) { rows = await c.cmd("agentTasks"); if (fn(rows)) return rows; await sleep(50); }
    throw new Error("task timeout: " + JSON.stringify(rows));
  };
  const said = turn => turn.events.filter(e => e.type === "text.delta").map(e => e.text).join("");
  const idle = async id => { for (let i = 0; i < 200; i++) { if (!(await c.cmd("running")).turns.some(r => r.sessionId === id)) return; await sleep(50); } };
  try {
    // 英語の画面で始めた会話
    await c.cmd("setPref", { key: "locale", value: "en" });
    const enTurn = await c.runTurn({ backend: "fake", cwd: ROOT, prompt: ply("ply_delegate", { backend: "fake", task: "echo:EN_CHILD" }) });
    const enId = enTurn.sessionId;
    let rows = await awaitTasks(rows => rows.some(r => r.parentSessionId === enId && r.notification === "sent"));
    const enChild = rows.find(r => r.parentSessionId === enId);
    await idle(enId);
    t.ok("会話を始めたときの画面の言語（en）を会話に保存する", (await rowOf(enId))?.agentLocale === "en");
    t.ok("委譲の子の会話は親の会話の言語を継ぐ", (await rowOf(enChild.sessionId))?.agentLocale === "en");
    const enNotice = (await c.cmd("loadSession", { sessionId: enId })).messages.find(m => m.internalTaskNotice);
    t.ok("en の会話の完了通知は英語（人間の発言とは本文のハッシュで見分ける）", enNotice?.text.startsWith(`[Pleiad task completion notice / ${enChild.taskId}]\nBackend: fake\nStatus: completed\nTask: echo:EN_CHILD\n`)
      && enNotice.text.endsWith("Continue the work needed for the original request."), enNotice?.text);
    const enTitle = await c.cmd("suggestTitle", { sessionId: enId });
    t.ok("en の会話のタイトル生成に渡す見出しは英語", enTitle.title.startsWith("Request:"), enTitle.title);

    // 画面を日本語に変えても、進行中の英語の会話への文は英語のまま
    await c.cmd("setPref", { key: "locale", value: "ja" });
    const enStatus = await c.runTurn({ sessionId: enId, prompt: ply("ply_task_status", { taskId: "ply-task-unknown" }) });
    const enError = enStatus.events.find(e => e.type === "tool.result")?.text;
    t.ok("画面の言語を変えても、進行中の会話への文は変えない", enError === "This Pleiad task was not created by this conversation." && (await rowOf(enId))?.agentLocale === "en", enError);
    const enDenied = await c.runTurn({ sessionId: enId, prompt: "ask" });
    t.ok("承認の拒否の理由は会話の言語（画面は印だけを送る）", said(enDenied).endsWith("The user denied it"), said(enDenied));

    // 日本語の画面で始めた会話
    const jaTurn = await c.runTurn({ backend: "fake", cwd: ROOT, prompt: ply("ply_delegate", { backend: "fake", task: "echo:JA_CHILD" }) });
    const jaId = jaTurn.sessionId;
    rows = await awaitTasks(rows => rows.some(r => r.parentSessionId === jaId && r.notification === "sent"));
    const jaChild = rows.find(r => r.parentSessionId === jaId);
    await idle(jaId);
    t.ok("ja の画面で始めた会話は ja", (await rowOf(jaId))?.agentLocale === "ja" && (await rowOf(jaChild.sessionId))?.agentLocale === "ja");
    const jaNotice = (await c.cmd("loadSession", { sessionId: jaId })).messages.find(m => m.internalTaskNotice);
    t.ok("ja の会話の完了通知は以前の日本語の文", jaNotice?.text.startsWith(`[Pleiad タスク完了通知 / ${jaChild.taskId}]\n実行先: fake\n状態: completed\n依頼: echo:JA_CHILD\n結果（子エージェントの報告）:\nJA_CHILD\n`)
      && jaNotice.text.endsWith("元の依頼に必要な作業を続けてください。"), jaNotice?.text);
    t.ok("ja の会話のタイトル生成に渡す見出しは日本語", (await c.cmd("suggestTitle", { sessionId: jaId })).title.startsWith("依頼:"));
    const jaDenied = await c.runTurn({ sessionId: jaId, prompt: "ask" });
    t.ok("ja の会話の拒否の理由は以前の文", said(jaDenied).endsWith("ユーザーが拒否した"), said(jaDenied));

    // 先に作っただけの会話（未送信）は、最初に送ったときの画面の言語で決まる
    await c.cmd("setPref", { key: "locale", value: "en" });
    const created = await c.cmd("newSession", { backend: "fake", cwd: ROOT });
    const unsentId = created?.sessionId ?? created?.id;
    t.ok("作っただけの会話はまだ言語を持たない", Boolean(unsentId) && (await rowOf(unsentId))?.agentLocale === null, JSON.stringify(created));
    await c.cmd("setPref", { key: "locale", value: "ja" });
    await c.runTurn({ sessionId: unsentId, prompt: "echo:hello" });
    t.ok("最初に動かしたときの画面の言語で決めて保存する", (await rowOf(unsentId))?.agentLocale === "ja");
  } finally {
    c.close();
    await srv.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
