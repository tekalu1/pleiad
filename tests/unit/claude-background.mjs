// main とバックグラウンド作業の追跡（core/backends/claude-background.mjs）。
//
// フィクスチャは実測したメッセージ列（output/bg-tasks/claude-report.md の r1 / r3 / r5、
// 2026-09、SDK 0.3.258）を必要な項目だけに削ったもの。
// ※ core/backends/claude-background.mjs の判定ルールを変えたら、ここも合わせること。
import { createTurnTracker, createInputQueue, createInputCloser, createHostCalls, createStderrLog, taskKind, subagentStatus }
  from "../../core/backends/claude-background.mjs";

export const name = "claude-background";
export const title = "Claude の main / バックグラウンドの状態と、入力を閉じる規則";

const init = () => ({ type: "system", subtype: "init", model: "claude-sonnet-5" });
const start = () => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });
const delta = (stop_reason) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason } } });
const subDelta = () => ({ type: "stream_event", parent_tool_use_id: "toolu_sub", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
const result = () => ({ type: "result", subtype: "success", num_turns: 1, total_cost_usd: 0.01 });
const changed = (...tasks) => ({ type: "system", subtype: "background_tasks_changed",
  tasks: tasks.map(([task_id, task_type, extra]) => ({ task_id, task_type, description: `${task_id} の説明`, ...(extra ?? {}) })) });
const started = (task_id, task_type, is_backgrounded, extra = {}) => ({ type: "system", subtype: "task_started", task_id, task_type, is_backgrounded, description: `${task_id} を始めた`, ...extra });
const updated = (task_id, patch) => ({ type: "system", subtype: "task_updated", task_id, patch });
const notified = (task_id, status = "completed") => ({ type: "system", subtype: "task_notification", task_id, status });
// 委譲ツール（Agent）の結果。tool_use_result は sdk-tools.d.ts の AgentOutput（実データ ~/.claude/projects の toolUseResult と同じ形）
const agentResult = (tool_use_id, tool_use_result, text, { isError = false, timestamp } = {}) => ({
  type: "user", parent_tool_use_id: null, tool_use_result, ...(timestamp ? { timestamp } : {}),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id, content: text, ...(isError ? { is_error: true } : {}) }] },
});

/** メッセージ列を流し、出てきた正規化イベントを全部返す */
function run(tracker, messages) {
  const out = [];
  for (const m of messages) out.push(...tracker.observe(m));
  return out;
}
const phases = (events) => events.filter((e) => e.type === "phase").map((e) => e.state).join(",");

