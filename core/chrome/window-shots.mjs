// 閉じた Chrome の窓の静止画（uploads/chrome-window/<sha256(会話の id)>/…）の置き場と、見せてよい相手の確かめ（ADR 0115）。
// 置き場の名前が会話の id の hash なので、パスから持ち主の会話が分かる。読み取りの口（/local-file・/file-preview。core/file-preview.mjs の inspectFile）は
// この guard を通し、持ち主の会話を見ている要求（sessionId がその会話）にだけ見せる。会話を消すと置き場も消える（close-window.mjs の forget）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FOLDER = 'chrome-window';
const ownerOf = sessionId => crypto.createHash('sha256').update(sessionId).digest('hex');

/** 会話の静止画の置き場 */
export const windowShotFolder = (dataDir, sessionId) => path.join(dataDir, 'uploads', FOLDER, ownerOf(sessionId));

const sameCase = value => process.platform === 'win32' ? value.toLowerCase() : value;

/**
 * 読み取りの口に渡す確かめ。file は realpath 済みのパス。置き場の外は素通し、置き場の中は持ち主の会話の要求だけ通す
 * （sessionId が無い・別の会話・置き場そのもの（一覧）は断る）。
 * @param deps.uploadDir uploads/ のパス
 * @param deps.sessionId 要求が見ている会話の id（無ければ null）
 * @param deny           断るときに投げる関数（PreviewError を作る）
 */
export function windowShotGuard({ uploadDir, sessionId = null, deny }) {
  return async function guard(file) {
    let root;
    try { root = await fs.realpath(path.join(uploadDir, FOLDER)); } catch { return; }   // 置き場が無ければ中のファイルも無い
    const rel = path.relative(sameCase(root), sameCase(file));
    if (rel === '') throw deny();   // 置き場そのもの（一覧）
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;   // 置き場の外
    const owner = rel.split(path.sep)[0];
    if (typeof sessionId !== 'string' || !sessionId || sameCase(owner) !== ownerOf(sessionId)) throw deny();
  };
}

/** 分岐した会話へ静止画を複製して、新しいパスを返す（元の会話を消すと置き場も消えるので、パスで指したままにしない）。無ければ null */
export async function copyWindowShot({ dataDir, from, to, file }) {
  if (typeof file !== 'string' || !file) return null;
  const source = windowShotFolder(dataDir, from);
  const rel = path.relative(sameCase(path.resolve(source)), sameCase(path.resolve(file)));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.includes(path.sep)) return null;   // 元の置き場の直下のファイルだけ
  const dir = windowShotFolder(dataDir, to);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, path.basename(file));
  try { await fs.copyFile(file, target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return target;
}
