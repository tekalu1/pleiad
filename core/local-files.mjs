import path from "node:path";
import { inspectFile, readBounded } from './file-preview.mjs';

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon" };

/** Only authenticated requests reach here. Resolve symlinks before checking roots. */
export async function readLocalFile(requested, roots, { maxBytes = 32 * 1024 * 1024, download = false } = {}) {
  const { file, stat } = await inspectFile(requested, roots);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("unsupported file");
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
  const body = await readBounded(file, maxBytes);
  if (body.length > maxBytes) throw new Error("unsupported file");
  return { body, headers: {
    "content-type": mime ?? "application/octet-stream",
    "content-disposition": `${mime && !download ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  } };
}
