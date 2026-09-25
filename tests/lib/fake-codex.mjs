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

const NL = String.fromCharCode(10);

const send = (frame) => process.stdout.write(JSON.stringify(frame) + NL);
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
  const id = `th_${++seq}`;
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
  };
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
      last: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 },
      total: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 },
    },
  });

  // 履歴に残す。thread/read {includeTurns:true} で読み直せることを測るため
  t.turns.push({
    id: turnId,
    status: "completed",
    startedAt: secs(),
    completedAt: secs(),
    items: [
      { id: "it_u1", type: "userMessage", content: [{ type: "text", text }] },
      { id: "it_r1", type: "reasoning", summary: ["考えている"], content: [] },
      done,
      { id: "it_m1", type: "agentMessage", text: body },
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

// 接続先（modelProvider）の扱いを本物に寄せる（スパイク 2026-09-23）: ロード済みのスレッドへの thread/resume は
// modelProvider・config を無視し、thread/unsubscribe の後の resume なら新しい接続先が効く。
// FAKE_CODEX_LOG があれば、そのファイルへ 1 行 JSON で記録する（テストが「どの接続先・鍵・モデルでターンが走ったか」を見る）
import fs from "node:fs";
const LOG = process.env.FAKE_CODEX_LOG;
const record = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + NL); };
function applyProvider(t, params) {
  if (t.loaded) return;
  t.loaded = true;
  const id = params?.modelProvider ?? "openai";
  const def = params?.config?.[`model_providers.${id}`] ?? null;
  t.provider = { id, baseUrl: def?.base_url ?? null, bearer: def?.experimental_bearer_token ?? null, headers: def?.http_headers ?? null,
    contextWindow: params?.config?.model_context_window ?? null, webSearch: params?.config?.web_search ?? null };
  // developerInstructions も読み込んだときのものだけが効く（ロード済みの resume では変わらない）
  t.developerInstructions = params?.developerInstructions ?? null;
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
      return { userAgent: "fake-codex/0.0.0" };

    case "thread/start": {
      const t = makeThread({ cwd: params?.cwd });
      t.plyConfig = params?.config?.['mcp_servers.ply'];
      t.ephemeral = Boolean(params?.ephemeral);
      t.model = params?.model;
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
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      if (params?.model) t.model = params.model;
      applyProvider(t, params);
      record({ method, threadId: t.id, modelProvider: params?.modelProvider ?? null, model: params?.model ?? null });
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

    case "turn/start": {
      const t = threads.get(params?.threadId);
      if (!t) throw new Error(`知らない threadId: ${params?.threadId}`);
      if (params?.cwd) t.cwd = params.cwd;
      const turnId = `tn_${++seq}`;
      const text = (params?.input ?? []).filter((i) => i?.type === "text").map((i) => i.text).join("");
      record({ method, threadId: t.id, provider: t.provider ?? null, model: t.model ?? null, effort: params?.effort ?? null, ephemeral: Boolean(t.ephemeral), developerInstructions: t.developerInstructions ?? null });
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
    case "turn/interrupt": {
      const slow = slowTurns.get(params?.turnId);
      if (slow) { slowTurns.delete(params.turnId); slow.resolve(); }
      return {};
    }

    case "thread/unsubscribe": {
      const gone = threads.get(params?.threadId);
      // FAKE_CODEX_CONTROL のファイルに sticky があれば、外したと答えてもロードしたまま（接続先の変更を無視する本物の場面の再現）。
      // unsubscribe-fail があれば失敗を返す
      const control = process.env.FAKE_CODEX_CONTROL ? (() => { try { return fs.readFileSync(process.env.FAKE_CODEX_CONTROL, "utf8"); } catch { return ""; } })() : "";
      if (control.includes("unsubscribe-fail")) throw new RpcError("thread is busy", -32000);
      if (gone && !control.includes("sticky")) gone.loaded = false;
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
      const t = threads.get(params?.threadId);
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

    case "thread/fork": {
      const src = threads.get(params?.threadId);
      if (!src) throw new Error(`知らない threadId: ${params?.threadId}`);
      const child = makeThread({
        cwd: src.cwd,
        forkedFromId: src.id,
        turns: src.turns.map((t) => ({ ...t })),
      });
      child.name = src.name ? `${src.name} (fork)` : null;
      return {
        thread: wire(child, false),
        approvalPolicy: "untrusted", approvalsReviewer: "user", cwd: child.cwd,
        model: "fake-model-1", modelProvider: "openai", sandbox: { type: "workspaceWrite" },
      };
    }

    case "config/read": return { config: { model: "fake-model-1", model_reasoning_effort: "medium" } };
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
          (result) => send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }),
          (err) => send({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code ?? -32000, message: String(err?.message ?? err) } }),
        );
    }
  }
});

// 親が消えたら道連れになる。cmd.exe 経由で起動されると kill が届かないことがあるため、
// stdin が閉じたことを終了の合図にする。
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
