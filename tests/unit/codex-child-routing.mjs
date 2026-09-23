// Codex のサブエージェント（子スレッド）と、新規セッションの受け皿の振り分け（codex-rpc）。
//
// 本物の codex は起こさない。tests/lib/scripted-codex.mjs がテストの渡した frame をそのまま
// stdout に流すので、codex-rpc は本物と同じ経路（子プロセスの stdio・改行区切り）で受ける。
// frame の形はスキーマ（ThreadStartedNotification、*RequestApprovalParams、ToolRequestUserInputParams、
// ThreadItem の collabAgentToolCall / subAgentActivity）と、Pleiad が gpt-6-astra（multi_agent v2）で
// 動かした rollout の値（agent_path、agent_nickname、thread id）に合わせている。
//
// 子の通知が親と同じ接続に本当に流れるかは、ここでは測れない（実機でしか分からない）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRpc, rpc as shared } from "../../core/backends/codex-rpc.mjs";
import { backend } from "../../core/backends/codex.mjs";

export const name = "codex-child-routing";
export const title = "Codex の子スレッドの承認を親の会話へ回し、新規セッションに他のスレッドの通知を混ぜない";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "tests", "lib", "scripted-codex.mjs");
const FAKE = path.join(ROOT, "tests", "lib", "fake-codex.mjs");

// rollout に残っていた id（Pleiad のセッション 01a09d8b… と、その子 csv_fixture_research / upplan_research）
const PARENT = "01a09d8b-f417-7ce1-abab-8f4cbf938c49";
const CHILD = "01a09d95-d535-7d40-b630-afc5f4b8753f";
const SIBLING = "01a09d96-0063-7213-86ae-b8f42b96696b";
// ここから下は作った id（UUIDv7 の形だけ揃える）
const GRANDCHILD = "01a09da0-1111-7000-8000-000000000001";
const FOREIGN = "01a09da0-2222-7000-8000-000000000002";   // この接続では一度も見ていないスレッド
const NEW = "01a09da0-3333-7000-8000-000000000003";       // thread/start が返す id
const ACTIVITY_CHILD = "01a09da0-4444-7000-8000-000000000004";
const NEW_A = "01a09da0-5555-7000-8000-000000000005";
const NEW_B = "01a09da0-6666-7000-8000-000000000006";
const UNKNOWN = "01a09da0-7777-7000-8000-000000000007";
const NEW_TURN = "01a09da0-8888-7000-8000-000000000008";
const TURN_CHILD = "01a09da0-9999-7000-8000-000000000009";

const LABEL = "サブエージェント csv_fixture_research";
const secs = () => Math.floor(Date.now() / 1000);
let serverSeq = 0;
const nextId = () => `srv_${++serverSeq}`;

// ---- frame（スキーマの形）

/** thread/started。withParentField を偽にすると source.subAgent.thread_spawn だけで親を示す。 */
function threadStarted(id, { parent = null, agentPath = null, nickname = null, withParentField = true } = {}) {
  const base = {
    id, sessionId: id, cliVersion: "0.153.2", createdAt: secs(), updatedAt: secs(), cwd: ROOT,
    ephemeral: false, modelProvider: "openai", preview: "", projectId: null, name: null,
    status: { type: "idle" }, turns: [],
  };
  const thread = parent
    ? {
        ...base, forkedFromId: parent, agentNickname: nickname, agentRole: null,
        ...(withParentField ? { parentThreadId: parent } : {}),
        source: { subAgent: { thread_spawn: {
          parent_thread_id: parent, depth: 1, agent_path: agentPath, agent_nickname: nickname, agent_role: null,
        } } },
      }
    : { ...base, source: "appServer" };
  return { method: "thread/started", params: { thread } };
}

const delta = (threadId, text, turnId = "tn_x") => ({
  method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "it_msg", delta: text },
});

const commandApproval = (threadId, itemId, command) => ({
  id: nextId(), method: "item/commandExecution/requestApproval",
  params: { threadId, turnId: "tn_x", itemId, startedAtMs: Date.now(), approvalId: null, command, cwd: ROOT, reason: null },
});

