// Claude のターンの終わり方。委譲の子が「報告を書いたのに running のまま」残った件（2026-09-27）の形を、
// SDK の query を身代わりに差し替えて（setClaudeSdkForTest）CLI も LLM も呼ばずに流す。
//   - Stop フック（exit 2 で続きを書かせる型）の続きは同じ query の中で流れ、result は最後に 1 回。これだけならターンは終わる
//   - 120 秒で終わらず CLI が裏へ回したコマンド（local_bash）が生きている間は、main が止まってもターンは終わらない（phase: waiting）
//   - 止める口（stopBackground -> Query.stopTask）で止めると、完了通知の後に入力を閉じてターンが終わる
// サーバー全体で委譲のタスクが running のまま残らないことは tests/unit/server-delegation-background.mjs が見る
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-turn-end";
export const title = "Claude: Stop フックの続きと、裏へ回ったまま終わらないコマンドがあるターンの終わり方";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION = "11111111-2222-4333-8444-555555555555";

/** SDK の Query の身代わり。入力（CLI の stdin）が閉じたら自分で終わる。stopTask は onStop に渡す */
function fakeSdk({ onStop } = {}) {
  const inbox = [];
  let wake = null, ended = false;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const q = {
    inputClosed: false,
    stopped: [],
    push(...ms) { inbox.push(...ms); poke(); },
    async stopTask(taskId) { q.stopped.push(taskId); onStop?.(taskId, q); },
    interrupt() { return Promise.resolve({}); },
    close() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (inbox.length) { yield inbox.shift(); continue; }
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
  const query = ({ prompt }) => {
    (async () => { for await (const _ of prompt) { /* 最初のプロンプトと途中送信 */ } q.inputClosed = true; ended = true; poke(); })();
    return q;
  };
  return { q, restore: setClaudeSdkForTest({ query, executable: () => "claude-fake", resumeGraceMs: 30 }) };
}

// SDK のメッセージの形（sdk.d.ts）。main の 1 回の応答は message_start … message_delta(stop_reason)
const init = () => ({ type: "system", subtype: "init", session_id: SESSION, model: "claude-test" });
const start = () => ({ type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "message_start" } });
const stop = (reason) => ({ type: "stream_event", parent_tool_use_id: null, session_id: SESSION, event: { type: "message_delta", delta: { stop_reason: reason } } });
const text = (s) => ({ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "text", text: s }] } });
const toolUse = (id, name) => ({ type: "assistant", parent_tool_use_id: null, session_id: SESSION, uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });
const toolResult = (id, s) => ({ type: "user", parent_tool_use_id: null, session_id: SESSION, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: s }] } });
const result = () => ({ type: "result", subtype: "success", session_id: SESSION, num_turns: 1, total_cost_usd: 0 });
// 報告 → Stop フックが続きを書かせる → ツールを 2 回呼んで一言 → result（2026-09-27 の子の transcript の末尾と同じ並び）
const reportThenStopHook = () => [
  start(), text("報告: 作業を終えた"), stop("end_turn"),
  start(), toolUse("toolu_search", "ToolSearch"), stop("tool_use"), toolResult("toolu_search", "ok"),
  start(), toolUse("toolu_skill", "mcp__ply_context__load_skill"), stop("tool_use"), toolResult("toolu_skill", "skill"),
  start(), text("ナレッジ化対象なし"), stop("end_turn"),
  result(),
];

async function startTurn() {
  const events = [];
  let settled = false;
  const done = claude.runTurn({
    prompt: "work", sessionId: null, cwd: process.cwd(), mode: "bypass",
    emit: (ev) => events.push(ev), askPermission: async () => ({ allow: true }),
    signal: new AbortController(), control: {}, hostSessionId: "host-turn-end",
  }).finally(() => { settled = true; });
  done.catch(() => {});
  return { events, done, settled: () => settled };
}
const until = async (fn, ms = 3000) => { for (let t = 0; t < ms && !fn(); t += 5) await sleep(5); return fn(); };
const results = (events) => events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join();

