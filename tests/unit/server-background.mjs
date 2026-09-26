// main が返答した後も裏の作業が残るターン（phase: waiting）を、fake バックエンドで server ごと通す。
// LLM は呼ばない。台本 "bg <本数> <秒>"（core/backends/fake.mjs）が Claude と同じ形のイベントを流す。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-background";
export const title = "裏を待っている間の phase / background と途中送信";

const turnOf = (ev, sessionId) => (ev.turns ?? []).find((t) => t.sessionId === sessionId);

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ply-bg-"));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake" } });
  const c = await open(server);
  try {
    const { sessionId } = await c.cmd("newSession", { backend: "fake", cwd: ROOT });
    const from = c.mark();
    await c.cmd("sendMessage", { sessionId, messageId: "bg-initial-0001", prompt: "bg 2 4" });

    const waiting = await c.waitFor((e) => e.type === "running" && turnOf(e, sessionId)?.phase === "waiting", { from, ms: 10000 });
    const turn = turnOf(waiting, sessionId);
    t.ok("running のターン行に phase: waiting が載る", turn.phase === "waiting");
    t.ok("running のターン行に裏のタスクの全量が載る", turn.background?.length === 2
      && turn.background.every((x) => x.kind === "agent" && x.id && x.label), JSON.stringify(turn.background));
    const polled = await c.cmd("running");
    t.ok("running コマンドでも同じ状態が読める", turnOf(polled, sessionId)?.phase === "waiting");
    t.ok("phase / background のイベントもそのターンの sessionId 付きで流れる",
      c.since(from).some((e) => e.type === "phase" && e.state === "waiting" && e.sessionId === sessionId)
      && c.since(from).some((e) => e.type === "background" && e.sessionId === sessionId));

    // 停止ボタンは、ターンの外に残った作業（Codex の端末など）だけでなく、
    // 走っているターンが抱えている裏の作業（Claude のバックグラウンドのコマンド）も引ける
    const unknown = await c.cmd("stopBackground", { sessionId, taskId: "そんなタスクは無い" }).then(() => null, (e) => e.message);
    t.ok("知らない id は「もう動いていない」", unknown?.includes("もう動いていません"), String(unknown));
    const inTurn = await c.cmd("stopBackground", { sessionId, taskId: turn.background[0].id }).then(() => null, (e) => e.message);
    t.ok("走っているターンが抱えている裏の作業も引ける（止められるかはバックエンド次第）",
      inTurn?.includes("止められません"), String(inTurn));

    // 待っている間の送信は、ターンを分けずに途中送信で届く
    const steerFrom = c.mark();
    await c.cmd("sendMessage", { sessionId, messageId: "bg-steer-0001", prompt: "ping while waiting" });
    await c.waitFor((e) => e.type === "userMessage" && e.messageId === "bg-steer-0001", { from: steerFrom, ms: 5000 });
    t.ok("待っている間の送信はすぐ送信済みになる（次のターンを待たない）",
      !c.since(steerFrom).some((e) => e.type === "turnEnd"));
    const box = c.since(steerFrom).filter((e) => e.type === "outbox" && e.sessionId === sessionId).at(-1);
    t.ok("送信待ちの状態は sent", box?.messages?.find((m) => m.id === "bg-steer-0001")?.status === "sent", JSON.stringify(box?.messages));
    await c.waitFor((e) => e.type === "text.end", { from: steerFrom, ms: 5000 });
    const said = c.since(steerFrom).filter((e) => e.type === "text.delta").map((e) => e.text).join("");
    t.ok("main がその場で答える", said.includes("受け取った: ping while waiting"), said.slice(0, 80));

    const shrink = await c.waitFor((e) => e.type === "running" && turnOf(e, sessionId)?.background?.length === 1, { from, ms: 10000 });
    t.ok("1 本終わると一覧が縮む", turnOf(shrink, sessionId).background[0].id === "fake-task-2");
    // サブエージェントの状態（getSubagentState）。終わった子はターンが終わるまで一覧に残り、completed で載る
    const halfway = (shrink.subagents ?? []).filter((a) => a.sessionId === sessionId);
    const doneSub = halfway.find((a) => a.status === "completed");
    t.ok("終わった子は completed で載る（一覧からは消えない）", halfway.length === 2 && doneSub
      && halfway.some((a) => a.status === "running"), JSON.stringify(halfway.map((a) => [a.description, a.status])));
    t.ok("終わった子には開始と終了の時刻が付き、走っている子の終了時刻は null",
      Boolean(doneSub?.startedAt && doneSub?.endedAt && doneSub.endedAt >= doneSub.startedAt)
      && halfway.filter((a) => a.status === "running").every((a) => a.startedAt && a.endedAt === null), JSON.stringify(halfway));
    t.ok("count は走っている子だけ数える（ターン 1 + 走っている子 1）", shrink.count === 2, `count=${shrink.count}`);

    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === sessionId, { from, ms: 15000 });
    const phases = c.since(from).filter((e) => e.type === "phase").map((e) => e.state).join(",");
    t.ok("waiting と active を行き来して、最後は active", phases.startsWith("waiting") && phases.endsWith("active"), phases);
    const after = await c.cmd("running");
    t.ok("終わったらターン行が消える", !turnOf(after, sessionId));

    const loaded = await c.cmd("loadSession", { sessionId });
    const users = loaded.messages.filter((m) => m.role === "user").map((m) => m.text);
    t.ok("途中送信の発言は履歴に一度だけ残る", users.filter((x) => x === "ping while waiting").length === 1, JSON.stringify(users));

    // サブエージェントの一覧。fake の listSubagents は前のターンの分も含め、作った順の逆で返す
    const subsOf = (ev) => (ev.subagents ?? []).filter((a) => a.sessionId === sessionId);
    const matches = async (list) => {
      for (const a of list) {
        const conv = await c.cmd("loadSubagent", { sessionId, agentId: a.id });
        if (conv.messages?.[0]?.text !== `${a.description} を始めた`) return false;
      }
      return true;
    };
    const first = subsOf(waiting);
    t.ok("1 ターン目: そのターンのサブエージェントが載る", first.length === 2, JSON.stringify(first));
    t.ok("見出しは生んだ委譲ツールの説明（並び順で当てない）", await matches(first),
      first.map((a) => `${a.id}=${a.description}`).join(" "));
    // バックグラウンドのダイアログ: エージェントと生んだツールの id を載せ、ターンが終わった子もツールの id から引ける
    const calls = c.since(from).filter((e) => e.type === "tool.start" && e.name === "Agent");
    t.ok("子にエージェントと生んだ委譲ツールの id が付く", first.every((a) => a.backend === "fake" && calls.some((x) => x.id === a.origin)),
      JSON.stringify(first.map((a) => [a.backend, a.origin])));
    t.ok("モデルが分からない子は null（親と同じ）", first.every((a) => a.model === null));
    const found = await Promise.all(first.map((a) => c.cmd("findSubagent", { sessionId, toolId: a.origin })));
    t.ok("終わったターンの子を委譲ツールの id から引ける", found.every((x, i) => x.agentId === first[i].id), JSON.stringify(found));
    t.ok("引き直した子の最新状態と開始・終了時刻も返す", found.every(x => x.status === 'completed' && x.startedAt && x.endedAt && Date.parse(x.endedAt) >= Date.parse(x.startedAt)));
    t.ok("知らないツールの id なら null", (await c.cmd("findSubagent", { sessionId, toolId: "no-such-call" })).agentId === null);

    const from2 = c.mark();
    await c.cmd("sendMessage", { sessionId, messageId: "bg-second-0001", prompt: "bg 3 1" });
    const waiting2 = await c.waitFor((e) => e.type === "running" && turnOf(e, sessionId)?.phase === "waiting", { from: from2, ms: 10000 });
    const second = subsOf(waiting2);
    t.ok("2 ターン目: 前のターンのサブエージェントは載らない",
      second.length === 3 && !second.some((a) => first.some((b) => b.id === a.id)),
      second.map((a) => a.id).join(","));
    t.ok("2 ターン目も見出しは本人のもの", await matches(second),
      second.map((a) => `${a.id}=${a.description}`).join(" "));
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === sessionId, { from: from2, ms: 15000 });
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
}
