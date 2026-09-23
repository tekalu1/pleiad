// 孤児の `agy` を掃除する控え（core/backends/antigravity-pids.mjs）。
//
// **ここで測りたいのは「殺しすぎない」こと。** agy は 1 プロセス = 1 会話で、Pleiad が
// 強制終了されると裏に取り残される（実例では 3 時間走り続けた。docs/multi-backend.md §2.8）。
// そこで pid を控えて次の起動で落とすが、**pid は使い回される**ので、
// 実行ファイル名を確かめずに落とすと無関係のプロセスを殺す。
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pids from "../../core/backends/antigravity-pids.mjs";

export const name = "antigravity-pids";
export const title = "孤児の agy は名前を確かめてから落とす";

/** すぐには終わらない子。落とされたかどうかを見るための的。 */
function decoy() {
  const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  proc.unref();
  return proc;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const gone = async (pid) => {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agypid-")));
  const data = process.env.AGENT_HOST_DATA;
  const bin = process.env.AGENT_HOST_AGY_BIN;
  process.env.AGENT_HOST_DATA = scratch;
  const file = path.join(scratch, "antigravity", "pids.json");
  const victims = [];

  try {
    // ---- 控える / 外す
    delete process.env.AGENT_HOST_AGY_BIN;
    pids.remember(4242);
    t.ok("控えは会話の控えと同じ置き場に入る", (await fs.readFile(file, "utf8")).includes("4242"), file);
    pids.remember(4242);
    t.ok("同じ pid を二重に控えない", pids.listed().filter((p) => p === 4242).length === 1,
         JSON.stringify(pids.listed()));
    pids.forget(4242);
    t.ok("外したものは残らない", !pids.listed().includes(4242), JSON.stringify(pids.listed()));

    // ---- 壊れていても落ちない
    await fs.writeFile(file, "{ これは JSON ではない", "utf8");
    t.ok("壊れた控えは空として読む", pids.listed().length === 0, JSON.stringify(pids.listed()));
    pids.remember(99);
    t.ok("壊れた控えの上からでも書ける", pids.listed().includes(99), JSON.stringify(pids.listed()));
    pids.forget(99);

    // ---- **名前が違うものは落とさない**（pid の使い回しで無関係なプロセスを殺さない）
    const other = decoy();
    victims.push(other);
    pids.remember(other.pid);
    t.ok("agy でない pid は agy と見なさない", (await pids.isAgy(other.pid)) === false, String(other.pid));
    const spared = await pids.reap();
    t.ok("名前が違えば落とさない", spared.length === 0 && alive(other.pid), JSON.stringify(spared));
    t.ok("見た pid は控えから外す（次の起動で見直さない）",
      !pids.listed().includes(other.pid), JSON.stringify(pids.listed()));

    // ---- 名前が合うものは落とす。
    // 起動に使う実行ファイルは AGENT_HOST_AGY_BIN で決まる（テストの身代わりは node）
    // 空白を含む置き場（`C:\Program Files\nodejs`）があるので、渡すときは括る
    process.env.AGENT_HOST_AGY_BIN = `"${process.execPath}"`;
    const orphan = decoy();
    victims.push(orphan);
    pids.remember(orphan.pid);
    t.ok("起動に使う実行ファイルと同じ名前なら agy と見なす",
      (await pids.isAgy(orphan.pid)) === true, String(orphan.pid));
    const killed = await pids.reap();
    t.ok("孤児は落とす", killed.includes(orphan.pid), JSON.stringify(killed));
    t.ok("落ちるまで見届けられる", await gone(orphan.pid), String(orphan.pid));

    // ---- **他の Pleiad が使っているものは孤児ではない**（控えは AGENT_HOST_DATA ごとに 1 つ。
    // worktree ごとの開発サーバなどで Pleiad が 2 つ動くと、後から起きた方が先の agy を殺しうる）
    const ply = decoy();          // 先に動いている Pleiad の身代わり
    const child = decoy();        // その Pleiad が起こした agy の身代わり
    victims.push(ply, child);
    await fs.writeFile(file, JSON.stringify([{ pid: child.pid, owner: ply.pid }]), "utf8");
    const untouched = await pids.reap();
    t.ok("他の生きている Pleiad の agy は落とさない",
      untouched.length === 0 && alive(child.pid), JSON.stringify(untouched));
    t.ok("他の Pleiad のものは控えにも残す", pids.listed().includes(child.pid),
      JSON.stringify(pids.listed()));
    ply.kill();
    t.ok("その Pleiad が居なくなるまで待つ", await gone(ply.pid), String(ply.pid));
    const inherited = await pids.reap();
    t.ok("Pleiad が落ちたら孤児として落とす", inherited.includes(child.pid), JSON.stringify(inherited));
    await fs.rm(file, { force: true });

    // ---- 居ない pid は触らない（使い回しの相手を殺さないための最後の砦）
    pids.remember(orphan.pid);
    const none = await pids.reap();
    t.ok("居なくなった pid は落とさない", none.length === 0, JSON.stringify(none));
    t.ok("控えは空になる", pids.listed().length === 0, JSON.stringify(pids.listed()));
  } finally {
    for (const proc of victims) { try { proc.kill(); } catch {} }
    if (data === undefined) delete process.env.AGENT_HOST_DATA; else process.env.AGENT_HOST_DATA = data;
    if (bin === undefined) delete process.env.AGENT_HOST_AGY_BIN; else process.env.AGENT_HOST_AGY_BIN = bin;
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
