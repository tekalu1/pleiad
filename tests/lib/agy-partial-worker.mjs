// antigravity の控えをターンの途中から書くこと（core/backends/antigravity.mjs の runTurn）を、別プロセスで確かめる。
// バックエンドを読み込むだけで置き場（AGENT_HOST_DATA）の孤児の掃除が走るので、置き場を一時ディレクトリにしてから読み込む。
// 判定は { label, pass, detail } の配列を JSON で stdout に出す（tests/unit/antigravity-partial-transcript.mjs が t.ok にする）
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-partial-")));
process.env.AGENT_HOST_DATA = scratch;
process.env.AGENT_HOST_AGY_BIN = `node "${path.join(ROOT, "tests", "lib", "fake-agy.mjs")}"`;
process.env.AGENT_HOST_AGY_SAVE_MS = "30";
process.env.FAKE_AGY_PARTIAL_HOLD_MS = "600";
process.env.FAKE_AGY_PID_FILE = path.join(scratch, "agy-pids.json");

const { backend } = await import("../../core/backends/antigravity.mjs");
const store = await import("../../core/backends/antigravity-store.mjs");

const checks = [];
const ok = (label, pass, detail = "") => checks.push({ label, pass: Boolean(pass), detail: String(detail) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pids = async () => JSON.parse(await fs.readFile(process.env.FAKE_AGY_PID_FILE, "utf8").catch(() => "[]"));
const gone = async (pid) => {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(20);
  }
  return false;
};
const released = async (pid) => {
  for (let i = 0; i < 100; i++) {
    const live = JSON.parse(await fs.readFile(path.join(scratch, "antigravity", "pids.json"), "utf8").catch(() => "[]"));
    if (!live.some((entry) => entry.pid === pid)) return true;
    await sleep(20);
  }
  return false;
};
const fileOf = (id) => path.join(scratch, "antigravity", `${id}.json`);
const record = async (id) => JSON.parse(await fs.readFile(fileOf(id), "utf8").catch(() => "null"));
const exists = (id) => fs.access(fileOf(id)).then(() => true, () => false);
/** 控えが条件を満たすまで読み直す（最長 ms） */
async function until(id, test, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await record(id);
    if (r && test(r)) return r;
    await sleep(15);
  }
  return record(id);
}
const reply = (r) => r?.messages?.at(-1)?.role === "assistant" ? r.messages.at(-1) : null;

/** ターンを走らせる。session が来たら onSession を呼ぶ。返り値は { result | error, events } */
function turn({ prompt, sessionId = null, ac = null, onSession }) {
  const events = [];
  const run = backend.runTurn({
    prompt, sessionId, cwd: os.tmpdir(), mode: "yolo", model: "", effort: "",
    emit: (e) => { events.push(e); if (e.type === "session") onSession?.(e.sessionId); },
    signal: ac, control: null,
  });
  return {
    events,
    done: run.then((result) => ({ result, events }), (error) => ({ error, events })),
  };
}

