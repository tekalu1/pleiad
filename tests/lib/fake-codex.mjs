// `codex app-server` の身代わり。stdio で JSON-RPC 2.0（改行区切り）を話す。
//
// 本物の codex は 300MB の実行ファイルで、起動に数秒かかり、ログインとネットワークを要る。
// テストで測りたいのは **core/backends/codex.mjs の写し替え**（通知 -> 正規化イベント、
// 承認の decision、履歴の畳み方）なので、プロトコルの形だけを真似た台本を返す。
//
// method 名・フィールド名・enum は codex app-server の JSON Schema から取っている
// （temporary/codex-schema/。ClientRequest / ServerRequest / ServerNotification）。
//
// 使い方: AGENT_HOST_CODEX_BIN="node tests/lib/fake-codex.mjs" で codex.mjs から起動される。
// 引数の "app-server" は無視する。
import process from "node:process";
import path from "node:path";
import { lines as rl, jsonl, policyRejection, spawnRejection } from "./codex-rollout.mjs";

const NL = String.fromCharCode(10);
const UNIQUE_IDS = process.env.FAKE_CODEX_UNIQUE_IDS === "1";
// FAKE_CODEX_LEGACY=1: 以前に作った legacy のスレッドのふり（thread/revert を断る。codex-cli 0.156.1 の実測）
const LEGACY = process.env.FAKE_CODEX_LEGACY === "1";

const send = (frame) => {
  if (STATE_DIR && frame.method === 'turn/completed') {
    const thread = threads.get(frame.params?.threadId);
    if (thread?.loaded) persist(thread);
  }
  process.stdout.write(JSON.stringify(frame) + NL);
};
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// **Thread / Turn の時刻は秒**（本物の codex がそう返す。スキーマは int64 としか言わない）。
// startedAtMs のように名前に Ms が付くものだけミリ秒。
const secs = () => Math.floor(Date.now() / 1000);

/** JSON-RPC のエラーコードを添えて撥ねる。コードの違いで呼び出し側の扱いが変わる（-32600 = 受け付けない） */
class RpcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

let nextServerId = 0;
let initialized = false;
const serverPending = new Map();   // server -> client request の応答待ち

/** server -> client の request を出して応答を待つ（承認・質問）。 */
function ask(method, params) {
  const id = `s${++nextServerId}`;
  return new Promise((resolve, reject) => {
    serverPending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// ---- 状態（プロセスの寿命だけ持てばよい）
const threads = new Map();   // threadId -> { id, name, cwd, createdAt, updatedAt, forkedFromId, turns }
let seq = 0;
// method ごとの呼ばれた回数（fake/stats）。キャッシュが効いているかを測る
const calls = new Map();
// 古い版のふり（fake/config）。parentFilter: "ignore" = thread/list が parentThreadId を知らずに無視する
let parentFilter = "support";
const account = { loggedIn: true, email: "tester@example.invalid", planType: "pro" };

function makeThread({ cwd, forkedFromId = null, turns = [], parentThreadId = null, spawn = null }) {
  const id = STATE_DIR ? `th_${process.pid}_${++seq}` : `th_${++seq}`;
  const now = secs();
  const t = { id, name: null, cwd: cwd ?? null, createdAt: now, updatedAt: now, forkedFromId, turns, parentThreadId, spawn };
  threads.set(id, t);
  return t;
}

/** Thread をそのまま返す（スキーマの必須フィールドは埋める）。 */
function wire(t, includeTurns) {
  return {
    id: t.id,
    sessionId: t.id,
    cliVersion: "fake",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    cwd: t.cwd,
    ephemeral: false,
    modelProvider: "openai",
    preview: "fake thread",
    projectId: null,
    // サブエージェントの子は source.subAgent.thread_spawn と parentThreadId を持つ（実機の thread/list の行と同じ）
    source: t.spawn ? { subAgent: { thread_spawn: t.spawn } } : "cli",
    status: "idle",
    name: t.name,
    forkedFromId: t.forkedFromId,
    // parentThreadId を知らない古い版は、このフィールド自体を返さない
    ...(parentFilter === "ignore" ? {} : { parentThreadId: t.parentThreadId }),
    ...(t.spawn ? { agentNickname: t.spawn.agent_nickname, agentRole: t.spawn.agent_role } : {}),
    turns: includeTurns ? t.turns : [],
    // rollout の置き場（[UNSTABLE] Thread.path）。FAKE_CODEX_ROLLOUT_DIR があるときだけ
    path: t.path ?? null,
  };
}

// ---- rollout（FAKE_CODEX_ROLLOUT_DIR）。本物と同じく、最初のターンで初めてファイルができる
const writeRollout = (t, rows) => {
  if (!t.path) return;
  if (!fs.existsSync(t.path)) fs.appendFileSync(t.path, jsonl([{ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cli_version: '0.156.1' } }]));
  fs.appendFileSync(t.path, jsonl(rows));
};

/**
 * 実行前に拒否されるターン（承認なしのモード。承認は求めない）。拒否はアイテムにならず、通知にも thread/read にも出ない。
 * rollout にだけ残る（codex-cli 0.156.1 の形。tests/lib/codex-rollout.mjs）。
 *   reject        code mode の exec の拒否（秘密を含むコマンド）+ wait に出たプロセス作成の失敗 + 引用されただけの文
 *   reject-direct exec_command を直接呼んで拒否
 *   reject-ask    同じ call id の承認を求めてから拒否（approvalRequested）
 *   reject-late   出力とターンの終わりの行を turn/completed の後に書く（書き込みの遅れ）
 */
async function runRejectTurn(t, turnId, text) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  const kind = text.split(/\s/)[0];
  const n = ++seq;
  const script = `Remove-Item -LiteralPath 'C:\\work\\tmp\\cache-${n}.bin' -Force`;
  const head = [rl.taskStarted(turnId), rl.userMessage(turnId, text)];
  let body = [], late = [];
  if (kind === "reject-direct") {
    body = [rl.directCall(turnId, `call_direct_${n}`, script), rl.directOutput(turnId, `call_direct_${n}`, policyRejection(script))];
  } else if (kind === "reject-ask") {
    try {
      await ask("item/commandExecution/requestApproval", {
        threadId: t.id, turnId, itemId: `call_ask_${n}`, command: script, cwd: t.cwd ?? ".",
        startedAtMs: Date.now(), approvalId: null, reason: "テスト用の承認",
      });
    } catch { /* 答えによらず拒否する */ }
    body = [rl.codeCall(turnId, `call_ask_${n}`, script), rl.codeOutput(turnId, `call_ask_${n}`, policyRejection(script))];
  } else if (kind === "reject-late") {
    body = [rl.codeCall(turnId, `call_late_${n}`, script)];
    late = [rl.codeOutput(turnId, `call_late_${n}`, policyRejection(script))];
  } else {
    const secret = 'Stop-Process -Id 4242; curl.exe -H "Authorization: Bearer fake-token-0123456789" "https://user:pass@example.invalid/x?token=abc&q=1"';
    body = [
      rl.codeCall(turnId, `call_code_${n}`, secret), rl.codeOutput(turnId, `call_code_${n}`, policyRejection(secret)),
      rl.waitCall(turnId, `call_wait_${n}`), rl.waitOutput(turnId, `call_wait_${n}`, spawnRejection()),
      rl.codeCall(turnId, `call_quote_${n}`, "gh issue view 24"), rl.quotedOutput(turnId, `call_quote_${n}`, policyRejection("Remove-Item x")),
    ];
  }
  const reply = `拒否された: ${kind}`;
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: reply });
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { id: "it_m1", type: "agentMessage", text: reply } });
  t.turns.push({ id: turnId, status: "completed", startedAt: secs(), completedAt: secs(),
    items: [{ id: `it_u${n}`, type: "userMessage", content: [{ type: "text", text }] }, { id: "it_m1", type: "agentMessage", text: reply }] });
  t.updatedAt = secs();
  const tail = [rl.assistant(turnId, reply), rl.taskComplete(turnId)];
  if (late.length) {
    writeRollout(t, [...head, ...body]);
    setTimeout(() => writeRollout(t, [...late, ...tail]), 150);
  } else writeRollout(t, [...head, ...body, ...tail]);
  notify("turn/completed", { threadId: t.id, turn: { id: turnId, items: [], status: "completed", startedAt: secs(), completedAt: secs() } });
}

