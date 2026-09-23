import crypto from "node:crypto";

export const name = "fork";
export const title = "Codex の実モデルで途中分岐を再開";
export const serverEnv = { AGENT_HOST_BACKENDS: "codex" };
export default async function(t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    for (const backend of (process.env.AGENT_HOST_E2E_FORK_BACKENDS ?? "codex").split(",")) {
      const keep = `violet_${crypto.randomBytes(4).toString("hex")}`;
      const omit = `amber_${crypto.randomBytes(4).toString("hex")}`;
      const model = process.env.AGENT_HOST_E2E_CODEX_MODEL;
      const first = await c.runTurn({ backend, cwd: ctx.work, model,
        prompt: `This is a conversation-memory test. Remember the code ${keep}. Reply with READY only. Do not use tools or modify files.` });
      t.ok(`${backend}: first turn`, first.outcome === "ok", first.events.find(e => e.error)?.error);
      if (first.outcome !== "ok") continue;
      const id = first.sessionId;
      const prefix = await c.cmd("loadSession", { sessionId: id });
      const later = await c.runTurn({ sessionId: id, model,
        prompt: `Another code is ${omit}. Reply with READY only. Do not use tools or modify files.` });
      t.ok(`${backend}: later turn`, later.outcome === "ok");
      const original = await c.cmd("loadSession", { sessionId: id });
      const child = await c.cmd("fork", { sessionId: id, upToMessageId: prefix.messages[0].uuid });
      const loaded = await c.cmd("loadSession", { sessionId: child.sessionId });
      t.ok(`${backend}: user-message boundary`, loaded.messages.length === 1 && loaded.messages[0].text.includes(keep));
      const resumed = await c.runTurn({ sessionId: child.sessionId, model,
        prompt: "Plain text extraction: copy the exact violet_ code from the conversation history above. Output just that code. Do not search files, use tools, or modify files." });
      const text = resumed.events.filter(e => e.type === "text.delta").map(e => e.text).join("");
      t.ok(`${backend}: resume retains only prefix`, resumed.outcome === "ok" && !resumed.events.some(e => e.error) && text.includes(keep) && !text.includes(omit),
        JSON.stringify({ text, outcome: resumed.outcome, errors: resumed.events.filter(e => e.error).map(e => e.error) }));
      t.ok(`${backend}: source unchanged`, JSON.stringify(original) === JSON.stringify(await c.cmd("loadSession", { sessionId: id })));
    }
  } finally { c.close(); }
}
