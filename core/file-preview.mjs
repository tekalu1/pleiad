import fs from 'node:fs/promises';
import path from 'node:path';
import { fileReference } from '../web/file-reference.mjs';
import { t } from './i18n.mjs';

const TEXT_LIMIT = 8 * 1024 * 1024;
export const FILE_LIMIT = 32 * 1024 * 1024;
const IMAGES = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.ico':'image/x-icon', '.svg':'image/svg+xml' };
const TEXT = new Set('md markdown mdx txt text log csv tsv html htm css js mjs cjs jsx ts tsx json jsonc yaml yml toml xml svg py rb rs go java c h cpp hpp cs sh bash zsh ps1 sql ini cfg conf env gitignore dockerfile makefile'.split(' '));
export class PreviewError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function cwdAt(meta, at) {
  const changes = (meta.history ?? []).filter(h => h.field === 'cwd');
  if (!changes.length) return meta.cwd;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) throw new PreviewError('cwd-unknown', t('filePreview.cwdAtUnknown'));
  let cwd = meta.cwd;
  for (const change of changes.slice().reverse()) if (Date.parse(change.at) > time) cwd = change.from;
  return cwd;
}

export function resolveReference(raw, cwd) {
  const ref = fileReference(raw);
  if (!ref) throw new PreviewError('invalid-path', t('filePreview.invalidPath'));
  if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(ref.path)) throw new PreviewError('different-host', t('filePreview.otherOs'));
  if (process.platform === 'win32' && /^\//.test(ref.path)) throw new PreviewError('different-host', t('filePreview.noDrive'));
  if (!path.isAbsolute(ref.path) && (!cwd || !path.isAbsolute(cwd))) throw new PreviewError('cwd-unknown', t('filePreview.relativeUnknownCwd'));
  return { path: path.resolve(cwd || '.', ref.path), line: ref.line };
}

export async function inspectFile(requested, roots) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested) || /^[\\/]{2}/.test(requested)) throw new PreviewError('invalid-path', t('filePreview.invalidPath'));
  const file = await fs.realpath(requested);
  const resolvedRoots = await Promise.all(roots.filter(Boolean).map(r => fs.realpath(r).catch(() => null)));
  if (!resolvedRoots.some(root => {
    if (!root) return false;
    const rel = path.relative(root, file);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  })) throw new PreviewError('outside-workspace', t('filePreview.outsideWorkspace'));
  const stat = await fs.stat(file);
  if (!stat.isFile() && !stat.isDirectory()) throw new PreviewError('not-file', t('filePreview.notFile'));
  return { file, stat, resolvedRoots };
}

export async function readBounded(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const chunks = []; let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); total += bytesRead;
    }
    if (total > maxBytes) throw new PreviewError('too-large', t('filePreview.tooLarge'));
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'temporary', '.turbo', '.next', '.cache', 'dist', 'build']);

async function buildTree(rootPath, maxDepth = 4, maxEntries = 1000) {
  let count = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth || count >= maxEntries) return [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    const children = [];
    for (const entry of entries) {
      if (count >= maxEntries) break;
      if (IGNORED_NAMES.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFil = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const s = await fs.stat(fullPath);
          isDir = s.isDirectory();
          isFil = s.isFile();
        } catch {
          continue;
        }
      }

      if (!isDir && !isFil) continue;
      count++;

      const node = {
        id: fullPath,
        name: entry.name,
        kind: isDir ? 'directory' : 'file',
      };

      if (isDir) {
        if (depth < maxDepth) {
          node.children = await walk(fullPath, depth + 1);
        } else {
          node.children = [];
        }
      }

      children.push(node);
    }
    return children;
  }

  const rootChildren = await walk(rootPath, 1);
  return [
    {
      id: rootPath,
      name: path.basename(rootPath) || rootPath,
      kind: 'directory',
      open: true,
      children: rootChildren,
    }
  ];
}

