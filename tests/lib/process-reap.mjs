// tests/run.mjs の worker が起こした子孫のプロセスだけを回収する。ユーザーの別のプロセス・別の作業のテストには触れない。
//
// worker が（suite の中で）起こしたサーバーなどの孫は、worker が先に死ぬと残る（Windows は親が死んでも子を道連れにしない）。
// 範囲は「worker の pid から親子の鎖でたどれる、worker より後に生まれたプロセス」だけ。pid の使い回しで別のプロセスを取り違えないよう、
// 子は親より後に生まれていること（作成時刻）を鎖の各段で見る。全部の node を止める・名前で探して止めることはしない。
//   - POSIX: worker は自分のプロセスグループ（fork の detached）。グループへの SIGKILL で、残った子孫だけが落ちる。
//     グループを抜けた孫（detached のシェルなど）は、worker ごとの環境変数の印（Linux は /proc/<pid>/environ）で見つける
//   - Windows: プロセス表（PowerShell の Get-CimInstance。読むだけ）から鎖をたどって 1 本ずつ止める
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** worker（とその子孫）の環境変数に入れる、worker ごとに一意の印。環境変数は detached で起こした孫にも引き継がれるので、親子の鎖が切れた孫を見つけられる（Linux） */
export const WORKER_TAG_ENV = "PLEIAD_TEST_WORKER_TAG";

const SLACK_MS = 2000;
/** worker は fork の直後に生まれる。pid が使い回された別のプロセスと見分けるための、生まれた時刻の許容幅 */
const BIRTH_WINDOW_MS = 15_000;

/** Windows のプロセス表: Map<pid, { ppid, created(ms) }>。読めなければ null（1 回だけ引き直す） */
export function listProcessesWin() {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }; '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, $c }";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    if (r.status !== 0 || typeof r.stdout !== "string") continue;
    const table = new Map();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^(\d+),(\d+),(-?\d+)$/.exec(line.trim());
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), created: Number(m[3]) });
    }
    if (table.size) return table;
  }
  return null;
}

/**
 * table（pid → { ppid, created }）から、roots（{ pid, spawnedAt, endedAt? }）の子孫を集める。roots 自身は含めない・自分（selfPid）は含めない。
 * pid の使い回しで、ほかの作業のプロセスを自分のものと取り違えないための条件:
 *   - root の pid が今もある（生きている）なら、その生まれた時刻が、起こした時刻（spawnedAt）の近くであること。違えば別のプロセスなので辿らない
 *   - root が死んだ後は、子が生まれたのが root の死（endedAt。無ければ今）より後でないこと。死んだ後に生まれた子は、使い回された pid の子
 *   - 子は親より後に生まれていること（鎖の各段）
 */
export function ownedDescendants(table, roots, selfPid = process.pid, now = Date.now()) {
  const kids = new Map();
  for (const [pid, p] of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  const owned = new Map();
  const rootPids = new Set(roots.map((r) => r.pid));
  const walk = (pid, since, until) => {
    for (const k of kids.get(pid) ?? []) {
      const p = table.get(k);
      if (!p || k === selfPid || rootPids.has(k) || owned.has(k) || p.created < since - SLACK_MS || p.created > until) continue;
      owned.set(k, p);
      walk(k, p.created, Infinity);
    }
  };
  for (const r of roots) {
    const me = table.get(r.pid);
    if (me && (me.created < r.spawnedAt - SLACK_MS || me.created > r.spawnedAt + BIRTH_WINDOW_MS)) continue;   // pid が別のプロセスに使い回されている
    walk(r.pid, r.spawnedAt, me ? Infinity : (r.endedAt ?? now) + SLACK_MS);
  }
  return owned;   // Map<pid, { ppid, created }>
}

/**
 * roots（{ pid, spawnedAt, endedAt? }）の残りの子孫を止める。{ killed, error? } を返す。
 * error があるときは、止められたか確かめられなかった（呼び出し側は失敗として扱う。黙って成功にしない）。
 * 止める直前にもう一度プロセス表を読み、親と生まれた時刻が同じものだけを止める（読んでから止めるまでの間の pid の使い回しを避ける）。
 * opts は試験用の差し替え（list・kill・platform）。
 */
export function reapOwned(roots, { list = listProcessesWin, kill = process.kill.bind(process), platform = process.platform } = {}) {
  if (!roots.length) return { killed: 0 };
  if (platform !== "win32") {
    // POSIX: worker は自分のプロセスグループ。死んだ直後（pid が使い回される前）に呼ぶこと
    let killed = 0;
    for (const r of roots) { try { kill(-r.pid, "SIGKILL"); killed++; } catch { /* グループにもう誰も居ない */ } }
    // グループを抜けた孫（host-shell・hook-adapter の detached のシェルなど。worker が先に死ぬと親の鎖も切れる）は、worker ごとの印を持つものだけを止める。
    // 印は環境変数なので、Linux は /proc/<pid>/environ から読める（自分のプロセスのものだけ。印の無い・読めないプロセスには触れない）。/proc が無い OS（macOS）は、グループ内だけ
    killed += killTagged(roots.map((r) => r.tag).filter(Boolean), { kill });
    return { killed };
  }
  const table = list();
  if (!table) return { killed: 0, error: "プロセス表を読めなかった（PowerShell）。worker の子孫が残っていないか確かめられない" };
  const owned = ownedDescendants(table, roots);
  if (!owned.size) return { killed: 0 };
  const again = list();
  if (!again) return { killed: 0, error: "止める直前のプロセス表を読めなかった（PowerShell）。worker の子孫を止められなかった可能性がある" };
  let killed = 0;
  for (const [pid, p] of owned) {
    const now = again.get(pid);
    if (!now || now.created !== p.created || now.ppid !== p.ppid) continue;   // もう居ない・別のプロセスに変わった
    try { kill(pid, "SIGKILL"); killed++; } catch { /* もう居ない */ }
  }
  return { killed };
}

/**
 * /proc の各プロセスの環境変数から、tags のどれかの印（WORKER_TAG_ENV=<tag>）を持つプロセスを止める。止めた本数を返す。
 * 印は worker ごとに一意で、親（ランナー）が worker の起動時に決めたもの。pid の使い回しや、ほかの作業のプロセスとは取り違えない。
 */
export function killTagged(tags, { procDir = "/proc", kill = process.kill.bind(process), selfPid = process.pid } = {}) {
  const want = new Set(tags);
  if (!want.size) return 0;
  let names;
  try { names = fs.readdirSync(procDir); } catch { return 0; }
  let killed = 0;
  const prefix = `${WORKER_TAG_ENV}=`;
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === selfPid) continue;
    let env;
    try { env = fs.readFileSync(`${procDir}/${n}/environ`, "utf8"); } catch { continue; }   // 読めない（別のユーザー・もう居ない）
    const hit = env.split("\0").find((e) => e.startsWith(prefix));
    if (!hit || !want.has(hit.slice(prefix.length))) continue;
    try { kill(Number(n), "SIGKILL"); killed++; } catch { /* もう居ない */ }
  }
  return killed;
}

/** 自分（worker）と、その子孫を全部止める。親が死んだとき worker が残さないために、worker 自身が呼ぶ */
export function killOwnTree() {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    else {
      killTagged([process.env[WORKER_TAG_ENV]].filter(Boolean));   // グループを抜けた孫（自分が死ぬと鎖が切れる）を先に
      process.kill(-process.pid, "SIGKILL");
    }
  } catch { /* 下の exit で終わる */ }
  process.exit(4);
}
