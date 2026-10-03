// データ置き場の SQLite（pleiad.db）。件数・会話の長さとともに増える記録の置き場（ADR 0106）。
//
// 1 ファイル・WAL。書くのは変わった行だけで、記録の件数が増えても 1 回の書き込みは重くならない。
// node:sqlite は同期 API。呼び出し側（store・usage・agent-tasks・conversations）は自分の直列化の中で呼ぶ。
// 形式の検査と JSON からの移行は data-schema.mjs（形式番号 2）。ここは表と、表ごとの読み書きだけを持つ。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

export const DB_FILE = 'pleiad.db';
// PRAGMA user_version。データ置き場の形式番号（data-schema.json）と同じ値
export const DB_VERSION = 2;
export const dbPath = dir => path.join(dir, DB_FILE);

// node:sqlite は Node 22 / 24 では読み込み時に ExperimentalWarning を出す。利用者のログを汚さないよう、
// この 1 回の読み込みの間だけ、SQLite の ExperimentalWarning に限って捨てる（ほかの警告は通す）
let sqliteModule = null;
export function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(text))) return;
    return original.call(this, warning, ...args);
  };
  try { sqliteModule = createRequire(import.meta.url)('node:sqlite'); }
  finally { process.emitWarning = original; }
  return sqliteModule;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS session_fields (
  session_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, field)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS context_entry_refs (
  session_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  PRIMARY KEY (session_id, pos)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS agent_tasks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS usage_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT,
  backend TEXT,
  at REAL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_records_id ON usage_records (id);
CREATE INDEX IF NOT EXISTS usage_records_backend_at ON usage_records (backend, at);
CREATE TABLE IF NOT EXISTS conversations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);
`;

/** 開く。新しいファイルなら表を作る。readOnly は別のプロセス（テスト・調査）から中身を読むとき */
export function openRaw(file, { readOnly = false } = {}) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    // WAL ではアプリが落ちても確定済みの書き込みは残る。電源断で最後の数件が戻ることだけを許し、毎回の fsync を省く
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${DB_VERSION}`);
  }
  return db;
}

/** 1 つのトランザクション。fn が投げたら戻す。外側にトランザクションがあれば、その一部として動く（移行がまとめて書くため） */
const inTransaction = new WeakSet();
export function transaction(db, fn) {
  if (inTransaction.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 開始前の失敗 */ }
    throw e;
  } finally { inTransaction.delete(db); }
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const jsonOf = value => JSON.stringify(value) ?? 'null';
const statements = new WeakMap();
/** 文は接続ごとに 1 度だけ準備する */
function prepared(db, sql) {
  let map = statements.get(db);
  if (!map) statements.set(db, map = new Map());
  let statement = map.get(sql);
  if (!statement) map.set(sql, statement = db.prepare(sql));
  return statement;
}

// ---- 会話の記録（sessions.json の後継） --------------------------------------------------------
// 1 会話 = sessions の 1 行 + 項目（backend・title・outbox・contextSession …）ごとに session_fields の 1 行。
// 項目が変わったら、その項目の行だけを書く。
// contextSession.report.entries は会話ごとに同じ中身の写しが並ぶ（実データでは 96%）ので、中身のハッシュで
// context_entries に 1 つだけ持ち、会話側は context_entry_refs で並びだけを持つ。読むときに元の形へ組み直す。
export const ENTRIES_MARK = '$entries';
export const RAW_FIELD = '$raw';

function splitContext(value) {
  const entries = value?.report?.entries;
  if (!Array.isArray(entries)) return { json: jsonOf(value), entries: null };
  const { entries: omitted, ...report } = value.report;
  void omitted;
  return {
    json: jsonOf({ ...value, report: { ...report, [ENTRIES_MARK]: entries.length } }),
    entries: entries.map(entry => { const json = jsonOf(entry); return { hash: sha256(json), json }; }),
  };
}

