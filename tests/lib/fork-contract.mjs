// Shared host fork contract, exercised through both real backend adapters.
export async function checkFork(t, c, { id, cwd, laterText, firstText }) {
  const source = await c.cmd("loadSession", { sessionId: id });
  await c.cmd("setTitle", { sessionId: id, title: "fork source" });
  await c.cmd("setStatus", { sessionId: id, status: "fork check" });
  for (const boundary of [0, 1]) {
    const fork = await c.cmd("fork", { sessionId: id, upToMessageId: source.messages[boundary].uuid, title: "fork child" });
    const child = await c.cmd("loadSession", { sessionId: fork.sessionId });
    t.ok(`boundary ${boundary}: exact prefix`, child.messages.length === boundary + 1 &&
      child.messages.every((m, i) => m.uuid === source.messages[i].uuid && m.text === source.messages[i].text));
    const row = (await c.cmd("listSessions")).find(s => s.id === fork.sessionId);
    t.ok(`boundary ${boundary}: metadata`, row?.title === "fork child" && row.status === "fork check" &&
      row.cwd === cwd && row.parent?.sessionId === id && row.parent.atMessage === source.messages[boundary].uuid);
    const result = await c.runTurn({ sessionId: fork.sessionId, prompt: "Continue fork check" }, { ms: 120000 });
    const text = result.events.filter(e => e.type === "text.delta").map(e => e.text).join("");
    t.ok(`boundary ${boundary}: resumed with prefix only`, text.includes(firstText) && !text.includes(laterText));
    const resumed = await c.cmd("loadSession", { sessionId: fork.sessionId });
    t.ok(`boundary ${boundary}: injected prompt hidden`, resumed.messages.filter(m => m.role === "user").at(-1)?.text === "Continue fork check");
    t.ok(`boundary ${boundary}: reload stable`, JSON.stringify(resumed) === JSON.stringify(await c.cmd("loadSession", { sessionId: fork.sessionId })));
  }
  t.ok("source unchanged after forks and execution", JSON.stringify(source) === JSON.stringify(await c.cmd("loadSession", { sessionId: id })));
  const before = (await c.cmd("listSessions")).length;
  await c.cmd("fork", { sessionId: id, upToMessageId: "missing-message" }).then(
    () => t.ok("missing boundary rejected", false), () => t.ok("missing boundary rejected", true));
  t.ok("failed fork adds no child", (await c.cmd("listSessions")).length === before);
}
