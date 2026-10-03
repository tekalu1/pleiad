// Shared host fork contract, exercised through both real backend adapters.
import crypto from "node:crypto";
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

/**
 * 同じ会話の中で巻き戻して送り直す共通契約（sendMessage の rewind。docs/message-fork.md「同じ会話で巻き戻す」）。
 * 2 つ目の自分の発言を起点にする。呼ぶ会話には自分の発言が 2 件以上ある前提。
 * 巻き戻した先のモデルが捨てた内容を見ないことは、引き継ぎ文をそのまま返すバックエンド（antigravity の身代わり）なら
 * sawPrefixOnly で確かめる（本物のモデルでの確認は tests/e2e/rewind.mjs）
 */
export async function checkRewind(t, c, { id, firstText, laterText, sawPrefixOnly = false }) {
  const before = await c.cmd("loadSession", { sessionId: id });
  const users = before.messages.filter(m => m.role === "user");
  const count = (await c.cmd("listSessions")).length;
  const messageId = crypto.randomUUID();
  const from = c.mark();
  const sent = await c.cmd("sendMessage", { sessionId: id, messageId, prompt: "Rewind check",
    rewind: { beforeMessageId: users[1].uuid } });
  await c.waitFor(e => e.type === "userMessage" && e.messageId === messageId, { from });
  const started = c.events.findIndex((e, i) => i >= from && e.type === "userMessage" && e.messageId === messageId);
  await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { from: started });
  const after = await c.cmd("loadSession", { sessionId: id });
  const text = c.since(started).filter(e => e.type === "text.delta").map(e => e.text).join("");
  const cut = before.messages.indexOf(users[1]);
  t.ok("rewind: same conversation, history cut before the target and continued",
    after.messages.length === cut + 2 && after.messages.slice(0, cut).every((m, i) => m.text === before.messages[i].text)
    && after.messages[cut].text === "Rewind check" && !after.messages.some(m => m.text?.includes(laterText)),
    after.messages.map(m => m.text).join(" | ").slice(0, 300));
  t.ok("rewind: reports how it rewound", ["resume", "thread", "host"].includes(sent.rewind?.mode), JSON.stringify(sent.rewind));
  t.ok("rewind: no child conversation", (await c.cmd("listSessions")).length === count);
  t.ok("rewind: kept messages keep their ids", before.messages.slice(0, cut).every((m, i) => after.messages[i]?.uuid === m.uuid) || sent.rewind.renumbered === true);
  if (sawPrefixOnly) t.ok("rewind: model context has the prefix only", text.includes(firstText) && !text.includes(laterText), text.slice(0, 200));
  const missing = await c.cmd("sendMessage", { sessionId: id, messageId: crypto.randomUUID(), prompt: "x", rewind: { beforeMessageId: "missing-message" } })
    .then(() => false, () => true);
  t.ok("rewind: unknown message rejected", missing);
}