export function sessionTable(db) {
  const writeField = (id, field, value) => {
    if (value === undefined) {
      prepared(db, 'DELETE FROM session_fields WHERE session_id = ? AND field = ?').run(id, field);
      if (field === 'contextSession') prepared(db, 'DELETE FROM context_entry_refs WHERE session_id = ?').run(id);
      return;
    }
    let json, entries = null;
    if (field === 'contextSession') ({ json, entries } = splitContext(value));
    else json = jsonOf(value);
    prepared(db, 'INSERT INTO session_fields (session_id, field, value) VALUES (?, ?, ?) ON CONFLICT (session_id, field) DO UPDATE SET value = excluded.value').run(id, field, json);
    if (field === 'contextSession') {
      prepared(db, 'DELETE FROM context_entry_refs WHERE session_id = ?').run(id);
      entries?.forEach((entry, pos) => {
        prepared(db, 'INSERT OR IGNORE INTO context_entries (hash, value) VALUES (?, ?)').run(entry.hash, entry.json);
        prepared(db, 'INSERT INTO context_entry_refs (session_id, pos, entry_id) SELECT ?, ?, id FROM context_entries WHERE hash = ?').run(id, pos, entry.hash);
      });
    }
  };
  const isPlain = entry => entry && typeof entry === 'object' && !Array.isArray(entry);
  return {
    /** 全会話。{ [sessionId]: 元の形の記録 } */
    loadAll() {
      const out = {};
      for (const row of prepared(db, 'SELECT session_id FROM sessions ORDER BY seq').iterate()) out[row.session_id] = {};
      for (const row of prepared(db, 'SELECT session_id, field, value FROM session_fields').iterate()) {
        const entry = out[row.session_id];
        if (!entry) continue;
        entry[row.field] = JSON.parse(row.value);
      }
      const bodies = new Map();
      for (const row of prepared(db, 'SELECT id, value FROM context_entries').iterate()) bodies.set(row.id, row.value);
      const lists = new Map();
      for (const row of prepared(db, 'SELECT session_id, pos, entry_id FROM context_entry_refs ORDER BY session_id, pos').iterate()) {
        if (!lists.has(row.session_id)) lists.set(row.session_id, []);
        lists.get(row.session_id).push(JSON.parse(bodies.get(row.entry_id) ?? 'null'));
      }
      for (const [id, entry] of Object.entries(out)) {
        if (RAW_FIELD in entry) { out[id] = entry[RAW_FIELD]; continue; }
        const report = entry.contextSession?.report;
        if (report && typeof report === 'object' && ENTRIES_MARK in report) {
          delete report[ENTRIES_MARK];
          report.entries = lists.get(id) ?? [];
        }
      }
      return out;
    },
    /** 会話の行を作り（無ければ）、fields の項目を entry の今の値へ合わせる。値が undefined の項目は消す */
    write(id, entry, fields) {
      transaction(db, () => {
        prepared(db, 'INSERT OR IGNORE INTO sessions (session_id) VALUES (?)').run(id);
        if (!isPlain(entry)) { writeField(id, RAW_FIELD, entry); return; }
        for (const field of fields) writeField(id, field, entry[field]);
      });
    },
    /** 新しく作った会話（または 1 度に全部）。entry の全項目を書く */
    writeAll(id, entry) {
      transaction(db, () => {
        prepared(db, 'DELETE FROM session_fields WHERE session_id = ?').run(id);
        prepared(db, 'DELETE FROM context_entry_refs WHERE session_id = ?').run(id);
        prepared(db, 'INSERT OR IGNORE INTO sessions (session_id) VALUES (?)').run(id);
        if (!isPlain(entry)) { writeField(id, RAW_FIELD, entry); return; }
        for (const field of Object.keys(entry)) writeField(id, field, entry[field]);
      });
    },
    remove(id) {
      transaction(db, () => {
        prepared(db, 'DELETE FROM session_fields WHERE session_id = ?').run(id);
        prepared(db, 'DELETE FROM context_entry_refs WHERE session_id = ?').run(id);
        prepared(db, 'DELETE FROM sessions WHERE session_id = ?').run(id);
      });
    },
    /** どの会話からも参照されない context_entries を消す（置き換えで孤立した分）。消した件数を返す */
    sweepEntries() {
      return Number(prepared(db, 'DELETE FROM context_entries WHERE id NOT IN (SELECT entry_id FROM context_entry_refs)').run().changes);
    },
    ids() { return prepared(db, 'SELECT session_id FROM sessions ORDER BY seq').all().map(row => row.session_id); },
  };
}

// ---- 委譲のタスク（agent-tasks.json の後継）。1 タスク 1 行 ---------------------------------------
export function taskTable(db) {
  return {
    /** 作った順の [[taskId, JSON の文字列]]。変わった行だけを書くための比べ元に、文字列のまま渡す */
    loadRows() {
      return prepared(db, 'SELECT task_id, data FROM agent_tasks ORDER BY seq').all().map(row => [row.task_id, row.data]);
    },
    /** 作った順の { taskId: 記録 } */
    loadAll() {
      const out = {};
      for (const [taskId, json] of this.loadRows()) out[taskId] = JSON.parse(json);
      return out;
    },
    /** rows: [[taskId, JSON の文字列]]。1 つのトランザクションで書く（rows が空でも書けるかを確かめる） */
    save(rows) {
      transaction(db, () => {
        for (const [taskId, json] of rows) prepared(db, 'INSERT INTO agent_tasks (task_id, data) VALUES (?, ?) ON CONFLICT (task_id) DO UPDATE SET data = excluded.data').run(taskId, json);
      });
    },
  };
}

