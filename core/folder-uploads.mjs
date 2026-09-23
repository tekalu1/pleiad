// 手元のフォルダーをホストへ送る（docs/remote.md §8.1、issue #15）。WS の upload* コマンドの中身。
//
// リモート専用ではない一般の口（ローカルの画面から使ってもよい）。流れ:
//   uploadCheck  { name, dest?, paths }            送り先を決める前の下見（既定の送り先・既にあるか・上書きする件数）
//   uploadStart  { name, dest?, files, overwrite } 置き場を用意して uploadId と受け取り済みの位置を返す。同じ name・files の途中があれば続きから
//   uploadChunk  { uploadId, file, offset, data }  base64 の断片（512 KiB）を置く
//   uploadFinish { uploadId }                      大きさを確かめて送り先へ移す（新しいフォルダーは rename 一回）
//   uploadCancel { uploadId }                      途中のものを捨てる
//
// 置き場: <root>/.partial/<uploadId>/{manifest.json, tree/<相対パス>}。root の既定は ~/Pleiad/uploads。
// 受け取った位置は tree に置いたファイルの大きさそのもの（書き込みは先頭から順に、位置を指定して行う）。
// manifest.json には送る一覧・送り先・最後に触った時刻と、受け取った位置の写しを残す（写しは間引いて書く）。
// サーバーを起動し直しても、端末がつなぎ直しても、uploadStart をもう一度呼べば置いたファイルの大きさから続けられる。
//
// パスは信用しない: 相対パスだけ。`..`・`.`・空の要素・絶対パス・ドライブ名・`:`（NTFS の代替ストリーム）・
// Windows で使えない字と予約名（CON・NUL・COM1 など）・末尾の `.` と空白を拒否する。区切りは `/` に揃える。
// 大文字小文字だけが違う名前、ファイルとフォルダーが同じ名前になる組も拒否する（Windows・macOS で重なるため）。
// 送り先: 置き場（root）の中なら新しいフォルダーを作ってよい。置き場の外は**既にあるフォルダー**だけで、必ず確認を経る。
// 既にあるフォルダー（置き場の中でも空でないもの）へ入れるときは overwrite: true（画面の確認）が要る。
// 送り先の中のリンク（シンボリックリンク・ジャンクション）を辿って外へ書かない（親フォルダーの実体を確かめる）。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.mjs';

export const CHUNK_BYTES = 512 * 1024;
export const DEFAULT_LIMITS = Object.freeze({
  files: 100_000,                  // 1 回に送るファイルの数
  totalBytes: 32 * 1024 ** 3,      // 合計の大きさ
  fileBytes: 16 * 1024 ** 3,       // 1 ファイルの大きさ
  pathLength: 1024,                // 相対パスの長さ（字数）
  partials: 20,                    // 同時に置いておける途中のもの（超えたら古いものから捨てる）
  keepMs: 7 * 24 * 60 * 60_000,    // 途中のものを残す期間
  spareBytes: 64 * 1024 ** 2,      // 空き容量の余裕
});
const MANIFEST_EVERY_MS = 30_000;
// 断片は 512 KiB で送る約束だが、受け側は倍まで受ける（画面の版の違いに備える）
const MAX_CHUNK_RAW = CHUNK_BYTES * 2;
const MAX_CHUNK_B64 = Math.ceil(MAX_CHUNK_RAW / 3) * 4;
const ID = /^[a-f0-9]{32}$/;
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f\u007f]/;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.[^.]*)?$/i;
const PARTIAL = '.partial';

/** エラー。code は画面が分けるための短い名前 */
export class UploadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
// i18n-dynamic: upload.
const fail = (code, key, vars) => { throw new UploadError(code, t(`upload.${key}`, vars)); };

/** 1 つの名前（フォルダー名・パスの 1 要素）として使えるか */
export function validSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..'
    && !BAD_CHARS.test(s) && !/[. ]$/.test(s) && !RESERVED.test(s);
}

/** 送るフォルダーの名前（1 要素） */
export function normalizeName(name) {
  const s = typeof name === 'string' ? name.normalize('NFC') : '';
  if (!validSegment(s)) fail('invalidName', 'invalidName');
  return s;
}

/** 相対パスを 'a/b/c' の形に揃える。使えない形なら null */
export function normalizeRelPath(p, maxLength = DEFAULT_LIMITS.pathLength) {
  if (typeof p !== 'string' || !p || p.length > maxLength) return null;
  const s = p.normalize('NFC').replaceAll('\\', '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/');
  if (!parts.every(validSegment)) return null;
  return parts.join('/');
}