// fileChange の承認要求は itemId しか運ばない（中身は先行する item/started にある）
const fileApproval = (threadId, itemId) => ({
  id: nextId(), method: "item/fileChange/requestApproval",
  params: { threadId, turnId: "tn_c", itemId, startedAtMs: Date.now(), reason: null, grantRoot: null },
});

const userInput = (threadId, itemId) => ({
  id: nextId(), method: "item/tool/requestUserInput",
  params: {
    threadId, turnId: "tn_x", itemId, isBlocking: true,
    questions: [{
      id: "q1", header: "選択", question: "どれにする？", isOther: false, isSecret: false,
      options: [{ label: "A", description: "一つ目" }, { label: "B", description: "二つ目" }],
    }],
  },
});

/** 子が spawn_agent を呼んだ記録。thread/started が来なくても、これで孫の親が分かる。 */
const spawnCall = (sender, receiver) => ({
  method: "item/completed",
  params: {
    threadId: sender, turnId: "tn_x", completedAtMs: Date.now(),
    item: {
      id: `call_spawn_${receiver.slice(-4)}`, type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
      senderThreadId: sender, receiverThreadIds: [receiver], prompt: "調べて", model: "gpt-6-astra",
      reasoningEffort: "medium", agentsStates: { [receiver]: { status: "pendingInit", message: null } },
    },
  },
});

/** rollout では親のターンに item_completed として残る（SubAgentActivity）。 */
const activity = (parent, child, agentPath) => ({
  method: "item/completed",
  params: {
    threadId: parent, turnId: "tn_x", completedAtMs: Date.now(),
    item: { id: `call_act_${child.slice(-4)}`, type: "subAgentActivity", kind: "started", agentThreadId: child, agentPath },
  },
});

const commandItem = (threadId, id, method, status) => ({
  method,
  params: {
    threadId, turnId: "tn_x", startedAtMs: Date.now(), completedAtMs: Date.now(),
    item: { id, type: "commandExecution", command: "npm test", commandActions: [], cwd: ROOT, status },
  },
});

// ---- 道具

/** 受けたものを順に記録するハンドラ。承認には accept を返す。 */
function recorder() {
  const log = [];
  return {
    log,
    onNotification: (method, params) => log.push({ via: "own", method, params }),
    onChildNotification: (method, params, child) => log.push({ via: "child", method, params, child }),
    onRequest: async (method, params, child) => {
      log.push({ via: "request", method, params, child });
      return { decision: "accept" };
    },
  };
}

/** scripted-codex への指示。push は応答が来た時点で frame が全部 codex-rpc に届いている。 */
const io = (rpc) => ({
  push: (...frames) => rpc.request("test/push", { frames }),
  ask: async (frame) => (await rpc.request("test/ask", { frame })).reply,
});

async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("待ちきれなかった");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isError = (reply) => reply?.error?.code === -32000 && /受け取る相手が居ない/.test(String(reply.error.message));

// ---- 1. 子スレッドの承認・質問を親へ

