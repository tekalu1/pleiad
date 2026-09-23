// 対応を終えたエージェント（procway-code）の会話と設定が残っていても、サーバーが安全に動くこと。
// 一覧には出す・開けば理由が返る・送信と設定の変更は断る・タイトルと状態は変えられる・既定のエージェントは使えるものへ落ちる。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-retired";
export const title = "procway-code の会話と設定が残っていても安全に動く（読むだけ・送信は断る）";

async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-retired-"));
  const now = Date.now();
  await fs.writeFile(path.join(scratch, "sessions.json"), JSON.stringify({
    "old-procway": { backend: "procway", title: "procway の古い会話", cwd: ROOT, createdAt: now - 1000, lastModified: now - 1000, model: "ply-x/gpt-5", procwayLimits: { context: 1000 } },
  }));
  await fs.writeFile(path.join(scratch, "prefs.json"), JSON.stringify({ backend: "procway", backends: { procway: { model: "ply-x/gpt-5" } } }));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake,procway" } });
  const c = await open({ port: server.port, token: server.token });
  try {
    const rows = await c.cmd("listSessions");
    const row = rows.find(r => r.id === "old-procway");
    t.ok("一覧に出す", row?.title === "procway の古い会話" && row.backend === "procway");
    t.ok("一覧の行に続けられない理由が付く", String(row?.retired ?? "").includes("procway-code への対応は終了しました"));
    t.ok("有効なエージェントには出さない", !(await c.cmd("backends")).some(b => b.id === "procway"));
    const loaded = await c.cmd("loadSession", { sessionId: "old-procway" });
    t.ok("開くと理由が返る（落ちない）", String(loaded?.retired ?? "").includes("対応は終了"));
    const sent = await rejects(c.cmd("runTurn", { sessionId: "old-procway", prompt: "echo:x" }));
    t.ok("送信は理由を付けて断る", String(sent?.message ?? "").includes("対応は終了"), sent?.message);
    const settings = await rejects(c.cmd("setTurnSettings", { sessionId: "old-procway", effort: "high" }));
    t.ok("設定の変更も断る", String(settings?.message ?? "").includes("対応は終了"), settings?.message);
    await c.cmd("setTitle", { sessionId: "old-procway", title: "名前を変えた" });
    t.ok("タイトルは変えられる", (await c.cmd("listSessions")).find(r => r.id === "old-procway")?.title === "名前を変えた");
    const fresh = await c.cmd("newSession", { cwd: ROOT });
    const created = (await c.cmd("listSessions")).find(r => r.id === fresh.sessionId);
    t.ok("既定が procway のままでも、新しい会話は使えるエージェントで作る", created?.backend === "fake", created?.backend);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
