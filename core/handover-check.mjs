// 新しい版のサーバーへ切り替える前の事前の確かめ（無停止の更新 段階 1 の 1-6。docs/zero-downtime-update/plan.md 1-6、design.md §5.1 の 6・§5.3）。
// 新しい main が、組み終えた実行場所の pleiad-node.exe で `app\<新>\core\handover-check.mjs` を走らせ、標準出力の最後の行の JSON を読む
// （desktop/switch.cjs の runHandoverCheck）。この版のデータの形式番号・main との口の版の範囲・版とビルドを出し、
// データ置き場の data-schema.json（今の形式番号）を読むだけで、DB もロックも開かない（走っている古いサーバーが持っている）。
// 出力 { check: 1, appVersion, build, protocolVersion, dataSchema, dataSchemaFound, ipc: [min, max] }。
//   dataSchema       この版が使うデータの形式番号（core/data-schema.mjs の DATA_SCHEMA）
//   dataSchemaFound  データ置き場の今の形式番号。読めなければ null
// 形が変わっても、読む側（main）が知っている欄だけを見る。欄を消さない・意味を変えない（check の版を上げるときは読む側も直す）。
// readBuildInfo はサーバーの ready（core/server.mjs）も使う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_SCHEMA } from './data-schema.mjs';
import { IPC_RANGE } from './main-link.mjs';
import { PROTOCOL_VERSION } from './protocol.mjs';

export const CHECK_VERSION = 1;
/** 版を見分けるビルドの短いハッシュの長さ（desktop/runtime-manifest.cjs の BUILD_HASH_LENGTH と同じ） */
export const BUILD_LENGTH = 12;

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const shortBuild = hash => (typeof hash === 'string' && /^[0-9a-f]{12,}$/.test(hash) ? hash.slice(0, BUILD_LENGTH) : null);

/**
 * appRoot（core\ の親）の版とビルド。ビルドは、実行場所の木なら組んだときの印（.runtime.json）、配布物の resources\app なら manifest.json の buildHash。
 * どちらも無い（開発のリポジトリ）なら null
 */
export function readBuildInfo(appRoot) {
  const appVersion = String(readJson(path.join(appRoot, 'package.json'))?.version ?? '');
  const build = shortBuild(readJson(path.join(appRoot, '.runtime.json'))?.buildHash) ?? shortBuild(readJson(path.join(appRoot, 'manifest.json'))?.buildHash);
  return { appVersion, build };
}

/** データ置き場の今の形式番号（data-schema.json）。無い・読めなければ null */
export function readDataSchema(dataDir) {
  const schema = readJson(path.join(dataDir, 'data-schema.json'))?.schema;
  return Number.isInteger(schema) ? schema : null;
}

export function handoverInfo({ appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), dataDir }) {
  return { check: CHECK_VERSION, ...readBuildInfo(appRoot), protocolVersion: PROTOCOL_VERSION, dataSchema: DATA_SCHEMA, dataSchemaFound: dataDir ? readDataSchema(dataDir) : null, ipc: IPC_RANGE };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.AGENT_HOST_DATA ? path.resolve(process.env.AGENT_HOST_DATA) : path.join(os.homedir(), '.agent-host');
  process.stdout.write(`${JSON.stringify(handoverInfo({ dataDir }))}\n`);
}