// ---- 使用量の記録（usage.json の後継）。1 ターン 1 行 ---------------------------------------------
export function usageTable(db) {
  const meta = key => { const row = prepared(db, 'SELECT value FROM usage_meta WHERE key = ?').get(key); return row ? JSON.parse(row.value) : undefined; };
  const setMeta = (key, value) => prepared(db, 'INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, jsonOf(value));
  const insert = record => prepared(db, 'INSERT INTO usage_records (id, backend, at, data) VALUES (?, ?, ?, ?)')
    .run(typeof record?.id === 'string' ? record.id : null, typeof record?.backend === 'string' ? record.backend : null, Number.isFinite(record?.at) ? record.at : null, jsonOf(record));
  return {
    /** 記録が 1 件も無く、メタも無いなら null。あれば { version, since, migrations, records } */
    snapshot() {
      const since = meta('since');
      if (since === undefined && meta('migrations') === undefined) return null;
      return {
        version: 1, since, migrations: meta('migrations') ?? [],
        records: prepared(db, 'SELECT data FROM usage_records ORDER BY seq').all().map(row => JSON.parse(row.data)),
      };
    },
    has(id) { return !!prepared(db, 'SELECT 1 AS found FROM usage_records WHERE id = ? LIMIT 1').get(id); },
    /** 1 件足す。メタが無ければ since・migrations も書く */
    add(record, { since, migrations }) {
      transaction(db, () => {
        if (meta('since') === undefined) setMeta('since', since);
        if (meta('migrations') === undefined) setMeta('migrations', migrations);
        insert(record);
      });
    },
    /** 移行（core/usage-migrations.mjs）の結果を書く。記録は並びも含めて置き換える（件数が同じ間は変わった行だけ） */
    replace(data) {
      transaction(db, () => {
        setMeta('since', data.since);
        setMeta('migrations', data.migrations ?? []);
        const current = prepared(db, 'SELECT seq, data FROM usage_records ORDER BY seq').all();
        const next = data.records.map(record => jsonOf(record));
        if (current.length === next.length) {
          current.forEach((row, i) => { if (row.data !== next[i]) prepared(db, 'UPDATE usage_records SET id = ?, backend = ?, at = ?, data = ? WHERE seq = ?')
            .run(typeof data.records[i]?.id === 'string' ? data.records[i].id : null, typeof data.records[i]?.backend === 'string' ? data.records[i].backend : null, Number.isFinite(data.records[i]?.at) ? data.records[i].at : null, next[i], row.seq); });
        } else {
          prepared(db, 'DELETE FROM usage_records').run();
          for (const record of data.records) insert(record);
        }
      });
    },
    /** backend の記録のうち、at が since 以後のもの（作った順） */
    recent(backend, since) {
      return prepared(db, 'SELECT data FROM usage_records WHERE backend = ? AND at >= ? ORDER BY seq').all(backend, since).map(row => JSON.parse(row.data));
    },
    count() { return Number(prepared(db, 'SELECT COUNT(*) AS n FROM usage_records').get().n); },
    since() { return meta('since'); },
  };
}

// ---- 会話の索引（conversations.json の後継）。1 会話 1 行（本文は conversations/<id>.json のまま） ----
export function conversationTable(db) {
  return {
    /** 作った順の [[id, JSON の文字列]]。変わった会話だけを書くための比べ元に、文字列のまま渡す */
    loadRows() { return prepared(db, 'SELECT id, data FROM conversations ORDER BY seq').all().map(row => [row.id, row.data]); },
    loadAll() {
      const out = {};
      for (const [id, json] of this.loadRows()) out[id] = JSON.parse(json);
      return out;
    },
    save(upserts, removals = []) {
      transaction(db, () => {
        for (const [id, json] of upserts) prepared(db, 'INSERT INTO conversations (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data').run(id, json);
        for (const id of removals) prepared(db, 'DELETE FROM conversations WHERE id = ?').run(id);
      });
    },
  };
}

// ---- 接続の共有 ---------------------------------------------------------------------------------
// 同じデータ置き場を使う store・usage・agent-tasks・conversations は 1 本の接続を数えて共有する。
// 最後の 1 つが離したら閉じる（Windows では開いたままのファイルがあるとデータ置き場を消せない）。
const open = new Map();   // 解決したディレクトリ -> { db, refs }

export function acquire(dir, prepare = () => {}) {
  const key = path.resolve(dir);
  let slot = open.get(key);
  if (!slot) {
    fs.mkdirSync(key, { recursive: true });
    prepare(key);
    slot = { db: openRaw(dbPath(key)), refs: 0 };
    open.set(key, slot);
  }
  slot.refs++;
  let released = false;
  return {
    db: slot.db,
    release() {
      if (released) return;
      released = true;
      if (--slot.refs > 0) return;
      open.delete(key);
      try { slot.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 閉じるだけ */ }
      try { slot.db.close(); } catch { /* 閉じるだけ */ }
    },
  };
}

/** 読み取り専用で開く（別のプロセスから見る・調査用）。無ければ null */
export function openReadOnly(dir) {
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return null;
  return openRaw(file, { readOnly: true });
}