async function routesChildren(t, r) {
  const { push, ask } = io(r);
  const p = recorder();
  const off = r.attach(PARENT, p);
  const lastRequest = () => p.log.filter((e) => e.via === "request").at(-1);

  await push(threadStarted(CHILD, { parent: PARENT, agentPath: "/root/csv_fixture_research", nickname: "Planck" }));
  let reply = await ask(commandApproval(CHILD, "call_c1", "npm test"));
  let got = lastRequest();
  t.ok("子の承認要求が親のハンドラに届き、親の答えが codex へ戻る",
    got?.params?.threadId === CHILD && reply.result?.decision === "accept", JSON.stringify(reply));
  t.ok("どの子の要求かが名前付きで添えられる",
    got?.child?.threadId === CHILD && got.child.path === "/root/csv_fixture_research" && got.child.nickname === "Planck",
    JSON.stringify(got?.child ?? null));

  await push(threadStarted(SIBLING, {
    parent: PARENT, agentPath: "/root/upplan_research", nickname: "Ampere", withParentField: false,
  }));
  reply = await ask(userInput(SIBLING, "call_q1"));
  got = lastRequest();
  t.ok("parentThreadId が無くても thread_spawn.parent_thread_id で子の質問が親へ届く",
    got?.method === "item/tool/requestUserInput" && got.child?.path === "/root/upplan_research" && !reply.error,
    JSON.stringify(reply));

  // 孫: 子が spawn_agent した先。thread/started が来なくても collabAgentToolCall で分かる
  await push(spawnCall(CHILD, GRANDCHILD));
  reply = await ask(commandApproval(GRANDCHILD, "call_g1", "ls"));
  got = lastRequest();
  t.ok("孫の承認は最上位の親（会話を持つスレッド）へ届く",
    got?.params?.threadId === GRANDCHILD && got.child?.threadId === GRANDCHILD && reply.result?.decision === "accept",
    JSON.stringify({ child: got?.child, reply }));

  await push(activity(PARENT, ACTIVITY_CHILD, "/root/pdf_fixture_research"));
  await ask(commandApproval(ACTIVITY_CHILD, "call_d1", "pwd"));
  got = lastRequest();
  t.ok("subAgentActivity の agentThreadId でも親を引ける",
    got?.child?.threadId === ACTIVITY_CHILD && got.child.path === "/root/pdf_fixture_research",
    JSON.stringify(got?.child ?? null));

  // 子の通知は親の本文・ツールの口（onNotification）には来ない
  const ownBefore = p.log.filter((e) => e.via === "own").length;
  await push(
    delta(CHILD, "子の本文"),
    commandItem(CHILD, "call_c2", "item/started", "inProgress"),
    commandItem(CHILD, "call_c2", "item/completed", "completed"),
    { method: "turn/completed", params: { threadId: CHILD, turn: { id: "tn_x", items: [], status: "completed" } } },
  );
  const own = p.log.filter((e) => e.via === "own");
  t.ok("子の本文・ツール・turn/completed は親の onNotification に来ない",
    own.length === ownBefore, own.map((e) => e.method).join(","));
  const childLog = p.log.filter((e) => e.via === "child");
  t.ok("子の通知は onChildNotification に子の印付きで来る",
    childLog.some((e) => e.method === "item/agentMessage/delta" && e.child?.threadId === CHILD)
      && childLog.some((e) => e.method === "turn/completed" && e.child?.threadId === CHILD),
    childLog.map((e) => e.method).join(","));
  await push(delta(PARENT, "親の本文"));
  t.ok("親自身の通知は今までどおり onNotification に来る",
    p.log.at(-1)?.via === "own" && p.log.at(-1).params.delta === "親の本文");

  // 親のターンが終わって外れた後
  off();
  reply = await ask(commandApproval(CHILD, "call_c3", "npm test"));
  t.ok("親が外れた後の子の承認は、今までどおりエラーで返す", isError(reply), JSON.stringify(reply));
  reply = await ask(commandApproval(GRANDCHILD, "call_g2", "ls"));
  t.ok("親が外れた後の孫の承認もエラーで返す", isError(reply), JSON.stringify(reply));
  const count = p.log.length;
  await push(delta(CHILD, "遅れた子の本文"));
  t.ok("外れた親へは子の通知も渡さない", p.log.length === count);

  // 子は親のターンをまたいで生きている。次のターンで親が attach し直せば、また届く
  const p2 = recorder();
  const off2 = r.attach(PARENT, p2);
  reply = await ask(commandApproval(CHILD, "call_c4", "npm test"));
  t.ok("親が attach し直せば、残っている子の承認はまた届く",
    p2.log.at(-1)?.child?.threadId === CHILD && reply.result?.decision === "accept", JSON.stringify(reply));
  off2();
}

// ---- 2. thread/start の応答待ちの受け皿

