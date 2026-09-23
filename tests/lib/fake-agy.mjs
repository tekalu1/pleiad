// `agy` の身代わり。ヘッドレスの stream-json（NDJSON）を話す。
//
// 本物の `agy` は 190MB の単一バイナリで、Google のサブスクへのログインが要る。
// テストで測りたいのは **core/backends/antigravity.mjs の写し替え**（step_update -> 正規化
// イベント、ツールの ACTIVE / DONE、出力の打ち切り、result の status、控えの書き出し、
// 認可コードの受け渡し）なので、
// プロトコルの形だけを真似た台本を返す。
//
// イベントの形は公式ドキュメントと、実機（agy 1.2.4 / windows-x64）で観測した
// `result` の形から取っている。**推測で足していない**。
//
// 使い方: AGENT_HOST_AGY_BIN="node tests/lib/fake-agy.mjs" で antigravity-cli.mjs から起動される。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const NL = String.fromCharCode(10);

const argv = process.argv.slice(2);
// 起こされた pid を控える。**呼び出し側が落としたかどうか**をテストから見るため
if (process.env.FAKE_AGY_PID_FILE) {
  try {
    const file = process.env.FAKE_AGY_PID_FILE;
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    list.push(process.pid);
    fs.writeFileSync(file, JSON.stringify(list));
  } catch {}
}
if (process.env.FAKE_AGY_ARGS_FILE) {
  try {
    const file = process.env.FAKE_AGY_ARGS_FILE;
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    list.push(argv);
    fs.writeFileSync(file, JSON.stringify(list));
  } catch {}
}
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : null;
};
const has = (name) => argv.includes(name);

if (has('--version')) {
  console.log('1.2.5');
  process.exit(0);
}
if (flag('--print') === '/usage') {
  console.log(JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { window: 'weekly', remaining_fraction: .9, reset_time: '2030-09-23T06:31:30Z' },
      { window: '5h', remaining_fraction: 1, reset_time: '2030-09-17T19:59:24Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: 0 }] },
  ] } } }));
  process.exit(0);
}

// 未ログインの再現。本物の資格情報は OS の資格情報ストアに残り、**プロセスをまたいで効く**。
// 身代わりは印のファイルで同じことをする（`agy models` は別プロセスで走るので、
// ここが無いと「ログインしたのに次の確認で未ログイン」になってしまう）。
const authFile = process.env.FAKE_AGY_AUTH_FILE || null;
const signedIn = () => Boolean(authFile && fs.existsSync(authFile));
const needsAuth = process.env.FAKE_AGY_NEEDS_AUTH === "1" && !signedIn();
let authorized = !needsAuth;

// `agy models` は別のサブコマンド（ヘッドレスではない）。ログイン判定がここを通る。
// 本物は未ログインだと「Please sign in …」で落ち、ログイン済みなら 1 行 1 モデルを出す
if (argv.includes("models")) {
  if (process.env.FAKE_AGY_NEEDS_AUTH === "1" && !signedIn()) {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in." + NL);
    process.exit(1);
  }
  // 本物（1.2.8）は `id<TAB>表示名`。段違いは別の id で並ぶ（core/backends/antigravity-models.mjs）
  const TAB = String.fromCharCode(9);
  process.stdout.write(["Fetching available models...",
    "fake-antigravity-1" + TAB + "Fake Antigravity 1",
    "fake-antigravity-2" + TAB + "Fake Antigravity 2 (Thinking)",
    "fake-flash-high" + TAB + "Fake Flash (High)",
    "fake-flash-low" + TAB + "Fake Flash (Low)",
  ].join(NL) + NL);
  // 本物は起動のたびにログへ選ばれているモデルの表示名を書く（Pleiad はここから既定を読む）。
  // FAKE_AGY_DEFAULT_LABEL が空なら書かない（既定が分からない場合の再現）
  const logFile = flag("--log-file");
  const label = process.env.FAKE_AGY_DEFAULT_LABEL ?? "Fake Flash (High)";
  if (logFile && label) fs.writeFileSync(logFile, `I0923 03:02:52.462073       1 model_config_manager.go:327] Propagating selected model override to backend: label="${label}"` + NL);
  process.exit(0);
}

