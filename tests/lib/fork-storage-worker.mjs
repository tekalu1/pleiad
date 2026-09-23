import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-fork-storage-"));
process.env.AGENT_HOST_DATA = scratch;
const { wrapBackend, conversation } = await import("../../core/conversations.mjs");
const { recordPresent } = await import("../../core/history.mjs");
const at = "2026-09-11T10:00:00Z";
for (const id of ["codex", "antigravity"]) {
  const sourceId = `${id}-source`;
  const source = [
    { role: "user", uuid: "u1", text: "remember violet\n[添付] C:/uploads/one.png", at },
    { role: "assistant", uuid: "a1", text: "done", at, thinking: "private reasoning",
      toolCalls: [{ id: "call1", name: "read", input: { path: "one" }, result: { text: "Z".repeat(90000), truncated: false } }] },
    { role: "user", uuid: "u2", text: "excluded amber\n[添付] C:/uploads/two.png", at: "2026-09-11T11:00:00Z" },
  ];
  await recordPresent(sourceId, { by: "human", kind: "image", path: "C:/uploads/one.png", dataUri: "data:image/png;base64,AAAA" });
  await recordPresent(sourceId, { by: "human", kind: "image", path: "C:/uploads/two.png", dataUri: "data:image/png;base64,BBBB" });
  let failRun = false;
  let seen;
  let nativeMessages = [];
  const native = { id, capabilities: { fork: false }, listSessions: async () => [],
    getSession: async () => ({ sessionId: sourceId, cwd: scratch, title: "source" }),
    getMessages: async sid => sid === sourceId ? structuredClone(source) : nativeMessages,
    runTurn: async args => {
      if (failRun) throw new Error("start failed");
      seen = args.prompt;
      assert.equal(args.sessionId, null);
      nativeMessages = [{ role: "user", uuid: "new", text: args.prompt }];
      args.emit({ type: "session", sessionId: "native-child" });
    },
  };
  const backend = wrapBackend(native);
  const empty = await backend.fork(sourceId, { beforeMessageId: 'u1' });
  assert.deepEqual((await conversation(empty.sessionId)).messages, []);
  assert.deepEqual((await conversation(empty.sessionId)).presents, []);
  assert.deepEqual(empty.parent, { sessionId: sourceId, atMessage: null, beforeMessage: 'u1' });
  const beforeSecond = await backend.fork(sourceId, { beforeMessageId: 'u2' });
  const beforeRecord = await conversation(beforeSecond.sessionId);
  assert.deepEqual(beforeRecord.messages, source.slice(0, 2));
  assert.equal(beforeRecord.presents.length, 1);
  assert.equal(beforeRecord.presents[0].path, 'C:/uploads/one.png');
  assert.equal(beforeSecond.parent.atMessage, 'a1');
  await assert.rejects(backend.fork(sourceId, { beforeMessageId: 'missing' }), /見つかりません/);
  await assert.rejects(backend.fork(sourceId, { beforeMessageId: 'u1', upToMessageId: 'a1' }), /どちらか/);
  const child = await backend.fork(sourceId, { upToMessageId: "a1" });
  const record = await conversation(child.sessionId);
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[1].toolCalls[0].result.text.length, 90000);
  assert.equal(record.presents.length, 1);
  assert.equal(record.presents[0].dataUri, "data:image/png;base64,AAAA");
  assert.equal((await backend.getMessages(child.sessionId))[1].toolCalls[0].result.truncated, true);
  assert.equal((await backend.getMessages(child.sessionId, { fullResults: true }))[1].toolCalls[0].result.text.length, 90000);
  const { wrapBackend: wrapAgain } = await import(`../../core/conversations.mjs?reload=${id}`);
  assert.deepEqual(await wrapAgain(native).getPresents(child.sessionId), record.presents);
  assert.deepEqual(await wrapAgain(native).getMessages(child.sessionId, { fullResults: true }), record.messages);
  failRun = true;
  await assert.rejects(backend.runTurn({ sessionId: child.sessionId, prompt: "continue", emit() {} }), /start failed/);
  assert.equal((await conversation(child.sessionId)).nativeId, null);
  failRun = false;
  await backend.runTurn({ sessionId: child.sessionId, prompt: "continue", emit() {} });
  const ref = /Full conversation: (.+)\nHISTORY/.exec(seen)[1];
  const transcript = JSON.parse(await fs.readFile(ref, "utf8"));
  assert.equal(transcript.messages[1].toolCalls[0].result.text.length, 90000);
  assert.equal(transcript.messages[1].thinking, undefined);
  assert.equal(transcript.presents.length, 1);
  assert(!JSON.stringify(transcript).includes("excluded amber"));
  assert(!seen.includes("excluded amber"));
  assert(seen.includes('"partial":true'));
  assert.equal((await backend.getMessages(child.sessionId)).at(-1).text, "continue");
  assert.deepEqual(await backend.getMessages(sourceId), source);
  const nested = await backend.fork(child.sessionId, { upToMessageId: "u1" });
  assert.equal((await backend.getMessages(nested.sessionId)).length, 1);
  assert.equal((await backend.getPresents(nested.sessionId)).length, 1);
}
// Even a native exact-message backend must take the host path for a live source.
const liveMessages = [
  { uuid: "live-u", role: "user", text: "saved" },
  { uuid: "live-a", role: "assistant", text: "working", toolCalls: [{ id: "pending", name: "read", result: null }] },
];
const liveBackend = wrapBackend({ id: "claude", capabilities: { forkMessage: true },
  fork: async () => { throw new Error("native fork must not run"); },
  getSession: async () => ({ sessionId: "live-source", cwd: scratch }),
  getMessages: async () => liveMessages,
});
const firstEdit = await liveBackend.fork('live-source', { beforeMessageId: 'live-u' });
assert.equal((await conversation(firstEdit.sessionId)).messages.length, 0);
const laterEdit = await liveBackend.fork('live-source', { beforeMessageId: 'live-a' });
assert.equal((await conversation(laterEdit.sessionId)).messages.length, 1);
await recordPresent("live-source", { kind: "text", content: "active turn only" });
const liveFork = await liveBackend.fork("live-source", { upToMessageId: "live-u",
  snapshot: { messageIds: ["live-u"], presents: [] } });
assert(liveFork.persisted);
assert.equal((await liveBackend.getPresents(liveFork.sessionId)).length, 0);
liveMessages[0].text = "parent changed";
assert.equal((await liveBackend.getMessages(liveFork.sessionId))[0].text, "saved");
await assert.rejects(liveBackend.fork("live-source", { upToMessageId: "live-a", snapshot: true }), /実行中のツール/);
console.log("storage, attachments, full tool results, bounded handoff, retry and nested forks passed");
