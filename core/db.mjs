// データ置き場の SQLite（pleiad.db）。件数・会話の長さとともに増える記録の置き場（ADR 0115）。
//
// 1 ファイル・WAL。書くのは変わった行だけで、記録の件数が増えても 1 回の書き込みは重くならない。
// node:sqlite は同期 API。呼び出し側（store・usage・agent-tasks・conversations）は自分の直列化の中で呼ぶ。
// 形式の検査と JSON からの移行は data-schema.mjs（形式番号 2）。ここは表と、表ごとの読み書きだけを持つ。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { assertNotGuarded } from './test-guard.mjs';

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
CREATE INDEX IF NOT EXISTS usage_records_session ON usage_records (json_extract(data, '$.sessionId'));
CREATE TABLE IF NOT EXISTS conversations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);
`;

// 後から足した表（bot・Channels・記憶）。REQUIRED_TABLES には入れない（無くても失った記録は無い）。
// 新しい DB は SCHEMA_SQL と一緒に作り、既にある形式 2 の DB には、使う側が最初に開くとき足す（ensureLateTables）
export const LATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS channel_threads (
  thread_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  data TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS channel_threads_channel ON channel_threads (channel_id);
CREATE TABLE IF NOT EXISTS memory_state (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS brain_stream (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  at REAL NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS brain_stream_bot ON brain_stream (bot_id, seq);
CREATE TABLE IF NOT EXISTS brain_loops (
  bot_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at REAL NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (bot_id, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS brain_wakes (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  at REAL NOT NULL,
  data TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS brain_wakes_due ON brain_wakes (status, at);
CREATE INDEX IF NOT EXISTS brain_wakes_bot ON brain_wakes (bot_id, status);
CREATE TABLE IF NOT EXISTS deleted_natives (
  backend TEXT NOT NULL,
  native_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (backend, native_id)
) WITHOUT ROWID;
`;
const lateEnsured = new WeakSet();
function ensureLateTables(db) {
  if (lateEnsured.has(db)) return;
  db.exec(LATE_TABLES_SQL);
  lateEnsured.add(db);
}

export const REQUIRED_TABLES = ['sessions', 'session_fields', 'context_entries', 'context_entry_refs', 'agent_tasks', 'usage_meta', 'usage_records', 'conversations'];

/**
 * 開く。既にある DB を開くだけで、無ければ投げる（形式 2 の置き場で DB が消えているときに、空の DB を作って起動しない）。
 * 新しい DB を作るときだけ create: true（表と user_version を書く）。readOnly は別のプロセス（テスト・調査）から中身を読むとき。
 * 書き込みの接続は WAL・synchronous=NORMAL（アプリが落ちても確定した書き込みは残り、DB は壊れない。OS ごと落ちたときだけ直前の数件が戻りうる。ADR 0115）。
 * busy_timeout は数百 ms: データ置き場はプロセス単位で排他する（core/data-lock.mjs）ので、待つ相手は調査・テストの短い接続だけ
 */
export function openRaw(file, { readOnly = false, create = false } = {}) {
  assertNotGuarded(path.dirname(file), 'open a database in');
  if (!readOnly && !create && !fs.existsSync(file)) throw new Error(`database file is missing: ${file}`);
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 300');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    if (create) {
      db.exec(SCHEMA_SQL);
      db.exec(LATE_TABLES_SQL);
      db.exec(`PRAGMA user_version = ${DB_VERSION}`);
    }
  }
  return db;
}

/** 新しい DB を作る（表と形式番号を書く） */
export const createDb = file => openRaw(file, { create: true });