/** 親の turn に残る subAgentActivity（rollout と thread/read の形。kind=started の id は spawn の call id） */
const activityItem = (id, kind, child, agentPath) =>
  ({ id, type: "subAgentActivity", kind, agentThreadId: child.id, agentPath });

// ---- 1ターンの台本 ---------------------------------------------------------
//
//   本文の delta を数回
//   -> commandExecution を item/started -> requestApproval -> item/completed
//   -> turn/completed
//
// 承認を拒否されたら status: "declined" のまま完了させる（本物と同じ形）。
async function runTurn(t, turnId, text) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  emitHookRuns(t, turnId);

  // 思考（要約）。thinking.start / thinking.delta に写るはず
  notify("item/reasoning/summaryTextDelta", {
    threadId: t.id, turnId, itemId: "it_r1", summaryIndex: 0, delta: "考えている",
  });

  const body = `了解: ${text}`;
  for (const chunk of body.match(/[\s\S]{1,4}/g) ?? []) {
    notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: chunk });
    await wait(1);
  }

  // ---- ツール（承認あり）
  const itemId = "it_c1";
  const started = {
    id: itemId, type: "commandExecution", command: "echo hi", commandActions: [],
    cwd: t.cwd ?? ".", status: "inProgress",
  };
  notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: started });

  let decision = "decline";
  try {
    const res = await ask("item/commandExecution/requestApproval", {
      threadId: t.id, turnId, itemId, command: "echo hi", cwd: t.cwd ?? ".",
      startedAtMs: Date.now(), approvalId: null, kind: "command", reason: "テスト用の承認",
    });
    decision = typeof res?.decision === "string" ? res.decision : "decline";
  } catch {
    decision = "decline";
  }

  const allowed = decision === "accept" || decision === "acceptForSession";
  const done = {
    ...started,
    status: allowed ? "completed" : "declined",
    aggregatedOutput: allowed ? "hi" : "",
    exitCode: allowed ? 0 : null,
    durationMs: 1,
  };
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: done });

  notify("item/completed", {
    threadId: t.id, turnId, completedAtMs: Date.now(),
    item: { id: "it_m1", type: "agentMessage", text: body },
  });

  notify("thread/tokenUsage/updated", {
    threadId: t.id, turnId,
    tokenUsage: {
      last: { cachedInputTokens: 0, inputTokens: text === 'large-context' ? 49995 : 10, outputTokens: 5,
        reasoningOutputTokens: 2, totalTokens: text === 'large-context' ? 50000 : 15 },
      total: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 },
      modelContextWindow: 200000,
    },
  });

  writeRollout(t, [rl.taskStarted(turnId), rl.userMessage(turnId, text), rl.assistant(turnId, body), rl.taskComplete(turnId)]);

  // 履歴に残す。thread/read {includeTurns:true} で読み直せることを測るため
  t.turns.push({
    id: turnId,
    status: "completed",
    startedAt: secs(),
    completedAt: secs(),
    items: [
      // FAKE_CODEX_UNIQUE_IDS=1: 履歴の item id をターンごとに変える（本物はそう。巻き戻しは item id からターンを引く）
      { id: UNIQUE_IDS ? `it_u_${turnId}` : "it_u1", type: "userMessage", content: [{ type: "text", text }] },
      { id: "it_r1", type: "reasoning", summary: ["考えている"], content: [] },
      done,
      { id: UNIQUE_IDS ? `it_m_${turnId}` : "it_m1", type: "agentMessage", text: body },
      // A boundary created outside Pleiad has no notification or sidecar entry.
      ...(text === 'compact-history' ? [{ id: `history_${turnId}`, type: 'contextCompaction' }] : []),
    ],
  });
  t.updatedAt = secs();

  notify("turn/completed", {
    threadId: t.id,
    turn: { id: turnId, items: [], status: "completed", startedAt: secs(), completedAt: secs() },
  });
}

/** 中断されるまで終わらないターン。abort（turn/interrupt）と途中送信（turn/steer）を測る。 */
const slowTurns = new Map();   // turnId -> { threadId, resolve, record }

async function runSlowTurn(t, turnId, text) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  // 最初のプロンプトも userMessage アイテムとして同じ turn に入る。**clientId は null**
  // （途中送信と見分けるのはここ。Pleiad はこれで誤って「渡った」を出さないことを確かめる）
  const first = { id: `it_u${++seq}`, type: "userMessage", clientId: null, content: [{ type: "text", text: String(text ?? "") }] };
  // 走っている間は履歴（thread/read）に出さない。中断で終わるだけのターンを、
  // 分岐（thread/fork）が「保存済みの履歴」として拾ってしまわないようにする。
  // 途中送信が入ったときだけ、その turn ごと履歴に載せる（turn/steer）
  const record = { id: turnId, status: "inProgress", startedAt: secs(), items: [first] };
  notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: first });
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: first });
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_s1", delta: "待つ" });
  await new Promise((resolve) => slowTurns.set(turnId, { threadId: t.id, resolve, record }));
  record.status = "interrupted";
  record.completedAt = secs();
  notify("turn/completed", {
    threadId: t.id,
    turn: { id: turnId, items: [], status: "interrupted", startedAt: record.startedAt, completedAt: record.completedAt },
  });
}