export default function (t) {
  t.ok("task_type を種類に落とす", taskKind("local_agent") === "agent" && taskKind("local_bash") === "shell"
    && taskKind("local_workflow") === "other" && taskKind(undefined) === "other");

  // ---- r1: バックグラウンド subagent 1 本
  {
    const k = createTurnTracker();
    t.ok("始まった時点では main が作業中で、入力は閉じない", k.mainActive && k.phase === "active" && !k.canCloseInput());
    const launched = run(k, [init(), start(), delta("tool_use"), changed(["T1", "local_agent"]), started("T1", "local_agent", true)]);
    t.ok("background が全量で 1 回だけ出る", launched.filter((e) => e.type === "background").length === 1
      && launched[0].tasks.length === 1 && launched[0].tasks[0].kind === "agent" && launched[0].tasks[0].label === "T1 の説明",
      JSON.stringify(launched));
    t.ok("tool_use で止まっても main は作業中のまま", k.mainActive && phases(launched) === "");

    const replied = run(k, [start(), delta("end_turn"), result()]);
    t.ok("main が返答を終えると waiting になる", phases(replied) === "waiting" && k.phase === "waiting");
    t.ok("subagent が走っている間は入力を閉じない", !k.canCloseInput());
    t.ok("subagent の中の end_turn では main の状態は変わらない", run(k, [subDelta(), started("T2", "local_bash", false)]).length === 0,
      "前景の Bash（is_backgrounded:false）は数えない");

    const done = run(k, [changed(), updated("T1", { status: "completed" }), notified("T1")]);
    t.ok("完了で一覧が空になり、waiting が解ける", done.map((e) => e.type).join(",") === "background,phase"
      && done[0].tasks.length === 0 && done[1].state === "active", JSON.stringify(done));
    t.ok("完了直後は main が止まっていて閉じられるが、再開を待つ印（sawWaitable）が立つ", k.canCloseInput() && k.sawWaitable);

    run(k, [init()]);
    t.ok("result の後の init は main の再開", k.mainActive && !k.canCloseInput());
    run(k, [start(), delta("end_turn"), result()]);
    t.ok("再開ターンの返答が終われば閉じてよい", k.canCloseInput() && k.phase === "active");
  }

  // ---- r3: バックグラウンド Bash だけ
  {
    const k = createTurnTracker();
    const ev = run(k, [init(), start(), delta("tool_use"), changed(["B1", "local_bash"]), started("B1", "local_bash", true), start(), delta("end_turn"), result()]);
    t.ok("shell だけでも、main が返答を終えれば waiting", phases(ev) === "waiting" && k.phase === "waiting");
    t.ok("shell が走っている間は入力を閉じない", !k.canCloseInput() && k.sawWaitable,
      "閉じると CLI が数秒でコマンドを kill し、完了通知も報告も来ない");
    t.ok("shell も background に載り、待てる印が付く",
      k.tasks.length === 1 && k.tasks[0].kind === "shell" && k.tasks[0].waitable === true, JSON.stringify(k.tasks));
    const done = run(k, [changed(), notified("B1")]);
    t.ok("完了通知で一覧が空になり、閉じられるようになる",
      done.map((e) => e.type).join(",") === "background,phase" && k.canCloseInput() && k.phase === "active",
      JSON.stringify(done));

    // 終わらないコマンド（npm run dev）の逃げ道は停止ボタン（claude.mjs の stopBackground -> Query.stopTask）
    const s = createTurnTracker();
    run(s, [init(), start(), changed(["S1", "local_bash"]), started("S1", "local_bash", true), delta("end_turn"), result()]);
    t.ok("止める前は waiting のまま閉じない", s.phase === "waiting" && !s.canCloseInput());
    run(s, [notified("S1", "stopped")]);
    t.ok("停止の通知でも一覧から消えて閉じられる", s.tasks.length === 0 && s.canCloseInput() && s.phase === "active");
  }

  // ---- r5: 2 本、2 つ目以降の result が保留される
  {
    const k = createTurnTracker();
    run(k, [init(), start(), changed(["A", "local_agent"]), changed(["A", "local_agent"], ["B", "local_agent"]), delta("tool_use"),
      start(), delta("end_turn"), result()]);
    t.ok("2 本走っていて main が返答済みなら waiting", k.phase === "waiting" && k.tasks.length === 2);
    const shrink = run(k, [changed(["A", "local_agent"], ["S", "local_bash"])]);
    t.ok("subagent が起動した shell も一覧に入り、waiting のまま", shrink.length === 1 && shrink[0].type === "background"
      && shrink[0].tasks.map((x) => x.kind).join(",") === "agent,shell" && k.phase === "waiting");
    t.ok("同じ内容の一覧が続いても出し直さない", run(k, [changed(["A", "local_agent"], ["S", "local_bash"])]).length === 0);
    run(k, [notified("B"), init(), start()]);
    t.ok("B の完了で main が再開すると active", k.phase === "active" && k.mainActive);
    const held = run(k, [delta("end_turn")]);
    t.ok("result が保留されても end_turn で waiting に戻る", phases(held) === "waiting" && !k.canCloseInput());
    run(k, [changed(["S", "local_bash"]), notified("A"), init(), start(), delta("end_turn"), result(), result()]);
    t.ok("最後の返答が終わっても、shell が残る間は閉じない", !k.canCloseInput() && k.phase === "waiting");
    run(k, [changed(), notified("S")]);
    t.ok("その shell も終われば閉じてよい", k.canCloseInput() && k.phase === "active");
  }

  // ---- 保険の経路（background_tasks_changed が来ない場合）
  {
    const k = createTurnTracker();
    run(k, [init(), start(), started("X", "local_agent", true), delta("end_turn"), result()]);
    t.ok("task_started(is_backgrounded) だけでも数える", k.phase === "waiting" && k.tasks[0]?.id === "X");
    run(k, [updated("X", { status: "killed" })]);
    t.ok("task_updated の終端状態で消える", k.tasks.length === 0 && k.phase === "active");
    run(k, [started("F", "local_agent", false), updated("F", { is_backgrounded: true })]);
    t.ok("前景で始まり後から裏へ回ったものを拾う", k.tasks[0]?.id === "F" && k.tasks[0].kind === "agent" && k.phase === "waiting");
    run(k, [notified("F", "failed")]);
    t.ok("task_notification で消える", k.tasks.length === 0);
    const amb = createTurnTracker();
    run(amb, [init(), start(), delta("end_turn"), result()]);
    t.ok("バックグラウンドを見ていなければ猶予は要らない", amb.canCloseInput() && !amb.sawWaitable);
    run(amb, [started("H", "local_agent", true, { ambient: true }), changed(["H2", "local_agent", { ambient: true }])]);
    t.ok("ambient は一覧に出さないし、閉じるのも止めない", amb.tasks.length === 0 && amb.phase === "active" && amb.canCloseInput(),
      "終わらない ambient で止めると、ターンが永久に終わらなくなる");
    t.ok("ambient でも、閉じる前の猶予は必ず置かせる", amb.sawWaitable,
      "一覧から外すのは表示の都合。CLI がこの後 main を再開しうるかとは別の話（猶予ゼロで閉じると host ツールが死ぬ）");

    const notice = createTurnTracker();
    run(notice, [init(), start(), delta("end_turn"), result(), notified("見たことのないタスク")]);
    t.ok("見ていないタスクの完了通知でも、再開を待つ印が立つ", notice.sawWaitable && notice.canCloseInput());
  }

  // ---- サブエージェントの状態（getSubagentState の材料）。task_id = agentId
  {
    t.ok("SDK の状態語を 4 つに写す", subagentStatus("completed") === "completed" && subagentStatus("failed") === "failed"
      && subagentStatus("killed") === "stopped" && subagentStatus("stopped") === "stopped"
      && ["pending", "running", "paused"].every((x) => subagentStatus(x) === "running") && subagentStatus("謎") === null);

    let clock = Date.parse("2026-09-22T01:00:00.000Z");
    const k = createTurnTracker({ now: () => new Date(clock) });
    t.ok("見ていない子は null（分からない）", k.subagentState("A") === null);
    run(k, [init(), start(), started("A", "local_agent", true, { tool_use_id: "toolu_A" })]);
    t.ok("task_started で running と開始時刻", JSON.stringify(k.subagentState("A"))
      === JSON.stringify({ status: "running", startedAt: "2026-09-22T01:00:00.000Z", endedAt: null }), JSON.stringify(k.subagentState("A")));
    // 裏に回した子の tool_result は起動直後に来る。完了と取り違えない（実データの形）
    run(k, [agentResult("toolu_A", { status: "async_launched", agentId: "A", isAsync: true }, "Async agent launched successfully.")]);
    t.ok("async_launched の tool_result は完了扱いしない", k.subagentState("A").status === "running");
    const end = Date.parse("2026-09-22T01:04:00.000Z");
    run(k, [updated("A", { status: "completed", end_time: end })]);
    t.ok("task_updated の completed と end_time を残す（以前は bg から消すだけで捨てていた）",
      k.subagentState("A").status === "completed" && k.subagentState("A").endedAt === "2026-09-22T01:04:00.000Z"
      && k.subagentState("A").startedAt === "2026-09-22T01:00:00.000Z", JSON.stringify(k.subagentState("A")));
    clock += 60_000;
    run(k, [notified("A")]);
    t.ok("続く task_notification で終了時刻を動かさない", k.subagentState("A").endedAt === "2026-09-22T01:04:00.000Z");

    run(k, [started("B", "local_agent", true), notified("B", "failed")]);
    t.ok("task_notification の failed", k.subagentState("B").status === "failed" && k.subagentState("B").endedAt);
    run(k, [started("C", "local_agent", true), updated("C", { status: "killed" })]);
    t.ok("killed は stopped", k.subagentState("C").status === "stopped");
    run(k, [started("D", "local_agent", true), updated("D", { status: "paused" })]);
    t.ok("paused は running のまま", k.subagentState("D").status === "running");
    run(k, [notified("E", "stopped")]);
    t.ok("始まりを見ていない子の停止通知も残す（開始時刻は null）",
      k.subagentState("E").status === "stopped" && k.subagentState("E").startedAt === null);

    // 前面で待つ子（is_backgrounded:false）。task 系の終わりが来なくても、委譲ツールの結果で完了とみなす
    const f = createTurnTracker({ now: () => new Date(clock) });
    run(f, [init(), start(), started("F", "local_agent", false, { tool_use_id: "toolu_F" })]);
    t.ok("前面の子も task_started で running", f.subagentState("F").status === "running" && f.tasks.length === 0);
    run(f, [agentResult("toolu_F", { status: "completed", agentId: "F", content: [{ type: "text", text: "報告" }] }, "報告",
      { timestamp: "2026-09-22T01:09:00.000Z" })]);
    t.ok("tool_use_result の completed で完了。時刻はメッセージの timestamp", f.subagentState("F").status === "completed"
      && f.subagentState("F").endedAt === "2026-09-22T01:09:00.000Z", JSON.stringify(f.subagentState("F")));
    // task_started が来なかった前面の子でも、結果の agentId で引ける
    run(f, [agentResult("toolu_G", { status: "completed", agentId: "G" }, "報告")]);
    t.ok("task_started が無くても結果の agentId で完了", f.subagentState("G")?.status === "completed" && f.subagentState("G").startedAt === null);
    run(f, [started("H", "local_agent", false, { tool_use_id: "toolu_H" }), agentResult("toolu_H", "Error: interrupted", "interrupted", { isError: true })]);
    t.ok("前面の子がエラーで返ったら failed", f.subagentState("H").status === "failed");
    run(f, [started("I", "local_agent", true), updated("I", { status: "failed" }), agentResult("toolu_I", { status: "completed", agentId: "I" }, "x")]);
    t.ok("失敗を完了で上書きしない", f.subagentState("I").status === "failed");
    run(f, [started("A2", "local_agent", true), notified("A2"), started("A2", "local_agent", true)]);
    t.ok("再開された子は running に戻り、終了時刻が消える", f.subagentState("A2").status === "running" && f.subagentState("A2").endedAt === null);
    const echo = createTurnTracker();
    run(echo, [{ ...agentResult("toolu_Z", { status: "completed", agentId: "Z" }, "x"), isReplay: true }]);
    t.ok("replay の echo は見ない", echo.subagentState("Z") === null);
  }

  // ---- session_state_changed（環境変数を付けた場合だけ来る）
  {
    const k = createTurnTracker();
    run(k, [{ type: "system", subtype: "session_state_changed", state: "idle" }]);
    t.ok("idle で main 停止", !k.mainActive);
    run(k, [{ type: "system", subtype: "session_state_changed", state: "running" }]);
    t.ok("running で main 作業中", k.mainActive);
  }

  // ---- (c) 流し込んだメッセージ
  {
    const k = createTurnTracker();
    run(k, [init(), start(), changed(["A", "local_agent"]), delta("end_turn"), result()]);
    k.pushed();
    t.ok("流し込んだ直後は、main が止まっていても未処理として数える", k.pending === 1 && !k.canCloseInput());
    run(k, [changed(), notified("A")]);
    t.ok("バックグラウンドが無くなっても、未処理が残る間は閉じない", !k.canCloseInput());
    run(k, [init(), start()]);
    t.ok("main が取りかかると未処理は消える", k.pending === 0 && k.mainActive);
    run(k, [delta("end_turn"), result()]);
    t.ok("その返答が終われば閉じてよい", k.canCloseInput());

    const busy = createTurnTracker();
    run(busy, [init(), start(), delta("tool_use")]);
    busy.pushed();
    run(busy, [start()]);
    t.ok("作業中に流し込んだものは、次のリクエストで取りかかったと数える", busy.pending === 0);
    busy.pushed();
    run(busy, [delta("end_turn"), result()]);
    t.ok("取りかかる前に main が止まったら閉じない", !busy.canCloseInput() && busy.phase === "active");
  }

  // ---- 入力を閉じる段取り（createInputCloser）
  // 閉じた入力は開き直せず、host ツールと承認の返事も通らなくなるので、迷ったら閉じない側に倒す
  {
    const clock = () => {
      let seq = 0;
      const jobs = new Map();
      return {
        timer: (fn, ms) => { jobs.set(++seq, { fn, ms }); return seq; },
        clear: (id) => { jobs.delete(id); },
        get waits() { return [...jobs.values()].map((j) => j.ms); },
        fire() { const list = [...jobs.values()]; jobs.clear(); for (const j of list) j.fn(); },
      };
    };
    const make = (state, inflight = () => 0) => {
      const c = clock();
      let closed = 0;
      const closer = createInputCloser({ tracker: state, inflight, close: () => { closed += 1; },
        graceMs: 5000, timer: c.timer, clear: c.clear });
      return { c, closer, get closed() { return closed; } };
    };

    const plain = { canCloseInput: () => true, sawWaitable: false };
    const a = make(plain);
    a.closer.settle();
    t.ok("バックグラウンドを見ていないターンは待たずに閉じる", a.c.waits.join() === "0");
    a.c.fire();
    t.ok("猶予が明けたら閉じる", a.closed === 1 && a.closer.closed);
    a.closer.settle();
    t.ok("閉じた後は何もしない", a.closed === 1 && !a.closer.armed);

    const waitable = { canCloseInput: () => true, sawWaitable: true };
    const b = make(waitable);
    b.closer.settle();
    b.closer.settle();
    t.ok("再開を待つターンは猶予を置き、期限は最初に揃った時点から数える", b.c.waits.join() === "5000");

    let ok = true;
    const c = make({ canCloseInput: () => ok, sawWaitable: true });
    c.closer.settle();
    ok = false;
    c.closer.settle();
    t.ok("揃わなくなったら予約を取り消す", !c.closer.armed);
    ok = true;
    c.closer.settle();
    ok = false;
    c.c.fire();
    t.ok("猶予の間に main が再開したら閉じない", c.closed === 0 && !c.closer.closed);

    let busy = 1;
    const d = make(waitable, () => busy);
    d.closer.settle();
    t.ok("host 側の応答が走っている間は予約もしない", !d.closer.armed, "結果を返す道（stdin）を塞ぐため");
    d.closer.settle();
    busy = 0;
    d.closer.settle();
    d.c.fire();
    t.ok("終われば閉じてよい", d.closed === 1);

    const e = make(waitable, () => 1);
    e.closer.now();
    t.ok("中断は段取りを飛ばして今すぐ閉じる", e.closed === 1 && e.closer.closed);
    e.closer.now();
    t.ok("二度は閉じない", e.closed === 1);
  }

  // ---- host ツール・承認の応答を数える（createHostCalls）
  return (async () => {
    const lines = [];
    let idle = 0;
    const calls = createHostCalls({ log: (l) => lines.push(l), onIdle: () => { idle += 1; } });
    let release;
    const held = calls.run("mcp__host__fork", () => new Promise((r) => { release = r; }));
    t.ok("走っている間は数に入る", calls.inflight === 1 && idle === 0);
    release("ok");
    t.ok("結果はそのまま返る", await held === "ok");
    t.ok("最後の 1 本が終わったら見直しを促す", calls.inflight === 0 && idle === 1);

    await calls.run("失敗するもの", async () => { throw new Error("boom"); }).catch(() => {});
    t.ok("失敗しても数は戻る", calls.inflight === 0 && idle === 2);

    calls.markClosed();
    await calls.run("mcp__host__set_title", async () => "late");
    t.ok("閉じた後に終わったものは届かないと知らせる", lines.length === 1 && lines[0].includes("mcp__host__set_title"),
      JSON.stringify(lines));

    // ---- 入力の列
    const q = createInputQueue();
    const got = [];
    const reader = (async () => { for await (const x of q) got.push(x); })();
    t.ok("開いている間は push を受け付ける", q.push("a") && q.push("b"));
    await new Promise((r) => setTimeout(r, 0));
    q.push("c");
    q.close();
    await reader;
    t.ok("push した順に取り出し、close で終わる", got.join("") === "abc", got.join(","));
    t.ok("close 後の push は断る", q.push("d") === false && q.closed);

    const early = createInputQueue();
    early.push("x");
    early.close();
    const left = [];
    for await (const x of early) left.push(x);
    t.ok("close 前に積んだものは取り出せる", left.join("") === "x");

    // ---- stderr のログ
    const errLines = [];
    const logErr = createStderrLog({ log: (l) => errLines.push(l), prefix: "P ", maxLine: 10, maxLines: 3 });
    logErr("one\ntw");
    logErr("o\r\n\n" + "x".repeat(25) + "\nfour\nfive\n");
    t.ok("行ごとに前置きを付け、途中で切れた行はつなぐ", errLines[0] === "P one" && errLines[1] === "P two", JSON.stringify(errLines));
    t.ok("長い行は切り詰める", errLines[2] === "P " + "x".repeat(10) + "…", errLines[2]);
    t.ok("上限を超えたら 1 回だけ省略を知らせて黙る", errLines.length === 4 && errLines[3].includes("省略"), JSON.stringify(errLines));
  })();
}
