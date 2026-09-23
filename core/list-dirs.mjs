// ホストのフォルダーの一覧。2 つの画面が使う:
//   - 作業ディレクトリを選ぶ簡易ブラウザー（入力欄のフォルダーのパネル。ブラウザー版）: フォルダーの名前だけ
//   - 添付の「ホストから」のファイルの面（web/host-files.mjs。リモート・ホストの画面ではないブラウザー）: { files: true } で
//     ファイルの名前・大きさ・更新時刻も返す
//
// デスクトップ版の作業ディレクトリは OS のダイアログ（desktop の ply:choose-folder）を使うので、これはブラウザーから開いたときの代わり。
// 返すのは名前と stat の値だけ（中身は読まない）。認証済みの接続からしか来ない。パスの検め（文字列・長さ・NUL）はどちらも同じ。
// 読めない（無い・権限が無い・フォルダーではない）ときは、その理由の一文で断る。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { t } from "./i18n.mjs";

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
    case "ENOENT": return t("dirs.notFound", { dir });
    case "ENOTDIR": return t("dirs.notDirectory", { dir });
    case "EACCES": case "EPERM": return t("dirs.accessDenied", { dir });
    default: return t("dirs.openFailed", { dir });
  }
}

/**
 * @param {string} [requested] 開くフォルダー。空なら fallback、それも空ならホーム
 * @param {{ fallback?: string, files?: boolean }} [o] files: ファイルも返す（件数の上限はフォルダーと合わせて MAX_ENTRIES）
 * @returns {Promise<{ path: string, parent: string|null, dirs: string[], files?: Array<{ name: string, size: number, mtime: number }>, truncated: boolean, roots: string[] }>}
 */
export async function listDirs(requested, { fallback, files: withFiles = false } = {}) {
  if (requested != null && typeof requested !== "string") throw new Error(t("dirs.invalidPath"));
  if (requested && (requested.length > 8192 || requested.includes("\0"))) throw new Error(t("dirs.invalidPath"));
  const dir = path.resolve(String(requested || fallback || os.homedir()).trim());
  let entries;
  try {
    if (!(await fs.stat(dir)).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) { throw new Error(reason(err, dir)); }
  const dirs = [];
  const files = [];
  let truncated = false;
  const fileRow = (name, st) => ({ name, size: st.size, mtime: Math.round(st.mtimeMs) });
  for (const e of entries) {
    if (dirs.length + files.length >= MAX_ENTRIES) { truncated = true; break; }
    if (e.isDirectory()) { dirs.push(e.name); continue; }
    if (withFiles && e.isFile()) {
      // 読めない（消えた・権限が無い）ファイルは黙って外す
      try { files.push(fileRow(e.name, await fs.stat(path.join(dir, e.name)))); } catch { /* 外す */ }
      continue;
    }
    // リンク（ジャンクション・シンボリックリンク）は先がフォルダーなら並べる（ファイルも返すときは先がファイルでも）。辿れないものは黙って外す
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.stat(path.join(dir, e.name));
        if (st.isDirectory()) dirs.push(e.name);
        else if (withFiles && st.isFile()) files.push(fileRow(e.name, st));
      } catch { /* 切れたリンク */ }
    }
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  dirs.sort(byName);
  files.sort((a, b) => byName(a.name, b.name));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    dirs,
    ...(withFiles ? { files } : {}),
    truncated: truncated || dirs.length + files.length >= MAX_ENTRIES,
    roots: parent === dir ? await driveRoots() : [],
  };
}
