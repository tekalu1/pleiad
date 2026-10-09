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

const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const sameDir = (a, b) => fold(a) === fold(b);
function within(root, file) {
  const rel = path.relative(fold(root), fold(file));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
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
 * @param {{ fallback?: string, files?: boolean, confine?: string }} [o] files: ファイルも返す（件数の上限はフォルダーと合わせて MAX_ENTRIES）。
 *   confine: このフォルダーの中だけ開く（審査モード。ADR 0172）。外は断る。このフォルダーが一番上で、parent・roots は返さない
 * @returns {Promise<{ path: string, parent: string|null, dirs: string[], files?: Array<{ name: string, size: number, mtime: number }>, truncated: boolean, roots: string[] }>}
 */
export async function listDirs(requested, { fallback, files: withFiles = false, confine = null } = {}) {
  if (requested != null && typeof requested !== "string") throw new Error(t("dirs.invalidPath"));
  if (requested && (requested.length > 8192 || requested.includes("\0"))) throw new Error(t("dirs.invalidPath"));
  const dir = path.resolve(String(requested || fallback || confine || os.homedir()).trim());
  const top = confine ? await fs.realpath(confine) : null;
  if (top) {
    const real = await fs.realpath(dir).catch(() => null);
    if (!real || !within(top, real)) throw Object.assign(new Error(reason({ code: "EACCES" }, dir)), { code: "EACCES" });
  }
  let entries;
  try {
    if (!(await fs.stat(dir)).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 理由の種類（ENOENT など）も返す。入力欄の作業ディレクトリの面が「無い」ときだけ、あるところまで上へたどる
    throw Object.assign(new Error(reason(err, dir)), typeof err?.code === "string" ? { code: err.code } : {});
  }
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
  const atTop = top ? sameDir(top, await fs.realpath(dir)) : parent === dir;
  return {
    path: dir,
    parent: atTop ? null : parent,
    dirs,
    ...(withFiles ? { files } : {}),
    truncated: truncated || dirs.length + files.length >= MAX_ENTRIES,
    roots: !top && parent === dir ? await driveRoots() : [],
  };
}