try {
  // ---- 1. 新しい会話。ターンの途中で控えにユーザー発言・ツール・本文が入り、中断しても残る
  const ac = new AbortController();
  let sid = null;
  const first = turn({ prompt: "partial", ac, onSession: (id) => { sid = id; } });
  while (!sid) await sleep(10);
  const mid = await until(sid, (r) => reply(r)?.toolCalls?.length === 1 && reply(r)?.text === "途中まで");
  ok("ターンの途中でユーザー発言が控えに入る", mid?.messages?.[0]?.role === "user" && mid.messages[0].text === "partial", JSON.stringify(mid?.messages?.[0] ?? null));
  ok("ターンの途中で完了したツールと本文が控えに入る", reply(mid)?.toolCalls?.[0]?.result?.text === "partial-out" && reply(mid)?.text === "途中まで",
    JSON.stringify(reply(mid) ?? null));
  const midUuid = reply(mid)?.uuid;
  ac.abort();
  const aborted = await first.done;
  ok("中断したターンは aborted で終わる", aborted.events.some((e) => e.type === "turnResult" && e.outcome === "aborted"),
    JSON.stringify(aborted.events.filter((e) => e.type === "turnResult")));
  const afterAbort = await record(sid);
  ok("中断したターンもそこまでのツールと本文が残る",
    afterAbort?.messages?.length === 2 && reply(afterAbort)?.toolCalls?.length === 1 && reply(afterAbort)?.text === "途中まで",
    JSON.stringify(afterAbort?.messages ?? null));
  ok("AI の発言の uuid はターンの途中と終わりで変わらない", midUuid && reply(afterAbort)?.uuid === midUuid, `${midUuid} / ${reply(afterAbort)?.uuid}`);

  // ---- 2. 再開して失敗するターン（ERROR）。途中の分も終わりの分も残り、前の発言は消えない
  const failing = turn({ prompt: "partial-fail", sessionId: sid });
  const failMid = await until(sid, (r) => r.messages.length === 4 && reply(r)?.toolCalls?.length === 1);
  ok("再開したターンも途中から控えに入る", failMid?.messages?.length === 4 && failMid.messages[2].text === "partial-fail",
    JSON.stringify(failMid?.messages?.map((m) => [m.role, m.text]) ?? null));
  const failed = await failing.done;
  ok("status ERROR のターンは失敗で終わる", Boolean(failed.error), String(failed.error?.message ?? "(投げない)"));
  const afterFail = await record(sid);
  ok("失敗したターンもツールと本文が残り、前のターンも残る",
    afterFail?.messages?.length === 4 && reply(afterFail)?.toolCalls?.[0]?.result?.text === "partial-out" && afterFail.messages[1].text === "途中まで",
    JSON.stringify(afterFail?.messages?.map((m) => [m.role, m.text, m.toolCalls?.length ?? 0]) ?? null));

  // ---- 3. 成功するターン。途中と同じ uuid の発言が、完了の時刻と最終の本文に差し替わる（二重にならない）
  const sentBefore = Date.now();
  const succeeding = turn({ prompt: "partial-ok", sessionId: sid });
  const okMid = await until(sid, (r) => r.messages.length === 6 && reply(r)?.toolCalls?.length === 1);
  const okMidReply = reply(okMid);
  const succeeded = await succeeding.done;
  const afterOk = await record(sid);
  const okReply = reply(afterOk);
  ok("成功したターンは ok で終わる", !succeeded.error && succeeded.events.some((e) => e.type === "turnResult" && e.outcome === "ok"),
    String(succeeded.error?.message ?? ""));
  ok("成功したターンの AI の発言は途中と同じ uuid で最終の本文になる",
    afterOk?.messages?.length === 6 && okReply?.uuid === okMidReply?.uuid && okReply?.text === "途中まで。続き",
    JSON.stringify({ mid: okMidReply?.uuid, final: okReply?.uuid, text: okReply?.text, n: afterOk?.messages?.length }));
  ok("控えの uuid が重ならない", new Set(afterOk?.messages?.map((m) => m.uuid)).size === afterOk?.messages?.length,
    JSON.stringify(afterOk?.messages?.map((m) => m.uuid) ?? null));
  const askedAt = Date.parse(afterOk?.messages?.[4]?.at), repliedAt = Date.parse(okReply?.at);
  ok("ユーザー発言は送信の時刻、AI の発言は完了の時刻で残る", askedAt >= sentBefore && repliedAt - askedAt >= 500 && repliedAt >= Date.parse(okMidReply?.at),
    `送信から ${askedAt - sentBefore}ms / 返答まで ${repliedAt - askedAt}ms`);

  // ---- 4. SUCCESS の result を返してからプロセスが終了しても、完了済みのターンは成功のまま
  const completed = await turn({ prompt: "result-then-exit", sessionId: sid }).done;
  const completedPid = (await pids()).at(-1);
  const exitedAfterResult = await gone(completedPid);
  // pid の控えが外れた時点で onExit の判定も済んでいる。
  const exitHandled = await released(completedPid);
  ok("SUCCESS の後に agy が終了する台本が動く", exitedAfterResult && exitHandled, String(completedPid));
  ok("完了後の終了で成功ターンを失敗に変えない",
    !completed.error && completed.events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join() === "ok",
    JSON.stringify({ error: completed.error?.message, results: completed.events.filter((e) => e.type === "turnResult") }));
  const restarted = await turn({ prompt: "再開", sessionId: sid }).done;
  ok("完了後に終了した会話は次のターンで起こし直せる",
    !restarted.error && restarted.events.some((e) => e.type === "turnResult" && e.outcome === "ok") && (await pids()).at(-1) !== completedPid,
    String(restarted.error?.message ?? ""));

  // ---- 5. agy が途中で落ちたターン。そこまでの分が残る
  const exiting = turn({ prompt: "partial-exit", sessionId: sid });
  const exited = await exiting.done;
  const afterExit = await record(sid);
  ok("途中で落ちたターンは失敗で終わる", Boolean(exited.error), String(exited.error?.message ?? "(投げない)"));
  ok("途中で落ちたターンもツールと本文が残る",
    afterExit?.messages?.length === 12 && afterExit.messages[10].text === "partial-exit" && reply(afterExit)?.toolCalls?.length === 1,
    JSON.stringify(afterExit?.messages?.map((m) => [m.role, m.text]) ?? null));

  // ---- 6. 控えの無い会話を再開した（別の起動で forget した・控えが無い）。途中・失敗の書き込みで作らない
  const ghost = "ghost-conversation";
  const ghostRun = await turn({ prompt: "partial-fail", sessionId: ghost }).done;
  ok("控えの無い会話を再開して失敗しても控えを作らない", Boolean(ghostRun.error) && !(await exists(ghost)), String(await exists(ghost)));

  // ---- 7. forget した会話は、後から届いた書き込みで作り直さない（成功のターンでも）
  const forgotten = turn({ prompt: "partial-ok", sessionId: sid });
  await until(sid, (r) => r.messages.length === 14);
  await store.forget(sid);
  const forgottenRun = await forgotten.done;
  ok("forget した会話は、走っていたターンの書き込みで作り直さない", !forgottenRun.error && !(await exists(sid)), String(await exists(sid)));

  // ---- 8. 同じ会話への書き込みは 1 本ずつ（read-modify-write が重なって発言が消えない）
  const burst = "burst-conversation";
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    store.appendMessages(burst, { cwd: scratch, messages: [{ role: "user", text: `m${i}`, uuid: `${burst}:u${i}` }] })));
  const burstRecord = await record(burst);
  ok("同時に積んだ書き込みがすべて残る", burstRecord?.messages?.length === 20, `${burstRecord?.messages?.length} 件`);
} catch (err) {
  ok("worker が最後まで走る", false, String(err?.stack ?? err));
} finally {
  process.stdout.write(JSON.stringify(checks));
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  // 生かしている agy は exit のフックが落とす（core/backends/antigravity.mjs）
  process.exit(0);
}
