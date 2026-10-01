// コンピューターの操作（ply_computer）を 3 つのエージェントへ渡す形と、結果の正規化（docs/computer-use.md「エージェントへの渡し方」
// 「tool.start / tool.result」「エージェントごとの値」）。LLM も本物の CLI も呼ばない:
//   - Claude: SDK の query を身代わりにして、mcpServers・timeout・指示文・ツールごとの承認を見る。正規化は純粋な関数で
//   - Codex: app-server の rpc を身代わりにして、thread/start の config（ply_computer・同梱を切るキー・tool_timeout_sec）と mcpToolCall の正規化を見る
//   - Antigravity: 置き場を分けた別プロセス（tests/lib/agy-computer-worker.mjs）で、偽の agy と 2 本目の中継を通す
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "../lib/server.mjs";
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";
import { normalizeSdkMessage, transcriptToMessages } from "../../core/backends/claude-normalize.mjs";
import { backend as codex, threadToMessages } from "../../core/backends/codex.mjs";
import { rpc } from "../../core/backends/codex-rpc.mjs";
import { codexComputerConfig, agyComputerName, computerPrompt, withoutImageNotes } from "../../core/backends/computer-delivery.mjs";

export const name = "computer-delivery";
export const title = "ply_computer: 3 つのエージェントへの注入（MCP・上限時間・指示文・承認）と、印の行からの正規化";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT = "4f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2";
const MARK = `[ply_computer] {"v":1,"tool":"screenshot","state":"ok","title":"画面を確かめる","shot":"${SHOT}","w":1460,"h":821,"display":1}`;
const SHOT_TEXT = `ディスプレイ 1 / 1・1460×821\n${MARK}`;
const IMAGE = "/9j/4AAQSkZJRgABAQAAAQABAAD" + "A".repeat(4000);
const runtime = { url: "http://127.0.0.1:1/mcp/computer", headers: { Authorization: `Bearer ${"a".repeat(64)}` }, instructions: "COMPUTER-COMMON-INSTRUCTIONS" };

