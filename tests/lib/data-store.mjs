// テストが、データ置き場の記録（SQLite。core/db.mjs）を別の接続から読み書きするための道具。
// 記録は JSON ファイルではなく pleiad.db にある（ADR 0106）。サーバーが動いている間でも読める（WAL）。
import fs from 'node:fs';
import path from 'node:path';
import { openRaw, openReadOnly, dbPath, sessionTable, taskTable, usageTable, conversationTable, transaction } from '../../core/db.mjs';

function withDb(dir, fn, { write = false } = {}) {
  const db = write ? openRaw(dbPath(dir), { create: true }) : openReadOnly(dir);
  if (!db) return undefined;
  try { return fn(db); } finally { db.close(); }
}

/** { [sessionId]: 記録 }。DB が無ければ空 */
export const readSessions = dir => withDb(dir, db => sessionTable(db).loadAll()) ?? {};
/** { [taskId]: 記録 } */
export const readAgentTasks = dir => withDb(dir, db => taskTable(db).loadAll()) ?? {};
/** { version, since, migrations, records }。無ければ null */
export const readUsage = dir => withDb(dir, db => usageTable(db).snapshot()) ?? null;
export const readConversationIndex = dir => withDb(dir, db => conversationTable(db).loadAll()) ?? {};

/**
 * 会話の記録を置き換える（サーバーを止めている間に、記録を書き換えて起動し直すテスト用）。
 * 形式番号（data-schema.json）が無ければ 2 にする
 */
export function writeSessions(dir, sessions) {
  fs.mkdirSync(dir, { recursive: true });
  ensureSchemaFile(dir);
  withDb(dir, db => transaction(db, () => {
    const table = sessionTable(db);
    for (const id of table.ids()) table.remove(id);
    for (const [id, entry] of Object.entries(sessions)) table.writeAll(id, entry);
  }), { write: true });
}

export function writeAgentTasks(dir, records) {
  fs.mkdirSync(dir, { recursive: true });
  ensureSchemaFile(dir);
  withDb(dir, db => taskTable(db).save(Object.entries(records).map(([id, record]) => [id, JSON.stringify(record)])), { write: true });
}

function ensureSchemaFile(dir) {
  const file = path.join(dir, 'data-schema.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ schema: 2 }) + '\n');
}

/** 使用量の記録を置き換える。data は { since, migrations?, records } */
export function writeUsage(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  ensureSchemaFile(dir);
  withDb(dir, db => usageTable(db).replace({ version: 1, since: data.since ?? null, migrations: data.migrations ?? [], records: data.records }), { write: true });
}