/**
 * ゲート（AGENT_HOST_FAKE_GATE_DIR のファイル。tests/lib/fake-gate.mjs と同じ置き場）が現れるまで待つ。ツールが走っている最中を、時間でなくテストの合図で作る。
 * 置き場が無ければ待たない
 */
async function gate(name) {
  const dir = process.env.AGENT_HOST_FAKE_GATE_DIR;
  if (!dir) return;
  const file = path.join(dir, name);
  while (!fs.existsSync(file)) await wait(20);
}

/**
 * ツールが走っている最中のターン（"gate:<名前>"。ゲートが開くまでツールが終わらない。承認は求めない）。
 * 本文 "start" → commandExecution の item/started → （ゲート）→ item/completed → 本文 "end <ゲートの名前>" → turn/completed。保持役の付け直しの確かめに使う
 */
async function runGateTurn(t, turnId, text) {
  const name = text.slice("gate:".length).split(/\s/)[0];
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  const body = `end ${name}`;
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: "start " });
  const started = { id: `it_g${++seq}`, type: "commandExecution", command: "build", commandActions: [], cwd: t.cwd ?? ".", status: "inProgress" };
  notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: started });
  await gate(name);
  record({ method: "gate-done", gate: name, threadId: t.id });
  const done = { ...started, status: "completed", aggregatedOutput: "built", exitCode: 0, durationMs: 1 };
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: done });
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: body });
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { id: "it_m1", type: "agentMessage", text: `start ${body}` } });
  notify("thread/tokenUsage/updated", { threadId: t.id, turnId, tokenUsage: {
    last: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
    total: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 }, modelContextWindow: 200000 } });
  t.turns.push({ id: turnId, status: "completed", startedAt: secs(), completedAt: secs(), items: [
    { id: `it_u${++seq}`, type: "userMessage", content: [{ type: "text", text }] }, done, { id: "it_m1", type: "agentMessage", text: `start ${body}` }] });
  t.updatedAt = secs();
  notify("turn/completed", { threadId: t.id, turn: { id: turnId, items: [], status: "completed", startedAt: secs(), completedAt: secs() } });
  record({ method: "gate-completed", gate: name, threadId: t.id });
}

/**
 * 裏の端末（unified_exec）を 1 本起こして、ターンは終わる（"bgterm"）。端末は走ったまま（thread/backgroundTerminals/list に載る）。
 * thread/backgroundTerminals/terminate で止めると、端末を起こしたターンの turnId のまま item/completed（failed）が届く（codex-cli 0.160.0 の実測）
 */
const terminals = new Map();   // itemId -> { threadId, turnId, itemId, processId, command, cwd }
async function runBgTermTurn(t, turnId, text) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  const processId = String(40000 + ++seq);
  const item = { id: `it_bg${seq}`, type: "commandExecution", command: "npm run dev", commandActions: [], cwd: t.cwd ?? ".", status: "inProgress", processId, source: "unifiedExecStartup" };
  terminals.set(item.id, { threadId: t.id, turnId, itemId: item.id, processId, command: item.command, cwd: item.cwd });
  notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item });
  const body = `端末を起こした: ${text}`;
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: body });
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: { id: "it_m1", type: "agentMessage", text: body } });
  t.turns.push({ id: turnId, status: "completed", startedAt: secs(), completedAt: secs(), items: [{ id: "it_m1", type: "agentMessage", text: body }] });
  t.updatedAt = secs();
  notify("turn/completed", { threadId: t.id, turn: { id: turnId, items: [], status: "completed", startedAt: secs(), completedAt: secs() } });
}

/** 質問（item/tool/requestUserInput）を出すターン。回答を本文にして返す。 */
async function runQuestionTurn(t, turnId) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  let answered = "(無回答)";
  try {
    const res = await ask("item/tool/requestUserInput", {
      threadId: t.id, turnId, itemId: "it_q1", isBlocking: true,
      questions: [{
        id: "q1", header: "選択", question: "どれにする？",
        options: [{ label: "A", description: "一つ目" }, { label: "B", description: "二つ目" }],
      }],
    });
    answered = (res?.answers?.q1?.answers ?? []).join(",") || "(無回答)";
  } catch { /* 応答が取れなければ無回答のまま */ }

  const body = `回答: ${answered}`;
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: body });
  notify("item/completed", {
    threadId: t.id, turnId, completedAtMs: Date.now(),
    item: { id: "it_m1", type: "agentMessage", text: body },
  });
  t.turns.push({
    id: turnId, status: "completed", startedAt: secs(), completedAt: secs(),
    items: [{ id: "it_m1", type: "agentMessage", text: body }],
  });
  notify("turn/completed", {
    threadId: t.id, turn: { id: turnId, items: [], status: "completed" },
  });
}

/**
 * サブエージェントを 1 本起こすターン（multi_agent v2 の形）。
 * 子は自分の threadId で item/* を流し、承認も子の threadId で求める。
 * Pleiad はそれを親の会話の承認カードとして出し、子の本文・ツールは親に混ぜないはず。
 */
