// ターンの保持役の起動口（無停止の更新 段階 2 の 2a。core/holder/client.mjs の launchHolder が、サーバーの子でない形で起こす）。
// 環境変数（core/holder/protocol.mjs の ENV）: PLEIAD_HOLDER_DATA（データ置き場。パイプの名前のキー）・PLEIAD_HOLDER_ROOT（版ごとの実行場所の置き場。
// 秘密のファイル run\holder-….json と logs\holder.log の置き場）・PLEIAD_HOLDER_KEY（実行場所の版の名前。あれば使用中の印を付ける）・PLEIAD_HOLDER_APP_VERSION・PLEIAD_HOLDER_IDLE_MS。
// stdio は無いので、標準出力・標準エラー・捕まらなかった例外は logs\holder.log へ書く（core/server-log.mjs。1 MB で .old へ回す）。**子の env・秘密はログに書かない**。
// 同じデータ置き場の保持役が既に居れば（パイプを作れない）、何も書かずに終わる。子が 1 つも生きておらず親が 10 分つながっていなければ終わる。
import path from 'node:path';
import { redirectOutput } from '../server-log.mjs';
import { markRuntimeInUse } from '../runtime-use.mjs';
import { createHolder } from './holder.mjs';
import { ENV, DEFAULT_IDLE_MS, holderPipeName, holderFilePath } from './protocol.mjs';

const dataDir = process.env[ENV.data];
const root = process.env[ENV.root];
if (!dataDir || !root) {
  console.error(`${ENV.data} and ${ENV.root} are required`);
  process.exit(2);
}
const key = process.env[ENV.key] || '';
const idleMs = Number(process.env[ENV.idleMs]);

redirectOutput({ file: path.join(root, 'logs', 'holder.log'), label: 'holder' });
const log = line => console.log(`${new Date().toISOString()} ${line}`);
process.on('unhandledRejection', reason => { console.error(`unhandledRejection: ${reason?.stack ?? reason}`); });

const releaseUse = key ? markRuntimeInUse({ root, key }) : null;
const file = holderFilePath(root, dataDir);
let stopping = false;
const holder = createHolder({
  pipe: holderPipeName(dataDir), file, appVersion: process.env[ENV.appVersion] || '', log,
  idleMs: idleMs > 0 ? idleMs : DEFAULT_IDLE_MS,
  onIdle: () => stop('idle'),
  onShutdown: () => stop('shutdown'),
});

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${reason})`);
  try { await holder.close(); } catch (error) { log(`close failed: ${error?.message ?? error}`); }
  releaseUse?.();
  process.exit(0);
}

process.on('exit', () => holder.dispose());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => stop(signal));

try {
  await holder.listen();
} catch (error) {
  log(error.code === 'HOLDER_RUNNING' ? 'a holder is already running for this data directory; exiting' : `could not listen: ${error?.stack ?? error}`);
  releaseUse?.();
  process.exit(error.code === 'HOLDER_RUNNING' ? 0 : 1);
}
