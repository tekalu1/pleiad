// 生き残りの試験で、起動された側が回し続ける小さなプロセス。
//   node heartbeat.mjs <出力先ディレクトリ> <ラベル>
// 200ms ごとに <出力先>/<ラベル>.hb へ {t, pid} を 1 行追記する（t は epoch ms）。
// 最初の 1 行に自分の Job Object の所属を書く（環境変数 ZD_KOFFI が koffi のディレクトリを指すとき）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [dir, label] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${label}.hb`);
const write = obj => fs.appendFileSync(file, JSON.stringify(obj) + '\n');

let job = null;
try {
  const req = createRequire(import.meta.url);
  const koffi = req(process.env.ZD_KOFFI);
  job = req('./job-info.cjs').jobInfo(koffi);
} catch (e) { job = { error: String(e?.message ?? e) }; }
write({ kind: 'start', t: Date.now(), pid: process.pid, exe: process.execPath, job });
setInterval(() => write({ t: Date.now(), pid: process.pid }), 200);