/** a が b の中（同じ場所は含まない）か。Windows は大文字小文字を区別しない */
export function isInside(parent, child) {
  const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(fold(parent), fold(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 送る一覧を確かめて揃える。[{ path, size, mtime }] */
export function normalizeFiles(files, limits = DEFAULT_LIMITS) {
  if (!Array.isArray(files) || !files.length) fail('noFiles', 'noFiles');
  if (files.length > limits.files) fail('tooManyFiles', 'tooManyFiles', { max: limits.files.toLocaleString('en-US') });
  const seen = new Map();
  const out = [];
  let total = 0;
  for (const f of files) {
    const rel = normalizeRelPath(f?.path, limits.pathLength);
    if (!rel) fail('invalidPath', 'invalidPath', { path: String(f?.path ?? '').slice(0, 200) });
    const size = f.size;
    if (!Number.isSafeInteger(size) || size < 0) fail('invalidPath', 'invalidSize', { path: rel });
    if (size > limits.fileBytes) fail('tooLarge', 'fileTooLarge', { path: rel });
    total += size;
    const key = rel.toLowerCase();
    if (seen.has(key)) fail('duplicatePath', 'duplicatePath', { path: rel });
    seen.set(key, 'file');
    out.push({ path: rel, size, mtime: Number.isFinite(f.mtime) ? Math.trunc(f.mtime) : 0 });
  }
  if (total > limits.totalBytes) fail('tooLarge', 'totalTooLarge');
  // ファイルとフォルダーが同じ名前（a と a/b）
  for (const f of out) {
    const parts = f.path.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join('/')) === 'file') fail('duplicatePath', 'fileDirClash', { path: f.path });
    }
  }
  return { files: out, total };
}

/** 同じフォルダーの同じ中身か（続きから送る鍵）。uploadId になる */
export function uploadKey(name, files) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify([name, files.map((f) => [f.path, f.size, f.mtime])]));
  return h.digest('hex').slice(0, 32);
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

async function realpathOfNearest(p) {
  // 無いパスは、在る先祖の実体の下にくっつけて考える（先祖がリンクでも外へ出たことを見抜く）
  let cur = p;
  const rest = [];
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest.reverse()); }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const up = path.dirname(cur);
      if (up === cur) throw e;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/**
 * @param {object} o
 * @param {string} [o.root] 置き場。既定は ~/Pleiad/uploads
 * @param {object} [o.limits] DEFAULT_LIMITS の一部を差し替える（テスト）
 * @param {() => number} [o.now]
 */
