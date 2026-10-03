import crypto from "node:crypto";
import { spawn } from "node:child_process";

// 同じ会話の中で巻き戻して送り直したあと、モデルが捨てた発言の中身を覚えていないこと（ADR 0091）。
// Claude は resume + resumeSessionAt + resumeDropsTurn、Codex は thread/revert（paginated）。
// 使う実行先は AGENT_HOST_E2E_REWIND_BACKENDS（既定 claude,codex）。Codex のモデルは AGENT_HOST_E2E_CODEX_MODEL、Claude は AGENT_HOST_E2E_CLAUDE_MODEL（既定 haiku）
export const name = "rewind";
export const title = "実モデルで、巻き戻した先のモデルは捨てた発言を覚えていない";
export const serverEnv = { AGENT_HOST_BACKENDS: "claude,codex" };

const said = events => events.filter(e => e.type === "text.delta").map(e => e.text).join("");

/**
 * 以前に作った legacy のスレッド（historyMode: "legacy"）を、app-server を 1 回起こして作り、最初のターンまで走らせる。0.156.1 の thread/start の既定は
 * paginated なので、legacy は明示して作るしかない。ターンが 1 つも無いスレッドは保存されず Pleiad が resume できない（thread not loaded）ので、
 * 最初のターンはここで走らせる。スレッドは codex の保存先に残るので、Pleiad のサーバーが同じ id で resume できる。作れなければ理由を返す
 */
