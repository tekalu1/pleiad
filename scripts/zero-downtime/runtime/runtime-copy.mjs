// resources/app を「実行場所」へ写す時間とディスクの量を測る（design.md §3.2）。
//   npm run desktop:pack の後に:
//   node scripts/zero-downtime/runtime/runtime-copy.mjs [--old-revs v0.9.0,v0.8.1,v0.7.2] [--conc 16]
// 測るもの: (1) そのまま写す（同期の逐次・非同期の並列） (2) 中身の SHA-256 の置き場（store）へ置いてハードリンクで app\<版> を組む
//          (3) 次の版（--old-revs の各タグの core/web/desktop/bin に差し替えた版）を、1 版目の store を使って組む／全部写す
//          (4) 組んだ版の削除。ディスクは statfs の空きの差（他のプロセスの影響が入る）と、一意な中身のクラスター丸めの合計で見る
// 写し先は %LOCALAPPDATA%\zdprobe-copytest（実行場所と同じボリューム。ハードリンクは同じボリュームの中だけ）。終わりに消す。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ms, round, mb, sizeOnDisk, rmTree, pool, walk, buildViaStore, makeVariant } from './tree-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const oldRevs = arg('--old-revs', 'v0.9.0,v0.8.1,v0.7.2').split(',');
const conc = Number(arg('--conc', 16));
const srcV1 = path.join(root, 'dist-desktop', 'win-unpacked', 'resources', 'app');
const work = path.join(process.env.LOCALAPPDATA, 'zdprobe-copytest');
const srcV2 = path.join(root, 'temporary', 'zdprobe', 'app-v2-src');

const free = () => { const s = fs.statfsSync(work); return s.bavail * s.bsize; };

async function plainCopySync(src, dst) { const t = ms(); fs.cpSync(src, dst, { recursive: true }); return ms() - t; }
async function plainCopyAsync(src, dst, n) {
  const files = walk(src); const t = ms();
  for (const d of new Set(files.map(f => path.dirname(path.join(dst, f.rel))))) fs.mkdirSync(d, { recursive: true });
  await pool(files, n, f => fsp.copyFile(path.join(src, f.rel), path.join(dst, f.rel)));
  return ms() - t;
}

async function readTree(dir, n) { const files = walk(dir); const t = ms(); await pool(files, n, f => fsp.readFile(path.join(dir, f.rel))); return round(ms() - t); }

/** 書いたばかりのファイルを最初に読むときの遅さ（ウイルス対策の検査など）。新しく写した木を、すぐ 1 回目、続けて 2 回目に全部読んで比べる */
async function freshReadProbe(n) {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const d = path.join(work, `fresh-${i}`);
    fs.cpSync(srcV1, d, { recursive: true });
    const files = walk(d);
    const read = async () => { const t = ms(); await pool(files, n, f => fsp.readFile(path.join(d, f.rel))); return round(ms() - t); };
    rows.push({ firstReadMs: await read(), secondReadMs: await read() });
    rmTree(d);
  }
  return rows;
}

const result = { node: process.version, conc };
fs.mkdirSync(work, { recursive: true });
try {
  const v1 = walk(srcV1);
  Object.assign(result, { srcFiles: v1.length, srcMB: mb(v1.reduce((a, f) => a + f.size, 0)), srcOnDiskMB: mb(v1.reduce((a, f) => a + sizeOnDisk(f.size), 0)) });

  result.plainCopy = { syncSequentialMs: [], asyncParallelMs: [] };
  for (let i = 0; i < 3; i++) {
    const d = path.join(work, `plain-${i}`);
    result.plainCopy.syncSequentialMs.push(round(await plainCopySync(srcV1, d))); rmTree(d);
    result.plainCopy.asyncParallelMs.push(round(await plainCopyAsync(srcV1, d, conc))); rmTree(d);
  }
  result.freshReadSequential = await freshReadProbe(1);
  result.freshReadParallel = await freshReadProbe(conc);

  // 1 版目を store 方式で（空の store から）。逐次と並列
  result.storeFirstVersion = {};
  for (const n of [1, conc]) {
    const store = path.join(work, `store-${n}`), a1 = path.join(work, `app-${n}`, 'v1');
    const f0 = free();
    const first = await buildViaStore(srcV1, store, a1, n);
    const f1 = free();
    const t = ms(); rmTree(a1); const rmMs = ms() - t;
    result.storeFirstVersion[`conc${n}`] = { ...first, freeDeltaMB: mb(f0 - f1), removeLinkedTreeMs: round(rmMs) };
    rmTree(path.join(work, `app-${n}`)); rmTree(store);
  }

  // 2 版目: 1 版目の store を使って組む（並列）。比べるのは、2 版目を全部写した場合
  result.secondVersion = {};
  for (const oldRev of oldRevs) {
    makeVariant({ root, src: srcV1, dst: srcV2, rev: oldRev });
    const store = path.join(work, 'store-v2'), a1 = path.join(work, 'app-v2', 'v1'), a2 = path.join(work, 'app-v2', 'v2');
    await buildViaStore(srcV1, store, a1, conc);
    await readTree(a1, conc);   // 1 版目を使い終えた状態（全部読んで、検査も済んでいる）にする
    const f1 = free();
    const second = await buildViaStore(srcV2, store, a2, conc);
    const f2 = free();
    // 2 版目の木（変わっていない分は 1 版目の実体へのハードリンク）を、組んだ直後に全部読む。比べるのは、同じ木を新しく写した直後に読む場合
    const linkedReadMs = await readTree(a2, conc);
    const freshDst = path.join(work, 'fresh-v2');
    fs.cpSync(srcV2, freshDst, { recursive: true });
    const freshReadMs = await readTree(freshDst, conc);
    rmTree(freshDst);
    const plainDst = path.join(work, 'plain-v2');
    const plainMs = await plainCopyAsync(srcV2, plainDst, conc);
    const f3 = free();
    result.secondVersion[oldRev] = { ...second, readRightAfterBuildMs: { viaHardlinks: linkedReadMs, freshCopy: freshReadMs }, freeDeltaMB: mb(f1 - f2), plainCopyMs: round(plainMs), plainCopyFreeDeltaMB: mb(f2 - f3) };
    rmTree(path.join(work, 'app-v2')); rmTree(store); rmTree(plainDst); rmTree(srcV2);
  }

  // 組んだ木が壊れていないか（ハードリンク先の中身が元と同じ）と、リンク数
  const store = path.join(work, 'store-check'), a = path.join(work, 'app-check');
  await buildViaStore(srcV1, store, a, conc);
  const sample = walk(a).filter((_, i) => i % 97 === 0);
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  result.sampleIdentical = { checked: sample.length, same: sample.every(f => sha(path.join(a, f.rel)) === sha(path.join(srcV1, f.rel))) };
  result.nlinkExample = fs.statSync(path.join(a, 'package.json')).nlink;
} finally {
  rmTree(work); rmTree(srcV2);
}
console.log(JSON.stringify(result, null, 2));
