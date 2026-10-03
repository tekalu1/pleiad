import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { acquire } from './db.mjs';
import { migrateSchema1To2, finishSchema1To2, legacyFiles, writeSchemaFile } from './schema-migration.mjs';

// 2: 件数とともに増える記録は SQLite（pleiad.db）の行（ADR 0106）。1 は記録ごとの JSON ファイル。
// 形式番号を上げる変更は、バックアップ → 移行 → 突き合わせ → 番号の更新を、ここと同じ形（core/schema-migration.mjs）で足す。
export const DATA_SCHEMA = 2;

/**
 * データ置き場の形式を確かめ、古ければ移行する（同期）。書き込みを始める前に呼ぶこと。
 * 読めない・未知（新しい版で作られた）形式ならデータに触れずに投げる。移行に失敗したときも元のデータは変えない。
 * 戻り値は移行したときの { backup, counts }、何もしなかったときは null。options はテストが失敗を差し込むためのもの
 */
export function ensureDataSchemaSync(directory, options = {}) {
  const file = path.join(directory, 'data-schema.json');
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, 'utf8')).schema;
    if (!Number.isInteger(schema)) throw new Error('Invalid schema');
  } catch (e) { if (e.code !== 'ENOENT') throw new Error(t('data.schemaUnreadable')); }
  if (schema !== undefined && schema > DATA_SCHEMA) throw new Error(t('data.schemaMismatch'));
  if (schema === DATA_SCHEMA) return null;
  if (schema !== undefined && schema < 1) throw new Error(t('data.schemaMismatch'));
  // 形式番号が無い置き場（形式番号を導入する前の版・新しい置き場）と形式 1 は、同じ扱いで移行する
  fs.mkdirSync(directory, { recursive: true });
  if (!legacyFiles(directory).length) {
    try { writeSchemaFile(directory, DATA_SCHEMA); } catch (e) { throw new Error(t('data.migrationFailed', { reason: String(e?.message ?? e) })); }
    return null;
  }
  let result;
  try { result = migrateSchema1To2(directory, options); }
  catch (e) { throw new Error(t('data.migrationFailed', { reason: String(e?.message ?? e) }), { cause: e }); }
  try { finishSchema1To2(directory, result.present); }
  catch (e) { throw new Error(t('data.migrationFailed', { reason: String(e?.message ?? e) }), { cause: e }); }
  return { backup: result.backup, counts: result.counts };
}

export async function ensureDataSchema(directory, options) {
  return ensureDataSchemaSync(directory, options);
}

/**
 * データ置き場の DB を開く（接続は同じ置き場で共有。離すときは release()）。最初に形式を確かめ、古ければ移行するので、
 * どのモジュールが最初に触っても、書き込みの前に移行が済む（移行したことの表示は、起動する core/server.mjs が ensureDataSchema の戻り値で出す）。
 */
export function openData(directory) {
  return acquire(directory, dir => { ensureDataSchemaSync(dir); });
}
