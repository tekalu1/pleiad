// runtime-copy.mjs と hardlink-start.mjs が使う、ファイルの木を扱う小さな部品。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const CLUSTER = 4096;
export const ms = () => performance.now();
export const round = x => Math.round(x);
export const sizeOnDisk = bytes => Math.ceil(bytes / CLUSTER) * CLUSTER;
export const mb = b => Math.round(b / 1024 / 1024 * 10) / 10;
export const rmTree = p => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });

export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; await fn(items[k], k); } }));
}
export function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push({ rel: path.relative(base, p), size: fs.statSync(p).size });
  }
  return out;
}
/** store（<store>/<sha256>）へ置き、app\<版> をハードリンクで組む。戻り値は段ごとの時間と、store に増えた分 */
export async function buildViaStore(src, store, appDir, n) {
  fs.mkdirSync(store, { recursive: true });
  const files = walk(src);
  let t = ms();
  const hashes = new Array(files.length);
  await pool(files, n, async (f, k) => { hashes[k] = crypto.createHash('sha256').update(await fsp.readFile(path.join(src, f.rel))).digest('hex'); });
  const hashMs = ms() - t;
  t = ms();
  const added = new Map();
  const todo = files.map((f, k) => ({ f, h: hashes[k] })).filter(({ h }) => !fs.existsSync(path.join(store, h)) && !added.has(h) && added.set(h, true));
  await pool(todo, n, async ({ f, h }) => { const tmp = path.join(store, `${h}.tmp`); await fsp.copyFile(path.join(src, f.rel), tmp); await fsp.rename(tmp, path.join(store, h)); });
  const copyMs = ms() - t;
  t = ms();
  for (const d of new Set(files.map(f => path.dirname(path.join(appDir, f.rel))))) fs.mkdirSync(d, { recursive: true });
  await pool(files, n, async (f, k) => { await fsp.link(path.join(store, hashes[k]), path.join(appDir, f.rel)); });
  const linkMs = ms() - t;
  const newBytes = todo.reduce((a, { f }) => a + f.size, 0);
  return { files: files.length, uniqueNew: todo.length, hashMs: round(hashMs), copyToStoreMs: round(copyMs), linkMs: round(linkMs), totalMs: round(hashMs + copyMs + linkMs),
    newLogicalMB: mb(newBytes), newOnDiskMB: mb(todo.reduce((a, { f }) => a + sizeOnDisk(f.size), 0)), hashes: new Set(hashes).size };
}


/** 次の版の元: src の写しに、旧タグ rev の core/web/desktop/bin（git archive）を重ねる。package.json の version だけ変える */
export function makeVariant({ root, src, dst, rev }) {
  rmTree(dst); fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  for (const d of ['core', 'web', 'desktop', 'bin']) rmTree(path.join(dst, d));
  const tar = path.join(os.tmpdir(), 'zdprobe-old.tar');
  const a = spawnSync('git', ['-C', root, 'archive', '--format=tar', '-o', tar, rev, 'core', 'web', 'desktop', 'bin'], { stdio: 'inherit' });
  if (a.status !== 0) throw new Error('git archive failed');
  // PATH 上の GNU tar は C: をホスト名と読み、\ も崩すので、Windows 付属の bsdtar を使う
  const x = spawnSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', tar, '-C', dst], { stdio: 'inherit' });
  fs.rmSync(tar, { force: true });
  if (x.status !== 0) throw new Error('tar failed');
  const pkgFile = path.join(dst, 'package.json');
  fs.writeFileSync(pkgFile, fs.readFileSync(pkgFile, 'utf8').replace(/"version": "[^"]+"/, '"version": "0.0.0-v2probe"'));
}
