// 開いている会話の宣言（loadSession の watch・watchSession）と、会話の一覧の使い回し（ADR 0024・docs/multi-backend.md §2.1）。
// fake バックエンドでサーバーを立て、宣言した接続と宣言していない接続の 2 本で確かめる。LLM もネットワークも要らない。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

export const name = "server-watch";
export const title = "流れの出来事は開いている会話の分だけ届き、一覧は使い回しても古くならない";

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-watch-")));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const runner = await open({ port: server.port, token: server.token });
  const phone = await open({ port: server.port, token: server.token });
  const turn = { cwd: ROOT, backend: "fake", mode: "default" };
  const endOf = (c, id, from) => c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id, { ms: 20_000, from });
  const deltas = (c, from, id) => c.since(from).filter((e) => e.type === "text.delta" && e.sessionId === id).length;

  try {
    const x = (await runner.runTurn({ ...turn, prompt: "echo:ひとつめの会話", sessionId: null }, { ms: 20_000 })).sessionId;
    const y = (await runner.runTurn({ ...turn, prompt: "echo:ふたつめの会話", sessionId: null }, { ms: 20_000 })).sessionId;
    t.ok("会話が 2 つできる", Boolean(x && y && x !== y), JSON.stringify({ x, y }));

    // ---- 宣言した接続には、開いている会話の流れだけが届く ----
    await phone.cmd("loadSession", { sessionId: x, live: true, watch: true });
    let from = phone.mark(), runFrom = runner.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:開いていない会話の返答", sessionId: y });
    await endOf(phone, y, from);
    await sleep(50);
    t.ok("開いていない会話の本文の流れは届かない", deltas(phone, from, y) === 0, String(deltas(phone, from, y)));
    t.ok("開いていない会話の完了（turnEnd）は届く", phone.since(from).some((e) => e.type === "turnEnd" && e.sessionId === y));
    t.ok("宣言していない接続には今までどおり全部届く", deltas(runner, runFrom, y) > 0, String(deltas(runner, runFrom, y)));

    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:開いている会話の返答", sessionId: x });
    await endOf(phone, x, from);
    t.ok("開いている会話の流れは届く", deltas(phone, from, x) > 0, String(deltas(phone, from, x)));

    // ---- watchSession で開き直すと、届く会話が替わる ----
    await phone.cmd("watchSession", { sessionId: y });
    from = phone.mark();
    await runner.cmd("runTurn", { ...turn, prompt: "echo:移った先の返答", sessionId: y });
    await runner.cmd("runTurn", { ...turn, prompt: "echo:移る前の会話の返答", sessionId: x }).catch(() => {});
    await Promise.all([endOf(phone, y, from), endOf(phone, x, from)]);
    await sleep(50);
    t.ok("watchSession の後は移った先の流れが届く", deltas(phone, from, y) > 0, String(deltas(phone, from, y)));
    t.ok("移る前の会話の流れは届かない", deltas(phone, from, x) === 0, String(deltas(phone, from, x)));

    // ---- 一覧の使い回し: 変えた直後の一覧に載る ----
    await runner.cmd("listSessions");
    await runner.cmd("setTitle", { sessionId: x, title: "付け直したタイトル" });
    const row = (await runner.cmd("listSessions")).find((s) => s.id === x);
    t.ok("タイトルを変えた直後の一覧に新しいタイトルが載る", row?.title === "付け直したタイトル", JSON.stringify(row?.title));
    const z = (await runner.runTurn({ ...turn, prompt: "echo:みっつめの会話", sessionId: null }, { ms: 20_000 })).sessionId;
    t.ok("作った直後の会話が一覧に載る", (await runner.cmd("listSessions")).some((s) => s.id === z));
    const fork = await runner.cmd("fork", { sessionId: z });
    const lineage = await runner.cmd("lineage", { sessionId: z });
    t.ok("分けた直後の枝が系譜に載る", lineage.sessions.some((s) => s.id === fork.sessionId), JSON.stringify(lineage.sessions.map((s) => s.id)));
  } finally {
    runner.close();
    phone.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
