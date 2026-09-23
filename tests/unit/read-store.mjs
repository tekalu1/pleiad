// 確認済み（readAt）の置き場（core/store.mjs の markRead）。store はデータ置き場を読み込み時に決めるので、
// 使い捨ての置き場を渡した子プロセスで読む。LLM もサーバーも要らない。
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib/server.mjs";

export const name = "read-store";
export const title = "確認済みの完了時刻をホストに残す（冪等・巻き戻らない・完了を超えない）";

const script = `
const store = await import(process.env.STORE_URL);
const out = {};
await store.setMeta("a", { completedAt: 1000 });
await store.setMeta("b", { completedAt: 2000 });
await store.setMeta("n", { title: "not completed" });
out.first = await store.markRead([["a", 1000], ["b", 1500]]);
out.again = await store.markRead([["a", 1000], ["b", 1500]]);
out.older = await store.markRead([["b", 900]]);
out.clamped = await store.markRead([["b", 99999]]);
out.ignored = await store.markRead([["missing", 5], ["n", 5], ["a", "x"], ["a", -1], "junk", [null, 3]]);
out.nonArray = await store.markRead(null);
out.a = (await store.get("a")).readAt;
out.b = (await store.get("b")).readAt;
out.missingCreated = "missing" in (await store.getAll());
console.log(JSON.stringify(out));
`;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-read-store-"));
  try {
    const stdout = await new Promise((res, rej) => execFile(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: pathToFileURL(path.join(ROOT, "core", "store.mjs")).href },
    }, (err, out, errOut) => err ? rej(new Error(`${err.message}\n${errOut}`)) : res(out)));
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    t.ok("変わった分だけを返す", JSON.stringify(r.first) === JSON.stringify([["a", 1000], ["b", 1500]]), JSON.stringify(r.first));
    t.ok("同じ確認を送り直しても何も変わらない（冪等）", r.again.length === 0, JSON.stringify(r.again));
    t.ok("古い確認で巻き戻らない", r.older.length === 0, JSON.stringify(r.older));
    t.ok("完了時刻を超える確認は完了時刻に丸める", JSON.stringify(r.clamped) === JSON.stringify([["b", 2000]]), JSON.stringify(r.clamped));
    t.ok("記録に無い・完了していない・壊れた値は無視する", r.ignored.length === 0 && r.nonArray.length === 0, JSON.stringify(r.ignored));
    t.ok("記録に無い会話の行を作らない", r.missingCreated === false);
    const saved = JSON.parse(await fs.readFile(path.join(dir, "sessions.json"), "utf8"));
    t.ok("sessions.json に残る（再起動しても確認済み）", saved.a?.readAt === 1000 && saved.b?.readAt === 2000, JSON.stringify({ a: saved.a?.readAt, b: saved.b?.readAt }));
    t.ok("完了していない会話には付けない", !("readAt" in (saved.n ?? {})));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