async function holdsForNewThread(t, r) {
  const { push, ask } = io(r);
  const mine = recorder();
  const release = r.claimOrphan(mine);

  // 応答待ちの間に、よそのスレッドの frame と、自分（NEW）の frame が混ざって来る
  const foreignAsk = ask(commandApproval(FOREIGN, "call_f1", "rm -rf build"));
  await push(
    delta(FOREIGN, "よその本文"),
    // 終わったターンに遅れて来る item/completed（バックグラウンド端末）
    { method: "item/completed", params: {
      threadId: PARENT, turnId: "tn_old", completedAtMs: Date.now(),
      item: { id: "call_bg", type: "commandExecution", command: "python -m http.server", commandActions: [],
        cwd: ROOT, status: "completed", exitCode: 0, aggregatedOutput: "" },
    } },
    delta(CHILD, "親の居ない子の本文"),
    { method: "account/rateLimits/updated", params: { rateLimits: {} } },   // threadId を持たない
    threadStarted(NEW),
    { method: "thread/status/changed", params: { threadId: NEW, status: { type: "idle" } } },
    delta(NEW, "早い本文", "tn_new"),
  );
  t.ok("id が分かるまで、受け皿には何も渡さない", mine.log.length === 0, mine.log.map((e) => e.method).join(","));

  const detach = r.adopt(NEW, mine);
  t.ok("adopt で、自分の frame だけが届いた順に渡る",
    mine.log.map((e) => e.method).join(",") === "thread/started,thread/status/changed,item/agentMessage/delta"
      && mine.log.every((e) => e.via === "own"),
    mine.log.map((e) => `${e.via}:${e.method}`).join(","));
  t.ok("よそのスレッドの本文は混ざらない",
    !mine.log.some((e) => /よその|親の居ない/.test(String(e.params?.delta ?? ""))) && mine.log.at(-1)?.params?.delta === "早い本文");
  const foreign = await foreignAsk;
  t.ok("見知らぬスレッドの承認要求は、受け皿が片付いたらエラーで返す（codex を待たせない）",
    isError(foreign), JSON.stringify(foreign));
  await push(delta(NEW, "後の本文", "tn_new"));
  t.ok("adopt の後は普通に届く", mine.log.at(-1)?.params?.delta === "後の本文");
  release();   // adopt 済みなら何もしない
  detach();

  // 新規セッションを並行して 2 本始めても取り合わない
  const a = recorder();
  const b = recorder();
  const releaseA = r.claimOrphan(a);
  const releaseB = r.claimOrphan(b);
  await push(delta(NEW_A, "a1"), delta(NEW_B, "b1"));
  const detachA = r.adopt(NEW_A, a);
  await push(delta(NEW_B, "b2"), delta(NEW_A, "a2"));
  t.ok("並行する新規: 先に id の分かった方は自分の分だけ受ける",
    a.log.map((e) => e.params.delta).join(",") === "a1,a2" && b.log.length === 0,
    JSON.stringify({ a: a.log.map((e) => e.params.delta), b: b.log.length }));
  const detachB = r.adopt(NEW_B, b);
  t.ok("並行する新規: 後の方も、預かっていた自分の分を順に受ける",
    b.log.map((e) => e.params.delta).join(",") === "b1,b2", b.log.map((e) => e.params.delta).join(","));
  detachA(); detachB(); releaseA(); releaseB();

  // thread/start が失敗して、adopt せずに取り下げた
  const c = recorder();
  const releaseC = r.claimOrphan(c);
  const pending = ask(commandApproval(UNKNOWN, "call_u", "ls"));
  await push(delta(UNKNOWN, "x"));
  releaseC();
  const reply = await pending;
  t.ok("取り下げただけでも、預かっていた承認要求にはエラーを返す",
    isError(reply) && c.log.length === 0, JSON.stringify(reply));
}

// ---- 3. codex バックエンド越し（runTurn → askPermission の形）