async function runSubagentTurn(t, turnId, { slow = false } = {}) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  const spawn = {
    parent_thread_id: t.id, depth: 1, agent_path: "/root/csv_fixture_research",
    agent_nickname: "Planck", agent_role: null,
  };
  const child = makeThread({ cwd: t.cwd, forkedFromId: t.id, parentThreadId: t.id, spawn });
  const parentItems = [];
  // 親の turn は走っている間から thread/read に出す（items は届いた順に積む）
  const record = { id: turnId, status: "inProgress", startedAt: secs(), items: parentItems };
  t.turns.push(record);
  notify("item/started", {
    threadId: t.id, turnId, startedAtMs: Date.now(),
    item: {
      id: "it_spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress",
      senderThreadId: t.id, receiverThreadIds: [], prompt: "CSV を調べて", model: null,
      reasoningEffort: null, agentsStates: {},
    },
  });
  notify("thread/started", {
    thread: {
      ...wire(child, false), forkedFromId: t.id, parentThreadId: t.id,
      agentNickname: "Planck", agentRole: null, source: { subAgent: { thread_spawn: spawn } },
    },
  });
  const started0 = activityItem(`call_act_${child.id}`, "started", child, spawn.agent_path);
  notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item: started0 });
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: started0 });
  parentItems.push(started0);
  const childTurn = `tn_${++seq}`;
  // 子には userMessage が無い（依頼文は親から注入され、item にならない。実機の子スレッドと同じ）
  const childRecord = { id: childTurn, status: "inProgress", startedAt: secs(), items: [
    { id: "it_ca", type: "agentMessage", text: "受け取った" },
  ] };
  child.turns.push(childRecord);
  notify("turn/started", { threadId: child.id, turn: { id: childTurn, items: [], status: "inProgress" } });
  notify("item/agentMessage/delta", { threadId: child.id, turnId: childTurn, itemId: "it_cm", delta: "子の本文" });
  const started = {
    id: "it_cc", type: "commandExecution", command: "npm test", commandActions: [],
    cwd: t.cwd ?? ".", status: "inProgress",
  };
  notify("item/started", { threadId: child.id, turnId: childTurn, startedAtMs: Date.now(), item: started });

  let decision = "decline";
  try {
    const res = await ask("item/commandExecution/requestApproval", {
      threadId: child.id, turnId: childTurn, itemId: "it_cc", command: "npm test", cwd: t.cwd ?? ".",
      startedAtMs: Date.now(), approvalId: null, reason: "子の承認",
    });
    decision = typeof res?.decision === "string" ? res.decision : "decline";
  } catch (err) {
    decision = `error: ${String(err?.message ?? err)}`;
  }
  const childDone = { ...started, status: "completed", aggregatedOutput: "ok", exitCode: 0, durationMs: 1 };
  notify("item/completed", {
    threadId: child.id, turnId: childTurn, completedAtMs: Date.now(), item: childDone,
  });
  childRecord.items.push(childDone, { id: "it_cm", type: "agentMessage", text: "子の本文" },
    { id: "it_cr", type: "agentMessage", text: "報告: ok" });
  child.updatedAt = secs();

  if (slow) {
    // 子は走ったまま、親のターンは中断されるまで終わらない（実行中一覧を測る）
    await new Promise((resolve) => slowTurns.set(turnId, { threadId: t.id, resolve, record }));
    const stopped = activityItem(`subagent-interrupted-${child.id}`, "interrupted", child, spawn.agent_path);
    notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: stopped });
    parentItems.push(stopped);
    childRecord.status = "interrupted";
    record.status = "interrupted";
    record.completedAt = secs();
    notify("turn/completed", { threadId: t.id, turn: { id: turnId, items: [], status: "interrupted" } });
    return;
  }

  childRecord.status = "completed";
  childRecord.completedAt = secs();
  notify("turn/completed", { threadId: child.id, turn: { id: childTurn, items: [], status: "completed" } });
  const spawnDone = {
    id: "it_spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
    senderThreadId: t.id, receiverThreadIds: [child.id], prompt: "CSV を調べて", model: null,
    reasoningEffort: null, agentsStates: { [child.id]: { status: "completed", message: null } },
  };
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: spawnDone });
  parentItems.unshift(spawnDone);
  const finished = activityItem(`subagent-completed-${child.id}`, "completed", child, spawn.agent_path);
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: finished });
  parentItems.push(finished);

  const body = `子の承認: ${decision}`;
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: "it_m1", delta: body });
  notify("item/completed", {
    threadId: t.id, turnId, completedAtMs: Date.now(),
    item: { id: "it_m1", type: "agentMessage", text: body },
  });
  parentItems.push({ id: "it_m1", type: "agentMessage", text: body });
  record.status = "completed";
  record.completedAt = secs();
  t.updatedAt = secs();
  notify("turn/completed", { threadId: t.id, turn: { id: turnId, items: [], status: "completed" } });
}

/**
 * 通知を出さずに、サブエージェントの記録だけを持つ親を作る（fake/seedSubagents）。
 * Pleiad が実行時に何も見ていない親（再起動の後・別のクライアントで走った会話）を、親の items から読めるかを測る。
 *   activity:   subAgentActivity started -> completed（gpt-6-astra の形）
 *   collab:     collabAgentToolCall(spawnAgent) だけ。agentsStates が errored
 *   stopped:    subAgentActivity started -> interrupted
 *   grandchild: activity の子が生んだ孫（親の直接の子ではない）
 */
function seedSubagents(cwd) {
  const parent = makeThread({ cwd });
  const spawnOf = (name) => ({ parent_thread_id: parent.id, depth: 1, agent_path: `/root/${name}`, agent_nickname: null, agent_role: null });
  const child = (name) => makeThread({ cwd, forkedFromId: parent.id, parentThreadId: parent.id, spawn: spawnOf(name),
    turns: [{ id: `tn_${++seq}`, status: "completed", startedAt: secs() - 50, completedAt: secs() - 40,
      items: [{ id: `it_${++seq}`, type: "agentMessage", text: `${name} の報告` }] }] });
  const activity = child("song_audit");
  const collab = child("lyrics_audit");
  const stopped = child("review_request");
  activity.createdAt = secs() - 60;
  activity.updatedAt = secs() - 30;
  const grandchild = makeThread({ cwd, forkedFromId: activity.id, parentThreadId: activity.id,
    spawn: { parent_thread_id: activity.id, depth: 2, agent_path: "/root/song_audit/deep", agent_nickname: null, agent_role: null } });
  parent.turns.push({
    id: `tn_${++seq}`, status: "completed", startedAt: secs() - 100, completedAt: secs() - 10,
    items: [
      { id: "it_su", type: "userMessage", content: [{ type: "text", text: "三つ調べて" }] },
      activityItem("call_seed_activity", "started", activity, "/root/song_audit"),
      { id: "call_seed_collab", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
        senderThreadId: parent.id, receiverThreadIds: [collab.id], prompt: "歌詞を監査して", model: null,
        reasoningEffort: null, agentsStates: { [collab.id]: { status: "errored", message: "boom" } } },
      activityItem("call_seed_stopped", "started", stopped, "/root/review_request"),
      activityItem(`subagent-completed-${activity.id}`, "completed", activity, "/root/song_audit"),
      activityItem(`subagent-interrupted-${stopped.id}`, "interrupted", stopped, "/root/review_request"),
      { id: "it_sm", type: "agentMessage", text: "終わった" },
    ],
  });
  return { parent: parent.id, activity: activity.id, collab: collab.id, stopped: stopped.id, grandchild: grandchild.id };
}

// ---- ディスパッチ -----------------------------------------------------------