export default async function (t) {
  // ---- 1. Stop フックの続きだけなら、ターンは終わる
  {
    const { q, restore } = fakeSdk();
    try {
      const turn = await startTurn();
      q.push(init(), ...reportThenStopHook());
      t.ok("Stop フックの続きがあってもターンは終わる", await until(turn.settled), `inputClosed=${q.inputClosed}`);
      t.ok("turnResult は最後に ok が 1 回だけ", results(turn.events) === "ok", results(turn.events));
      const tools = turn.events.filter((e) => e.type === "tool.start").map((e) => e.name).join();
      t.ok("フックの続き（ツールの呼び出し）も同じターンの中で流れる", tools === "ToolSearch,mcp__ply_context__load_skill", tools);
    } finally { restore(); }
  }

  // ---- 2. 裏へ回ったまま終わらないコマンドが残ると、報告の後もターンは終わらない
  {
    const { q, restore } = fakeSdk({
      // 止めると CLI は stopped の完了通知と一覧の更新を出し、main を再開させる
      onStop: (taskId, q) => q.push(
        { type: "system", subtype: "task_notification", task_id: taskId, status: "stopped", session_id: SESSION },
        { type: "system", subtype: "background_tasks_changed", tasks: [], session_id: SESSION },
        { type: "system", subtype: "init", session_id: SESSION, model: "claude-test" },
        start(), text("裏のコマンドは止められた"), stop("end_turn"), result()),
    });
    try {
      const turn = await startTurn();
      q.push(init(),
        // 前面で始めた Bash が 120 秒で終わらず、CLI が裏へ回した（backgroundTaskId）
        start(), toolUse("toolu_bash", "Bash"), stop("tool_use"),
        { type: "system", subtype: "task_started", task_id: "bko0w1ra2", task_type: "local_bash", description: "playwright-cli run-code", tool_use_id: "toolu_bash", session_id: SESSION },
        { type: "system", subtype: "task_updated", task_id: "bko0w1ra2", patch: { is_backgrounded: true }, session_id: SESSION },
        { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bko0w1ra2", task_type: "local_bash", description: "playwright-cli run-code" }], session_id: SESSION },
        toolResult("toolu_bash", "Command did not complete within its 120s timeout and was moved to the background (ID: bko0w1ra2)."),
        ...reportThenStopHook());
      await until(() => turn.events.some((e) => e.type === "phase" && e.state === "waiting"));
      await sleep(200);
      t.ok("報告と result の後も、裏のコマンドが生きている間はターンが終わらない（入力を閉じない）", !turn.settled() && !q.inputClosed,
        `settled=${turn.settled()} inputClosed=${q.inputClosed}`);
      const phases = turn.events.filter((e) => e.type === "phase").map((e) => e.state);
      const bg = turn.events.filter((e) => e.type === "background").at(-1)?.tasks ?? [];
      t.ok("phase: waiting と、裏のコマンド（shell・waitable）の一覧が出る", phases.at(-1) === "waiting" && bg.length === 1 && bg[0].kind === "shell" && bg[0].waitable === true,
        JSON.stringify({ phases, bg }));
      t.ok("result はまだ出さない（query の終わりに 1 回）", results(turn.events) === "", results(turn.events));

      await claude.stopBackground("host-turn-end", "bko0w1ra2");
      t.ok("止める口は Query.stopTask に届く", q.stopped.join() === "bko0w1ra2");
      t.ok("止めた後は完了通知と main の再開を待ってからターンが終わる", await until(turn.settled), `inputClosed=${q.inputClosed}`);
      t.ok("turnResult は ok が 1 回", results(turn.events) === "ok", results(turn.events));
      t.ok("最後は phase: active", turn.events.filter((e) => e.type === "phase").at(-1)?.state === "active");
    } finally { restore(); }
  }
}