/** 中継を env なしで起こし（--computer）、JSON-RPC を流して返事を集める */
async function relayAlone(messages) {
  const env = { ...process.env };
  for (const k of ["PLY_COMPUTER_URL", "PLY_COMPUTER_AUTHORIZATION", "PLY_CONTEXT_URL", "PLY_CONTEXT_AUTHORIZATION"]) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, "core", "agy-context-relay.mjs"), "--computer"], { env, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  const expected = messages.filter((m) => m.id !== undefined).length;
  for (let i = 0; i < 100 && out.split("\n").filter(Boolean).length < expected; i++) await sleep(50);
  child.kill();
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Claude の SDK の身代わり。options を控え、result を 1 つ流して終わる */
function fakeClaudeSdk() {
  const q = { options: null, close() {}, interrupt: async () => ({}) };
  let release;
  const gate = new Promise((r) => { release = r; });
  q.finish = () => release();
  q[Symbol.asyncIterator] = async function* () { await gate; yield { type: "result", subtype: "success", num_turns: 1, session_id: "claude-computer" }; };
  const query = ({ prompt, options }) => { q.options = options; (async () => { for await (const _ of prompt) { /* 入力は読み捨てる */ } })(); return q; };
  return { q, restore: setClaudeSdkForTest({ query, executable: () => "claude-fake" }) };
}

export default async function (t) {
  // ---- 共通の補助
  t.ok("Codex の config: ply_computer（approve・required: false・tool_timeout_sec 660）と、同梱を切る 2 つのプラグインのキー", (() => {
    const c = codexComputerConfig(runtime);
    const s = c["mcp_servers.ply_computer"];
    return s?.url === runtime.url && s.http_headers?.Authorization === runtime.headers.Authorization && s.required === false && s.default_tools_approval_mode === "approve" && s.tool_timeout_sec === 660
      && c["plugins.unified-computer-use@openai-bundled.enabled"] === false && c["plugins.computer-use@openai-bundled.enabled"] === false
      && !("features.computer_use" in c) && !Object.keys(c).some((k) => k.startsWith("mcp_servers.cua_repl") || k.startsWith("mcp_servers.node_repl"));
  })());
  t.ok("Codex の config: 渡さない会話には何も足さない", Object.keys(codexComputerConfig(null)).length === 0);
  t.ok("agy の名前: 接頭辞の付いた ToolName を見る（ServerName は空のことが多い）。他のサーバーのツールは null",
    agyComputerName({ ServerName: "", ToolName: "ply_computer_left_click" }) === "mcp__ply_computer__left_click"
    && agyComputerName({ ServerName: "ply_computer", ToolName: "zoom" }) === "mcp__ply_computer__zoom"
    && agyComputerName({ ServerName: "", ToolName: "screenshot" }) === null && agyComputerName({ ServerName: "", ToolName: "ply_computer_" }) === null);
  t.ok("画像の退避の行（agy の Resource offloaded・Claude の CLI の Image: source）だけを除く", withoutImageNotes(`a\n${MARK}\n[Resource offloaded to file:///C:/x/media_0.jpg]`) === `a\n${MARK}`
    && withoutImageNotes(`a\n${MARK}\n[Image: source: C:\\Users\\u\\.claude\\projects\\p\\tool-results\\mcp-ply_computer-blob-1]`) === `a\n${MARK}`);
  t.ok("指示文: Claude は共通の文だけ、Codex は遅延ロードと image() の渡し方を足す", computerPrompt(runtime, { locale: "ja", agent: "claude" }) === runtime.instructions
    && /tool_search/.test(computerPrompt(runtime, { locale: "ja", agent: "codex" })) && /image\(r\.content\[1\]\)/.test(computerPrompt(runtime, { locale: "en", agent: "codex" }))
    && computerPrompt(null, { locale: "ja", agent: "codex" }) === null);

  const alone = await relayAlone([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "resources/list" },
  ]);
  t.ok("中継（--computer）は接続先が無ければツールを持たない ply_computer として答える", alone.find((m) => m.id === 1)?.result?.serverInfo?.name === "Pleiad Computer"
    && alone.find((m) => m.id === 2)?.result?.tools?.length === 0 && alone.find((m) => m.id === 3)?.error?.code === -32601, JSON.stringify(alone));

  // ---- Claude: 正規化（ライブ）
  const ids = new Set();
  const [start] = normalizeSdkMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__ply_computer__type", input: { title: "入力", text: "token=sk-abcdefghijklmnopqrstuv" } }] } }, { computerIds: ids }).filter((e) => e.type === "tool.start");
  t.ok("Claude: type の入力の秘密を伏せて tool.start に出す", start?.name === "mcp__ply_computer__type" && !start.input.text.includes("sk-abcdefghijklmnopqrstuv") && ids.has("tu1"), JSON.stringify(start));
  normalizeSdkMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "mcp__ply_computer__screenshot", input: { title: "画面を確かめる" } }] } }, { computerIds: ids });
  const shot = normalizeSdkMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: SHOT_TEXT }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMAGE } }, { type: "text", text: "[Image: source: C:\\tmp\\tool-results\\mcp-ply_computer-blob-1]" }] }] } }, { computerIds: ids })[0];
  t.ok("Claude: tool_result の印の行から images と computer を作り、text から印を除く", shot?.images?.[0]?.url === `/computer-shot/${SHOT}.jpg` && shot.images[0].width === 1460
    && shot.computer?.tool === "screenshot" && shot.computer?.state === "ok" && !("v" in shot.computer) && shot.text === "ディスプレイ 1 / 1・1460×821" && !JSON.stringify(shot).includes(IMAGE.slice(0, 40)), JSON.stringify(shot).slice(0, 300));
  const other = normalizeSdkMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read1", content: SHOT_TEXT }] } }, { computerIds: ids })[0];
  t.ok("Claude: ply_computer でないツールの結果は、印の形の行があっても読まない", other?.text === SHOT_TEXT && !other.images && !other.computer, JSON.stringify(other));

  // ---- Claude: 正規化（履歴）
  const long = "x".repeat(2500) + "\n" + MARK;
  const history = transcriptToMessages([
    { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "h1", name: "mcp__ply_computer__screenshot", input: { title: "画面を確かめる" } }, { type: "tool_use", id: "h2", name: "Read", input: { file_path: "docs/computer-use.md" } }, { type: "tool_use", id: "h3", name: "mcp__ply_computer__type", input: { title: "入力", text: "password=hunter2" } }] } },
    { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "h1", content: [{ type: "text", text: long }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMAGE } }] }, { type: "tool_result", tool_use_id: "h2", content: SHOT_TEXT }, { type: "tool_result", tool_use_id: "h3", content: "x\n[ply_computer] {\"v\":1,\"tool\":\"type\",\"state\":\"stopped\",\"reason\":\"stop\",\"title\":\"入力\"}", is_error: true }] } },
  ]);
  const [h1, h2, h3] = history[0]?.toolCalls ?? [];
  t.ok("Claude 履歴: 2000 字を超える本文でも印の行を読み、本文は切る", h1?.result?.images?.[0]?.shot === SHOT && h1.result.truncated === true && !h1.result.text.includes("[ply_computer]"), JSON.stringify(h1?.result ?? null).slice(0, 200));
  t.ok("Claude 履歴: 他のツールの結果は今までどおり", h2?.result?.text === SHOT_TEXT && !h2.result.images, JSON.stringify(h2?.result ?? null));
  t.ok("Claude 履歴: 止めた理由と isError を残し、type の入力を伏せる", h3?.result?.computer?.reason === "stop" && h3.result.isError === true && !h3.input.text.includes("hunter2"), JSON.stringify(h3 ?? null));

  // ---- Claude: 注入
  {
    const { q, restore } = fakeClaudeSdk();
    let asked = 0;
    try {
      const done = claude.runTurn({ prompt: "p", sessionId: null, cwd: process.cwd(), mode: "default", locale: "ja", emit: () => {},
        askPermission: async () => { asked++; return { allow: false }; }, signal: new AbortController(), control: {}, hostSessionId: "host-computer", computerRuntime: runtime });
      done.catch(() => {});
      for (let i = 0; i < 200 && !q.options; i++) await sleep(5);
      const server = q.options?.mcpServers?.ply_computer;
      t.ok("Claude: mcpServers に ply_computer（http・Bearer・timeout 660000）", server?.type === "http" && server.url === runtime.url && server.headers?.Authorization === runtime.headers.Authorization && server.timeout === 660_000, JSON.stringify(server));
      t.ok("Claude: 指示文を systemPrompt.append に足す", q.options?.systemPrompt?.append?.includes("COMPUTER-COMMON-INSTRUCTIONS"), JSON.stringify(q.options?.systemPrompt ?? null).slice(0, 200));
      const decision = await q.options?.canUseTool?.("mcp__ply_computer__left_click", { coordinate: [1, 2] }, { signal: new AbortController().signal, suggestions: [] });
      t.ok("Claude: ply_computer はツールごとに聞かずに allow（アプリの承認は橋で行う）", decision?.behavior === "allow" && asked === 0, JSON.stringify(decision));
      const other = await q.options?.canUseTool?.("mcp__other__left_click", {}, { signal: new AbortController().signal, suggestions: [] });
      t.ok("Claude: 名前の似た別のサーバーのツールは今までどおり聞く", other?.behavior === "deny" && asked === 1, JSON.stringify(other));
      t.ok("Claude: capabilities.computerUse は inline・分けない", claude.capabilities.computerUse?.images === "inline" && claude.capabilities.computerUse?.waitSliceMs === null);
      q.finish();
      await Promise.race([done.catch(() => {}), sleep(3000)]);
    } finally { restore(); }
  }
  {
    const { q, restore } = fakeClaudeSdk();
    try {
      const done = claude.runTurn({ prompt: "p", sessionId: null, cwd: process.cwd(), mode: "default", locale: "ja", emit: () => {}, askPermission: async () => ({ allow: true }), signal: new AbortController(), control: {}, hostSessionId: "host-computer-2" });
      done.catch(() => {});
      for (let i = 0; i < 200 && !q.options; i++) await sleep(5);
      t.ok("Claude: computerRuntime が無ければ ply_computer も指示文も足さない", q.options && !q.options.mcpServers?.ply_computer && !String(q.options.systemPrompt?.append ?? "").includes("COMPUTER-COMMON"), Object.keys(q.options?.mcpServers ?? {}).join(","));
      q.finish();
      await Promise.race([done.catch(() => {}), sleep(3000)]);
    } finally { restore(); }
  }

  // ---- Codex: 注入とライブの正規化（rpc の身代わり）
  const computerItem = { type: "mcpToolCall", id: "mcp-1", server: "ply_computer", tool: "screenshot", status: "completed", arguments: { title: "画面を確かめる" },
    result: { content: [{ type: "text", text: SHOT_TEXT }, { type: "image", mimeType: "image/jpeg", data: IMAGE }], isError: false } };
  const typeItem = { type: "mcpToolCall", id: "mcp-2", server: "ply_computer", tool: "type", status: "completed", arguments: { title: "入力", text: "password=hunter2" },
    result: { content: [{ type: "text", text: "止めました\n[ply_computer] {\"v\":1,\"tool\":\"type\",\"state\":\"stopped\",\"reason\":\"escape\",\"title\":\"入力\"}" }], isError: true } };
  const otherItem = { type: "mcpToolCall", id: "mcp-3", server: "other", tool: "screenshot", status: "completed", arguments: {}, result: { content: [{ type: "text", text: SHOT_TEXT }] } };
  const originals = { request: rpc.request, attach: rpc.attach, claimOrphan: rpc.claimOrphan };
  const requests = [];
  let handlers;
  rpc.attach = (_id, h) => { handlers = h; return () => {}; };
  rpc.claimOrphan = (h) => { handlers = h; return () => {}; };
  rpc.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "computer-thread" } };
    if (method === "mcpServerStatus/list") return { data: [{ name: "ply_computer", tools: {} }] };
    if (method !== "turn/start") throw new Error(method);
    queueMicrotask(() => {
      for (const item of [computerItem, typeItem, otherItem]) {
        handlers.onNotification("item/started", { item: { ...item, status: "inProgress", result: null }, turnId: "t" });
        handlers.onNotification("item/completed", { item, turnId: "t" });
      }
      handlers.onNotification("turn/completed", { turn: { id: "t", status: "completed" } });
    });
    return { turn: { id: "t" } };
  };
  try {
    const events = [];
    await codex.runTurn({ prompt: "fixture", cwd: process.cwd(), mode: "default", locale: "ja", emit: (e) => events.push(e), computerRuntime: runtime });
    const start = requests.find((r) => r.method === "thread/start")?.params;
    t.ok("Codex: thread/start の config に ply_computer と同梱を切るキー", start?.config?.["mcp_servers.ply_computer"]?.tool_timeout_sec === 660 && start.config["plugins.computer-use@openai-bundled.enabled"] === false
      && start.config["plugins.unified-computer-use@openai-bundled.enabled"] === false, JSON.stringify(start?.config ?? null).slice(0, 400));
    t.ok("Codex: developerInstructions に共通の文と Codex での呼び方", start?.developerInstructions?.includes("COMPUTER-COMMON-INSTRUCTIONS") && start.developerInstructions.includes("tool_search"), String(start?.developerInstructions ?? "").slice(-300));
    t.ok("Codex: 同梱の computer use が切れたかを mcpServerStatus/list で確かめる", requests.some((r) => r.method === "mcpServerStatus/list" && r.params?.threadId === "computer-thread"));
    const starts = events.filter((e) => e.type === "tool.start"), results = events.filter((e) => e.type === "tool.result");
    t.ok("Codex: ply_computer の mcpToolCall は mcp__ply_computer__<ツール> と引数で出す。他のサーバーは今までどおり", starts[0]?.name === "mcp__ply_computer__screenshot" && starts[0]?.input?.title === "画面を確かめる"
      && starts[2]?.name === "mcpToolCall" && starts[2]?.input?.server === "other", JSON.stringify(starts.map((e) => [e.name, e.input])));
    t.ok("Codex: type の入力の秘密を伏せる", starts[1]?.name === "mcp__ply_computer__type" && !starts[1].input.text.includes("hunter2"), JSON.stringify(starts[1]?.input));
    t.ok("Codex: 結果は text ブロックだけ。base64 を捨て、印の行から images と computer", results[0]?.images?.[0]?.url === `/computer-shot/${SHOT}.jpg` && results[0]?.text === "ディスプレイ 1 / 1・1460×821"
      && results[0]?.isError === false && results[0]?.truncated === false && !JSON.stringify(results[0]).includes(IMAGE.slice(0, 40)), JSON.stringify(results[0]).slice(0, 300));
    t.ok("Codex: 止められた結果は isError で、理由は computer に残る", results[1]?.isError === true && results[1]?.computer?.reason === "escape", JSON.stringify(results[1]));
    t.ok("Codex: 他のサーバーの結果は今までどおり JSON を切ったもの", results[2]?.text?.startsWith("{") && !results[2].images, JSON.stringify(results[2]).slice(0, 200));
    t.ok("Codex: capabilities.computerUse は inline・分けない", codex.capabilities.computerUse?.images === "inline" && codex.capabilities.computerUse?.waitSliceMs === null);

    requests.length = 0;
    await codex.runTurn({ prompt: "fixture", cwd: process.cwd(), mode: "default", locale: "ja", emit: () => {} });
    const plain = requests.find((r) => r.method === "thread/start")?.params;
    t.ok("Codex: computerRuntime が無ければ config にも指示にも足さない（利用者の ~/.codex に任せる）", plain && !Object.keys(plain.config).some((k) => k.includes("computer")) && !String(plain.developerInstructions ?? "").includes("COMPUTER-COMMON")
      && !requests.some((r) => r.method === "mcpServerStatus/list"), JSON.stringify(Object.keys(plain?.config ?? {})));
  } finally { Object.assign(rpc, originals); }

  // ---- Codex: 履歴
  const messages = threadToMessages({ turns: [{ id: "t", items: [computerItem, typeItem, { type: "agentMessage", id: "a", text: "done" }] }] });
  const [c1, c2] = messages[0]?.toolCalls ?? [];
  t.ok("Codex 履歴: 同じ名前・印からの images・伏せた入力", c1?.name === "mcp__ply_computer__screenshot" && c1.result?.images?.[0]?.shot === SHOT && c2?.name === "mcp__ply_computer__type" && !c2.input.text.includes("hunter2"),
    JSON.stringify(messages[0]?.toolCalls ?? null).slice(0, 300));
  const full = threadToMessages({ turns: [{ id: "t", items: [computerItem, { type: "agentMessage", id: "a", text: "done" }] }] }, { fullResults: true });
  t.ok("Codex 履歴（全文）: 画像の base64 を入れず、印を除いた本文", full[0]?.toolCalls?.[0]?.result?.text === "ディスプレイ 1 / 1・1460×821", JSON.stringify(full[0]?.toolCalls?.[0]?.result ?? null).slice(0, 200));

  // ---- Antigravity（別プロセス）
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, "tests/lib/agy-computer-worker.mjs")], { timeout: 120_000 });
  let checks = [];
  try { checks = JSON.parse(stdout); } catch { t.ok("agy: worker の結果が読める", false, stdout.slice(0, 500)); return; }
  t.ok("agy: worker の判定が揃う", checks.length >= 16, `${checks.length} 件`);
  for (const c of checks) t.ok(`agy: ${c.label}`, c.pass, c.detail);
}
