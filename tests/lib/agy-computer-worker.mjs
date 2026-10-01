// antigravity に ply_computer を渡すこと（core/backends/antigravity.mjs の runTurn と core/agy-context-relay.mjs --computer）を、別プロセスで確かめる。
// 橋の代わりに小さな HTTP の MCP を立て、偽の agy（tests/lib/fake-agy.mjs）が agent.md の 2 本目の中継を起こしてそこへ呼ぶ。
// バックエンドを読み込むだけで置き場（AGENT_HOST_DATA）の孤児の掃除が走るので、置き場を一時ディレクトリにしてから読み込む。
// 判定は { label, pass, detail } の配列を JSON で stdout に出す（tests/unit/computer-delivery.mjs が t.ok にする）
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-computer-")));
const agentFile = path.join(scratch, "agent.json");
process.env.AGENT_HOST_DATA = path.join(scratch, "data");
process.env.AGENT_HOST_AGY_BIN = `node "${path.join(ROOT, "tests", "lib", "fake-agy.mjs")}"`;
process.env.FAKE_AGY_AGENT_FILE = agentFile;

const { backend } = await import("../../core/backends/antigravity.mjs");

const checks = [];
const ok = (label, pass, detail = "") => checks.push({ label, pass: Boolean(pass), detail: String(detail) });

// 橋の身代わり。tools/list は接頭辞の無い名前、tools/call は受けた名前と引数を覚え、印の行と画像を返す
const token = crypto.randomBytes(32).toString("hex");
const shot = "0123456789abcdef0123456789abcdef";
const calls = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
  const m = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (m.id === undefined) { res.writeHead(202); return res.end(); }
  const result = m.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ply_computer", version: "1" }, instructions: "x" }
    : m.method === "tools/list" ? { tools: [{ name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } }, { name: "type", description: "Type text", inputSchema: { type: "object" } }] }
    : m.method === "tools/call" ? (calls.push(m.params), m.params.name === "screenshot"
      ? { content: [{ type: "text", text: `ディスプレイ 1 / 1・1460×821\nスクリーンショットの保存先: C:/data/computer-use/shots/${shot}.jpg\n[ply_computer] {"v":1,"tool":"screenshot","state":"ok","title":"画面を確かめる","shot":"${shot}","w":1460,"h":821,"display":1}` }, { type: "image", mimeType: "image/jpeg", data: "/9j/AAAA" }] }
      : { content: [{ type: "text", text: `ユーザーがコンピューターの操作を止めました。\n[ply_computer] {"v":1,"tool":"type","state":"stopped","reason":"escape","title":"金額を入力"}` }], isError: true })
    : {};
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const computerRuntime = { url: `http://127.0.0.1:${server.address().port}/mcp/computer`, headers: { Authorization: `Bearer ${token}` }, instructions: "COMPUTER-COMMON-INSTRUCTIONS" };

function turn({ prompt, sessionId = null, runtime = computerRuntime }) {
  const events = [];
  return backend.runTurn({
    prompt, sessionId, cwd: os.tmpdir(), mode: "yolo", model: "", effort: "", locale: "ja",
    emit: (e) => events.push(e), signal: new AbortController(), control: null, computerRuntime: runtime,
  }).then((result) => ({ result, events }), (error) => ({ error, events }));
}