// 本物は `--print=`（空値）を要る。`--print` 単体だと次のフラグを prompt として飲み込む。
// 身代わりでも同じ約束を守らせて、呼び出し側の組み立てが崩れたら気づけるようにする
if (!argv.includes("--print=")) {
  process.stderr.write(`Error: --print took "${argv[0] ?? ""}" as its prompt.` + NL);
  process.exit(2);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + NL);

// 既存会話の再開なら id を引き継ぐ。新規なら採番する（本物はサーバ側が決める）
let conversationId = flag("--conversation") ?? randomUUID();
let started = false;

let pendingPrompt = null;

const AUTH_URL = "https://accounts.google.com/o/oauth2/auth?client_id=fake&code_challenge=fake&state=fake";

function emitInit() {
  if (started) return;
  started = true;
  send({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: process.cwd(),
      tools: ["run_command", "read_file"],
      permission_mode: has("--dangerously-skip-permissions") ? "skip" : (flag("--mode") ?? "default"),
      model: flag("--model") ?? "fake-antigravity-1",
      agent: flag("--agent") ?? "default",
    },
  });
}

const step = (body) => send({ event: "step_update", step_update: { conversation_id: conversationId, ...body } });

let stepIndex = 0;

// ---- カスタムエージェント（`--agent`）--------------------------------------
//
// 本物（agy 1.2.7）で観測したとおりに真似る（報告書 temporary/reports/mcp-auth-agents.md）:
//   - `--agent <名前>` はワークスペース（cwd と `--add-dir`）の `.agents/agents/<名前>/agent.md` を探す。
//     無ければ stderr に「not found, falling back to default」を出して既定のエージェントで動く
//   - frontmatter の `mcpServers`（リスト）の stdio MCP は、最初のプロンプトで起動する。agy の env を引き継ぐ
//   - 最初に `server/discover` を送る（知らない MCP は断る）。続けて initialize / initialized / tools/list
// frontmatter は Pleiad が書く形（1 行 1 キー、値は JSON か素の文字列）だけを読む。
const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
const agentName = flag("--agent");
const customAgent = (() => {
  if (!agentName) return null;
  for (const root of [process.cwd(), ...addDirs]) {
    const file = path.join(root, ".agents", "agents", agentName, "agent.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, NL);
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) return null;
    const front = {};
    for (const line of match[1].split(NL)) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const raw = line.slice(at + 1).trim();
      try { front[line.slice(0, at).trim()] = JSON.parse(raw); } catch { front[line.slice(0, at).trim()] = raw; }
    }
    return { file, front, body: match[2].trim() };
  }
  process.stderr.write(`Agent "${agentName}" not found, falling back to default` + NL);
  return null;
})();
if (process.env.FAKE_AGY_AGENT_FILE) {
  try {
    fs.writeFileSync(process.env.FAKE_AGY_AGENT_FILE, JSON.stringify({
      agent: agentName, found: Boolean(customAgent), file: customAgent?.file ?? null, front: customAgent?.front ?? null, body: customAgent?.body ?? null,
      authorization: process.env.PLY_CONTEXT_AUTHORIZATION ?? null, url: process.env.PLY_CONTEXT_URL ?? null,
    }));
  } catch {}
}