// ---- hooks（Hooks を Pleiad がそろえる会話。ADR 0049）
// 起動の -c hooks=<表>（本物では source: sessionFlags・sourcePath "<session-flags>/config.toml"）。プローブが hash を取るのに使う
import { parse as tomlParse } from "smol-toml";
import crypto from "node:crypto";
const LAUNCH_HOOKS = (() => {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-c' && argv[i + 1].startsWith('hooks=')) {
    try { return tomlParse(`hooks = ${argv[i + 1].slice(6)}`).hooks; } catch { return null; }
  }
  return null;
})();
const snake = s => s.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase());
const FLAGS_PATH = process.platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml';
// 定義の hash（本物の計算は分からないので、同じ定義なら同じ値になる形だけ真似る）
const hookHash = (event, g, h) => `sha256:${crypto.createHash('sha256').update(JSON.stringify([event, g.matcher ?? null, h])).digest('hex')}`;
function rowsOf(map, file, source, trust) {
  return Object.entries(map ?? {}).filter(([k, v]) => k !== 'state' && Array.isArray(v)).flatMap(([event, groups]) => groups.flatMap((g, gi) => (g.hooks ?? []).map((h, hi) => ({
    key: `${file}:${snake(event)}:${gi}:${hi}`, eventName: event[0].toLowerCase() + event.slice(1), handlerType: 'command', command: h.command,
    matcher: g.matcher ?? null, sourcePath: file, source, enabled: true, isManaged: false, currentHash: hookHash(event, g, h), trustStatus: trust }))));
}
/** ユーザー（CODEX_HOME/hooks.json）とプロジェクト（<cwd>/.codex/hooks.json）の定義。信頼状態は FAKE_CODEX_HOOK_TRUST（既定 untrusted） */
function nativeHooks(cwd) {
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).hooks ?? {}; } catch { return {}; } };
  const trust = process.env.FAKE_CODEX_HOOK_TRUST || 'untrusted';
  const user = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'hooks.json') : null;
  const project = cwd ? path.join(cwd, '.codex', 'hooks.json') : null;
  return [...(user ? rowsOf(read(user), user, 'user', trust) : []), ...(project ? rowsOf(read(project), project, 'project', trust) : []),
    ...(LAUNCH_HOOKS ? rowsOf(LAUNCH_HOOKS, FLAGS_PATH, 'sessionFlags', 'untrusted') : [])];
}
/**
 * ターンの始めに、走るはずの hooks の hook/started・hook/completed を出す（コマンドは動かさない）。
 * ネイティブ: 信頼済み（FAKE_CODEX_HOOK_TRUST=trusted）で state の enabled:false でないもの。
 * thread の config の hooks: state の trusted_hash が定義の hash と同じもの（source: sessionFlags）
 */
function emitHookRuns(t, turnId) {
  const state = t.hooksConfig?.state ?? {};
  const native = nativeHooks(t.cwd).filter(h => h.source !== 'sessionFlags');
  const mine = t.hooksConfig ? rowsOf(t.hooksConfig, FLAGS_PATH, 'sessionFlags', 'untrusted') : [];
  const runs = [...native.filter(h => h.trustStatus === 'trusted' && state[h.key]?.enabled !== false),
    ...mine.filter(h => state[h.key]?.trusted_hash === h.currentHash && state[h.key]?.enabled !== false)];
  for (const h of runs) {
    const run = { id: `hr_${++seq}`, eventName: h.eventName, source: h.source, sourcePath: h.sourcePath, handlerType: 'command', executionMode: 'sync', scope: 'turn',
      displayOrder: 0, entries: [], startedAt: Date.now() };
    notify('hook/started', { threadId: t.id, turnId, run: { ...run, status: 'running' } });
    notify('hook/completed', { threadId: t.id, turnId, run: { ...run, status: 'completed', durationMs: 5, completedAt: Date.now() } });
  }
}

// 接続先（modelProvider）の扱いを本物に寄せる（スパイク 2026-09-23）: ロード済みのスレッドへの thread/resume は
// modelProvider・config を無視し、thread/unsubscribe の後の resume なら新しい接続先が効く。
// FAKE_CODEX_LOG があれば、そのファイルへ 1 行 JSON で記録する（テストが「どの接続先・鍵・モデルでターンが走ったか」を見る）
import fs from "node:fs";
const LOG = process.env.FAKE_CODEX_LOG;
const record = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + NL); };
// サーバーを替えて再開するテストだけ、履歴と生きている writer を別プロセスと共有する。
const STATE_DIR = process.env.FAKE_CODEX_STATE_DIR;
const statePath = id => path.join(STATE_DIR, `${id}.json`);
const writerPath = id => path.join(STATE_DIR, `${id}.writer`);
const persist = t => { if (STATE_DIR && !t.ephemeral) fs.writeFileSync(statePath(t.id), JSON.stringify(t)); };
function readThread(id) {
  let t = threads.get(id);
  if (STATE_DIR && !t?.loaded && fs.existsSync(statePath(id))) {
    t = { ...JSON.parse(fs.readFileSync(statePath(id), 'utf8')), loaded: false };
    threads.set(id, t);
  }
  return t;
}
function claimWriter(t) {
  if (!STATE_DIR || t.ephemeral) return;
  let owner;
  try { owner = Number(fs.readFileSync(writerPath(t.id), 'utf8')); } catch {}
  if (owner && owner !== process.pid) {
    let alive = false;
    try { process.kill(owner, 0); alive = true; } catch {}
    if (alive) throw new RpcError(`thread ${t.id} already has an active writer`, -32600);
  }
  fs.writeFileSync(writerPath(t.id), String(process.pid));
}
function applyProvider(t, params) {
  if (t.loaded) return;
  claimWriter(t);
  t.loaded = true;
  // hooks の config（Hooks を Pleiad がそろえる会話）も読み込んだときのものだけが効く（ロード済みの resume では変わらない）
  t.hooksConfig = params?.config?.hooks ?? null;
  const id = params?.modelProvider ?? "openai";
  const def = params?.config?.[`model_providers.${id}`] ?? null;
  t.provider = { id, baseUrl: def?.base_url ?? null, bearer: def?.experimental_bearer_token ?? null, headers: def?.http_headers ?? null,
    contextWindow: params?.config?.model_context_window ?? null, webSearch: params?.config?.web_search ?? null };
  // developerInstructions も読み込んだときのものだけが効く（ロード済みの resume では変わらない）
  t.developerInstructions = params?.developerInstructions ?? null;
  // ply_computer の MCP と、同梱の computer use を切る上書き（ADR 0074）も同じ
  t.computer = params?.config?.["mcp_servers.ply_computer"] ?? null;
  t.bundledComputerUse = Object.fromEntries(Object.entries(params?.config ?? {}).filter(([k]) => /computer[-_]use/.test(k)));
}

/**
 * ply_computer のツールを呼ぶターン（"computer:<JSON>"。{ name, arguments } か、その配列）。
 * thread/start の config の mcp_servers.ply_computer（url・http_headers）へ tools/call を送り、本物と同じ mcpToolCall のアイテムで返す
 */