try {
  ok("capabilities.computerUse は images: path・150 秒ごとに分ける", backend.capabilities.computerUse?.images === "path" && backend.capabilities.computerUse?.waitSliceMs === 150_000,
    JSON.stringify(backend.capabilities.computerUse));

  // ---- 1. agent.md に 2 本目の中継、env に接続先。指示文に共通の文と agy での呼び方
  const first = await turn({ prompt: "mcp-tools" });
  const recorded = JSON.parse(await fs.readFile(agentFile, "utf8").catch(() => "null"));
  const servers = recorded?.front?.mcpServers ?? [];
  const computer = servers.find((s) => s.serverName === "ply_computer");
  ok("computerRuntime があればカスタムエージェントを使う", recorded?.agent === "ply-context" && recorded?.found === true, JSON.stringify(recorded?.agent));
  ok("agent.md の mcpServers に ply_computer の中継（--computer）を足す", computer && computer.args?.at(-1) === "--computer" && /agy-context-relay\.mjs$/.test(computer.args?.[0] ?? ""), JSON.stringify(servers));
  ok("ply_context が無いときは ply_computer だけ", servers.length === 1, JSON.stringify(servers.map((s) => s.serverName)));
  ok("接続先とトークンはファイルに書かず env で渡す", recorded?.computerUrl === computerRuntime.url && recorded?.computerAuthorization === computerRuntime.headers.Authorization
    && !JSON.stringify(recorded?.front ?? {}).includes(token) && !String(recorded?.body ?? "").includes(token), JSON.stringify({ url: recorded?.computerUrl }));
  ok("指示文に共通の文と、agy での呼び方（接頭辞・view_file）を書く", String(recorded?.body ?? "").includes("COMPUTER-COMMON-INSTRUCTIONS") && String(recorded?.body ?? "").includes("ply_computer_screenshot") && String(recorded?.body ?? "").includes("view_file"),
    String(recorded?.body ?? "").slice(-400));
  const listed = JSON.parse(first.events.filter((e) => e.type === "text.delta").map((e) => e.text).join("") || "[]");
  ok("中継はツール名に ply_computer_ を付けて見せる", listed.map((x) => x.name).join(",") === "ply_computer_screenshot,ply_computer_type", JSON.stringify(listed));

  // ---- 2. 呼び出し: 接頭辞を外して橋へ、正規化は mcp__ply_computer__<名前>、印の行から images と computer
  const sid = first.events.find((e) => e.type === "session")?.sessionId;
  const shotTurn = await turn({ prompt: 'mcp-call:ply_computer_screenshot {"title":"画面を確かめる"}', sessionId: sid });
  ok("橋には接頭辞の無い名前と引数が届く", calls[0]?.name === "screenshot" && calls[0]?.arguments?.title === "画面を確かめる", JSON.stringify(calls[0]));
  const start = shotTurn.events.find((e) => e.type === "tool.start");
  const done = shotTurn.events.find((e) => e.type === "tool.result");
  ok("tool.start は mcp__ply_computer__screenshot と引数", start?.name === "mcp__ply_computer__screenshot" && start?.input?.title === "画面を確かめる" && !("ToolName" in (start?.input ?? {})), JSON.stringify(start));
  ok("tool.result は印の行から images と computer を作る", done?.images?.[0]?.url === `/computer-shot/${shot}.jpg` && done?.computer?.tool === "screenshot" && done?.computer?.state === "ok" && done?.isError === false, JSON.stringify(done));
  ok("tool.result の text から印の行と退避先の行を除く", done && !done.text.includes("[ply_computer]") && !done.text.includes("Resource offloaded") && done.text.startsWith("ディスプレイ 1 / 1"), JSON.stringify(done?.text));
  ok("同じ会話のまま 1 本の agy を使い回す（接続先が同じ）", !shotTurn.error, String(shotTurn.error ?? ""));

  // ---- 3. 止められた結果は isError。type の文字列は秘密の形を伏せる。控えにも同じ形で残る
  const typeTurn = await turn({ prompt: 'mcp-call:ply_computer_type {"title":"金額を入力","text":"password=hunter2"}', sessionId: sid });
  const typed = typeTurn.events.find((e) => e.type === "tool.start");
  const stopped = typeTurn.events.find((e) => e.type === "tool.result");
  ok("type の入力の秘密を伏せる（画面へ流す tool.start）", typed?.input?.text && !typed.input.text.includes("hunter2"), JSON.stringify(typed?.input));
  ok("止められた結果は isError で、理由は computer に残る", stopped?.isError === true && stopped?.computer?.state === "stopped" && stopped?.computer?.reason === "escape", JSON.stringify(stopped));
  const record = JSON.parse(await fs.readFile(path.join(process.env.AGENT_HOST_DATA, "antigravity", `${sid}.json`), "utf8").catch(() => "null"));
  const savedCalls = (record?.messages ?? []).flatMap((m) => m.toolCalls ?? []);
  const savedShot = savedCalls.find((c) => c.name === "mcp__ply_computer__screenshot");
  ok("控えに images と computer の付いた結果を残す（読み直しでも同じに出る）", savedShot?.result?.images?.[0]?.shot === shot && savedShot?.result?.computer?.state === "ok", JSON.stringify(savedShot ?? record ?? null).slice(0, 400));

  // ---- 4. computerRuntime を外した次のターンは agy を起こし直し、ply_computer を渡さない
  const plain = await turn({ prompt: "mcp-tools", sessionId: sid, runtime: null });
  const again = JSON.parse(await fs.readFile(agentFile, "utf8").catch(() => "null"));
  ok("渡さなくなったら起こし直し、中継も env も無い", !plain.error && !(again?.front?.mcpServers ?? []).some((s) => s.serverName === "ply_computer") && again?.computerUrl === null,
    JSON.stringify({ agent: again?.agent, servers: again?.front?.mcpServers, url: again?.computerUrl }));
} catch (error) {
  ok("worker が最後まで走る", false, String(error?.stack ?? error));
} finally {
  server.close();
  // 生かしている agy は exit のフックが落とす（core/backends/antigravity.mjs）
  process.stdout.write(JSON.stringify(checks));
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  process.exit(0);
}
