// 作業ディレクトリを選ぶための、フォルダーだけの一覧（入力欄のフォルダーのパネル。ブラウザー版で使う）。
//
// デスクトップ版は OS のダイアログ（desktop の ply:choose-folder）を使うので、これはブラウザーから開いたときの代わり。
// 返すのは名前だけ（ファイルは出さない・中身は読まない）。認証済みの接続からしか来ない。
// 読めない（無い・権限が無い・フォルダーではない）ときは、その理由の一文で断る。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES = 2000;

/** Windows のドライブ（C:\ など）。一番上の階層から他のドライブへ移れるように */
async function driveRoots() {
  if (process.platform !== "win32") return [];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const found = await Promise.all(letters.map(async (l) => {
    const root = `${l}:${path.sep}`;
    try { await fs.access(root); return root; } catch { return null; }
  }));
  return found.filter(Boolean);
}

function reason(err, dir) {
  switch (err?.code) {
    case "ENOENT": return `フォルダーが見つかりません: ${dir}`;
    case "ENOTDIR": return `フォルダーではありません: ${dir}`;
    case "EACCES": case "EPERM": return `フォルダーを開けません（アクセスが許可されていません）: ${dir}`;
    default: return `フォルダーを開けません: ${dir}`;
  }
}

/**
 * @param {string} [requested] 開くフォルダー。空なら fallback、それも空ならホーム
 * @param {{ fallback?: string }} [o]
 * @returns {Promise<{ path: string, parent: string|null, dirs: string[], truncated: boolean, roots: string[] }>}
 */
export async function listDirs(requested, { fallback } = {}) {
  if (requested != null && typeof requested !== "string") throw new Error("パスの指定が不正です");
  if (requested && (requested.length > 8192 || requested.includes("\0"))) throw new Error("パスの指定が不正です");
  const dir = path.resolve(String(requested || fallback || os.homedir()).trim());
  let entries;
  try {
    if (!(await fs.stat(dir)).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) { throw new Error(reason(err, dir)); }
  const dirs = [];
  for (const e of entries) {
    if (dirs.length >= MAX_ENTRIES) break;
    if (e.isDirectory()) { dirs.push(e.name); continue; }
    // リンク（ジャンクション・シンボリックリンク）は先がフォルダーなら並べる。辿れないものは黙って外す
    if (e.isSymbolicLink()) {
      try { if ((await fs.stat(path.join(dir, e.name))).isDirectory()) dirs.push(e.name); } catch { /* 切れたリンク */ }
    }
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    dirs,
    truncated: dirs.length >= MAX_ENTRIES,
    roots: parent === dir ? await driveRoots() : [],
  };
}
