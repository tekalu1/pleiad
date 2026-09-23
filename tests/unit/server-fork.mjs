import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { checkFork } from "../lib/fork-contract.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

export const name = "server-fork";
export const title = "発言単位の分岐・永続化・失敗の共通契約";
export default async function(t) {
  const worker = await promisify(execFile)(process.execPath, [path.join(ROOT, "tests/lib/fork-storage-worker.mjs")]);
  t.ok("storage contract", worker.stdout.includes("passed"));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-fork-"));
  const config = { dataDir: scratch, env: { AGENT_HOST_BACKENDS: "codex",
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, "tests/lib/fake-codex.mjs")}"` } };
  let server = await startServer(config);
  const connect = () => open({ port: server.port, token: server.token, autoAllow: true });
  let c = await connect();
  try {
    const first = await c.runTurn({ backend: "codex", cwd: ROOT, prompt: "prefix violet" });
    const id = first.sessionId;
    await c.runTurn({ sessionId: id, prompt: "excluded amber" });
    await checkFork(t, c, { id, cwd: ROOT, firstText: "prefix violet", laterText: "excluded amber" });
    const source = await c.cmd("loadSession", { sessionId: id });
    const outline = await c.cmd("loadSession", { sessionId: id, outline: true });
    t.ok("outline は照合に要る分だけ返す（ツールの入出力と提示を載せない）",
      outline.messages.length === source.messages.length &&
      outline.messages.every((m, i) => m.uuid === source.messages[i].uuid && m.role === source.messages[i].role
        && (m.text ?? "") === (source.messages[i].text ?? "")) &&
      outline.messages.every(m => (m.toolCalls ?? []).every(call => Object.keys(call).join() === "name")) &&
      outline.presents === undefined);
    const rootChild = await c.cmd('fork', { sessionId: id, beforeMessageId: source.messages[0].uuid });
    const emptyHistory = await c.cmd('loadSession', { sessionId: rootChild.sessionId });
    t.ok('first-message fork starts empty', emptyHistory.messages.length === 0 && emptyHistory.presents.length === 0);
    const rootRow = (await c.cmd('lineage', { sessionId: rootChild.sessionId })).sessions.find(s => s.id === rootChild.sessionId);
    t.ok('empty fork keeps an explicit root boundary', rootRow.parent.sessionId === id && rootRow.parent.beforeMessage === source.messages[0].uuid && rootRow.parent.atMessage === null);
    await c.cmd('saveDraft', { sessionId: rootChild.sessionId, text: 'edited first message', attached: [] });
    t.ok('empty fork saves its draft', (await c.cmd('loadSession', { sessionId: rootChild.sessionId })).draft.text === 'edited first message');
    const rootResult = await c.runTurn({ sessionId: rootChild.sessionId, prompt: 'edited first message' });
    t.ok('empty fork runs without excluded source context', rootResult.outcome === 'ok' &&
      !(await c.cmd('loadSession', { sessionId: rootChild.sessionId })).messages.some(m => m.text?.includes('prefix violet')));
    t.ok('editing leaves source intact', JSON.stringify(source) === JSON.stringify(await c.cmd('loadSession', { sessionId: id })));
    // fake Codex はターンごとに item ID を再利用するため、ホストの実行区間で識別した履歴を使う。
    const editable = await c.cmd('fork', { sessionId: id, upToMessageId: source.messages[1].uuid });
    await c.runTurn({ sessionId: editable.sessionId, prompt: 'second user message' });
    const editSource = (await c.cmd('loadSession', { sessionId: editable.sessionId })).messages;
    const secondUser = editSource.findIndex((m, i) => i > 0 && m.role === 'user');
    const edited = await c.cmd('fork', { sessionId: editable.sessionId, beforeMessageId: editSource[secondUser].uuid });
    const editedMessages = (await c.cmd('loadSession', { sessionId: edited.sessionId })).messages;
    t.ok('later edit excludes the selected user and all following replies',
      JSON.stringify(editedMessages) === JSON.stringify(editSource.slice(0, secondUser)));
    const at = source.messages[0].uuid;
    const mark = c.mark();
    await c.cmd("runTurn", { sessionId: id, prompt: "slow" });
    const liveChild = await c.cmd("fork", { sessionId: id, upToMessageId: at });
    const liveRoot = await c.cmd('fork', { sessionId: id, beforeMessageId: at });
    t.ok('first-message edit during a turn preserves running parent',
      (await c.cmd('loadSession', { sessionId: liveRoot.sessionId })).messages.length === 0 &&
      (await c.cmd('running')).turns.some(turn => turn.sessionId === id));
    const liveHistory = await c.cmd("loadSession", { sessionId: liveChild.sessionId });
    t.ok("running source forks at exact boundary", liveHistory.messages.length === 1 && liveHistory.messages[0].uuid === at);
    t.ok("fork preserves running parent", (await c.cmd("running")).turns.some(turn => turn.sessionId === id));
    const continued = await c.runTurn({ sessionId: liveChild.sessionId, prompt: "independent child" });
    t.ok("child runs while parent continues", continued.outcome === "ok" && (await c.cmd("running")).turns.some(turn => turn.sessionId === id));
    const tail = await c.cmd("fork", { sessionId: id });
    const content = messages => messages.map(({ uuid, role, text }) => ({ uuid, role, text }));
    t.ok("running tail copies saved history", JSON.stringify(content((await c.cmd("loadSession", { sessionId: tail.sessionId })).messages)) === JSON.stringify(content(source.messages)));
    await c.cmd("fork", { sessionId: id, upToMessageId: "not-persisted" }).then(
      () => t.ok("unpersisted boundary rejected", false), e => t.ok("unpersisted boundary rejected", e.message.includes("まだ履歴")));
    t.ok("failed fork preserves parent", (await c.cmd("running")).turns.some(turn => turn.sessionId === id));
    await c.cmd("abort", { sessionId: id });
    await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { from: mark });
    const count = (await c.cmd("listSessions")).length;
    await fs.mkdir(path.join(scratch, "conversations.json.tmp"));
    await c.cmd("fork", { sessionId: id, upToMessageId: at }).then(
      () => t.ok("save failure reported", false), () => t.ok("save failure reported", true));
    t.ok("save failure leaves no visible child", (await c.cmd("listSessions")).length === count);
    await fs.rmdir(path.join(scratch, "conversations.json.tmp"));
    const child = await c.cmd("fork", { sessionId: id, upToMessageId: at, title: "persistent fork" });
    const before = await c.cmd("loadSession", { sessionId: child.sessionId });
    c.close(); await server.stop();
    server = await startServer(config); c = await connect();
    t.ok("restart retains exact transcript", JSON.stringify(before) === JSON.stringify(await c.cmd("loadSession", { sessionId: child.sessionId })));
    const row = (await c.cmd("listSessions")).find(s => s.id === child.sessionId);
    t.ok("restart retains metadata", row?.parent?.atMessage === at && row.parent.sessionId === id &&
      row.title === "persistent fork" && row.status === "fork check" && row.cwd === ROOT);
    const handoff = path.join(scratch, `handoff-${crypto.createHash("sha256").update(child.sessionId).digest("hex")}.json`);
    await fs.mkdir(handoff);
    const failed = await c.runTurn({ sessionId: child.sessionId, prompt: "retry after failure" });
    t.ok("handoff write failure reaches UI", failed.outcome === "error" && failed.events.some(e => e.error));
    const afterFailure = await c.cmd("loadSession", { sessionId: child.sessionId });
    const failureCompletedAt = failed.events.find(e => e.type === "turnEnd")?.completedAt;
    t.ok("handoff failure records completion", Number.isFinite(failureCompletedAt) && afterFailure.completedAt === failureCompletedAt);
    t.ok("handoff failure preserves child history", JSON.stringify({ ...before, completedAt: failureCompletedAt }) === JSON.stringify(afterFailure));
    await fs.rmdir(handoff);
    const result = await c.runTurn({ sessionId: child.sessionId, prompt: "after restart" });
    t.ok("restart resumes child", result.outcome === "ok");
  } finally { c.close(); await server.stop(); }
}