async function backendTurn(t) {
  shared.stop();   // 他のテストが起こしていたら止める。ここで scripted-codex を起こし直す
  const { push, ask } = io(shared);
  const events = [];
  const asked = [];
  const run = backend.runTurn({
    prompt: "サブエージェントに任せて", sessionId: null, cwd: ROOT, mode: "ask",
    emit: (e) => events.push(e),
    askPermission: async (req) => {
      asked.push(req);
      return req.kind === "question"
        ? { allow: true, answers: { [req.questions[0].question]: "A" } }
        : { allow: true };
    },
  });
  await until(async () => (await shared.request("test/state")).startPending > 0);

  // thread/start の応答待ちの間に、よそのスレッドの本文・ツール・承認要求が来る
  const foreignAsk = ask(commandApproval(FOREIGN, "call_f2", "rm -rf build"));
  await push(
    delta(FOREIGN, "よその本文"),
    { method: "item/started", params: {
      threadId: FOREIGN, turnId: "tn_f", startedAtMs: Date.now(),
      item: { id: "call_ftool", type: "commandExecution", command: "rm -rf build", commandActions: [], cwd: ROOT, status: "inProgress" },
    } },
    threadStarted(NEW_TURN),
  );
  await shared.request("test/release", { result: {
    thread: threadStarted(NEW_TURN).params.thread, model: "gpt-6-astra", modelProvider: "openai", cwd: ROOT,
    approvalPolicy: "untrusted", approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  } });
  const state = await until(async () => {
    const s = await shared.request("test/state");
    return s.turns.length ? s : null;
  });
  const turnId = state.turns.at(-1);
  const foreign = await foreignAsk;

  // 親のターンの中で子が動き、子の threadId で承認と質問を求める
  const file = path.join(ROOT, "fixtures", "a.csv");
  const patch = { id: "call_patch", type: "fileChange", status: "inProgress", changes: [{ path: file, kind: { type: "add" }, diff: "a,b" }] };
  await push(
    { method: "turn/started", params: { threadId: NEW_TURN, turn: { id: turnId, items: [], status: "inProgress" } } },
    threadStarted(TURN_CHILD, { parent: NEW_TURN, agentPath: "/root/csv_fixture_research", nickname: "Planck" }),
    { method: "turn/started", params: { threadId: TURN_CHILD, turn: { id: "tn_c", items: [], status: "inProgress" } } },
    delta(TURN_CHILD, "子の本文", "tn_c"),
    { method: "item/started", params: { threadId: TURN_CHILD, turnId: "tn_c", startedAtMs: Date.now(), item: patch } },
  );
  const fileReply = await ask(fileApproval(TURN_CHILD, "call_patch"));
  const questionReply = await ask(userInput(TURN_CHILD, "call_q"));
  await push(
    { method: "item/completed", params: { threadId: TURN_CHILD, turnId: "tn_c", completedAtMs: Date.now(), item: { ...patch, status: "completed" } } },
    { method: "turn/completed", params: { threadId: TURN_CHILD, turn: { id: "tn_c", items: [], status: "completed" } } },
    delta(NEW_TURN, "親の本文", turnId),
    { method: "turn/completed", params: { threadId: NEW_TURN, turn: { id: turnId, items: [], status: "completed" } } },
  );
  const result = await run;

  const text = events.filter((e) => e.type === "text.delta").map((e) => e.text).join("");
  t.ok("runTurn: 新規の id が session で来る",
    result.sessionId === NEW_TURN && events.some((e) => e.type === "session" && e.first && e.sessionId === NEW_TURN));
  t.ok("runTurn: 本文は親のものだけ（よそのスレッド・子の本文が混ざらない）", text === "親の本文", JSON.stringify(text));
  t.ok("runTurn: よそのスレッド・子のツールはカードにならない",
    !events.some((e) => e.type === "tool.start"), JSON.stringify(events.filter((e) => e.type === "tool.start")));
  t.ok("runTurn: 応答待ちの間に来たよそのスレッドの承認要求はエラーで返す", isError(foreign), JSON.stringify(foreign));
  t.ok("runTurn: ターンは ok で終わる", events.some((e) => e.type === "turnResult" && e.outcome === "ok"));

  const fileAsk = asked.find((a) => a.toolName === "fileChange");
  t.ok("子の fileChange 承認が親の会話に出る", fileAsk?.sessionId === NEW_TURN && fileAsk.kind === "tool",
    JSON.stringify(fileAsk ?? null));
  t.ok("承認カードの見出しにサブエージェントの名前が付く", fileAsk?.title === LABEL, String(fileAsk?.title));
  t.ok("子の item/started で見た変更ファイルが承認カードに載る",
    fileAsk?.input?.files?.[0] === file, JSON.stringify(fileAsk?.input ?? null));
  t.ok("子の承認の答えが codex へ戻る", fileReply.result?.decision === "accept", JSON.stringify(fileReply));

  const questionAsk = asked.find((a) => a.kind === "question");
  t.ok("子の質問も親の会話に、名前付きで出る",
    questionAsk?.sessionId === NEW_TURN && questionAsk.title === LABEL, JSON.stringify(questionAsk ?? null));
  t.ok("子の質問の答えが質問 id 付きで codex へ戻る",
    questionReply.result?.answers?.q1?.answers?.[0] === "A", JSON.stringify(questionReply));

  // ターンが終わって親が外れた後に、生きている子が承認を求める
  const late = await ask(commandApproval(TURN_CHILD, "call_late", "npm test"));
  t.ok("runTurn が返った後の子の承認はエラーで返す（codex は待たされない）", isError(late), JSON.stringify(late));
}

