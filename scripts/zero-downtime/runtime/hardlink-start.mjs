// 実行場所をハードリンクで組んだとき、次の版のサーバーの初回起動が、新しく写した場合より速いかを測る。
//   npm run desktop:pack の後に:
//   node scripts/zero-downtime/runtime/hardlink-start.mjs --data <実データの写し> [--rev v0.9.0] [--conc 16] [--runs 3]
// 流れ: 1 版目を store 方式で組む → その木でサーバーを起動して「使っている版」の状態にする（ファイルを読み終えて、検査も済む）
//       → 2 版目（--rev の core/web/desktop/bin に差し替えた版）を、1 版目の store を使って組む → その木から直ちにサーバーを起動（ハードリンク）
//       対照: 2 版目を普通に写した直後に起動（server-startup.mjs --fresh-copy-from と同じ）
// 起動時間の測り方は server-startup.mjs（スクリプトを呼んで JSON を受ける）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildViaStore, makeVariant, rmTree } from './tree-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const data = path.resolve(arg('--data'));
const rev = arg('--rev', 'v0.9.0');
const conc = Number(arg('--conc', 16));
const runs = arg('--runs', '3');
const srcV1 = path.join(root, 'dist-desktop', 'win-unpacked', 'resources', 'app');
const srcV2 = path.join(root, 'temporary', 'zdprobe', 'app-v2-src');
const work = path.join(process.env.LOCALAPPDATA, 'zdprobe-copytest');
const startup = path.join(here, 'server-startup.mjs');

const measure = (serverRoot, n, extra = []) => {
  const r = spawnSync(process.execPath, [startup, '--data', data, '--runs', String(n), '--handovers', '0', '--server-root', serverRoot, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return JSON.parse(r.stdout).runs.map(x => ({ spawnToLockMs: x.spawnToLockMs, lockToListenMs: x.lockToListenMs, spawnToListenMs: x.spawnToListenMs, spawnToWsReadyMs: x.spawnToWsReadyMs }));
};

const out = { rev };
fs.mkdirSync(work, { recursive: true });
try {
  const store = path.join(work, 'store');
  const v1 = path.join(work, 'app', 'v1'), v2 = path.join(work, 'app', 'v2');
  out.buildV1 = await buildViaStore(srcV1, store, v1, conc);
  out.runV1 = measure(v1, 2);   // 使っている版（S1）の状態にする
  makeVariant({ root, src: srcV1, dst: srcV2, rev });
  out.buildV2 = await buildViaStore(srcV2, store, v2, conc);
  out.v2ViaHardlinksRightAfterBuild = measure(v2, Number(runs));
  // 対照: 2 版目を新しく写した直後（ハードリンクなし）。実行ごとに新しい写し
  out.v2FreshCopyRightAfterCopy = JSON.parse(spawnSync(process.execPath, [startup, '--data', data, '--runs', runs, '--handovers', '0', '--fresh-copy-from', srcV2], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout).runs
    .map(x => ({ copyMs: x.freshCopyMs, spawnToLockMs: x.spawnToLockMs, lockToListenMs: x.lockToListenMs, spawnToListenMs: x.spawnToListenMs, spawnToWsReadyMs: x.spawnToWsReadyMs }));
} finally { rmTree(work); rmTree(srcV2); }
console.log(JSON.stringify(out, null, 2));
