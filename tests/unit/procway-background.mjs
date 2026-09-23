// procway の裏の子の数え方（core/backends/procway-background.mjs）。serve のイベントの形は
// output/bg-tasks/procway-report.md §2 の表（ai-agent の registry.mjs / agent-job.mjs / wake-supervisor.mjs）に合わせる。
import { createBackgroundTracker, settledFromWake } from "../../core/backends/procway-background.mjs";

export const name = "procway-background";
export const title = "procway のバックグラウンドの子を serve のイベントから数える";

const spawned = (jobId, task = "調べる") => ({
  type: "tool.call.completed", toolCallId: `tc-${jobId}`, ok: true,
  result: { kind: "spawn_agent", summary: "started", data: { jobId, status: "running", background: true, task, cwd: "." } },
});
const job = (tool, data) => ({ type: "tool.call.completed", toolCallId: "tc-x", ok: true, result: { kind: "spawn_agent", summary: "", data: { tool, ...data } } });
const wake = (text) => ({ type: "user.prompt.submitted", messageId: "m1", wake: true, content: [{ kind: "text", text }] });
const WAKE = [
  "<system-reminder>",
  "AUTOMATIC RESUME — this is NOT a message from the user. Background work you started has settled while no turn was running, so these results were never collected.",
  "",
  "Settled (2):",
  "- child agent job-a — completed",
  "  task: 一つ目",
  "  result: ok",
  "- child agent job-b — failed",
  "  task: 二つ目",
  "  error: boom",
  "</system-reminder>",
].join("\n");

export default async function (t) {
  t.ok("wake の本文から settle した子を拾う",
    JSON.stringify(settledFromWake(WAKE)) === JSON.stringify([{ jobId: "job-a", status: "completed" }, { jobId: "job-b", status: "failed" }]),
    JSON.stringify(settledFromWake(WAKE)));
  t.ok("ダッシュの種類に寛容", settledFromWake("- child agent job-c - completed").length === 1
    && settledFromWake("- child agent job-d – completed").length === 1);
  t.ok("読めない文面は空", settledFromWake("something else").length === 0 && settledFromWake(null).length === 0);

  let b = createBackgroundTracker();
  t.ok("spawn_agent の background:true で 1 本増える", b.apply(spawned("job-a", "一つ目の  作業\n続き")) && b.size === 1);
  t.ok("見出しは task を 1 行にしたもの、kind は agent",
    JSON.stringify(b.list()) === JSON.stringify([{ id: "job-a", kind: "agent", label: "一つ目の 作業 続き" }]), JSON.stringify(b.list()));
  b.apply(spawned("job-b"));
  t.ok("前面の spawn_agent（background が無い）は数えない",
    !b.apply(job(undefined, { jobId: "job-f", status: "completed", text: "x" })) && b.size === 2);
  t.ok("裏のシェルは数えない（終わりが分からない）", !b.apply({
    type: "tool.call.completed", toolCallId: "tc-s", ok: true,
    result: { kind: "run_shell", data: { runInBackground: true, shellId: "sh-1", pid: 1, status: "running" } },
  }) && b.size === 2);
  t.ok("wake の本文に並んだ子は消える", b.apply(wake(WAKE)) && b.size === 0);

  b = createBackgroundTracker();
  b.apply(spawned("job-a"));
  t.ok("agent_job wait の時間切れ（running のまま）は残す", !b.apply(job("agent_wait", { jobId: "job-a", status: "running", timedOut: true })) && b.size === 1);
  t.ok("承認で撥ねられた呼び出し（status も error も無い）は触らない", !b.apply(job("agent_status", { jobId: "job-a" })) && b.size === 1);
  t.ok("agent_job wait が completed を返したら消える", b.apply(job("agent_wait", { jobId: "job-a", status: "completed" })) && b.size === 0);
  b.apply(spawned("job-a"));
  t.ok("見つからない jobId（error）も消える", b.apply(job("agent_status", { jobId: "job-a", error: "jobId not found" })) && b.size === 0);
  b.apply(spawned("job-a"));
  t.ok("agent_kill で消える（status がまだ running でも）", b.apply(job("agent_kill", { jobId: "job-a", killed: true, status: "running" })) && b.size === 0);
  b.apply(spawned("job-a"));
  b.apply(spawned("job-b"));
  b.apply(spawned("job-c"));
  t.ok("agent_list: running 以外と載っていないものが消える", b.apply(job("agent_list", {
    jobs: [{ jobId: "job-a", status: "running" }, { jobId: "job-b", status: "completed" }], running: 1,
  })) && JSON.stringify(b.list().map((x) => x.id)) === JSON.stringify(["job-a"]));

  t.ok("文面が読めない wake でも、1 本しか数えていなければそれが終わった", b.apply(wake("<system-reminder>something new</system-reminder>")) && b.size === 0);
  b.apply(spawned("job-a"));
  b.apply(spawned("job-b"));
  t.ok("文面が読めない wake で 2 本以上なら触らない（どれか分からない）", !b.apply(wake("unknown")) && b.size === 2);
  t.ok("wake の印が無い発言は触らない", !b.apply({ type: "user.prompt.submitted", content: [{ kind: "text", text: WAKE }] }) && b.size === 2);
  t.ok("clear で全部消える（serve の終了・接続断）", b.clear() && b.size === 0 && !b.clear());
}