// ---- 4. サブエージェント一覧の口（listSubagents / getSubagentMessages / getSubagentOrigin / getSubagentState）
//
// こちらは tests/lib/fake-codex.mjs（thread/list { parentThreadId } と thread/read を持つ台本）と話す。
// server の runningWork は 4 秒ごとにこれらを全部呼ぶので、呼び出し回数（fake/stats）も測る。

async function subagentsViaFake(t) {
  shared.stop();
  process.env.AGENT_HOST_CODEX_BIN = `node "${FAKE}"`;
  const stats = async () => shared.request("fake/stats");
  const events = [];
  const res = await backend.runTurn({
    prompt: "subagent", sessionId: null, cwd: ROOT, mode: "ask",
    emit: (e) => events.push(e), askPermission: async () => ({ allow: true }),
  });
  const parent = res.sessionId;
  const ids = await backend.listSubagents(parent);
  const child = ids[0];
  t.ok("listSubagents: 親の直接の子が 1 本だけ返る", ids.length === 1 && /^th_\d+$/.test(child ?? ""), JSON.stringify(ids));
  t.ok("capabilities.subagents と subagentTools を申告する",
    backend.capabilities.subagents === true
      && JSON.stringify(backend.subagentTools) === JSON.stringify(["subAgentActivity", "collabAgentToolCall"]));

  // tool.start の event.id と getSubagentOrigin の戻りが同じ id 空間（server の taskHints はこれで引く）
  const origin = await backend.getSubagentOrigin(parent, child);
  const starts = events.filter((e) => e.type === "tool.start");
  const originCard = starts.find((e) => e.id === origin);
  t.ok("getSubagentOrigin: subAgentActivity(started) の id を返し、それは tool.start で出した id",
    origin === `call_act_${child}` && originCard?.name === "subAgentActivity", JSON.stringify({ origin, starts: starts.map((e) => e.id) }));
  t.ok("その委譲カードの description が一覧の見出しになる",
    originCard?.input?.description === "csv_fixture_research", JSON.stringify(originCard?.input ?? null));

  const msgs = await backend.getSubagentMessages(parent, child, { limit: 200 });
  t.ok("getSubagentMessages: thread/read の子の turns を threadToMessages で読む",
    msgs.map((m) => m.text).join("|") === "受け取った|子の本文|報告: ok" && msgs.every((m) => m.role === "assistant" && m.at),
    JSON.stringify(msgs.map((m) => m.text)));
  const two = await backend.getSubagentMessages(parent, child, { limit: 2 });
  t.ok("limit を超えたら先頭と末尾を残す（Claude と同じ省略）",
    two.map((m) => m.text).join("|") === "受け取った|報告: ok", JSON.stringify(two.map((m) => m.text)));

  const state = await backend.getSubagentState(parent, child);
  t.ok("getSubagentState: 通知で見た subAgentActivity(completed) から completed と時刻",
    state?.status === "completed" && !Number.isNaN(Date.parse(state.startedAt)) && !Number.isNaN(Date.parse(state.endedAt))
      && Date.parse(state.startedAt) <= Date.parse(state.endedAt),
    JSON.stringify(state));

  // 4 秒ごとの呼び出しを重くしない
  const before = await stats();
  await backend.listSubagents(parent);
  await backend.getSubagentState(parent, child);
  await backend.getSubagentOrigin(parent, child);
  const mid = await stats();
  t.ok("続けて呼んでも thread/list と親の thread/read を叩き直さない",
    (mid["thread/list"] ?? 0) === (before["thread/list"] ?? 0) && (mid["thread/read"] ?? 0) === (before["thread/read"] ?? 0),
    JSON.stringify({ before, mid }));
  await new Promise((r) => setTimeout(r, 3_200));
  await backend.listSubagents(parent);   // 期限切れ -> 読み直して updatedAt を覚え直す
  const readsBefore = (await stats())["thread/read"] ?? 0;
  await backend.getSubagentMessages(parent, child, { limit: 200 });
  const readsAfter = (await stats())["thread/read"] ?? 0;
  t.ok("終わった子の本文は updatedAt が変わらなければ読み直さない", readsAfter === readsBefore, `${readsBefore} -> ${readsAfter}`);

  // agentId はクライアントから戻ってくる。形の違うもの・子でないものは読まない
  for (const bad of ["", "../th_1", "th 1", "a/b", "x".repeat(200), null, 42]) {
    const got = [
      await backend.getSubagentMessages(parent, bad, { limit: 10 }),
      await backend.getSubagentOrigin(parent, bad),
      await backend.getSubagentState(parent, bad),
    ];
    if (got[0].length || got[1] !== null || got[2] !== null) {
      t.ok(`形の違う agentId を撥ねる: ${JSON.stringify(bad)}`, false, JSON.stringify(got));
    }
  }
  t.ok("形の違う agentId は読まない（本文は空、origin / 状態は null）", true);

  // ---- 実行時に何も見ていない親（再起動の後など）。親の items から引く
  const seed = await shared.request("fake/seedSubagents", { cwd: ROOT });
  const seeded = await backend.listSubagents(seed.parent);
  t.ok("listSubagents: thread/list { parentThreadId } の子。孫は入らない",
    [seed.activity, seed.collab, seed.stopped].every((id) => seeded.includes(id)) && seeded.length === 3,
    JSON.stringify({ seeded, seed }));
  t.ok("getSubagentMessages: 親の子でない thread は読まない（孫・よその会話）",
    (await backend.getSubagentMessages(seed.parent, seed.grandchild)).length === 0
      && (await backend.getSubagentMessages(seed.parent, parent)).length === 0
      && (await backend.getSubagentMessages(parent, seed.activity)).length === 0);
  t.ok("getSubagentMessages: 永続化された子の本文",
    (await backend.getSubagentMessages(seed.parent, seed.activity)).map((m) => m.text).join("|") === "song_audit の報告");

  t.ok("getSubagentOrigin: 履歴の subAgentActivity(started) の id",
    await backend.getSubagentOrigin(seed.parent, seed.activity) === "call_seed_activity");
  t.ok("getSubagentOrigin: subAgentActivity が無ければ spawnAgent の collabAgentToolCall の id",
    await backend.getSubagentOrigin(seed.parent, seed.collab) === "call_seed_collab");
  t.ok("getSubagentOrigin: 分からなければ null（孫）", await backend.getSubagentOrigin(seed.parent, seed.grandchild) === null);

  const done = await backend.getSubagentState(seed.parent, seed.activity);
  t.ok("getSubagentState: 履歴の completed。時刻は子の Thread の createdAt / updatedAt",
    done?.status === "completed" && Math.abs(Date.parse(done.startedAt) - (Date.now() - 60_000)) < 5_000
      && Math.abs(Date.parse(done.endedAt) - (Date.now() - 30_000)) < 5_000,
    JSON.stringify(done));
  const failed = await backend.getSubagentState(seed.parent, seed.collab);
  t.ok("getSubagentState: collabAgentToolCall の agentsStates errored は failed", failed?.status === "failed" && Boolean(failed.endedAt), JSON.stringify(failed));
  const stopped = await backend.getSubagentState(seed.parent, seed.stopped);
  t.ok("getSubagentState: subAgentActivity interrupted は stopped", stopped?.status === "stopped" && Boolean(stopped.endedAt), JSON.stringify(stopped));
  t.ok("getSubagentState: 分からなければ null", await backend.getSubagentState(seed.parent, seed.grandchild) === null);

  // ---- 走っている子（親のターンの中）
  const live = [];
  const slowRun = backend.runTurn({
    prompt: "subagent-slow", sessionId: null, cwd: ROOT, mode: "ask",
    emit: (e) => live.push(e), askPermission: async () => ({ allow: true }),
  });
  const slowParent = (await until(async () => live.find((e) => e.type === "session"))).sessionId;
  const slowChild = await until(async () => (await backend.listSubagents(slowParent))[0]);
  await until(async () => (await backend.getSubagentMessages(slowParent, slowChild)).length === 3);
  const running = await backend.getSubagentState(slowParent, slowChild);
  t.ok("getSubagentState: 走っている子は running、endedAt は null",
    running?.status === "running" && Boolean(running.startedAt) && running.endedAt === null, JSON.stringify(running));
  const readsLive = (await stats())["thread/read"] ?? 0;
  await backend.getSubagentState(slowParent, slowChild);
  t.ok("親が走っている間の状態は通知から（thread/read を叩かない）", ((await stats())["thread/read"] ?? 0) === readsLive);
  const slowTurnId = (await shared.request("thread/read", { threadId: slowParent, includeTurns: true })).thread.turns.at(-1).id;
  await shared.request("turn/interrupt", { threadId: slowParent, turnId: slowTurnId });
  await slowRun;
  const interrupted = await backend.getSubagentState(slowParent, slowChild);
  t.ok("親が中断して subAgentActivity(interrupted) が来たら stopped", interrupted?.status === "stopped" && Boolean(interrupted.endedAt), JSON.stringify(interrupted));

  // ---- parentThreadId を知らない古い版: 絞らずに普通の一覧を返しても、会話をサブエージェントにしない
  await shared.request("fake/config", { parentFilter: "ignore" });
  await new Promise((r) => setTimeout(r, 2_100));   // 一覧の覚えが切れるのを待つ
  const old = await backend.listSubagents(seed.parent);
  t.ok("古い版: トップレベルの会話を子として返さない", !old.includes(parent) && !old.includes(slowParent), JSON.stringify(old));
  const oldLive = await backend.listSubagents(parent);
  t.ok("古い版: 実行時に覚えた子（rpc.parents）だけに落ちる", JSON.stringify(oldLive) === JSON.stringify([child]), JSON.stringify(oldLive));
}

export default async function (t) {
  const previous = process.env.AGENT_HOST_CODEX_BIN;
  process.env.AGENT_HOST_CODEX_BIN = `node "${SCRIPT}"`;
  const r = new CodexRpc();
  try {
    await r.start();
    await routesChildren(t, r);
    await holdsForNewThread(t, r);
    await backendTurn(t);
    await subagentsViaFake(t);
  } finally {
    r.stop();
    shared.stop();
    if (previous === undefined) delete process.env.AGENT_HOST_CODEX_BIN;
    else process.env.AGENT_HOST_CODEX_BIN = previous;
  }
}