async function startLegacyThread({ cwd, model, prompt }) {
  const bin = process.env.AGENT_HOST_CODEX_BIN || "codex";
  const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: true });
  let buffer = "", id = 0;
  const pending = new Map();
  let completed = null;
  const completion = new Promise(resolve => { completed = resolve; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === "turn/completed") completed(m.params?.turn?.status ?? "completed");
      } catch {}
    }
  });
  child.stderr.on("data", () => {});
  const request = (method, params = {}) => new Promise(resolve => {
    const n = ++id; pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    setTimeout(() => { if (pending.delete(n)) resolve({ error: { message: `${method} timed out` } }); }, 30000).unref?.();
  });
  try {
    await request("initialize", { clientInfo: { name: "rewind-e2e", title: "rewind-e2e", version: "0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const started = await request("thread/start", { cwd, historyMode: "legacy", approvalPolicy: "never", sandbox: "read-only", ...(model ? { model } : {}) });
    if (started.error) return { error: started.error.message };
    const thread = started.result?.thread;
    if (!thread?.id) return { error: "no thread id" };
    const turn = await request("turn/start", { threadId: thread.id, input: [{ type: "text", text: prompt }], ...(model ? { model } : {}) });
    if (turn.error) return { error: turn.error.message };
    const status = await Promise.race([completion, new Promise(resolve => setTimeout(() => resolve("timeout"), 120000).unref?.())]);
    return { id: thread.id, historyMode: thread.historyMode ?? null, error: status === "completed" ? null : `最初のターンが ${status}` };
  } finally { child.kill(); }
}

export default async function(t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    for (const backend of (process.env.AGENT_HOST_E2E_REWIND_BACKENDS ?? "claude,codex").split(",")) {
      const keep = `violet_${crypto.randomBytes(4).toString("hex")}`;
      const omit = `amber_${crypto.randomBytes(4).toString("hex")}`;
      const model = backend === "codex" ? process.env.AGENT_HOST_E2E_CODEX_MODEL : (process.env.AGENT_HOST_E2E_CLAUDE_MODEL ?? "haiku");
      const first = await c.runTurn({ backend, cwd: ctx.work, model,
        prompt: `This is a conversation-memory test. Remember the code ${keep}. Reply with READY only. Do not use tools or modify files.` });
      t.ok(`${backend}: first turn`, first.outcome === "ok", first.events.find(e => e.error)?.error);
      if (first.outcome !== "ok") { t.note(`${backend}: 走れなかった（${first.events.find(e => e.error)?.error ?? first.outcome}）`); continue; }
      const id = first.sessionId;
      const later = await c.runTurn({ sessionId: id, model,
        prompt: `Another code is ${omit}. Remember it too. Reply with READY only. Do not use tools or modify files.` });
      t.ok(`${backend}: later turn`, later.outcome === "ok");
      const before = await c.cmd("loadSession", { sessionId: id });
      const users = before.messages.filter(m => m.role === "user");
      t.ok(`${backend}: 前提 2 往復`, users.length === 2, before.messages.map(m => `${m.role}:${m.uuid}`).join());

      const messageId = crypto.randomUUID();
      const from = c.mark();
      const sent = await c.cmd("sendMessage", { sessionId: id, messageId, rewind: { beforeMessageId: users[1].uuid },
        prompt: "Plain text extraction: list every violet_ or amber_ code that appears anywhere in the conversation history above, separated by spaces. If there are none, output NONE. Do not search files, use tools, or modify files." });
      await c.waitFor(e => e.type === "userMessage" && e.messageId === messageId, { from });
      const started = c.events.findIndex((e, i) => i >= from && e.type === "userMessage" && e.messageId === messageId);
      await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { from: started });
      const events = c.since(started);
      const text = said(events);
      const result = events.find(e => e.type === "turnResult");
      t.ok(`${backend}: 巻き戻して送り直したターンが成功`, result?.outcome === "ok" && !events.some(e => e.error), JSON.stringify({ text, outcome: result?.outcome, errors: events.filter(e => e.error).map(e => e.error) }));
      t.ok(`${backend}: 巻き戻しの方式`, sent.rewind?.mode === (backend === "claude" ? "resume" : "thread"), JSON.stringify(sent.rewind));
      t.ok(`${backend}: 残した発言の中身は覚えている`, text.includes(keep), text);
      t.ok(`${backend}: 捨てた発言の中身は覚えていない`, !text.includes(omit), text);
      const after = await c.cmd("loadSession", { sessionId: id });
      t.ok(`${backend}: 同じ会話で履歴が切れて続く`, after.messages.length === 4 && after.messages[0].text.includes(keep) && !after.messages.some(m => (m.text ?? "").includes(omit) && m.role === "user"),
        after.messages.map(m => `${m.role}:${String(m.text).slice(0, 40)}`).join(" | "));
      // 一覧は実機の Claude / Codex の会話全部（ほかの作業のものが増減する）なので、件数ではなく「この会話が 1 件のまま・子が増えていない」で見る
      const rows = await c.cmd("listSessions");
      t.ok(`${backend}: 会話は増えない（この会話は 1 件のまま・子の会話を作らない）`, rows.filter(r => r.id === id).length === 1 && !rows.some(r => r.parent?.sessionId === id),
        JSON.stringify(rows.filter(r => r.id === id || r.parent?.sessionId === id).map(r => ({ id: r.id, parent: r.parent }))))
      t.note(`${backend}: costUsd=${result?.costUsd ?? "-"} usage=${JSON.stringify(result?.usage ?? null)}`);
      t.ok(`${backend}: 使用量の推計がマイナスや桁違いにならない`, result?.costUsd == null || (result.costUsd >= 0 && result.costUsd < 1), String(result?.costUsd));

      // 続きのターンでも、捨てた内容を思い出さない（古い葉に戻らない）
      const next = await c.runTurn({ sessionId: id, model,
        prompt: "Plain text extraction: list every violet_ or amber_ code in the conversation history above, separated by spaces, or NONE. Do not use tools." });
      const nextText = said(next.events);
      t.ok(`${backend}: 続きのターンでも捨てた内容を覚えていない`, next.outcome === "ok" && nextText.includes(keep) && !nextText.includes(omit), nextText);
      const reloaded = await c.cmd("loadSession", { sessionId: id });
      t.ok(`${backend}: 続きのあとも履歴は 6 件`, reloaded.messages.length === 6, String(reloaded.messages.length));

      // ツールを使った発言（tool_use・tool_result）を挟んだ会話。残す側にツールの発言があっても、捨てる側にあっても切れる
      const keep2 = `teal_${crypto.randomBytes(4).toString("hex")}`;
      const omit2 = `coral_${crypto.randomBytes(4).toString("hex")}`;
      const toolFirst = await c.runTurn({ backend, cwd: ctx.work, model,
        prompt: `Remember the code ${keep2}. Use the shell tool once to run: echo ${keep2}. Then reply READY only. Do not modify files.` });
      t.ok(`${backend}: ツールを使う 1 つ目`, toolFirst.outcome === "ok" && toolFirst.tools.length > 0, JSON.stringify({ tools: toolFirst.tools, outcome: toolFirst.outcome }));
      if (toolFirst.outcome !== "ok") continue;
      const id2 = toolFirst.sessionId;
      const toolSecond = await c.runTurn({ sessionId: id2, model,
        prompt: `Another code is ${omit2}. Use the shell tool once to run: echo ${omit2}. Then reply READY only. Do not modify files.` });
      t.ok(`${backend}: ツールを使う 2 つ目`, toolSecond.outcome === "ok");
      const toolBefore = await c.cmd("loadSession", { sessionId: id2 });
      const toolUsers = toolBefore.messages.filter(m => m.role === "user");
      const askCodes = "Plain text extraction: list every teal_ or coral_ code that appears anywhere in the conversation history above (including tool output), separated by spaces, or NONE. Do not use tools.";
      const toolMessageId = crypto.randomUUID();
      const toolFrom = c.mark();
      const toolSent = await c.cmd("sendMessage", { sessionId: id2, messageId: toolMessageId, prompt: askCodes, rewind: { beforeMessageId: toolUsers[1].uuid } });
      await c.waitFor(e => e.type === "userMessage" && e.messageId === toolMessageId, { from: toolFrom });
      const toolStarted = c.events.findIndex((e, i) => i >= toolFrom && e.type === "userMessage" && e.messageId === toolMessageId);
      await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id2, { from: toolStarted });
      const toolEvents = c.since(toolStarted);
      const toolText = said(toolEvents);
      t.ok(`${backend}: ツールの発言を含む会話でも巻き戻せる`, toolEvents.some(e => e.type === "turnResult" && e.outcome === "ok") && toolSent.rewind?.mode === (backend === "claude" ? "resume" : "thread"),
        JSON.stringify({ rewind: toolSent.rewind, text: toolText }));
      t.ok(`${backend}: 残したツールの発言の中身は覚えていて、捨てたツールの発言は覚えていない`, toolText.includes(keep2) && !toolText.includes(omit2), toolText);
    }

    // 以前に作った legacy のスレッド: thread/revert は断られるので、thread/fork { beforeTurnId } で別スレッドに差し替える（会話の id は同じ）
    if ((process.env.AGENT_HOST_E2E_REWIND_BACKENDS ?? "claude,codex").split(",").includes("codex") && process.env.AGENT_HOST_E2E_REWIND_LEGACY !== "0") {
      const model = process.env.AGENT_HOST_E2E_CODEX_MODEL;
      const keep = `indigo_${crypto.randomBytes(4).toString("hex")}`;
      const omit = `crimson_${crypto.randomBytes(4).toString("hex")}`;
      const legacy = await startLegacyThread({ cwd: ctx.work, model, prompt: `This is a conversation-memory test. Remember the code ${keep}. Reply with READY only. Do not use tools or modify files.` });
      if (legacy.error || legacy.historyMode !== "legacy") {
        t.note(`codex legacy: 作れなかった（${legacy.error ?? `historyMode=${legacy.historyMode}`}）`);
      } else {
        const id = legacy.id;
        t.ok("codex legacy: legacy のスレッドを作れた（historyMode: legacy）", legacy.historyMode === "legacy");
        {
          const two = await c.runTurn({ sessionId: id, backend: "codex", cwd: ctx.work, model, prompt: `Another code is ${omit}. Remember it too. Reply with READY only. Do not use tools or modify files.` });
          t.ok("codex legacy: 2 つ目のターン", two.outcome === "ok");
          const before = await c.cmd("loadSession", { sessionId: id });
          const users = before.messages.filter(m => m.role === "user");
          t.ok("codex legacy: 前提 2 往復", users.length === 2, before.messages.map(m => m.uuid).join());
          const messageId = crypto.randomUUID();
          const from = c.mark();
          const sent = await c.cmd("sendMessage", { sessionId: id, messageId, rewind: { beforeMessageId: users[1].uuid },
            prompt: "Plain text extraction: list every indigo_ or crimson_ code that appears anywhere in the conversation history above, separated by spaces, or NONE. Do not use tools." });
          await c.waitFor(e => e.type === "userMessage" && e.messageId === messageId, { from });
          const started = c.events.findIndex((e, i) => i >= from && e.type === "userMessage" && e.messageId === messageId);
          await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { from: started });
          const events = c.since(started);
          const text = said(events);
          t.ok("codex legacy: thread/revert を断られて thread/fork で別スレッドに差し替える（会話の id は同じ・uuid は付け直し）", sent.rewind?.mode === "thread" && sent.rewind.renumbered === true, JSON.stringify(sent.rewind));
          t.ok("codex legacy: 差し替えたスレッドで送り直したターンが成功", events.some(e => e.type === "turnResult" && e.outcome === "ok"), JSON.stringify({ text, errors: events.filter(e => e.error).map(e => e.error) }));
          t.ok("codex legacy: 残した発言の中身は覚えていて、捨てた発言は覚えていない", text.includes(keep) && !text.includes(omit), text);
          const after = await c.cmd("loadSession", { sessionId: id });
          t.ok("codex legacy: 同じ会話で履歴が切れて続く", after.messages.length === 4 && !after.messages.some(m => m.role === "user" && (m.text ?? "").includes(omit)),
            after.messages.map(m => `${m.role}:${String(m.text).slice(0, 30)}`).join(" | "));
          const next = await c.runTurn({ sessionId: id, model, prompt: "Plain text extraction: list every indigo_ or crimson_ code in the conversation history above, separated by spaces, or NONE. Do not use tools." });
          const nextText = said(next.events);
          t.ok("codex legacy: 続きのターンは差し替えたスレッドで走り、捨てた内容を覚えていない", next.outcome === "ok" && nextText.includes(keep) && !nextText.includes(omit), nextText);
          t.ok("codex legacy: 続きのあとも履歴は 6 件", (await c.cmd("loadSession", { sessionId: id })).messages.length === 6);
        }
      }
    }
  } finally { c.close(); }
}
