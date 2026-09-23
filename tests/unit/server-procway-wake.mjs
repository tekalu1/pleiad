// procway の裏の作業と wake ターン（procway が自分で始めるターン）を、server ごと通す。
//
// procway serve の身代わり（tests/lib/fake-procway）を使う。本物の procway-code は cli-agent でしか
// LLM 無しに動かせず、cli-agent はツールを呼べない（spawn_agent も wake も起きない）ので、
// serve の WS プロトコルとイベントの形だけを台本で再現する（形は output/bg-tasks/procway-report.md §2）。
// Pleiad 側（core/backends/procway.mjs の振り分け・外部ターン・requeue、server の background / externalTurn、
// 送信待ち）は本物のまま通る。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

export const name = "server-procway-wake";
export const title = "procway の裏の子と wake ターンを、衛星・外部ターン・送信待ちとして見せる";

const FAKE = path.join(ROOT, "tests", "lib", "fake-procway", "cli.mjs");
const bgOf = (ev, id) => (ev.background ?? []).find((b) => b.sessionId === id);
const turnOf = (ev, id) => (ev.turns ?? []).find((t) => t.sessionId === id);
const servePids = (text) => [...String(text).matchAll(/procway: serve を起動した pid=(\d+)/g)].map((m) => Number(m[1]));

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ply-pw-wake-")));
  const home = path.join(scratch, "home");
  const cwd = path.join(scratch, "work");
  const dataDir = path.join(scratch, "data");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "procway", AGENT_HOST_PROCWAY_CODE: FAKE, AGENT_HOST_PROCWAY_HOME: home },
    dataDir,
    timeoutMs: 30_000,
  });
  const c = await open(server);
  const at = (ev) => c.events.indexOf(ev);
  const after = (ev, pred) => (e) => at(e) > at(ev) && pred(e);
  const textFrom = (from, id) => c.since(from).filter((e) => e.type === "text.delta" && e.sessionId === id).map((e) => e.text).join("");
  const send = (sessionId, messageId, prompt, extra = {}) => c.cmd("sendMessage", { sessionId, messageId, prompt, ...extra });
  const turnEnd = (id, from, ms = 20_000) => c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id, { from, ms });

  try {
    const { sessionId: id } = await c.cmd("newSession", { backend: "procway", cwd });

    // ---- 裏の子を数える → ターンが終わっても衛星 → wake ターンが外部ターンとして走る
    let from = c.mark();
    await send(id, "a-00000001", "bg 2 1500 800");
    const counted = await c.waitFor((e) => e.type === "running" && bgOf(e, id)?.tasks?.length === 2, { from, ms: 20_000 });
    const tasks = bgOf(counted, id).tasks;
    t.ok("spawn_agent（background:true）の子が running の background に載る",
      tasks.every((x) => x.kind === "agent" && /^job-/.test(x.id)) && tasks.map((x) => x.label).join("|") === "子の作業 1|子の作業 2",
      JSON.stringify(tasks));
    await turnEnd(id, from);
    const idle = await c.cmd("running");
    t.ok("ターンが終わっても、子が残っている間は background に残る（ターン行は無い）",
      !turnOf(idle, id) && bgOf(idle, id)?.tasks.length === 2, JSON.stringify(idle.background));
    t.ok("background は count に入れない（止める口が無いので、デスクトップの終了を塞がない）", idle.count === 0, String(idle.count));

    const wakeA = c.mark();
    await c.waitFor((e) => e.type === "resumed" && e.sessionId === id, { from: wakeA, ms: 20_000 });
    const live = await c.waitFor((e) => e.type === "running" && turnOf(e, id), { from: wakeA, ms: 5000 });
    t.ok("wake ターンは外部ターンとして running のターン行に載る（弧）", turnOf(live, id).external === true, JSON.stringify(turnOf(live, id)));
    await turnEnd(id, wakeA);
    const saidA = textFrom(wakeA, id);
    t.ok("wake ターンの返答がライブで流れる", /^再開した: job-\w+,job-\w+/.test(saidA), saidA);
    t.ok("Pleiad の承認モードが wake ターンにも効く（procway の既定 auto-readonly ではない）", saidA.includes("mode=always-ask"), saidA);
    t.ok("wake の本文は利用者の発言として流れない", !c.since(wakeA).some((e) => e.type === "userMessage"));
    t.ok("wake ターンは turnResult ok で終わる",
      c.since(wakeA).some((e) => e.type === "turnResult" && e.sessionId === id && e.outcome === "ok"));
    const doneA = await c.cmd("running");
    t.ok("wake の本文に並んだ子は background から消え、ターン行も消える", !bgOf(doneA, id) && !turnOf(doneA, id), JSON.stringify(doneA));
    const usage = JSON.parse(await fs.readFile(path.join(dataDir, "usage.json"), "utf8")).records;
    t.ok("外部ターンの使用量も記録される", usage.length === 2 && usage.some((r) => r.costUsd === 0.001), JSON.stringify(usage));

    // ---- wake ターン中の送信は送信待ちになり、終わってから自動で送られる
    from = c.mark();
    await send(id, "b-00000001", "bg 1 500 1500");
    await turnEnd(id, from);
    const wakeB = c.mark();
    await c.waitFor((e) => e.type === "resumed" && e.sessionId === id, { from: wakeB, ms: 20_000 });
    await send(id, "b-00000002", "echo:after wake");
    const waiting = await c.waitFor((e) => e.type === "outbox" && e.sessionId === id
      && e.messages.find((m) => m.id === "b-00000002")?.status === "queued", { from: wakeB, ms: 5000 });
    t.ok("wake ターン中の送信は失敗せず送信待ちになる", Boolean(waiting));
    const wakeEndB = await turnEnd(id, wakeB);
    const deliveredB = await c.waitFor(after(wakeEndB, (e) => e.type === "userMessage" && e.messageId === "b-00000002"), { from: wakeB, ms: 20_000 });
    t.ok("送信待ちは wake ターンが終わってから自動で送られる", at(deliveredB) > at(wakeEndB));
    await c.waitFor(after(deliveredB, (e) => e.type === "turnEnd" && e.sessionId === id), { from: wakeB, ms: 20_000 });
    t.ok("送り直した発言に返答が来る", textFrom(at(deliveredB), id).includes("echo: echo:after wake"), textFrom(at(deliveredB), id));
    t.ok("失敗の turnResult は出ない", !c.since(wakeB).some((e) => e.type === "turnResult" && e.outcome !== "ok"),
      JSON.stringify(c.since(wakeB).filter((e) => e.type === "turnResult")));

    // ---- 送信と wake がぶつかる（turn_in_progress）→ requeue → wake の後で送り直す
    from = c.mark();
    await send(id, "c-00000001", "race 800");
    await turnEnd(id, from);
    const race = c.mark();
    await send(id, "c-00000002", "echo:racing");
    const requeued = await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id && e.requeued === true, { from: race, ms: 20_000 });
    t.ok("wake とぶつかった送信は requeue で畳まれる（completedAt を残さない）", requeued.completedAt === null);
    const back = await c.waitFor(after(requeued, (e) => e.type === "outbox" && e.sessionId === id
      && e.messages.find((m) => m.id === "c-00000002")?.status === "queued"), { from: race, ms: 5000 });
    t.ok("ぶつかった送信は送信待ちへ戻る", Boolean(back));
    await c.waitFor((e) => e.type === "resumed" && e.sessionId === id, { from: race, ms: 20_000 });
    const wakeEndC = await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id && !e.requeued, { from: race, ms: 20_000 });
    t.ok("割り込んだ wake は外部ターンとして流れる", textFrom(race, id).startsWith("再開した: job-"), textFrom(race, id));
    const again = await c.waitFor(after(wakeEndC, (e) => e.type === "userMessage" && e.messageId === "c-00000002"), { from: race, ms: 20_000 });
    await c.waitFor(after(again, (e) => e.type === "turnEnd" && e.sessionId === id), { from: race, ms: 20_000 });
    t.ok("wake の後で送り直され、返答が来る", textFrom(at(again), id).includes("echo: echo:racing"), textFrom(at(again), id));
    t.ok("ぶつかってもエラーにならない", !c.since(race).some((e) => e.type === "turnResult" && e.outcome !== "ok"),
      JSON.stringify(c.since(race).filter((e) => e.type === "turnResult")));

    // ---- wake ターンの承認はその場で UI に届く。モードを変えると次の wake にも効く（serve は入れ替えない）
    const servesBefore = servePids(server.tail(400)).length;
    from = c.mark();
    await send(id, "d-00000001", "bg 1 400 300 ask", { mode: "full-auto" });
    await turnEnd(id, from);
    const wakeD = c.mark();
    const perm = await c.waitFor((e) => e.type === "permission" && e.sessionId === id, { from: wakeD, ms: 20_000 });
    const askedIn = await c.cmd("running");
    t.ok("wake ターンの承認は次の送信を待たずに届く", perm.toolName === "run_shell" && turnOf(askedIn, id)?.external === true,
      JSON.stringify({ tool: perm.toolName, turn: turnOf(askedIn, id) }));
    await c.cmd("resolvePermission", { id: perm.id, allow: true });
    await turnEnd(id, wakeD);
    t.ok("承認すると wake ターンの続きが流れて終わる", textFrom(wakeD, id).includes("承認の結果: allow"), textFrom(wakeD, id));
    from = c.mark();
    await send(id, "d-00000002", "bg 1 300 100");
    await turnEnd(id, from);
    const wakeD2 = c.mark();
    await c.waitFor((e) => e.type === "resumed" && e.sessionId === id, { from: wakeD2, ms: 20_000 });
    await turnEnd(id, wakeD2);
    t.ok("選び直した承認モードが次の wake ターンに効く", textFrom(wakeD2, id).includes("mode=full-auto"), textFrom(wakeD2, id));
    t.ok("モードを変えても serve を入れ替えない（裏の子を道連れにしない）", servePids(server.tail(400)).length === servesBefore);

    // ---- 履歴: wake の生テキストは利用者の発言にならず、再開後の返答に resumed が付く
    const history = await c.cmd("loadSession", { sessionId: id });
    const users = history.messages.filter((m) => m.role === "user").map((m) => m.text);
    t.ok("履歴に wake の本文が利用者の発言として出ない", users.every((u) => !/system-reminder|AUTOMATIC RESUME/.test(u)), JSON.stringify(users));
    t.ok("利用者の発言だけが順に残る（ぶつかった送信も一度だけ）", JSON.stringify(users) === JSON.stringify([
      "bg 2 1500 800", "bg 1 500 1500", "echo:after wake", "race 800", "echo:racing", "bg 1 400 300 ask", "bg 1 300 100",
    ]), JSON.stringify(users));
    const resumed = history.messages.filter((m) => m.resumed);
    t.ok("再開後の返答に resumed が付く（web が「再開した」の一行を出す）",
      resumed.length === 5 && resumed.every((m) => m.role === "assistant"), JSON.stringify(resumed.map((m) => [m.role, m.text])));

    // ---- 裏のシェルは数えない / agent_job で回収した子は消える
    from = c.mark();
    await send(id, "e-00000001", "shell");
    await turnEnd(id, from);
    t.ok("裏のシェルは background に載せない（終わりが分からない）", !bgOf(await c.cmd("running"), id));
    from = c.mark();
    await send(id, "f-00000001", "bg 1 60000");
    await turnEnd(id, from);
    t.ok("長く走る子は残る", bgOf(await c.cmd("running"), id)?.tasks.length === 1);
    from = c.mark();
    await send(id, "f-00000002", "collect");
    await turnEnd(id, from);
    t.ok("agent_job で回収した子は background から消える", !bgOf(await c.cmd("running"), id));

    // ---- 接続が切れている間に wake が始まった → 繋ぎ直すと session.resumed.runningTurn で外部ターンとして受ける
    from = c.mark();
    await send(id, "g-00000001", "drop 300 2500");
    const endG = await turnEnd(id, from);
    await c.waitFor(after(endG, (e) => e.type === "running" && !bgOf(e, id)), { from, ms: 5000 });
    t.ok("接続が切れたら数えていた子を消す（切れている間の wake は見えない）", !bgOf(await c.cmd("running"), id));
    await sleep(900);
    const drop = c.mark();
    await send(id, "g-00000002", "echo:after drop");
    const dropRequeue = await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id && e.requeued, { from: drop, ms: 20_000 });
    const dropExt = await c.waitFor(after(dropRequeue, (e) => e.type === "running" && turnOf(e, id)?.external), { from: drop, ms: 5000 });
    t.ok("繋ぎ直した時点で走っていた wake は外部ターンとして見せる", Boolean(dropExt));
    // requeue された 1 回目も userMessage を出している。外部ターンが終わった後の送り直しを見る
    const dropWakeEnd = await c.waitFor(after(dropRequeue, (e) => e.type === "turnEnd" && e.sessionId === id && !e.requeued), { from: drop, ms: 20_000 });
    const dropSent = await c.waitFor(after(dropWakeEnd, (e) => e.type === "userMessage" && e.messageId === "g-00000002"), { from: drop, ms: 20_000 });
    await c.waitFor(after(dropSent, (e) => e.type === "turnEnd" && e.sessionId === id), { from: drop, ms: 20_000 });
    t.ok("その後で送信が届き、返答が来る", textFrom(at(dropSent), id).includes("echo: echo:after drop"), textFrom(at(dropSent), id));

    // ---- serve が終わったら全部消す（走っていた job は失われ、settle も wake も来ない）
    const { sessionId: other } = await c.cmd("newSession", { backend: "procway", cwd });
    const pidsBefore = new Set(servePids(server.tail(400)));
    from = c.mark();
    await send(other, "h-00000001", "bg 1 60000");
    await turnEnd(other, from);
    t.ok("別の会話の子も数える", bgOf(await c.cmd("running"), other)?.tasks.length === 1);
    const pid = servePids(server.tail(400)).find((p) => !pidsBefore.has(p));
    t.ok("会話ごとの serve が起きている", Boolean(pid), String(pid));
    const gone = c.mark();
    process.kill(pid);
    await c.waitFor((e) => e.type === "running" && !bgOf(e, other), { from: gone, ms: 10_000 }).catch(() => null);
    t.ok("serve が終わると、その会話の background は消える", !bgOf(await c.cmd("running"), other));
  } finally {
    // 落ちたときに Pleiad と serve の側で何が起きていたか言えるように
    if (t.failures.length) t.note(server.tail(60).split("\n").join("\n      "));
    c.close();
    const pids = servePids(server.tail(400));
    await server.stop();
    for (const pid of pids) { try { process.kill(pid); } catch { /* もう居ない */ } }
    if (process.env.AGENT_HOST_KEEP_SCRATCH) t.note(`使い捨てを残した: ${scratch}`);
    else await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