export function createFolderUploads({ root = path.join(os.homedir(), 'Pleiad', 'uploads'), limits: over = {}, now = Date.now } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...over };
  root = path.resolve(root);
  const partialDir = path.join(root, PARTIAL);
  const live = new Map();        // uploadId -> { id, dir, meta, received, lock, savedAt }
  let rootReal = null;

  async function ensureRoot() {
    await fs.mkdir(partialDir, { recursive: true });
    rootReal = await fs.realpath(root);
    return rootReal;
  }

  /**
   * 送り先の下見。dest が無ければ root/<name>（あれば -2, -3…）。
   * 返すもの: { dest, root, exists, inRoot, empty, conflicts, sample, needsConfirm }
   */
  async function plan({ name, dest, paths = [] }) {
    const rr = await ensureRoot();
    let target;
    if (dest == null || dest === '') {
      target = path.join(rr, name);
      for (let i = 2; await exists(target); i++) {
        if (i > 999) fail('invalidDest', 'destInvalid');
        target = path.join(rr, `${name}-${i}`);
      }
      return { dest: target, root: rr, exists: false, inRoot: true, empty: true, conflicts: 0, sample: [], needsConfirm: false };
    }
    if (typeof dest !== 'string' || dest.length > 4096 || dest.includes('\0') || !path.isAbsolute(dest.trim())) fail('invalidDest', 'destInvalid');
    const resolved = path.resolve(dest.trim());
    let st = null;
    try { st = await fs.stat(resolved); } catch (e) { if (e.code !== 'ENOENT') fail('invalidDest', 'destInvalid'); }
    if (st && !st.isDirectory()) fail('invalidDest', 'destNotFolder', { path: resolved });
    const real = st ? await fs.realpath(resolved) : await realpathOfNearest(resolved);
    const partialReal = path.join(rr, PARTIAL);
    // 置き場そのもの・途中の置き場・ドライブの根には入れない
    if (real === rr || path.parse(real).root === real || real === partialReal || isInside(partialReal, real)) fail('invalidDest', 'destInvalid');
    const inRoot = isInside(rr, real);
    if (!st) {
      if (!inRoot) fail('destOutside', 'destOutside', { path: resolved, root: rr });
      return { dest: real, root: rr, exists: false, inRoot, empty: true, conflicts: 0, sample: [], needsConfirm: false };
    }
    const entries = await fs.readdir(real);
    let conflicts = 0;
    const sample = [];
    await mapLimit(paths, 16, async (p) => {
      if (await exists(path.join(real, ...p.split('/')))) { conflicts++; if (sample.length < 20) sample.push(p); }
    });
    sample.sort();
    const empty = entries.length === 0;
    return { dest: real, root: rr, exists: true, inRoot, empty, conflicts, sample, needsConfirm: !empty || !inRoot };
  }

  async function check({ name, dest, paths }) {
    const n = normalizeName(name);
    const list = Array.isArray(paths) ? paths.slice(0, limits.files).map((p) => normalizeRelPath(p, limits.pathLength)).filter(Boolean) : [];
    return plan({ name: n, dest, paths: list });
  }

  const manifestFile = (dir) => path.join(dir, 'manifest.json');
  const stagedPath = (u, rel) => {
    const p = path.join(u.dir, 'tree', ...rel.split('/'));
    if (!isInside(path.join(u.dir, 'tree'), p)) fail('invalidPath', 'invalidPath', { path: rel });
    return p;
  };

  async function saveManifest(u) {
    u.meta.updatedAt = now();
    u.meta.received = u.received;
    u.savedAt = now();
    const tmp = manifestFile(u.dir) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(u.meta));
    await fs.rename(tmp, manifestFile(u.dir));
  }

  /** 置き場の途中のものを読む（覚えていなければ manifest と置いたファイルの大きさから） */
  async function load(id) {
    if (typeof id !== 'string' || !ID.test(id)) fail('unknownUpload', 'unknownUpload');
    if (live.has(id)) return live.get(id);
    await ensureRoot();
    const dir = path.join(partialDir, id);
    let meta;
    try { meta = JSON.parse(await fs.readFile(manifestFile(dir), 'utf8')); } catch { fail('unknownUpload', 'unknownUpload'); }
    const u = { id, dir, meta, received: [], lock: Promise.resolve(), savedAt: 0 };
    u.received = await mapLimit(meta.files, 16, async (f) => {
      try { return Math.min((await fs.stat(stagedPath(u, f.path))).size, f.size); } catch { return 0; }
    });
    if (live.has(id)) return live.get(id);
    live.set(id, u);
    return u;
  }

  /** 同じ途中のものへの操作は順に行う（同じファイルの断片が行き違わないように） */
  function serial(u, fn) {
    const run = u.lock.then(fn, fn);
    u.lock = run.catch(() => {});
    return run;
  }

  async function prune(keepId) {
    let names = [];
    try { names = (await fs.readdir(partialDir)).filter((n) => ID.test(n) && n !== keepId); } catch { return; }
    if (names.length < limits.partials) return;
    const ages = await Promise.all(names.map(async (n) => {
      try { return { n, at: (await fs.stat(path.join(partialDir, n))).mtimeMs }; } catch { return { n, at: 0 }; }
    }));
    ages.sort((a, b) => a.at - b.at);
    for (const { n } of ages.slice(0, names.length - limits.partials + 1)) await discard(n);
  }

  async function discard(id) {
    live.delete(id);
    await fs.rm(path.join(partialDir, id), { recursive: true, force: true, maxRetries: 3 });
  }

  async function freeBytes(dir) {
    if (typeof fs.statfs !== 'function') return Infinity;
    try { const s = await fs.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
  }

  async function start({ name, dest, files, overwrite = false }) {
    const n = normalizeName(name);
    const { files: list, total } = normalizeFiles(files, limits);
    const p = await plan({ name: n, dest, paths: list.map((f) => f.path) });
    if (p.needsConfirm && overwrite !== true) return { needsConfirm: true, ...p };
    const id = uploadKey(n, list);
    let u = live.get(id);
    if (!u && await exists(manifestFile(path.join(partialDir, id)))) u = await load(id).catch(() => null);
    const resumed = Boolean(u);
    if (!u) {
      await prune(id);
      const dir = path.join(partialDir, id);
      await fs.mkdir(path.join(dir, 'tree'), { recursive: true });
      u = { id, dir, meta: { v: 1, id, name: n, files: list, total, createdAt: now() }, received: list.map(() => 0), lock: Promise.resolve(), savedAt: 0 };
      live.set(id, u);
    }
    const have = u.received.reduce((a, b) => a + b, 0);
    if (total - have + limits.spareBytes > await freeBytes(root)) fail('noSpace', 'noSpace');
    // 送り先・上書きの確認は今回の指定に合わせる（置いたファイルは送り先に依らない）
    u.meta.dest = p.dest;
    u.meta.overwrite = overwrite === true;
    await serial(u, () => saveManifest(u));
    return { uploadId: id, dest: p.dest, exists: p.exists, inRoot: p.inRoot, received: u.received, resumed, chunkBytes: CHUNK_BYTES };
  }

  async function chunk({ uploadId, file, offset, data }) {
    const u = await load(uploadId);
    const f = Number.isInteger(file) ? u.meta.files[file] : null;
    if (!f || !Number.isSafeInteger(offset) || offset < 0 || typeof data !== 'string' || data.length > MAX_CHUNK_B64) fail('badChunk', 'badChunk');
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_CHUNK_RAW || offset + buf.length > f.size) fail('badChunk', 'badChunk');
    return serial(u, async () => {
      if (!live.has(u.id)) fail('unknownUpload', 'unknownUpload');
      const have = u.received[file];
      // 抜けがある（先の断片が先に来た）なら書かずに今の位置を返す。画面はそこから送り直す
      if (offset > have) return { received: have };
      const end = offset + buf.length;
      if (end > have) {
        const target = stagedPath(u, f.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const h = await fs.open(target, have === 0 ? 'w' : 'r+');
        try { await h.write(buf, 0, buf.length, offset); } finally { await h.close(); }
        u.received[file] = end;
      }
      if (now() - u.savedAt > MANIFEST_EVERY_MS) await saveManifest(u);
      return { received: u.received[file] };
    });
  }

  async function moveFile(from, to) {
    try { await fs.rename(from, to); }
    catch (e) {
      if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      await fs.copyFile(from, to);
      await fs.rm(from, { force: true });
    }
  }

  async function finish({ uploadId }) {
    const u = await load(uploadId);
    return serial(u, async () => {
      if (!live.has(u.id)) fail('unknownUpload', 'unknownUpload');
      const { files, name } = u.meta;
      let missing = 0;
      await mapLimit(files, 16, async (f, i) => {
        const p = stagedPath(u, f.path);
        if (f.size === 0 && u.received[i] === 0) {
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, '');
          return;
        }
        let size = -1;
        try { size = (await fs.stat(p)).size; } catch { /* 無い */ }
        if (size !== f.size) { missing++; u.received[i] = Math.max(0, Math.min(size, f.size)); }
      });
      if (missing) fail('incomplete', 'incomplete', { count: missing });
      const p = await plan({ name, dest: u.meta.dest, paths: files.map((f) => f.path) });
      if (p.needsConfirm && !u.meta.overwrite) return { needsConfirm: true, ...p };
      const tree = path.join(u.dir, 'tree');
      let merged = p.exists;
      if (!p.exists) {
        await fs.mkdir(path.dirname(p.dest), { recursive: true });
        try { await fs.rename(tree, p.dest); }
        catch (e) {
          // 別のドライブ・行き違いで先にできた、など。中へ 1 つずつ移す
          if (!['EXDEV', 'EPERM', 'EACCES', 'EEXIST', 'ENOTEMPTY', 'EBUSY'].includes(e.code)) throw e;
          await fs.mkdir(p.dest, { recursive: true });
          merged = true;
        }
      }
      if (merged) {
        const destReal = await fs.realpath(p.dest);
        for (const f of files) {
          const to = path.join(destReal, ...f.path.split('/'));
          const parent = path.dirname(to);
          await fs.mkdir(parent, { recursive: true });
          // 送り先の中のリンクを辿って外へ出ない
          const parentReal = await fs.realpath(parent);
          if (parentReal !== destReal && !isInside(destReal, parentReal)) fail('escape', 'escape', { path: f.path });
          const st = await fs.lstat(to).catch(() => null);
          if (st?.isDirectory()) fail('conflict', 'conflictDir', { path: f.path });
          await moveFile(stagedPath(u, f.path), path.join(parentReal, path.basename(to)));
        }
      }
      await discard(u.id);
      return { dest: p.dest, files: files.length, bytes: u.meta.total };
    });
  }

  async function cancel({ uploadId }) {
    if (typeof uploadId !== 'string' || !ID.test(uploadId)) fail('unknownUpload', 'unknownUpload');
    const u = live.get(uploadId);
    if (u) await serial(u, () => discard(uploadId));
    else await discard(uploadId);
    return { cancelled: true };
  }

  /** 古い途中のもの（keepMs を過ぎた）を捨てる。起動時と 1 日ごと */
  async function sweep() {
    let names = [];
    try { names = await fs.readdir(partialDir); } catch { return 0; }
    let removed = 0;
    for (const n of names) {
      if (live.has(n)) continue;
      const dir = path.join(partialDir, n);
      let at = 0;
      try { at = JSON.parse(await fs.readFile(manifestFile(dir), 'utf8')).updatedAt ?? 0; } catch { /* manifest が無い・壊れている */ }
      if (!at) { try { at = (await fs.stat(dir)).mtimeMs; } catch { continue; } }
      if (now() - at > limits.keepMs) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); removed++; }
    }
    return removed;
  }

  return { root, check, start, chunk, finish, cancel, sweep, limits };
}