async function runComputerTurn(t, turnId, text) {
  notify("turn/started", { threadId: t.id, turn: { id: turnId, items: [], status: "inProgress" } });
  const items = [];
  for (const [i, call] of [].concat(JSON.parse(text.slice("computer:".length))).entries()) {
    const item = { id: `mcp_${turnId}_${i}`, type: "mcpToolCall", server: "ply_computer", tool: call.name, arguments: call.arguments ?? {}, status: "inProgress", result: null, error: null };
    notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item });
    let done;
    if (!t.computer?.url) done = { ...item, status: "failed", error: { message: "ply_computer is not configured" } };
    else {
      const response = await fetch(t.computer.url, { method: "POST", headers: { ...(t.computer.http_headers ?? {}), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: call.name, arguments: call.arguments ?? {} } }) });
      const body = await response.json().catch(() => null);
      done = body?.result ? { ...item, status: "completed", result: body.result } : { ...item, status: "failed", error: { message: `HTTP ${response.status}` } };
    }
    items.push(done);
    notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: done });
  }
  const reply = `computer:${items.length}`;
  notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: `it_c_${turnId}`, delta: reply });
  const message = { id: `it_c_${turnId}`, type: "agentMessage", text: reply };
  notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: message });
  t.turns.push({ id: turnId, status: "completed", startedAt: secs(), completedAt: secs(), items: [{ id: `u_${turnId}`, type: "userMessage", content: [{ type: "text", text }] }, ...items, message] });
  t.updatedAt = secs();
  notify("turn/completed", { threadId: t.id, turn: { id: turnId, items: [], status: "completed", startedAt: secs(), completedAt: secs() } });
}

