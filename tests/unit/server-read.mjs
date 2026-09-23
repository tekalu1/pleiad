// 完了の確認（既読）はホストに 1 つ。別の窓・別の端末（リモート）から見ても同じ（docs/design.md「完了・未確認」）。
// fake バックエンドでサーバーを立て、2 本の WebSocket で確かめる。LLM もネットワークも要らない。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

export const name = "server-read";
export const title = "完了の確認をホストに残し、ほかの窓・端末へ知らせる";

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-read-")));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake" }, dataDir: path.join(scratch, "data"), timeoutMs: 30_000 });
  const host = await open({ port: server.port, token: server.token });
  const remote = await open({ port: server.port, token: server.token });
  const rowOf = async (c, id) => (await c.cmd("listSessions")).find((s) => s.id === id);

  try {
    const one = await host.runTurn({ prompt: "echo:ひとつめ", sessionId: null, cwd: ROOT, backend: "fake", mode: "default" }, { ms: 20_000 });
    const two = await host.runTurn({ prompt: "echo:ふたつめ", sessionId: null, cwd: ROOT, backend: "fake", mode: "default" }, { ms: 20_000 });
    const a = one.sessionId, b = two.sessionId;
    const doneA = one.events.find((e) => e.type === "turnEnd")?.completedAt;
    const doneB = two.events.find((e) => e.type === "turnEnd")?.completedAt;
    t.ok("完了時刻が一覧に載る", (await rowOf(remote, a))?.completedAt === doneA, String(doneA));
    t.ok("まだ誰も確認していなければ readAt は null", (await rowOf(remote, a))?.readAt === null);

    // ---- 片方で確認すると、もう片方へ届き、一覧にも載る ----
    const from = remote.mark();
    const res = await host.cmd("markRead", { reads: [[a, doneA]] });
    t.ok("markRead は変わった分を返す", JSON.stringify(res.reads) === JSON.stringify([[a, doneA]]), JSON.stringify(res));
    const ev = await remote.waitFor((e) => e.type === "read", { ms: 5000, from });
    t.ok("別の接続に read が届く", JSON.stringify(ev.reads) === JSON.stringify([[a, doneA]]), JSON.stringify(ev));
    t.ok("別の接続の一覧にも readAt が載る", (await rowOf(remote, a))?.readAt === doneA);

    // ---- 送り直し・古い値は何も起こさない ----
    const quiet = remote.mark();
    const again = await host.cmd("markRead", { sessionId: a, at: doneA - 10 });
    await sleep(200);
    t.ok("古い・同じ確認は変わらず、知らせもしない", again.reads.length === 0 && !remote.since(quiet).some((e) => e.type === "read"), JSON.stringify(again));

    // ---- 旧版がブラウザーに持っていた確認済みを最初の接続で移す（大きい方で合わさる） ----
    const migrate = remote.mark(), hostFrom = host.mark();
    const merged = await remote.cmd("markRead", { reads: [[a, doneA - 5], [b, doneB], ["gone-session", 123]] });
    t.ok("移行は大きい方で合わさり、無い会話は無視する", JSON.stringify(merged.reads) === JSON.stringify([[b, doneB]]), JSON.stringify(merged));
    const hostEv = await host.waitFor((e) => e.type === "read", { ms: 5000, from: hostFrom }).catch(() => null);
    t.ok("移行した分もほかの接続へ届く", hostEv?.reads?.some(([id]) => id === b), JSON.stringify(hostEv));
    t.ok("自分の接続にも届く", remote.since(migrate).some((e) => e.type === "read"));
    const saved = JSON.parse(await fs.readFile(path.join(scratch, "data", "sessions.json"), "utf8"));
    t.ok("sidecar に残る", saved[a]?.readAt === doneA && saved[b]?.readAt === doneB, JSON.stringify({ a: saved[a]?.readAt, b: saved[b]?.readAt }));
    t.ok("無い会話の行は作らない", !("gone-session" in saved));

    // ---- 次の完了は再び未確認（readAt < completedAt） ----
    await sleep(5);
    const next = await host.runTurn({ prompt: "echo:もう一度", sessionId: a, cwd: ROOT, backend: "fake", mode: "default" }, { ms: 20_000 });
    const doneA2 = next.events.find((e) => e.type === "turnEnd")?.completedAt;
    const row = await rowOf(remote, a);
    t.ok("次の完了は確認済みを越える", row?.completedAt === doneA2 && row.readAt === doneA && doneA2 > doneA, JSON.stringify(row && { c: row.completedAt, r: row.readAt }));

    // ---- 新しくつないだ接続（別の端末）も同じ状態から始まる ----
    const late = await open({ port: server.port, token: server.token });
    try { t.ok("後からつないだ端末も同じ確認済み", (await rowOf(late, b))?.readAt === doneB); } finally { late.close(); }
  } finally {
    host.close();
    remote.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
