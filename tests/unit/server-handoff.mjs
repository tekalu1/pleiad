import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-handoff";
export const title = "バックエンドを往復しても会話・ID・承認先が続く";
export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-handoff-"));
  const config = { dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake,codex",
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, "tests/lib/fake-codex.mjs")}"` } };
  let server = await startServer(config);
  const permissions = [];
  const connect = () => open({ port: server.port, token: server.token,
    onEvent: async (ev, self) => {
      if (ev.type === "permission") {
        permissions.push(ev.sessionId);
        await self.cmd("resolvePermission", { id: ev.id, allow: true });
      }
    } });
  let c = await connect();
  try {
    const first = await c.runTurn({ backend: "fake", cwd: ROOT, prompt: "echo:remember violet" });
    const id = first.sessionId;
    const mark = c.mark();
    await c.cmd("runTurn", { sessionId: id, prompt: "slow" });
    await c.cmd("switchBackend", { sessionId: id, backend: "codex" }).then(
      () => t.ok("実行中は切り替えを拒否", false), () => t.ok("実行中は切り替えを拒否", true));
    await c.cmd("abort", { sessionId: id });
    await c.waitFor(e => e.type === "turnEnd", { from: mark, ms: 10000 });
    await c.cmd("setTitle", { sessionId: id, title: "引き継ぎ" });
    await c.cmd("switchBackend", { sessionId: id, backend: "codex" });
    const second = await c.runTurn({ sessionId: id, prompt: "continue amber" });
    t.ok("切り替え先も同じ会話ID", second.events.every(e => !e.sessionId || e.sessionId === id));
    t.ok("新規待ちタブが切り替え先を奪わない", second.events.filter(e => e.type === "session").every(e => !e.first));
    t.ok("過去の文脈を渡す", second.events.filter(e => e.type === "text.delta").map(e => e.text).join("").includes("remember violet"));
    t.ok("承認はアプリの会話ID", permissions.includes(id));
    let data = await c.cmd("loadSession", { sessionId: id });
    t.ok("引き継ぎプロンプトでユーザー発言を汚さない", data.messages.filter(m => m.role === "user").map(m => m.text).join("|") === "echo:remember violet|slow|continue amber");
    await c.cmd("switchBackend", { sessionId: id, backend: "fake" });
    const third = await c.runTurn({ sessionId: id, prompt: "echo:back again" });
    t.ok("元へ戻るときにも間の会話を渡す", third.events.filter(e => e.type === "text.delta").map(e => e.text).join("").includes("continue amber"));
    const rows = await c.cmd("listSessions");
    t.ok("ネイティブの実行区間は一覧で重複しない", rows.length === 1 && rows[0].id === id && rows[0].backend === "fake");
    t.ok("タイトルを維持", rows[0].title === "引き継ぎ");
    data = await c.cmd("loadSession", { sessionId: id });
    const before = JSON.stringify(data.messages);
    await c.cmd("setPref", { key: "mode", value: "readonly", backend: "codex" });
    await c.cmd("setPref", { key: "mode", value: "auto", backend: "fake" });
    await c.cmd("setPref", { key: "backend", value: "codex" });
    await c.cmd("setPref", { key: "mode", value: "readonly", backend: "fake" }).then(
      () => t.ok("Reject another backend's mode", false),
      () => t.ok("Reject another backend's mode", true));
    c.close(); await server.stop();
    server = await startServer(config); c = await connect();
    const prefs = await c.cmd("prefs");
    t.ok("Remember backend and separate modes after restart", prefs.backend === "codex" && prefs.backends.codex.mode === "readonly" && prefs.backends.fake.mode === "auto");
    const fresh = await c.runTurn({ prompt: "hello", cwd: ROOT });
    const freshRow = (await c.cmd("listSessions")).find(s => s.id === fresh.sessionId);
    t.ok("New session uses remembered backend and mode", freshRow.backend === "codex" && freshRow.mode === "readonly");
    data = await c.cmd("loadSession", { sessionId: id });
    t.ok("再起動しても全区間の履歴が残る", JSON.stringify(data.messages) === before);
    const fork = await c.cmd("fork", { sessionId: id, upToMessageId: data.messages[1].uuid });
    const forkData = await c.cmd("loadSession", { sessionId: fork.sessionId });
    t.ok("古いバックエンドの発言から分岐できる", forkData.messages.length === 2);
    await c.cmd("runTurn", { sessionId: id, backend: "codex", prompt: "bad" }).then(
      () => t.ok("再開APIでIDを別バックエンドへ渡さない", false),
      () => t.ok("再開APIでIDを別バックエンドへ渡さない", true));
  } finally { c.close(); await server.stop(); }
}