async function handle(method, params) {
  calls.set(method, (calls.get(method) ?? 0) + 1);
  switch (method) {
    // ---- テスト用の口（本物には無い）
    case "fake/stats": return Object.fromEntries(calls);
    case "fake/config":
      if (params?.parentFilter) parentFilter = params.parentFilter;
      return {};
    case "fake/seedSubagents": return seedSubagents(params?.cwd ?? null);

    case "initialize":
      record({ method, args: process.argv.slice(2) });
      // 本物は 2 回目の initialize に Already initialized を返すだけ（codex-cli 0.160.0。接続は無事）
      if (initialized) throw new RpcError("Already initialized", -32600);
      initialized = true;
      return { userAgent: "fake-codex/0.0.0" };

    case "thread/start": {
      const t = makeThread({ cwd: params?.cwd });
      t.plyConfig = params?.config?.['mcp_servers.ply'];
      t.ephemeral = Boolean(params?.ephemeral);
      t.model = params?.model;
      if (process.env.FAKE_CODEX_ROLLOUT_DIR && !t.ephemeral) t.path = path.join(process.env.FAKE_CODEX_ROLLOUT_DIR, `rollout-${t.id}.jsonl`);
      applyProvider(t, params);
      record({ method, threadId: t.id, modelProvider: params?.modelProvider ?? null, model: params?.model ?? null, ephemeral: t.ephemeral });
      return {
        thread: wire(t, false),
        approvalPolicy: params?.approvalPolicy ?? "untrusted",
        approvalsReviewer: "user",
        cwd: t.cwd,
        model: params?.model || "fake-model-1",
        modelProvider: "openai",
        sandbox: { type: "workspaceWrite" },
      };
    }

    case "thread/resume": {
      const t = readThread(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      if (params?.model) t.model = params.model;
      applyProvider(t, params);
      record({ method, threadId: t.id, modelProvider: params?.modelProvider ?? null, model: params?.model ?? null, hooks: Boolean(params?.config?.hooks) });
      return {
        thread: wire(t, false),
        approvalPolicy: params?.approvalPolicy ?? "untrusted",
        approvalsReviewer: "user",
        cwd: t.cwd,
        model: "fake-model-1",
        // 実際に効いている接続先（本物もロード済みなら前の provider を返す）
        modelProvider: t.provider?.id ?? "openai",
        sandbox: { type: "workspaceWrite" },
      };
    }

    case "thread/compact/start": {
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`Unknown threadId: ${params?.threadId}`);
      const item = { id: `compact_${++seq}`, type: "contextCompaction" };
      const turnId = `compact_turn_${seq}`;
      record({ method, threadId: t.id });
      const control = process.env.FAKE_CODEX_CONTROL ? fs.readFileSync(process.env.FAKE_CODEX_CONTROL, 'utf8') : '';
      if (control.includes('compact-fail')) throw new RpcError('compaction failed', -32000);
      notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item });
      await wait(50);
      notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item });
      notify("thread/compacted", { threadId: t.id, turnId });
      notify("thread/tokenUsage/updated", { threadId: t.id, turnId,
        tokenUsage: { last: { cachedInputTokens: 0, inputTokens: 18000, outputTokens: 3000,
          reasoningOutputTokens: 0, totalTokens: 21000 }, modelContextWindow: 200000 } });
      t.turns.push({ id: turnId, status: "completed", startedAt: secs(), completedAt: secs(), items: [item] });
      return {};
    }

    case "turn/start": {
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      if (params?.cwd) t.cwd = params.cwd;
      const turnId = `tn_${++seq}`;
      const text = (params?.input ?? []).filter((i) => i?.type === "text").map((i) => i.text).join("");
      // folded: `!` のターンが閉じる前に来た。本物はこの発言を `!` のターンに入れ、返答しないまま閉じる（codex-cli 0.156.1）
      record({ method, threadId: t.id, provider: t.provider ?? null, model: t.model ?? null, effort: params?.effort ?? null, ephemeral: Boolean(t.ephemeral), developerInstructions: t.developerInstructions ?? null, hooks: t.hooksConfig ?? null,
        computer: t.computer ? { ...t.computer, http_headers: Object.keys(t.computer.http_headers ?? {}) } : null, bundledComputerUse: t.bundledComputerUse ?? {}, ...(t.shellTurn ? { folded: true } : {}) });
      if (t.ephemeral && process.env.FAKE_CODEX_CHECK_TITLE === "1") {
        if (t.model !== "gpt-5.6-luna" || params?.effort !== "low") {
          throw new Error("Title generation must use Luna with low effort");
        }
      }
      // 応答を返してから走る。本物も turn/start の応答と通知は別々に来る
      const script = text.startsWith("slow") ? runSlowTurn(t, turnId, text)
        : text.startsWith("question") ? runQuestionTurn(t, turnId)
        : text.startsWith("subagent-slow") ? runSubagentTurn(t, turnId, { slow: true })
        : text.startsWith("subagent") ? runSubagentTurn(t, turnId)
        : text.startsWith("gate:") ? runGateTurn(t, turnId, text)
        : text.startsWith("bgterm") ? runBgTermTurn(t, turnId, text)
        : text.startsWith("reject") ? runRejectTurn(t, turnId, text)
        : text.startsWith("computer:") ? runComputerTurn(t, turnId, text)
        : runTurn(t, turnId, text);
      script.catch((err) => notify("error", {
        threadId: t.id, turnId, willRetry: false, error: { message: String(err?.message ?? err) },
      }));
      return { turn: { id: turnId, items: [], status: "inProgress" } };
    }

    case 'turn/steer': {
      const slow = slowTurns.get(params?.expectedTurnId);
      // 走っているターンが無い・turnId が食い違うのは**プロトコル上の拒否**。本物は -32600 を返し、
      // Pleiad はそれを見て「受理できなかった」（送信待ちへ戻す）と判断する
      if (!slow || slow.threadId !== params?.threadId) throw new RpcError('No matching active turn', -32600);
      const t = threads.get(slow.threadId);
      const text = params.input.map(i => i.text).join('');
      // 走っている turn の中へそのまま入る（別のターンにはならない）。clientUserMessageId は
      // clientId としてそのまま返る
      const item = { id: `steer_${++seq}`, type: 'userMessage',
        clientId: params?.clientUserMessageId ?? null, content: [{ type: 'text', text }] };
      slow.record.items.push(item);
      if (!t.turns.includes(slow.record)) t.turns.push(slow.record);
      // 本物は走っているツールが終わった直後に通知が来る。受理の応答を先に返し、少し置いてから出す
      setTimeout(() => {
        notify('item/started', { threadId: t.id, turnId: params.expectedTurnId, startedAtMs: Date.now(), item });
        notify('item/completed', { threadId: t.id, turnId: params.expectedTurnId, completedAtMs: Date.now(), item });
      }, 20);
      return { turnId: params.expectedTurnId };
    }
    // 入力欄の `!`（codex-cli 0.156.1 の ThreadShellCommandParams: { threadId, command, timeoutMs }、応答は {}）。
    // 結果は source: userShell の commandExecution として、応答の後に通知で流す。本物がターンで包むかは未確認なので、turn/started・completed も出す。
    // "slow" を含むコマンドは turn/interrupt まで終わらない。"fail" を含むと exit 1
    case "thread/shellCommand": {
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      if (typeof params?.command !== "string") throw new RpcError("command is required", -32602);
      record({ method, threadId: t.id, command: params.command, timeoutMs: params.timeoutMs ?? null });
      const turnId = `sh_${++seq}`;
      // 本物（codex-cli 0.156.1）はシェルに包んで POSIX 式にクォートした形を command に入れる
      const wrapped = `/bin/bash -lc '${params.command.replace(/'/g, "'\\''")}'`;
      const item = { id: `ush_${++seq}`, type: "commandExecution", command: wrapped, cwd: t.cwd, source: "userShell", status: "inProgress", commandActions: [] };
      setTimeout(async () => {
        notify("turn/started", { threadId: t.id, turn: { id: turnId, status: "inProgress", items: [] } });
        t.shellTurn = turnId;
        notify("item/started", { threadId: t.id, turnId, startedAtMs: Date.now(), item });
        notify("item/commandExecution/outputDelta", { threadId: t.id, turnId, itemId: item.id, delta: "fake out\n" });
        let interrupted = false;
        if (params.command.includes("slow")) await new Promise((resolve) => slowTurns.set(turnId, { threadId: t.id, resolve: () => { interrupted = true; resolve(); } }));
        // 止めた分は本物と同じく exitCode -1・定型の文で閉じる
        const done = { ...item, status: interrupted || params.command.includes("fail") ? "failed" : "completed", exitCode: interrupted ? -1 : params.command.includes("fail") ? 1 : 0,
          aggregatedOutput: interrupted ? "command aborted by user" : "fake out\n", durationMs: interrupted ? 0 : 3 };
        t.turns.push({ id: turnId, status: "completed", startedAt: secs(), completedAt: secs(), items: [done] });
        notify("item/completed", { threadId: t.id, turnId, completedAtMs: Date.now(), item: done });
        // lag: 本物と同じく、item が閉じてから少し遅れてターンが閉じる
        if (params.command.includes("lag")) await new Promise((resolve) => setTimeout(resolve, 300));
        t.shellTurn = null;
        notify("turn/completed", { threadId: t.id, turn: { id: turnId, status: interrupted ? "interrupted" : "completed", items: [] } });
      }, 10);
      return {};
    }
    case "turn/interrupt": {
      const slow = slowTurns.get(params?.turnId);
      if (slow) { slowTurns.delete(params.turnId); slow.resolve(); }
      return {};
    }

    case "fake/hooks": return { launch: LAUNCH_HOOKS };
    // 裏の端末の一覧と停止（codex-cli 0.160.0。要素は { itemId, processId, command, cwd, osPid, cpuPercent, rssKb }）
    case "thread/backgroundTerminals/list":
      return { data: [...terminals.values()].filter((x) => x.threadId === params?.threadId)
        .map(({ itemId, processId, command, cwd }) => ({ itemId, processId, command, cwd, osPid: null, cpuPercent: null, rssKb: null })), nextCursor: null };
    case "thread/backgroundTerminals/terminate": {
      const hit = [...terminals.values()].find((x) => x.threadId === params?.threadId && x.processId === String(params?.processId));
      if (!hit) return { terminated: false };
      terminals.delete(hit.itemId);
      setTimeout(() => notify("item/completed", { threadId: hit.threadId, turnId: hit.turnId, completedAtMs: Date.now(),
        item: { id: hit.itemId, type: "commandExecution", command: hit.command, commandActions: [], cwd: hit.cwd, status: "failed", processId: hit.processId, source: "unifiedExecStartup", aggregatedOutput: "", exitCode: null } }), 20);
      return { terminated: true };
    }
    case "thread/unsubscribe": {
      const gone = threads.get(params?.threadId);
      // FAKE_CODEX_CONTROL のファイルに sticky があれば、外したと答えてもロードしたまま（接続先の変更を無視する本物の場面の再現）。
      // unsubscribe-fail があれば失敗を返す
      const control = process.env.FAKE_CODEX_CONTROL ? (() => { try { return fs.readFileSync(process.env.FAKE_CODEX_CONTROL, "utf8"); } catch { return ""; } })() : "";
      if (control.includes("unsubscribe-fail")) throw new RpcError("thread is busy", -32000);
      if (gone && !control.includes("sticky")) {
        gone.loaded = false;
        if (STATE_DIR && fs.existsSync(writerPath(gone.id)) && Number(fs.readFileSync(writerPath(gone.id), 'utf8')) === process.pid) fs.unlinkSync(writerPath(gone.id));
      }
      record({ method, threadId: params?.threadId });
      if (gone?.ephemeral) threads.delete(params.threadId);
      return { status: "unsubscribed" };
    }

    case "thread/list": {
      const dir = params?.sortDirection === "asc" ? 1 : -1;
      // 既定（sourceKinds 無し）は対話の会話だけ。サブエージェントの子は parentThreadId を付けたときだけ返る
      // （実機で確認）。古い版は parentThreadId を知らずに無視し、普通の一覧を返す
      const parent = parentFilter === "ignore" ? null : params?.parentThreadId ?? null;
      const data = [...threads.values()]
        .filter((t) => (parent ? t.parentThreadId === parent : !t.parentThreadId))
        .sort((a, b) => dir * (a.updatedAt - b.updatedAt))
        .slice(0, params?.limit ?? 100)
        .map((t) => wire(t, false));
      return { data, nextCursor: null };
    }

    case "thread/read": {
      const t = readThread(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      return { thread: wire(t, Boolean(params?.includeTurns)) };
    }

    case "thread/name/set": {
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      t.name = String(params?.name ?? "");
      t.updatedAt = secs();
      return {};
    }

    // ある 1 ターンの手前までで履歴を置き換える（codex-cli 0.156.1 の thread/revert。paginated のスレッドだけ）
    case "thread/revert": {
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      record({ method, threadId: t.id, beforeTurnId: params?.beforeTurnId ?? null, ...(LEGACY ? { refused: true } : {}) });
      if (LEGACY) throw new RpcError("thread/revert only supports paginated threads", -32600);
      const at = t.turns.findIndex((turn) => turn.id === params?.beforeTurnId);
      if (at < 0) throw new RpcError(`turn not found: ${params?.beforeTurnId}`, -32600);
      t.turns = t.turns.slice(0, at);
      t.updatedAt = secs();
      notify("thread/reverted", { threadId: t.id });
      return {};
    }

    case "thread/fork": {
      const src = threads.get(params?.threadId);
      if (!src) throw new Error(`知らない threadId: ${params?.threadId}`);
      // beforeTurnId: そのターンの手前までで切る（0.156.1。legacy のスレッドでも効く）
      const cut = params?.beforeTurnId ? src.turns.findIndex((turn) => turn.id === params.beforeTurnId) : -1;
      if (params?.beforeTurnId && cut < 0) throw new RpcError(`turn not found: ${params.beforeTurnId}`, -32600);
      const child = makeThread({
        cwd: src.cwd,
        forkedFromId: src.id,
        turns: (cut >= 0 ? src.turns.slice(0, cut) : src.turns).map((t) => ({ ...t })),
      });
      record({ method, threadId: src.id, childId: child.id, beforeTurnId: params?.beforeTurnId ?? null });
      child.name = src.name ? `${src.name} (fork)` : null;
      return {
        thread: wire(child, false),
        approvalPolicy: "untrusted", approvalsReviewer: "user", cwd: child.cwd,
        model: "fake-model-1", modelProvider: "openai", sandbox: { type: "workspaceWrite" },
      };
    }

    case "config/read": return { config: { model: "fake-model-1", model_reasoning_effort: "medium" } };
    // skills/list: 本物と同じ形（cwd ごとの skills）。fake-codex は自分の Skills を持たないので空で返す
    case "skills/list": return { data: (params?.cwds ?? []).map(cwd => ({ cwd, skills: [], errors: [] })) };
    // hooks/list: 各 cwd の .codex/hooks.json を本物と同じ形（key = <sourcePath>:<snake_case>:<group>:<handler>）で返す。
    // 信頼状態は FAKE_CODEX_HOOK_TRUST（既定 untrusted）。FAKE_CODEX_PLUGIN_HOOK=1 ならプラグインの定義も 1 件足す
    case "hooks/list": {
      return { data: (params?.cwds ?? []).map(cwd => {
        const hooks = nativeHooks(cwd);
        if (process.env.FAKE_CODEX_PLUGIN_HOOK === '1') hooks.push({ key: 'C:/plugins/x/hooks/hooks.json:stop:0:0', eventName: 'stop', handlerType: 'command',
          command: 'node plugin-stop.js --token SECRET-PLUGIN', sourcePath: 'C:/plugins/x/hooks/hooks.json', source: 'plugin', pluginId: 'x', enabled: true, isManaged: false, trustStatus: 'trusted' });
        return { cwd, hooks, errors: [], warnings: [] };
      }) };
    }
    // 2 ページに分けて返す（本物も `nextCursor` で続きを渡す）。タイトル生成の Luna は 2 ページ目にだけ居る
    case "model/list": {
      const efforts = ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort }));
      const row = (id, displayName, extra = {}) => ({ id, model: id, displayName, isDefault: false,
        hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: efforts, ...extra });
      if (params?.cursor == null) {
        return { data: [row("fake-model-1", "Fake 1", { isDefault: true }), row("fake-model-2", "Fake 2")], nextCursor: "2" };
      }
      if (params.cursor !== "2") throw new RpcError(`知らない cursor: ${params.cursor}`, -32600);
      return { data: [row("gpt-5.6-luna", "Luna"), row("fake-hidden", "隠し", { hidden: true })], nextCursor: null };
    }

    case "account/read":
      return {
        requiresOpenaiAuth: true,
        account: account.loggedIn
          ? { type: "chatgpt", email: account.email, planType: account.planType }
          : null,
      };

    case "account/login/start": {
      const loginId = `lg_${++seq}`;
      // 応答を返した直後に完了通知。**この通知は threadId を持たない**
      setTimeout(() => {
        account.loggedIn = true;
        notify("account/login/completed", { loginId, success: true, error: null });
      }, 5);
      return { type: "chatgpt", loginId, authUrl: "https://auth.example.invalid/codex?code=fake" };
    }

    case "account/logout":
      account.loggedIn = false;
      return {};

    default:
      throw new Error(`fake-codex は ${method} を知らない`);
  }
}

// ---- stdio ------------------------------------------------------------------

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // client -> server の応答（承認・質問の答え）
    if (msg.id !== undefined && msg.method === undefined) {
      const p = serverPending.get(msg.id);
      if (!p) continue;
      serverPending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? "error")));
      else p.resolve(msg.result);
      continue;
    }

    if (msg.method === "initialized") continue;   // notification。応答しない

    if (msg.id !== undefined) {
      Promise.resolve()
        .then(() => handle(msg.method, msg.params ?? {}))
        .then(
          (result) => { if (STATE_DIR) for (const t of threads.values()) if (t.loaded) persist(t); send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }); },
          (err) => send({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code ?? -32000, message: String(err?.message ?? err) } }),
        );
    }
  }
});

// 親が消えたら道連れになる。cmd.exe 経由で起動されると kill が届かないことがあるため、
// stdin が閉じたことを終了の合図にする。
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