/** DB が形式 2 として使えるか確かめる（読み取り専用）。使えれば null、だめなら理由の文字列 */
export function checkDb(file) {
  if (!fs.existsSync(file)) return 'missing';
  let db;
  try {
    db = openRaw(file, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== DB_VERSION) return `user_version is ${version}, expected ${DB_VERSION}`;
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const missing = REQUIRED_TABLES.filter(name => !names.has(name));
    return missing.length ? `missing tables: ${missing.join(', ')}` : null;
  } catch (e) { return `unreadable: ${e?.message ?? e}`; }
  finally { try { db?.close(); } catch { /* 閉じるだけ */ } }
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
    /**
     * 既にある会話の、fields の項目を entry の今の値へ合わせる。値が undefined の項目は消す。
     * 会話の行が無ければ何も書かず false を返す（別の手段で消された会話を、更新で欠けた形のまま作り直さない）。
     * 新しい会話は writeAll
     */
    write(id, entry, fields) {
      return transaction(db, () => {
        if (!prepared(db, 'SELECT 1 AS found FROM sessions WHERE session_id = ?').get(id)) return false;
        if (!isPlain(entry)) { writeField(id, RAW_FIELD, entry); return true; }
        for (const field of fields) writeField(id, field, entry[field]);
        return true;
      });
    },
    /** 新しく作った会話（または 1 度に全部）。会話の行を作り、entry の全項目を書く */
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
    /** 記録が 1 件も無く、メタも無いなら null。あれば { version, since, migrations, records, …そのほかの最上位の項目 } */
    snapshot() {
      const since = meta('since');
      if (since === undefined && meta('migrations') === undefined) return null;
      return {
        ...(meta('extra') ?? {}),
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
        // version・since・migrations・records 以外の最上位の項目も落とさず持つ（古い版が足した項目・移行の検証が元の全体と比べる）
        const { version, since, migrations, records, ...extra } = data;
        void version; void since; void migrations; void records;
        if (Object.keys(extra).length) setMeta('extra', extra);
        else prepared(db, "DELETE FROM usage_meta WHERE key = 'extra'").run();
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
    /** backend の記録のうち、at が since 以後のもののトークン（入力・出力・キャッシュ）の合計（チャンネルの予算の目安。ADR 0119） */
    tokensSince(backend, since) {
      const row = prepared(db, "SELECT SUM(COALESCE(json_extract(data, '$.inputTokens'), 0) + COALESCE(json_extract(data, '$.outputTokens'), 0) + COALESCE(json_extract(data, '$.cachedTokens'), 0)) AS n FROM usage_records WHERE backend = ? AND at >= ?").get(backend, since);
      return Number(row?.n ?? 0);
    },
    /** 会話ごとの記録（bot ごと・スレッドごとの合計。ADR 0109）。sessionIds の会話の、at が since 以後のもの（作った順）。sessionId を持たない古い記録は載らない */
    forSessions(sessionIds, since = 0) {
      const out = [];
      for (let i = 0; i < sessionIds.length; i += 400) {
        const chunk = sessionIds.slice(i, i + 400);
        const marks = chunk.map(() => '?').join(',');
        for (const row of db.prepare(`SELECT seq, data FROM usage_records WHERE json_extract(data, '$.sessionId') IN (${marks}) AND at >= ? ORDER BY seq`).iterate(...chunk, since)) out.push([row.seq, JSON.parse(row.data)]);
      }
      return out.sort((a, b) => a[0] - b[0]).map(([, record]) => record);
    },
    count() { return Number(prepared(db, 'SELECT COUNT(*) AS n FROM usage_records').get().n); },
    since() { return meta('since'); },
  };
}

// ---- スレッドの状態（channels/threads.json の後継）。1 スレッド 1 行 -----------------------------------
// スレッドの状態は、bot のターンのたびにトークンの足し算などで書き換わり、スレッドの数だけ増える。全体を書き直さない
export function threadTable(db) {
  ensureLateTables(db);
  return {
    /** { [thread_key]: ThreadState }。作った順は問わない */
    loadAll() {
      const out = {};
      for (const row of prepared(db, 'SELECT thread_key, data FROM channel_threads').iterate()) out[row.thread_key] = JSON.parse(row.data);
      return out;
    },
    put(key, channelId, json) {
      prepared(db, 'INSERT INTO channel_threads (thread_key, channel_id, data) VALUES (?, ?, ?) ON CONFLICT (thread_key) DO UPDATE SET channel_id = excluded.channel_id, data = excluded.data').run(key, channelId, json);
    },
  };
}

// ---- 夜の整理の進み（memory/learn-state.json の後継）。会話・チャンネルごとのカーソルを 1 件 1 行 ---------------
// kind: 'cursor.sessions'・'cursor.posts'・'cursor.postOffsets' など（id は会話・チャンネルの id）、'meta'（lastRunAt）
export function memoryStateTable(db) {
  ensureLateTables(db);
  return {
    loadAll() {
      const out = {};
      for (const row of prepared(db, 'SELECT kind, id, value FROM memory_state').iterate()) (out[row.kind] ??= {})[row.id] = JSON.parse(row.value);
      return out;
    },
    /** 1 行の値（無ければ undefined）。bot の頭の中の状態など、1 体 1 行で毎回読むもの（loadAll は全部を読むので使わない） */
    get(kind, id) {
      const row = prepared(db, 'SELECT value FROM memory_state WHERE kind = ? AND id = ?').get(kind, id);
      return row ? JSON.parse(row.value) : undefined;
    },
    /** kind の全行（{ [id]: 値 }）。id の前方一致で絞れる */
    ofKind(kind, idPrefix = '') {
      const out = {};
      for (const row of prepared(db, 'SELECT id, value FROM memory_state WHERE kind = ? AND id >= ? AND id < ?').iterate(kind, idPrefix, `${idPrefix}￿`)) out[row.id] = JSON.parse(row.value);
      return out;
    },
    /** changes: [[kind, id, value]]。value が undefined なら行を消す。1 つのトランザクションで書く */
    save(changes) {
      if (!changes.length) return;
      transaction(db, () => {
        for (const [kind, id, value] of changes) {
          if (value === undefined) prepared(db, 'DELETE FROM memory_state WHERE kind = ? AND id = ?').run(kind, id);
          else prepared(db, 'INSERT INTO memory_state (kind, id, value) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value').run(kind, id, jsonOf(value));
        }
      });
    },
  };
}

// ---- bot の頭の中（思考の流れ・気がかり。ADR 0126）。思考の流れは心拍ごとに 1 行、気がかりは 1 件 1 行 ----------------
// 思考の流れ brain_stream: 書くのは追記だけ（読むのは bot ごとの末尾と画面の一覧）。bot ごとに古い行を落とす（prune）ので、件数が際限なく増えない。
// 気がかり brain_loops: (bot_id, id) の 1 行。開いているものは 1 体 12 件までに抑える（core/brain/store.mjs）。
export function brainTable(db) {
  ensureLateTables(db);
  const streamRow = (row) => ({ seq: row.seq, botId: row.bot_id, at: row.at, kind: row.kind, ...JSON.parse(row.data) });
  const loopRow = (row) => ({ botId: row.bot_id, id: row.id, status: row.status, updatedAt: row.updated_at, ...JSON.parse(row.data) });
  return {
    /** 1 行足す。足した行の seq を返す */
    append(botId, at, kind, data) {
      const info = prepared(db, 'INSERT INTO brain_stream (bot_id, at, kind, data) VALUES (?, ?, ?, ?)').run(botId, at, kind, jsonOf(data));
      return Number(info.lastInsertRowid);
    },
    /** 新しい順に limit 件（before は seq。それより古い分）。画面の一覧 */
    list(botId, { before = null, limit = 60 } = {}) {
      const rows = before == null
        ? prepared(db, 'SELECT seq, bot_id, at, kind, data FROM brain_stream WHERE bot_id = ? ORDER BY seq DESC LIMIT ?').all(botId, limit)
        : prepared(db, 'SELECT seq, bot_id, at, kind, data FROM brain_stream WHERE bot_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(botId, before, limit);
      return rows.map(streamRow);
    },
    /** 末尾の limit 件（古い順）。束に入れる分 */
    tail(botId, limit) {
      return prepared(db, 'SELECT seq, bot_id, at, kind, data FROM brain_stream WHERE bot_id = ? ORDER BY seq DESC LIMIT ?').all(botId, limit).reverse().map(streamRow);
    },
    /** at が since 以後の行（古い順）。朝に独り言の写りを突き合わせる材料 */
    since(botId, since, limit = 2000) {
      return prepared(db, 'SELECT seq, bot_id, at, kind, data FROM brain_stream WHERE bot_id = ? AND at >= ? ORDER BY seq LIMIT ?').all(botId, since, limit).map(streamRow);
    },
    count(botId) { return Number(prepared(db, 'SELECT COUNT(*) AS n FROM brain_stream WHERE bot_id = ?').get(botId).n); },
    /** at が olderThan より前の行と、新しい keep 件より後ろの行を消す。消した件数を返す */
    prune(botId, olderThan, keep) {
      const cut = prepared(db, 'SELECT seq FROM brain_stream WHERE bot_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(botId, Math.max(0, keep - 1));
      let removed = Number(prepared(db, 'DELETE FROM brain_stream WHERE bot_id = ? AND at < ?').run(botId, olderThan).changes);
      if (cut) removed += Number(prepared(db, 'DELETE FROM brain_stream WHERE bot_id = ? AND seq < ?').run(botId, cut.seq).changes);
      return removed;
    },
    clearStream(botId) { return Number(prepared(db, 'DELETE FROM brain_stream WHERE bot_id = ?').run(botId).changes); },
    loops(botId, status = null) {
      const rows = status
        ? prepared(db, 'SELECT bot_id, id, status, updated_at, data FROM brain_loops WHERE bot_id = ? AND status = ? ORDER BY updated_at').all(botId, status)
        : prepared(db, 'SELECT bot_id, id, status, updated_at, data FROM brain_loops WHERE bot_id = ? ORDER BY updated_at').all(botId);
      return rows.map(loopRow);
    },
    loop(botId, id) {
      const row = prepared(db, 'SELECT bot_id, id, status, updated_at, data FROM brain_loops WHERE bot_id = ? AND id = ?').get(botId, id);
      return row ? loopRow(row) : null;
    },
    putLoop(botId, id, status, updatedAt, data) {
      prepared(db, 'INSERT INTO brain_loops (bot_id, id, status, updated_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (bot_id, id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data').run(botId, id, status, updatedAt, jsonOf(data));
    },
    /** 手放した・解決した気がかりのうち、updated_at が olderThan より前のものを消す */
    pruneLoops(botId, olderThan) {
      return Number(prepared(db, "DELETE FROM brain_loops WHERE bot_id = ? AND status != 'open' AND updated_at < ?").run(botId, olderThan).changes);
    },
    clearLoops(botId) { return Number(prepared(db, 'DELETE FROM brain_loops WHERE bot_id = ?').run(botId).changes); },
    transaction: (fn) => transaction(db, fn),
  };
}

// ---- bot の予約（自分で予約した時刻に起きる。ADR 0140）。1 件 1 行。待っているものは 1 体 20 件まで、終わったものは 7 日で消す（core/brain/wakes.mjs） ----
export function wakeTable(db) {
  ensureLateTables(db);
  const row = (r) => ({ ...JSON.parse(r.data), id: r.id, botId: r.bot_id, status: r.status, at: r.at });
  return {
    get(id) { const r = prepared(db, 'SELECT id, bot_id, status, at, data FROM brain_wakes WHERE id = ?').get(id); return r ? row(r) : null; },
    put(id, botId, status, at, data) {
      prepared(db, 'INSERT INTO brain_wakes (id, bot_id, status, at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, at = excluded.at, data = excluded.data').run(id, botId, status, at, jsonOf(data));
    },
    /** bot の予約（時刻の順）。status を渡せばそれだけ */
    list(botId, status = null) {
      const rows = status
        ? prepared(db, 'SELECT id, bot_id, status, at, data FROM brain_wakes WHERE bot_id = ? AND status = ? ORDER BY at').all(botId, status)
        : prepared(db, 'SELECT id, bot_id, status, at, data FROM brain_wakes WHERE bot_id = ? ORDER BY at').all(botId);
      return rows.map(row);
    },
    /** 時刻が until 以前の、待っている予約（全 bot。時刻の順） */
    due(until) { return prepared(db, "SELECT id, bot_id, status, at, data FROM brain_wakes WHERE status = 'pending' AND at <= ? ORDER BY at").all(until).map(row); },
    countPending(botId) { return Number(prepared(db, "SELECT COUNT(*) AS n FROM brain_wakes WHERE bot_id = ? AND status = 'pending'").get(botId).n); },
    /** 終わった予約（待っていないもの）のうち、時刻が olderThan より前のものを消す */
    prune(olderThan) { return Number(prepared(db, "DELETE FROM brain_wakes WHERE status != 'pending' AND at < ?").run(olderThan).changes); },
    clear(botId) { return Number(prepared(db, 'DELETE FROM brain_wakes WHERE bot_id = ?').run(botId).changes); },
    transaction: (fn) => transaction(db, fn),
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

// ---- 消した会話のネイティブの id（ADR 0143）。1 つのネイティブの会話 1 行 ------------------------------------
// 送った会話を消しても、ネイティブの会話（Claude の transcript・Codex の rollout など）は残す。残ったものが一覧に
// ネイティブだけの行として戻ってこないよう、消した会話が持っていたネイティブの id を覚えて一覧から隠す（core/conversations.mjs の wrapBackend）
export function deletedNativeTable(db) {
  ensureLateTables(db);
  return {
    /** [[backend, nativeId]] */
    loadAll() { return prepared(db, 'SELECT backend, native_id FROM deleted_natives').all().map(row => [row.backend, row.native_id]); },
    /** rows: [[backend, nativeId]]。1 つのトランザクションで書く */
    add(rows, sessionId, at = Date.now()) {
      transaction(db, () => {
        for (const [backend, nativeId] of rows) prepared(db, 'INSERT OR IGNORE INTO deleted_natives (backend, native_id, session_id, at) VALUES (?, ?, ?, ?)').run(backend, nativeId, sessionId, at);
      });
    },
  };
}

// ---- 接続の共有 ---------------------------------------------------------------------------------
// 同じデータ置き場を使う store・usage・agent-tasks・conversations は 1 本の接続を数えて共有する。
// 最後の 1 つが離したら閉じる（Windows では開いたままのファイルがあるとデータ置き場を消せない）。
const open = new Map();   // 解決したディレクトリ -> { db, refs }

export function acquire(dir, prepare = () => {}) {
  assertNotGuarded(dir, 'open');
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

/** この置き場の共有している接続の数（0 なら閉じている。データ置き場を消す前の確認・テスト用） */
export const openCount = dir => open.get(path.resolve(dir))?.refs ?? 0;

/** 読み取り専用で開く（別のプロセスから見る・調査用）。無ければ null */
export function openReadOnly(dir) {
  const file = dbPath(dir);
  if (!fs.existsSync(file)) return null;
  return openRaw(file, { readOnly: true });
}