/** 起動した MCP。{ name, call(method, params) }。最初のプロンプトで 1 回だけ起こす */
let mcpServers = null;
async function startMcp() {
  if (mcpServers) return mcpServers;
  mcpServers = [];
  const { spawn } = await import("node:child_process");
  for (const spec of Array.isArray(customAgent?.front?.mcpServers) ? customAgent.front.mcpServers : []) {
    const child = spawn(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
    const waiting = new Map();
    let buffer = "", next = 1;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf(NL)) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch {}
      }
    });
    const call = (method, params) => new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + NL);
    });
    await call("server/discover");
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NL);
    const listed = await call("tools/list", {});
    mcpServers.push({ name: spec.serverName, call, tools: listed.result?.tools ?? [], child });
  }
  return mcpServers;
}
process.on("exit", () => { for (const s of mcpServers ?? []) { try { s.child.kill(); } catch {} } });

/** カスタムエージェントの確認用の台本。返事の本文を返す。該当しなければ null */
async function agentScript(text) {
  if (text === "agent-body") return customAgent?.body ?? "(no agent)";
  if (!/^mcp-(tools|call:)/.test(text)) return null;
  const servers = await startMcp();
  if (text === "mcp-tools") return JSON.stringify(servers.flatMap((s) => s.tools.map((t) => ({ server: s.name, name: t.name, description: t.description ?? "" }))));
  // mcp-call:<ツール名または説明の一部> [JSON の引数]
  const [, key, json] = /^mcp-call:(\S+(?: \/ \S+)?)(?: (\{.*\}))?$/.exec(text) ?? [];
  const server = servers.find((s) => s.tools.some((t) => t.name === key || (t.description ?? "").includes(`[${key}]`)));
  const tool = server?.tools.find((t) => t.name === key || (t.description ?? "").includes(`[${key}]`));
  if (!tool) return `no-tool:${key}`;
  const index = ++stepIndex;
  step({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: server.name, ToolName: tool.name } } });
  const reply = await server.call("tools/call", { name: tool.name, arguments: json ? JSON.parse(json) : {} });
  const output = reply.error ? `error:${reply.error.message}` : (reply.result?.content ?? []).map((c) => c.text ?? "").join("");
  step({ step_index: index, state: "DONE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: server.name, ToolName: tool.name }, output } });
  return `mcp:${output}`;
}

async function runTurn(text) {
  emitInit();

  // カスタムエージェントの確認（agent-body / mcp-tools / mcp-call:…）。本文だけ返して終える
  const scripted = await agentScript(text);
  if (scripted !== null) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: scripted });
    step({ step_index: stepIndex, state: "DONE", step_type: "agent_response" });
    return send({
      event: "result",
      result: {
        conversation_id: conversationId, status: "SUCCESS", response: scripted, duration_seconds: 0.1, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
      },
    });
  }

  // 中断を測るための、終わらないターン
  if (text.startsWith("slow")) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: "待つ" });
    return;   // result を出さない。呼び出し側は kill するしかない
  }

  // **出力の打ち切り**（`--print-timeout`、既定 5m0s）。実機の観測どおり、
  // stderr に文言を出し、**本文が空のまま status:"SUCCESS"** / usage 全 0 の result を吐く。
  // そして**ターンは裏で続く**ので、ここでは落ちない（呼び出し側が落とすのが正しい）
  // 実機は印を先に書くが、stderr と stdout は別のパイプなので、読む側に着く順は保証されない
  // （Linux の CI では result が先に読まれて落ちた）。**遅い側の順（result が先）**で出し、
  // 印が遅れて着いても空の SUCCESS を ok にしないことを確かめる
  if (text.startsWith("timeout")) {
    send({
      event: "result",
      result: {
        conversation_id: conversationId, status: "SUCCESS", response: "",
        duration_seconds: 0, num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    process.stderr.write("[agy] print timeout after 5m0s with turn in progress; returning partial output" + NL);
    return;
  }

  // 送信と完了で時刻が変わることを測るための、少しかかるターン（delay / delay500）
  const slowly = /^delay(\d+)?/.exec(text);
  if (slowly) await new Promise((r) => setTimeout(r, Number(slowly[1] ?? 300)));

  if (text.startsWith("fail")) {
    return send({
      event: "result",
      result: {
        conversation_id: conversationId, status: "ERROR", response: "",
        error: "agy が失敗した", duration_seconds: 0, num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      },
    });
  }

  // 本文は**真のデルタ**で流れる（state: ACTIVE を繰り返し、最後に DONE）
  const body = `了解: ${text}`;
  for (const chunk of body.match(/[\s\S]{1,4}/g) ?? []) {
    step({ step_index: ++stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: chunk });
    await new Promise((r) => setTimeout(r, 1));
  }
  step({ step_index: stepIndex, state: "DONE", step_type: "agent_response" });

  // **ツールは同じ step_index で 2 回来る**（実機の観測）。
  // 1 回目 ACTIVE は `tool_info.output` を持たず、2 回目 DONE で出力が入る
  const toolStep = ++stepIndex;
  step({
    step_index: toolStep, state: "ACTIVE", step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo hello" } },
  });
  await new Promise((r) => setTimeout(r, 1));
  step({
    step_index: toolStep, state: "DONE", step_type: "tool",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { CommandLine: "echo hello" },
      output: "hello\r\n",
    },
  });

  // 会話には出さない step（実機では user_input が DONE だけで来る）
  step({ step_index: ++stepIndex, state: "DONE", step_type: "user_input" });

  send({
    event: "result",
    result: {
      conversation_id: conversationId, status: "SUCCESS", response: body,
      duration_seconds: 0.2, num_turns: 1,
      usage: { input_tokens: 11, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 2, total_tokens: 23 },
    },
  });
}

// ---- stdin -----------------------------------------------------------------
//
// 1 行 1 プロンプト、1 行につき 1 ターン。未ログインなら最初の行で認証に入り、
// **認可コードも同じ stdin で**受ける（本物と同じ）。

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;

    // **プロンプトと認可コードは別経路。** 本物は stream-json の読み手がプロンプト行を食べ、
    // 認可コードはコンソールの読み取りで受ける（実機では、パイプで渡したプロンプト行が
    // 認可コード扱いにはならず、コードの入力待ちで時間切れになった）。
    // ここでも JSON として読めた行はプロンプト、読めない行を認可コードとして扱う
    let msg = null;
    try { msg = JSON.parse(line); } catch {}

    if (msg === null) {
      if (authorized) continue;   // 認証済みなら素の行は捨てる
      if (line === "fake-auth-code") {
        authorized = true;
        // 資格情報が残った、の印。次に起きるプロセス（`agy models` など）から見える
        if (authFile) { try { fs.mkdirSync(path.dirname(authFile), { recursive: true }); fs.writeFileSync(authFile, "ok"); } catch {} }
        const queued = pendingPrompt;
        pendingPrompt = null;
        if (queued) runTurn(queued);
      } else {
        process.stderr.write("Error: authentication failed." + NL);
        send({
          event: "result",
          result: {
            conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out",
            duration_seconds: 0, num_turns: 0,
            usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
          },
        });
      }
      continue;
    }

    if (msg?.event !== "user") continue;
    const content = msg.message?.content;
    const text = typeof content === "string"
      ? content
      : (content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");

    if (needsAuth && !authorized) {
      pendingPrompt = text;
      continue;
    }
    runTurn(text);
  }
});

// 未ログインなら、最初の入力を待たずに URL を出す（本物もターンを起こした時点で出す）
if (needsAuth) {
  process.stderr.write(
    "Authentication required. Please visit the URL to log in:" + NL
    + "  " + AUTH_URL + NL
    + "Waiting for authentication (timeout 60s)..." + NL
    + "Or, paste the authorization code here and press Enter:" + NL,
  );
}

// 親が消えたら道連れになる。stdin が閉じたことを終了の合図にする
// （本物も「stdin を閉じると走っているターンを終えてから落ちる」）
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
