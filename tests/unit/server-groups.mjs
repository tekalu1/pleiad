// グループ（fork でつながった会話のまとまり、docs/design-system.md §4.1）をサーバ側から見る。
// LLM もネットワークも要らない（AGENT_HOST_BACKENDS=fake）。
//
// グループは持ち物ではない。**親子・状態・「人が外した印」**の 3 つで決まるので、
// サーバが守るのは 2 つだけ: 枝は親の状態を引き継いで生まれること、根を動かすと中も動くこと。
// 描画側の組み立ては tests/unit/family.mjs（web/family.mjs）が見る。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-groups";
export const title = "fork のグループが状態と一緒に動く";

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-groups-")));
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake" },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });
  const c = await open({ port: server.port, token: server.token });
  const rowOf = async (id) => (await c.cmd("listSessions")).find((s) => s.id === id);

  try {
    const first = await c.runTurn({ prompt: "echo:はじめ", sessionId: null, cwd: ROOT, backend: "fake", mode: "default" }, { ms: 20_000 });
    const root = first.sessionId;
    await c.cmd("setStatus", { sessionId: root, status: "進行中", reason: "テスト" });

    // ---- 枝は親の状態を引き継いで生まれる（でないと生まれた瞬間に外れる） ----
    const child = (await c.cmd("fork", { sessionId: root })).sessionId;
    const childRow = await rowOf(child);
    t.ok("fork した枝は親の状態で始まる", childRow?.status === "進行中", childRow?.status ?? "(なし)");
    t.ok("枝は親を指す", childRow?.parent?.sessionId === root, childRow?.parent?.sessionId ?? "(なし)");
    t.ok("生まれたばかりの枝に「外した印」は無い", childRow?.ungrouped === false, String(childRow?.ungrouped));

    const grand = (await c.cmd("fork", { sessionId: child })).sessionId;

    // ---- 根を動かすと、中の会話も一緒に動く ----
    await c.cmd("setStatus", { sessionId: root, status: "レビュー待ち", reason: "グループごと移動" });
    const after = await c.cmd("listSessions");
    const statusOf = (id) => after.find((s) => s.id === id)?.status;
    t.ok("根を動かすとグループごと移る", statusOf(root) === "レビュー待ち" && statusOf(child) === "レビュー待ち" && statusOf(grand) === "レビュー待ち",
      `${statusOf(root)} / ${statusOf(child)} / ${statusOf(grand)}`);

    // ---- 中の会話を動かすと、その 1 本だけが出る ----
    await c.cmd("setStatus", { sessionId: child, status: "進行中", reason: "枝だけ" });
    const moved = await c.cmd("listSessions");
    const st = (id) => moved.find((s) => s.id === id)?.status;
    t.ok("中の枝を動かしても、他は動かない", st(child) === "進行中" && st(root) === "レビュー待ち" && st(grand) === "レビュー待ち",
      `${st(root)} / ${st(child)} / ${st(grand)}`);

    // ---- 外した印。覚えるのはこれだけ ----
    await c.cmd("setGrouped", { sessionId: grand, ungrouped: true });
    t.ok("外した印が一覧の行に出る", (await rowOf(grand))?.ungrouped === true);
    const saved = JSON.parse(await fs.readFile(path.join(scratch, "data", "sessions.json"), "utf8"));
    t.ok("外した印は sidecar に残る（再起動しても外れたまま）", saved[grand]?.ungrouped === true, JSON.stringify(saved[grand]?.ungrouped));
    await c.cmd("setGrouped", { sessionId: grand, ungrouped: false });
    t.ok("戻すと印が消える", (await rowOf(grand))?.ungrouped === false);

    // ---- 取り消しの経路。1 本ずつ戻すので、根を戻しても中は巻き込まない ----
    await c.cmd("setStatus", { sessionId: root, status: "進行中", reason: "元に戻す", alone: true });
    const undone = await c.cmd("listSessions");
    const u = (id) => undone.find((s) => s.id === id)?.status;
    t.ok("alone なら根を動かしても広がらない", u(root) === "進行中" && u(grand) === "レビュー待ち", `${u(root)} / ${u(grand)}`);
  } finally {
    c.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
