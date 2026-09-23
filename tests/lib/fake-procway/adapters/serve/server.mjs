// procway-code serve の身代わり。LLM も procway の本体も使わない。
//
// Pleiad の procway バックエンドが話す WS プロトコル（ai-agent/docs/host-contract.md: ready / event / command / response）と、
// procway の wake（バックグラウンドの子が終わると、procway が自分でターンを差し込む）を台本で再現する。
// イベントの形は本物に合わせる（output/bg-tasks/procway-report.md §2 の表）:
//   spawn_agent の結果 { kind: "spawn_agent", data: { jobId, status: "running", background: true, task } }
//   wake ターンの頭    user.prompt.submitted { wake: true, content: [{ kind: "text", text: "<system-reminder>AUTOMATIC RESUME … - child agent <jobId> — <status> …" }] }
//   走っている間の runTurn は { code: "turn_in_progress" } で撥ねる。区切りは同時に 1 本だけ
//   承認は park: approval.requested → turn.completed。approve で続き（approval.resolved → … → turn.completed）
//
// 台本（ターンの本文の先頭で選ぶ）:
//   bg <本数> <ms> [wakeMs] [ask]  … 裏の子を <本数> 起こして返答する。子は <ms> 後に終わり、wake ターンが来る。
//                                    wake ターンは wakeMs かけて返答する（既定 600）。ask なら wake ターンで承認を park する
//   shell                       … 裏のシェル（run_shell runInBackground）を起こして返答する
//   collect                     … 走っている子の 1 本目を agent_job wait で回収する（その子の wake は来ない）
//   race [wakeMs]               … 終わらない子を 1 本起こす。次の runTurn が届いた瞬間にその子が終わり、wake ターンが始まる
//                                  （Pleiad の送信と wake がぶつかる窓を毎回作る。応答 turn_in_progress が wake の頭より先に届く）
//   drop <ms> [wakeMs]          … bg 1 と同じだが、ターンの後でこの会話の WS を切る（Pleiad は wake を見られない）
//   slow                        … 中断されるまで終わらない
//   steer <ms>                  … ツールを 1 本呼び、<ms> 待ってから区切りを作る（既定 500）。
//                                 その継ぎ目で保留の途中送信を会話へ折り込み、返答に混ぜる
//   それ以外                     … "echo: <本文>" を返す
// 途中送信（serve の steer コマンド）は既定では**知らないふり**をする（ready に commands を載せず、
// steer にも応答しない = 古い procway）。AGENT_HOST_FAKE_PROCWAY_STEER=1 で対応する側になる
// wake ターンの返答は `再開した: <jobId,…> mode=<settings.approvalMode>`。Pleiad が選んだ承認モードが
// wake ターン（runTurn の options を持たない）に効いているかをこれで確かめる。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const rand = () => crypto.randomBytes(4).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAKE_DEBOUNCE_MS = 200;
// 途中送信を知っている procway のふりをするか。既定は知らない側（古い procway）
const STEER = process.env.AGENT_HOST_FAKE_PROCWAY_STEER === "1";
const BASE_COMMANDS = ["runTurn", "approve", "interaction.resolve", "compact", "history", "abort", "listSessions", "loadSession", "wake"];
// 台本の不具合で serve ごと落とさない。落ちた理由は stderr に出す（Pleiad は serve の出力を覚えていて、終了時に出す）
process.on("unhandledRejection", (e) => console.error(`fake procway: ${e?.stack ?? e}`));

