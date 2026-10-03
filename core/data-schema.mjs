import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { acquire, checkDb, createDb, dbPath } from './db.mjs';
import { acquireDataLock } from './data-lock.mjs';
import { assertNotGuarded } from './test-guard.mjs';
import { migrateSchema1To2, finishSchema1To2, legacyFiles, removeLegacy, writeSchemaFile } from './schema-migration.mjs';

// 2: 件数とともに増える記録は SQLite（pleiad.db）の行（ADR 0115）。1 は記録ごとの JSON ファイル。
// 形式番号を上げる変更は、バックアップ → 移行 → 突き合わせ → 番号の更新を、ここと同じ形（core/schema-migration.mjs）で足す。
export const DATA_SCHEMA = 2;

const reasonOf = e => String(e?.message ?? e);

/**
 * 形式 2 の置き場の確認。DB が無い・形式番号（user_version）が違う・必要な表が無いなら、空の DB を作らずに止める
 * （作って起動すると、記録が消えたことに気付かずに新しい記録を書き始める）。
 * 前の移行で元の JSON を外し切れなかった（Windows の削除拒否など）なら、写しにあることを確かめてから外し直す。外せなくても止めない
 */
function verifyCurrent(directory, options) {
  const reason = checkDb(dbPath(directory));
  if (reason) throw new Error(t('data.dbInvalid', { reason }));
  const left = legacyFiles(directory);
  if (left.length) removeLegacy(directory, left, options);
  return null;
}

/**
 * 新しい置き場（JSON も DB も無い）だけが、DB を新しく作ってよい。DB だけがあれば、使えるものか確かめる。形式番号は最後
 */
function createFresh(directory) {
  const file = dbPath(directory);
  if (fs.existsSync(file)) {
    const reason = checkDb(file);
    if (reason) throw new Error(t('data.dbInvalid', { reason }));
  } else {
    try { createDb(file).close(); }
    catch (e) { throw new Error(t('data.migrationFailed', { reason: reasonOf(e) })); }
  }
  try { writeSchemaFile(directory, DATA_SCHEMA); }
  catch (e) { throw new Error(t('data.migrationFailed', { reason: reasonOf(e) })); }
}

/**
 * データ置き場の形式を確かめ、古ければ移行する（同期）。書き込みを始める前に呼ぶこと。
 * 読めない・未知（新しい版で作られた）形式・形式 2 なのに DB が使えないなら、データに触れずに投げる。
 * 移行に失敗したときも元のデータは変えない。移行と新規作成の間は、置き場のロックを取る（別のプロセスが同時に触らない）。
 * 戻り値は移行したときの { backup, counts }、何もしなかったときは null。options はテストが失敗を差し込むためのもの
 */
export function ensureDataSchemaSync(directory, options = {}) {
  assertNotGuarded(directory, 'check or migrate');
  const file = path.join(directory, 'data-schema.json');
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, 'utf8')).schema;
    if (!Number.isInteger(schema)) throw new Error('Invalid schema');
  } catch (e) { if (e.code !== 'ENOENT') throw new Error(t('data.schemaUnreadable')); }
  if (schema !== undefined && schema > DATA_SCHEMA) throw new Error(t('data.schemaMismatch'));
  if (schema !== undefined && schema < 1) throw new Error(t('data.schemaMismatch'));
  if (schema === DATA_SCHEMA) return verifyCurrent(directory, options);

  // 形式番号が無い置き場（形式番号を導入する前の版・新しい置き場）と形式 1 は、同じ扱いで移行する
  const unlock = acquireDataLock(directory);
  try {
    if (!legacyFiles(directory).length) { createFresh(directory); return null; }
    let result;
    try { result = migrateSchema1To2(directory, options); }
    catch (e) { throw new Error(t('data.migrationFailed', { reason: reasonOf(e) }), { cause: e }); }
    try { finishSchema1To2(directory, result.present, options); }
    catch (e) { throw new Error(t('data.migrationFailed', { reason: reasonOf(e) }), { cause: e }); }
    return { backup: result.backup, counts: result.counts };
  } finally { unlock(); }
}

export async function ensureDataSchema(directory, options) {
  return ensureDataSchemaSync(directory, options);
}

/**
 * データ置き場の DB を開く（接続は同じ置き場で共有。離すときは release()）。置き場のロックを取り（別のプロセスが持っていれば投げる）、
 * 形式を確かめ、古ければ移行してから開くので、どのモジュールが最初に触っても、書き込みの前に済む
 * （移行したことの表示は、起動する core/server.mjs が ensureDataSchema の戻り値で出す）。
 */
export function openData(directory) {
  const unlock = acquireDataLock(directory);
  try {
    const handle = acquire(directory, dir => { ensureDataSchemaSync(dir); });
    return { db: handle.db, release() { handle.release(); unlock(); } };
  } catch (e) { unlock(); throw e; }
}
