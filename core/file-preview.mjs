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
  rejectNetworkPath(typeof raw === 'string' ? raw.trim() : raw);
  const ref = fileReference(raw);
  if (!ref) throw new PreviewError('invalid-path', t('filePreview.invalidPath'));
  if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(ref.path)) throw new PreviewError('different-host', t('filePreview.otherOs'));
  if (process.platform === 'win32' && /^\//.test(ref.path)) throw new PreviewError('different-host', t('filePreview.noDrive'));
  if (!path.isAbsolute(ref.path) && (!cwd || !path.isAbsolute(cwd))) throw new PreviewError('cwd-unknown', t('filePreview.relativeUnknownCwd'));
  if (!path.isAbsolute(ref.path)) rejectNetworkPath(cwd);
  return { path: path.resolve(cwd || '.', ref.path), line: ref.line };
}

function rejectNetworkPath(file) {
  if (typeof file === 'string' && /^[\\/]{2}/.test(file)) throw new PreviewError('network-path', t('filePreview.networkPath'));
}

function containsPath(root, file) {
  if (process.platform === 'win32') { root = root.toLowerCase(); file = file.toLowerCase(); }
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** guard は、データ置き場の中の読んでよい場所（uploads）のうち、持ち主の会話にだけ見せるもの（閉じた Chrome の窓の静止画。core/chrome/window-shots.mjs）を断る */
export async function inspectFile(requested, { dataDir, uploadDir, guard = null, confine = null }) {
  // Check before realpath: even resolving a UNC path can send SMB credentials.
  rejectNetworkPath(requested);
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new PreviewError('invalid-path', t('filePreview.invalidPath'));
  const file = await fs.realpath(requested);
  rejectNetworkPath(file);
  rejectNetworkPath(dataDir);
  const protectedDir = await fs.realpath(dataDir);
  rejectNetworkPath(protectedDir);
  if (confine) {
    // 審査モード（ADR 0172）: 作業フォルダーの中だけ。データ置き場の保護はこの外側でかかる（作業フォルダーは置き場の中にある）
    if (!containsPath(await fs.realpath(confine), file)) throw new PreviewError('protected-data', t('filePreview.protectedData'));
  } else if (containsPath(protectedDir, file)) {
    rejectNetworkPath(uploadDir);
    const uploads = uploadDir ? await fs.realpath(uploadDir).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }) : null;
    rejectNetworkPath(uploads);
    if (!uploads || containsPath(uploads, protectedDir) || !containsPath(uploads, file)) {
      throw new PreviewError('protected-data', t('filePreview.protectedData'));
    }
    if (guard) await guard(file);
  }
  const stat = await fs.stat(file);
  if (!stat.isFile() && !stat.isDirectory()) throw new PreviewError('not-file', t('filePreview.notFile'));
  return { file, stat };
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

/** ツリーの 1 フォルダーに一度に出す件数。続きは「さらに N 件を表示」で読む */
export const TREE_PAGE = 200;

const sameName = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const byKindAndName = (a, b) => {
  const aDir = a.isDirectory(), bDir = b.isDirectory();
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
};

/** ツリーの 1 行。フォルダーは中身を読まずに lazy で返す（開いたときに読む。空の [] とは別） */
async function treeEntry(dir, name, access) {
  const id = path.join(dir, name);
  let stat;
  try { ({ stat } = await inspectFile(id, access)); } catch { return null; }
  if (stat.isDirectory()) return { id, name, kind: 'directory', lazy: true };
  if (stat.isFile()) return { id, name, kind: 'file' };
  return null;
}

/**
 * フォルダーの中身を 1 ページ（offset から TREE_PAGE 件）。除外はせず、置いてあるものを全部並べる。
 * pin は開いたファイルへの経路の次の段の名前。ページの外なら末尾に足す（pinned）。
 * more は続きの件数（足した pin は数えない）、next は続きを読むときの offset
 */
async function listEntries(dir, access, { offset = 0, pin = null } = {}) {
  await inspectFile(dir, access);
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(byKindAndName);
  const end = offset + TREE_PAGE;
  const children = (await Promise.all(entries.slice(offset, end).map(entry => treeEntry(dir, entry.name, access)))).filter(Boolean);
  let more = Math.max(0, entries.length - end);
  const at = pin ? entries.findIndex(entry => sameName(entry.name, pin)) : -1;
  if (at >= end) {
    const node = await treeEntry(dir, entries[at].name, access);
    if (node) { node.pinned = true; children.push(node); more--; }
  }
  return { children, more, next: entries.length > end ? end : null };
}

/**
 * プレビューの横のツリー。根から開いたもの（target）の親までの各段は中身を必ず返し、ほかのフォルダーは lazy のまま。
 * 深さの上限は無い（件数は段数 × TREE_PAGE で収まる）。どの段もフォルダー名で除外せず、同じ listEntries で読む
 * （docs/design-system.md「右パネル」のツリー）
 */
async function buildTree(rootPath, target, access) {
  const root = { id: rootPath, name: path.basename(rootPath) || rootPath, kind: 'directory', open: true };
  const rel = path.relative(rootPath, target);
  const steps = rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel.split(path.sep) : [];
  let node = root;
  for (let i = 0; ; i++) {
    const pin = steps[i] ?? null;
    let listing;
    try {
      listing = await listEntries(node.id, access, { pin });
    } catch {
      if (node === root) root.children = [];   // 根が読めない。ほかの段は lazy のまま残し、開いたときに失敗を示す
      break;
    }
    delete node.lazy;
    Object.assign(node, listing);
    if (!pin || i === steps.length - 1) break;   // pin が開いたもの自身。フォルダーでも中身は開いたときに読む
    const next = listing.children.find(child => sameName(child.name, pin));
    if (!next || next.kind !== 'directory') break;
    node = next;
  }
  return [root];
}

/**
 * ツリーの 1 フォルダーの続き（開いたとき・「さらに表示」）。読める範囲は /file-preview でフォルダーを開くのと同じ
 * （inspectFile）。roots の外のファイルを開くとツリーの根はそのフォルダーになるので、roots では絞らない
 */
export async function listTreeFolder(requested, { access, offset = 0 } = {}) {
  const { stat } = await inspectFile(requested, access);
  if (!stat.isDirectory()) throw new PreviewError('not-directory', t('filePreview.notDirectory'));
  const dir = path.resolve(requested);
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  return { path: dir, ...await listEntries(dir, access, { offset: start }) };
}

export async function readPreview(requested, roots, { access, resource = false } = {}) {
  const { file, stat } = await inspectFile(requested, access);
  // Roots select the tree shown beside the preview; they never grant access.
  const resolvedRoots = resource ? [] : await Promise.all(roots.filter(Boolean).map(async root => {
    try { return (await inspectFile(root, access)).file; } catch { return null; }
  }));
  const matchingRoots = (resolvedRoots || []).filter(root => {
    if (!root) return false;
    const rel = path.relative(root, file);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  });
  const treeRoot = matchingRoots.sort((a, b) => b.length - a.length)[0] || (stat.isDirectory() ? file : path.dirname(file));
  const tree = resource ? [] : await buildTree(treeRoot, file, access);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(file, { withFileTypes: true }).catch(() => []);
    const items = [];
    for (const entry of entries) {
      const entryPath = path.join(file, entry.name);
      let isDir = entry.isDirectory();
      let isFil = entry.isFile();
      let entryStat = null;
      try {
        ({ stat: entryStat } = await inspectFile(entryPath, access));
        isDir = entryStat.isDirectory();
        isFil = entryStat.isFile();
      } catch { continue; }
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