export async function startServer({ cwd, settings, port, host = "127.0.0.1", token }) {
  const root = path.join(os.homedir(), ".procway", "ai-agent", "sessions");
  const sessions = new Map();

  // ---------------------------------------------------------------- 永続化（Pleiad の getMessages / listSessions が読む）
  function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
  // Windows では、Pleiad が読んでいる最中のファイルへの rename が EPERM / EBUSY で失敗することがある。
  // 何度か撃ち直し、それでも駄目なら直接書く（Pleiad の getMessages は読みかけの JSON を撃ち直す）。
  // 保存の失敗で serve を落とさない（落ちると WS が閉じ、別の不具合に見える）
  function replace(file, text) {
    const tmp = `${file}.${rand()}.tmp`;
    fs.writeFileSync(tmp, text);
    for (let i = 0; i < 20; i += 1) {
      try { fs.renameSync(tmp, file); return; }
      catch (e) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, text);
  }
  function save(s) {
    try {
      const dir = path.join(root, s.id);
      fs.mkdirSync(dir, { recursive: true });
      const meta = { title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: new Date().toISOString() };
      replace(path.join(dir, "snapshot.json"), JSON.stringify({ messages: s.messages }));
      replace(path.join(dir, "meta.json"), JSON.stringify(meta));
      const index = readJson(path.join(root, "index.json")) ?? { sessions: {} };
      index.sessions[s.id] = meta;
      replace(path.join(root, "index.json"), JSON.stringify(index));
    } catch (e) {
      console.error(`fake procway: 保存に失敗: ${e.message}`);
    }
  }
  function session(id, where) {
    let s = sessions.get(id);
    if (s) return s;
    const snap = readJson(path.join(root, id, "snapshot.json"));
    const meta = readJson(path.join(root, id, "meta.json"));
    s = {
      id, cwd: meta?.cwd ?? where ?? cwd, title: meta?.title ?? null, createdAt: meta?.createdAt ?? new Date().toISOString(),
      messages: snap?.messages ?? [{ id: `sys-${rand()}`, role: "system", content: [{ kind: "text", text: "fake system" }] }],
      sockets: new Set(), running: false, abort: null, parked: new Map(), jobs: new Map(),
      pendingWake: [], wakeTimer: null, wakeMs: 600, wakeAsk: false, armed: null, dropAfter: false,
      pendingSteer: [],
    };
    sessions.set(id, s);
    return s;
  }
  const message = (role, content, extra = {}) => ({ id: `m-${rand()}`, role, content, ...extra });

  function emit(s, event) {
    const text = JSON.stringify({ kind: "event", event: { ...event, sessionId: s.id } });
    for (const ws of s.sockets) { try { ws.send(text); } catch { /* 閉じかけ */ } }
  }

  // ---------------------------------------------------------------- 途中送信（steer）
  // 本物と同じ: 受理は「保留に積んだ」だけ。会話に入るのは区切りの継ぎ目で、そこで
  // user.prompt.submitted（steer:true, clientMessageId 付き）を出す。読まれずに終わったら steer.dropped
  function drainSteer(s) {
    if (!s.pendingSteer.length) return [];
    const batch = s.pendingSteer.splice(0);
    for (const p of batch) {
      const m = message("user", [{ kind: "text", text: p.prompt }]);
      s.messages.push(m);
      emit(s, {
        type: "user.prompt.submitted", messageId: m.id, content: m.content, steer: true,
        ...(p.clientMessageId ? { clientMessageId: p.clientMessageId } : {}),
      });
    }
    save(s);
    return batch.map((p) => p.prompt);
  }
  function dropSteer(s, reason) {
    if (!s.pendingSteer.length) return;
    const batch = s.pendingSteer.splice(0);
    emit(s, { type: "steer.dropped", reason, count: batch.length, clientMessageIds: batch.map((p) => p.clientMessageId).filter(Boolean) });
  }

  // ---------------------------------------------------------------- 区切り
  const interrupted = () => Object.assign(new Error("Interrupted by user"), { code: "interrupted" });

  async function say(s, text, { ms = 0, signal } = {}) {
    const m = message("assistant", [{ kind: "text", text }]);
    const parts = text.match(/[\s\S]{1,6}/g) ?? [];
    for (const p of parts) {
      if (signal?.aborted) throw interrupted();
      emit(s, { type: "assistant.message.delta", messageId: m.id, deltaText: p });
      if (ms) await sleep(ms / parts.length);
    }
    s.messages.push(m);
    emit(s, { type: "assistant.message.completed", messageId: m.id, content: m.content });
  }

  function tool(s, name, args, result) {
    const toolCallId = `tc-${rand()}`;
    emit(s, { type: "tool.call.scheduled", toolCallId, name, args, mutation: false });
    emit(s, { type: "tool.call.started", toolCallId, name });
    emit(s, { type: "tool.call.completed", toolCallId, ok: true, result });
    s.messages.push(message("assistant", [{ kind: "tool_use", toolCallId, name, args }]));
    s.messages.push(message("tool", [{ kind: "tool_result", toolCallId, ok: true, result }]));
  }

  /** 1 本の区切りを走らせる。body は区切りの中身（throw で turn.failed、{ parked } で park して畳む）。 */
  async function segment(s, messageId, body) {
    s.running = true;
    const ac = new AbortController();
    s.abort = () => ac.abort();
    try {
      await body(ac.signal);
      // The host reads snapshot.json as soon as it receives turn.completed.
      // Commit the history before notifying another process, including on slow CI disks.
      save(s);
      emit(s, { type: "turn.completed", round: 0, exitCode: 0, messageId });
    } catch (e) {
      save(s);
      emit(s, { type: "turn.failed", round: 0, error: { message: e.message, code: e.code ?? "" }, messageId });
      dropSteer(s, e.code === "interrupted" ? "interrupted" : "turn_failed");
    } finally {
      s.running = false;
      s.abort = null;
      if (s.dropAfter) {
        s.dropAfter = false;
        setTimeout(() => { for (const ws of [...s.sockets]) ws.terminate(); }, 30);
      }
      turnSettled(s);
    }
  }

  async function runTurn(s, prompt, { wake = false } = {}) {
    s.running = true;
    const user = message("user", [{ kind: "text", text: prompt }], wake ? { wake: true } : {});
    s.messages.push(user);
    if (!s.title && !wake) s.title = prompt.slice(0, 80);
    emit(s, { type: "user.prompt.submitted", messageId: user.id, content: user.content, ...(wake ? { wake: true } : {}) });
    save(s);
    await segment(s, user.id, (signal) => (wake ? wakeBody(s, prompt, signal) : script(s, prompt.trim(), signal)));
  }

  // ---------------------------------------------------------------- 裏の子と wake
  function spawnChild(s, task, ms) {
    const jobId = `job-${rand()}`;
    const job = { jobId, task, status: "running", timer: null };
    s.jobs.set(jobId, job);
    if (ms != null) job.timer = setTimeout(() => settle(s, jobId, "completed"), ms);
    return job;
  }
  function settle(s, jobId, status) {
    const job = s.jobs.get(jobId);
    if (!job || job.status !== "running") return;
    clearTimeout(job.timer);
    job.status = status;
    s.pendingWake.push(job);
    turnSettled(s);
  }
  // procway の wake supervisor と同じく、区切りが走っている間は溜め、終わってから少し待ってまとめて差し込む
  function turnSettled(s) {
    if (s.running || !s.pendingWake.length || s.wakeTimer) return;
    s.wakeTimer = setTimeout(() => {
      s.wakeTimer = null;
      if (s.running || !s.pendingWake.length) return turnSettled(s);
      runTurn(s, wakeText(s.pendingWake.splice(0)), { wake: true });
    }, WAKE_DEBOUNCE_MS);
  }
  const wakeText = (batch) => [
    "<system-reminder>",
    "AUTOMATIC RESUME — this is NOT a message from the user. Background work you started has settled while no turn was running.",
    "",
    `Settled (${batch.length}):`,
    ...batch.map((j) => `- child agent ${j.jobId} — ${j.status}\n  task: ${j.task}\n  result: done`),
    "",
    "What to do now:",
    "- If nothing is left to do, say what finished and stop.",
    "</system-reminder>",
  ].join("\n");

  async function wakeBody(s, text, signal) {
    // Keep the disconnected wake alive until the test reconnects. A fixed
    // wall-clock window can expire while a hosted Windows worker is starting.
    if (s.reconnectBarrier) {
      const barrier = s.reconnectBarrier;
      s.reconnectBarrier = null;
      await barrier;
    }
    const ids = [...text.matchAll(/child agent (\S+)/g)].map((m) => m[1]);
    emit(s, { type: "activity.started", activityId: `a-${rand()}`, label: "model" });
    if (s.wakeAsk) {
      s.wakeAsk = false;
      park(s, { kind: "run_shell", summary: "echo wake", payload: { command: "echo wake" } }, async (decision, sig) => {
        await say(s, `承認の結果: ${decision}`, { ms: 100, signal: sig });
      });
      return;
    }
    await say(s, `再開した: ${ids.join(",")} mode=${settings.approvalMode}`, { ms: s.wakeMs, signal });
    emit(s, { type: "usage.recorded", inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
  }

  // ---------------------------------------------------------------- 承認（park）
  function park(s, { kind, summary, payload }, resume) {
    const requestId = `ap-${rand()}`;
    s.parked.set(requestId, { requestId, kind, summary, payload, resume });
    emit(s, { type: "approval.requested", requestId, kind, summary, payload });
  }
  function approve(s, requestId, decision) {
    const p = s.parked.get(requestId);
    if (!p || s.running) return false;
    s.parked.delete(requestId);
    emit(s, { type: "approval.resolved", requestId, decision });
    setImmediate(() => segment(s, null, async (signal) => {
      tool(s, p.kind, p.payload ?? {}, { kind: p.kind, summary: decision, data: { decision } });
      await p.resume(decision, signal);
    }));
    return true;
  }

  // ---------------------------------------------------------------- 台本
  async function script(s, prompt, signal) {
    const [word, ...rest] = prompt.split(/\s+/);
    if (word === "bg" || word === "drop") {
      const n = word === "drop" ? 1 : Math.max(1, Math.min(4, Number(rest[0]) || 1));
      const ms = Number(word === "drop" ? rest[0] : rest[1]) || 1500;
      const wakeMs = Number(word === "drop" ? rest[1] : rest[2]);
      if (Number.isFinite(wakeMs) && wakeMs >= 0) s.wakeMs = wakeMs;
      s.wakeAsk = rest.includes("ask");
      for (let i = 1; i <= n; i += 1) {
        const job = spawnChild(s, `子の作業 ${i}`, ms);
        tool(s, "spawn_agent", { task: job.task, runInBackground: true }, {
          kind: "spawn_agent", summary: `Child agent started in background: ${job.task}`,
          data: { jobId: job.jobId, status: "running", background: true, task: job.task, cwd: "." },
        });
      }
      if (word === "drop") {
        s.dropAfter = true;
        s.reconnectBarrier = new Promise(resolve => { s.releaseReconnect = resolve; });
      }
      return say(s, `裏で ${n} 本を動かした`);
    }
    if (word === "shell") {
      tool(s, "run_shell", { command: "npm run dev", runInBackground: true }, {
        kind: "run_shell", summary: "Started bg", data: { command: "npm run dev", runInBackground: true, shellId: `sh-${rand()}`, pid: 1, status: "running" },
      });
      return say(s, "裏でシェルを動かした");
    }
    if (word === "collect") {
      const job = [...s.jobs.values()].find((j) => j.status === "running");
      if (!job) return say(s, "回収するものが無い");
      clearTimeout(job.timer);
      job.status = "completed";
      tool(s, "agent_job", { action: "wait", jobId: job.jobId }, {
        kind: "spawn_agent", summary: `child ${job.jobId}: completed`,
        data: { tool: "agent_wait", jobId: job.jobId, kind: "agent", status: "completed", text: "done", waitedMs: 1 },
      });
      return say(s, `回収した: ${job.jobId}`);
    }
    if (word === "race") {
      const wakeMs = Number(rest[0]);
      if (Number.isFinite(wakeMs) && wakeMs >= 0) s.wakeMs = wakeMs;
      const job = spawnChild(s, "ぶつける子", null);
      tool(s, "spawn_agent", { task: job.task, runInBackground: true }, {
        kind: "spawn_agent", summary: "Child agent started in background",
        data: { jobId: job.jobId, status: "running", background: true, task: job.task, cwd: "." },
      });
      // 次の runTurn が届いた瞬間に子が終わり、wake が区切りを取る（runningTurn が先に立つ）
      s.armed = () => {
        job.status = "completed";
        s.running = true;
        setImmediate(() => runTurn(s, wakeText([job]), { wake: true }));
      };
      return say(s, "次の送信で wake が割り込む");
    }
    if (word === "steer") {
      const ms = Number(rest[0]) || 500;
      tool(s, "run_shell", { command: `sleep ${ms}` }, { kind: "run_shell", summary: "slept", data: { command: `sleep ${ms}`, exitCode: 0 } });
      await sleep(ms);
      if (signal.aborted) throw interrupted();
      // ここが区切りの継ぎ目。溜まっている途中送信をこのターンの会話へ入れる
      const folded = drainSteer(s);
      return say(s, folded.length ? `echo: ${prompt} + ${folded.join(" + ")}` : `echo: ${prompt}`);
    }
    if (word === "slow") {
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(interrupted());
        signal.addEventListener("abort", () => reject(interrupted()), { once: true });
      });
      return;
    }
    return say(s, `echo: ${prompt}`);
  }

  // ---------------------------------------------------------------- WS
  function command(s, ws, msg) {
    const reply = (ok, value) => {
      try { ws.send(JSON.stringify(ok ? { kind: "response", id: msg.id, ok: true, result: value } : { kind: "response", id: msg.id, ok: false, error: value })); } catch { /* 閉じた */ }
    };
    switch (msg.command) {
      case "runTurn": {
        const prompt = typeof msg.args?.prompt === "string" ? msg.args.prompt : "";
        if (!prompt) return reply(false, "runTurn: prompt is required");
        if (s.armed) { const go = s.armed; s.armed = null; go(); }
        if (s.running) return reply(false, { code: "turn_in_progress", message: "A turn is already in progress for this session." });
        return runTurn(s, prompt).then(() => reply(true, { ok: true }));
      }
      case "steer": {
        // 知らない command は本物でも parseClientMessage が捨てて**応答を返さない**。
        // Pleiad が ready の commands で確かめずに送ったら待ちぼうけになる、という形をそのまま再現する
        if (!STEER) return;
        const prompt = typeof msg.args?.prompt === "string" ? msg.args.prompt : "";
        if (!prompt) return reply(false, { code: "invalid_args", message: "steer: prompt is required" });
        if (!s.running) return reply(false, { code: "no_active_turn", message: "No turn is running for this session." });
        s.pendingSteer.push({ prompt, clientMessageId: msg.args?.clientMessageId ?? null });
        return reply(true, { queued: true });
      }
      case "approve":
        return reply(true, { accepted: approve(s, msg.args?.requestId, msg.args?.decision) });
      case "abort": {
        const stop = s.abort;
        stop?.();
        return reply(true, { aborted: Boolean(stop) });
      }
      case "interaction.resolve":
        return reply(true, { accepted: true });
      default:
        return reply(true, {});
    }
  }

  const server = http.createServer((req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/ws" || url.searchParams.get("token") !== token) return socket.destroy();
    // 101 の応答と、接続直後に送る ready 以降のフレームを 1 回の書き込みにまとめる。
    // 負荷の高い hosted runner では loopback でもこうまとまって届き、ws クライアントは
    // "open" を出したのと同じ tick で ready を "message" として出す。"open" を await してから
    // 受け口を付けるクライアントはここで ready を落とす（WS_OPEN_TIMEOUT_MS 待って失敗する）。
    // 手元でもその届き方を毎回再現するため、わざとまとめる
    socket.cork();
    process.nextTick(() => socket.uncork());
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = session(url.searchParams.get("session") || `fake-${rand()}`, url.searchParams.get("cwd"));
      s.sockets.add(ws);
      ws.on("close", () => s.sockets.delete(ws));
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg?.kind === "command") command(s, ws, msg);
      });
      // commands は「後から足した command を使ってよいか」の唯一の手掛かり。
      // 知らない側のふりをするときは、載せない（古い procway と同じ）
      ws.send(JSON.stringify({
        kind: "ready", sessionId: s.id, version: "fake", protocolVersion: 1,
        ...(STEER ? { commands: [...BASE_COMMANDS, "steer"] } : {}),
      }));
      if (s.messages.some((m) => m.role !== "system")) {
        ws.send(JSON.stringify({ kind: "event", event: { type: "session.resumed", sessionId: s.id, messages: [], messageCount: s.messages.length, eventCount: 0, runningTurn: s.running } }));
      }
      s.releaseReconnect?.();
      s.releaseReconnect = null;
      for (const p of s.parked.values()) {
        ws.send(JSON.stringify({ kind: "event", event: { type: "approval.requested", sessionId: s.id, requestId: p.requestId, kind: p.kind, summary: p.summary, payload: p.payload } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { close: () => new Promise((resolve) => { wss.close(); server.close(() => resolve()); }) };
}
