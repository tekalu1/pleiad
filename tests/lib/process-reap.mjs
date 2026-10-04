// tests/run.mjs の worker が起こした子孫のプロセスだけを回収する。ユーザーの別のプロセス・別の作業のテストには触れない。
//
// worker が（suite の中で）起こしたサーバーなどの孫は、worker が先に死ぬと残る（Windows は親が死んでも子を道連れにしない）。
// 範囲は「worker の pid から親子の鎖でたどれる、worker より後に生まれたプロセス」だけ。pid の使い回しで別のプロセスを取り違えないよう、
// 子は親より後に生まれていること（作成時刻）を鎖の各段で見る。全部の node を止める・名前で探して止めることはしない。
//   - POSIX: worker は自分のプロセスグループ（fork の detached）。グループへの SIGKILL で、残った子孫だけが落ちる
//   - Windows: プロセス表（PowerShell の Get-CimInstance。読むだけ）から鎖をたどって 1 本ずつ止める
import { spawnSync } from "node:child_process";

const SLACK_MS = 2000;

/** Windows のプロセス表: Map<pid, { ppid, created(ms) }>。読めなければ null */
export function listProcessesWin() {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }; '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, $c }";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const table = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(-?\d+)$/.exec(line.trim());
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), created: Number(m[3]) });
  }
  return table.size ? table : null;
}

/** table（pid → { ppid, created }）から、roots（{ pid, spawnedAt }）の子孫を集める。roots 自身は含めない・自分（selfPid）とその祖先は含めない */
export function ownedDescendants(table, roots, selfPid = process.pid) {
  const kids = new Map();
  for (const [pid, p] of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  const owned = new Set();
  const rootPids = new Set(roots.map((r) => r.pid));
  const walk = (pid, since) => {
    for (const k of kids.get(pid) ?? []) {
      const p = table.get(k);
      if (!p || k === selfPid || rootPids.has(k) || owned.has(k) || p.created < since - SLACK_MS) continue;
      owned.add(k);
      walk(k, p.created);
    }
  };
  for (const r of roots) walk(r.pid, r.spawnedAt);
  return [...owned];
}

/**
 * roots（{ pid, spawnedAt }）の残りの子孫を止める。止めた本数を返す。
 * Windows でプロセス表が読めないときは { killed: 0, error } を返す（呼び出し側は注意として出す。失敗にはしない）。
 */
export function reapOwned(roots) {
  if (!roots.length) return { killed: 0 };
  if (process.platform !== "win32") {
    let killed = 0;
    for (const r of roots) { try { process.kill(-r.pid, "SIGKILL"); killed++; } catch { /* グループにもう誰も居ない */ } }
    return { killed };
  }
  const table = listProcessesWin();
  if (!table) return { killed: 0, error: "プロセス表を読めなかった（PowerShell）" };
  let killed = 0;
  for (const pid of ownedDescendants(table, roots)) {
    try { process.kill(pid, "SIGKILL"); killed++; } catch { /* もう居ない */ }
  }
  return { killed };
}

/** 自分（worker）と、その子孫を全部止める。親が死んだとき worker が残さないために、worker 自身が呼ぶ */
export function killOwnTree() {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    else process.kill(-process.pid, "SIGKILL");
  } catch { /* 下の exit で終わる */ }
  process.exit(4);
}
