// 生かしている `agy` の pid の控え。**孤児を掃除するためだけにある。**
//
// agy は **1 プロセス = 1 会話**で、Pleiad が落ちても誰も落としてくれない
// （前の起動の agy が裏で走り続けていた実例がある。docs/multi-backend.md §2.8）。
// 走り続けた agy は Pleiad が見ていない所でファイルを書き換え、Google の枠も食う。
//
// 本筋はサーバ終了時に畳むこと（antigravity.mjs 末尾の `process.once("exit")`）だが、
// 強制終了やクラッシュではそれが走らない。そこで生かしている pid をここに控え、
// **次の起動でまだ生きているものを落とす**。
//
// **pid は使い回される。** 名前を確かめずに落とすと無関係のプロセスを殺すので、
// 落とす前に必ずその pid の実行ファイル名を見て、agy（= 起動に使う実行ファイル）だと
// 確かめる。確かめられなければ落とさない。
//
// 置き場は会話の控えと同じ `AGENT_HOST_DATA/antigravity/`（antigravity-store.mjs の `dir()`）。
// 読み書きは壊れていても落ちない（無い・壊れている、はどちらも「控えが無い」と同じ）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliCommand } from "../cli-installation.mjs";
import { dir } from "./antigravity-store.mjs";

const NL = String.fromCharCode(10);

/** 控えの場所。`<conversation_id>.json` とは形が違うので、一覧は拾わない（store の read 参照）。 */
const file = () => path.join(dir(), "pids.json");

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(raw) ? raw.filter((e) => Number.isInteger(e?.pid)) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(list, null, 2), "utf8");
  } catch {}
}

/**
 * 起こした agy を控える。**同期で書く**（終了時にも同じ口を使うため）。
 *
 * `owner` は起こした Pleiad の pid。**控えは `AGENT_HOST_DATA` ごとに 1 つしかなく、
 * Pleiad を 2 つ動かすことがある**（worktree ごとの開発サーバなど）ので、これが無いと
 * 後から起きた Pleiad が、先に動いている Pleiad の agy を孤児と見なして落としてしまう。
 */
export function remember(pid) {
  if (!Number.isInteger(pid)) return;
  const list = read().filter((e) => e.pid !== pid);
  list.push({ pid, owner: process.pid, at: new Date().toISOString() });
  write(list);
}

/** 落とした（もう居ない）agy を控えから外す。 */
export function forget(...pids) {
  const drop = new Set(pids.filter((p) => Number.isInteger(p)));
  if (!drop.size) return;
  const list = read();
  const kept = list.filter((e) => !drop.has(e.pid));
  if (kept.length !== list.length) write(kept);
}

/** 控えにある pid（テスト・点検用）。 */
export function listed() {
  return read().map((e) => e.pid);
}

/**
 * 前の起動が残した孤児を落とす。**実行ファイル名を確かめられたものだけ。**
 *
 * **他の Pleiad が今まさに使っているものは孤児ではない**（`owner` が生きているもの）。
 * 触らず、控えにも残す。判断に迷ったら落とさない側に倒す（取り残す方がまだ安全）。
 * 見た pid のうち、落としたもの・もう居ないものだけ控えから外す。
 * @returns 落とした pid の一覧
 */
export async function reap() {
  const list = read();
  if (!list.length) return [];
  const killed = [];
  const keep = [];
  for (const entry of list) {
    const { pid, owner } = entry;
    // 自分が起こしたものと、他の生きている Pleiad のものは触らない
    if (pid === process.pid || (Number.isInteger(owner) && owner !== process.pid && alive(owner))) {
      keep.push(entry);
      continue;
    }
    if (!(await isAgy(pid))) continue;   // 居ない・名前が違う・確かめられない -> 触らない
    try {
      process.kill(pid);
      killed.push(pid);
    } catch {}
  }
  write(keep);
  return killed;
}

/** その pid のプロセスが居るか。**居るかどうかだけ**（誰かは isAgy が見る）。 */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}

/** その pid が agy か。**確かめられなければ false**（疑わしきは落とさない）。 */
export async function isAgy(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const name = await imageName(pid);
  if (!name) return false;
  return expectedNames().has(path.basename(name).trim().toLowerCase());
}

/**
 * 起動に使う実行ファイルの名前。
 *
 * `AGENT_HOST_AGY_BIN` で別のものを指していることがある（テストの身代わりは `node`）ので、
 * 名前は決め打ちにせず `cliCommand` が解決したものから取る。
 */
function expectedNames() {
  const argv = cliCommand("antigravity");
  const command = String(argv?.[0] ?? "agy");
  const names = new Set();
  // /proc/<pid>/exe はリンクを辿った実体なので、置き場がリンク（~/.local/bin/agy -> …）でも合うよう実体の名前も足す
  let real = null;
  try { real = fs.realpathSync(command); } catch {}
  for (const file of [command, real].filter(Boolean)) {
    const base = path.basename(file).toLowerCase();
    const bare = base.replace(/\.exe$/, "");
    names.add(base).add(bare).add(`${bare}.exe`);
  }
  return names;
}

/**
 * pid から実行ファイル名を引く。居なければ null。
 *
 * Linux は `/proc/<pid>/exe` の実体を先に見る。`ps -o comm=` はメインスレッドの名前で、
 * プロセス側が書き換えられる（ubuntu の Node 24 では身代わりの node が `node` と出なかった）。
 * 読めなければ（他人のプロセスなど）`ps` に落とす。どちらも駄目なら確かめられない = 落とさない
 */
async function imageName(pid) {
  if (process.platform === "linux") {
    try {
      const exe = await fs.promises.readlink(`/proc/${pid}/exe`);
      // 実行中に置き換えられた実体は末尾に ` (deleted)` が付く
      if (exe) return exe.replace(/ \(deleted\)$/, "");
    } catch {}
  }
  return psName(pid);
}

function psName(pid) {
  const [command, args] = process.platform === "win32"
    ? ["tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]]
    : ["ps", ["-p", String(pid), "-o", "comm="]];
  return new Promise((resolve) => {
    try {
      execFile(command, args, { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
        if (err) return resolve(null);
        const text = String(stdout ?? "").trim();
        if (process.platform === "win32") {
          // "node.exe","12345","Console","1","10,000 K" / 居なければ INFO: No tasks …
          const hit = /^"([^"]+)","(\d+)"/.exec(text);
          return resolve(hit && Number(hit[2]) === pid ? hit[1] : null);
        }
        return resolve(text.split(NL)[0]?.trim() || null);
      });
    } catch {
      resolve(null);
    }
  });
}
