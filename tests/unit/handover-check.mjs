// 新しい版の事前の確かめ（無停止の更新 1-6。core/handover-check.mjs、docs/zero-downtime-update/plan.md 1-6）。
//   - 版とビルド: 実行場所の木は組んだときの印（.runtime.json）、配布物は manifest.json、開発のリポジトリは null
//   - データ置き場の今の形式番号（data-schema.json）を読むだけで、DB・ロックを作らない
//   - 本物の Node で走らせて 1 行の JSON を出す（desktop/switch.cjs の runHandoverCheck で読む）
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, readDataSchema, handoverInfo, CHECK_VERSION } from '../../core/handover-check.mjs';
import { DATA_SCHEMA } from '../../core/data-schema.mjs';
import { IPC_RANGE } from '../../core/main-link.mjs';
import { PROTOCOL_VERSION } from '../../core/protocol.mjs';

const require = createRequire(import.meta.url);
const { runHandoverCheck, judgeCheck } = require('../../desktop/switch.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'handover-check';
export const title = '事前の確かめ（handover-check）: 版とビルド・データの形式番号・口の版を出し、データ置き場を開かない';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-handover-check-'));
const write = (dir, file, value) => fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));

export default async function (t) {
  const dirs = [];
  const temp = () => { const dir = tempDir(); dirs.push(dir); return dir; };
  try {
    // ---- 版とビルド
    {
      const app = temp();
      write(app, 'package.json', { version: '2.3.4' });
      t.ok('開発のリポジトリ（印も manifest も無い）はビルドが null', JSON.stringify(readBuildInfo(app)) === JSON.stringify({ appVersion: '2.3.4', build: null }));
      write(app, 'manifest.json', { buildHash: 'a'.repeat(64) });
      t.ok('配布物の resources\\app は manifest.json の buildHash の先頭 12 桁', readBuildInfo(app).build === 'a'.repeat(12));
      write(app, '.runtime.json', { buildHash: 'b'.repeat(64), state: 'full' });
      t.ok('実行場所の木は組んだときの印を先に見る', readBuildInfo(app).build === 'b'.repeat(12));
      write(app, '.runtime.json', { buildHash: 'not-a-hash' });
      t.ok('印のハッシュが壊れていれば manifest に戻る', readBuildInfo(app).build === 'a'.repeat(12));
    }
    // ---- データの形式番号
    {
      const data = temp();
      t.ok('data-schema.json が無ければ null', readDataSchema(data) === null);
      write(data, 'data-schema.json', '{broken');
      t.ok('読めなければ null', readDataSchema(data) === null);
      write(data, 'data-schema.json', { schema: 2 });
      t.ok('今の形式番号を読む', readDataSchema(data) === 2);
      const info = handoverInfo({ appRoot: ROOT, dataDir: data });
      t.ok('出力は check の版・この版の形式番号・置き場の形式番号・口の版の範囲・protocolVersion',
        info.check === CHECK_VERSION && info.dataSchema === DATA_SCHEMA && info.dataSchemaFound === 2 && JSON.stringify(info.ipc) === JSON.stringify(IPC_RANGE) && info.protocolVersion === PROTOCOL_VERSION);
      t.ok('このリポジトリの版を出す', info.appVersion === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    }
    // ---- 本物の Node で走らせる
    {
      const data = temp();
      write(data, 'data-schema.json', { schema: 1 });
      const before = fs.readdirSync(data).sort().join();
      const result = await runHandoverCheck({ nodeExe: process.execPath, appDir: ROOT, dataDir: data, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      t.ok('runHandoverCheck: 走らせて 1 行の JSON を読む（置き場は AGENT_HOST_DATA で渡す）', result.check === 1 && result.dataSchemaFound === 1 && result.dataSchema === DATA_SCHEMA, JSON.stringify(result));
      t.ok('データ置き場に何も作らない（DB・ロックを開かない）', fs.readdirSync(data).sort().join() === before);
      t.ok('形式番号が違う置き場では自動の切り替えをしない判定になる', DATA_SCHEMA === 1 || judgeCheck(result).reason === 'schema');
      const missing = await runHandoverCheck({ nodeExe: process.execPath, appDir: temp(), dataDir: data }).then(() => null, error => error);
      t.ok('確かめのスクリプトが無い（壊れた版）なら失敗する', /handover-check failed/.test(missing?.message ?? ''));
    }
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}