export async function readPreview(requested, roots, { resource = false } = {}) {
  const { file, stat, resolvedRoots } = await inspectFile(requested, roots);
  const matchingRoots = (resolvedRoots || []).filter(root => {
    if (!root) return false;
    const rel = path.relative(root, file);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  });
  const treeRoot = matchingRoots.sort((a, b) => b.length - a.length)[0] || (stat.isDirectory() ? file : path.dirname(file));
  const tree = resource ? [] : await buildTree(treeRoot);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(file, { withFileTypes: true }).catch(() => []);
    const items = [];
    for (const entry of entries) {
      const entryPath = path.join(file, entry.name);
      let isDir = entry.isDirectory();
      let isFil = entry.isFile();
      let entryStat = null;
      try {
        entryStat = await fs.stat(entryPath);
        isDir = entryStat.isDirectory();
        isFil = entryStat.isFile();
      } catch {}
      if (!isDir && !isFil) continue;
      items.push({
        name: entry.name,
        path: entryPath,
        kind: isDir ? 'directory' : 'file',
        size: isDir ? 0 : (entryStat?.size ?? 0),
        modifiedAt: entryStat?.mtime?.toISOString() ?? new Date().toISOString(),
      });
    }
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return {
      path: file,
      name: path.basename(file) || file,
      kind: 'directory',
      size: 0,
      modifiedAt: stat.mtime.toISOString(),
      fetchedAt: new Date().toISOString(),
      downloadable: false,
      items,
      tree,
    };
  }

  const ext = path.extname(file).toLowerCase();
  const result = { path:file, name:path.basename(file), size:stat.size, modifiedAt:stat.mtime.toISOString(), fetchedAt:new Date().toISOString(), downloadable:stat.size <= FILE_LIMIT, tree };
  const mime = IMAGES[ext] || (ext === '.pdf' ? 'application/pdf' : null);
  const textLike = TEXT.has(ext.slice(1)) || (!ext && TEXT.has(path.basename(file).toLowerCase()));
  const limit = resource ? (mime ? 4 * 1024 * 1024 : 512 * 1024) : mime ? FILE_LIMIT : TEXT_LIMIT;
  // i18n-dynamic: filePreview.overLimit
  if (stat.size > limit) return { ...result, kind:'unsupported', reason:t(result.downloadable ? 'filePreview.overLimitDownload' : 'filePreview.overLimitHost', { mb: limit / 1024 / 1024 }) };
  const body = await readBounded(file, limit);
  if (mime) return { ...result, kind:ext === '.pdf' ? 'pdf' : 'image', mime, data:body.toString('base64'), ...(ext === '.svg' ? { text:body.toString('utf8') } : {}) };
  let text;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(body); }
  catch { return { ...result, kind:'unsupported', reason:t('filePreview.unsupportedEncoding') }; }
  if (text.includes('\0') || (!textLike && /[\u0001-\u0008\u000e-\u001f]/.test(text))) return { ...result, kind:'unsupported', reason:t('filePreview.unsupportedType') };
  if (['.docx','.xlsx','.pptx','.zip','.exe','.dll','.7z','.mp4','.mp3'].includes(ext)) return { ...result, kind:'unsupported', reason:t('filePreview.unsupportedType') };
  const kind = ['.md','.markdown'].includes(ext) ? 'markdown' : ['.html','.htm'].includes(ext) ? 'html' : ['.csv','.tsv'].includes(ext) ? 'table' : 'text';
  return { ...result, kind, text, ...(kind === 'table' ? { delimiter:ext === '.tsv' ? '\t' : ',' } : {}) };
}

export function previewFailure(error) {
  if (error instanceof PreviewError) return { code:error.code, message:error.message };
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { code:'not-found', message:t('filePreview.notFound') };
  if (error.code === 'EACCES' || error.code === 'EPERM') return { code:'access-denied', message:t('filePreview.accessDenied') };
  return { code:'read-failed', message:t('filePreview.readFailed') };
}
