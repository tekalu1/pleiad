// データ置き場の形式 1 → 2 の移行（ADR 0115）。形式 1 は記録ごとの JSON ファイル、形式 2 は SQLite（pleiad.db）。
//
// 手順（docs/desktop-releases.md「適用とデータ保護」）。起動時、書き込みを始める前に 1 回だけ走る:
//   1. 対象の JSON を <data>/backup-schema1-<日時>/ へ写す
//   2. 作りかけの pleiad.db があれば消し、新しい DB に取り込む
//   3. DB から読み戻して、元の JSON と突き合わせる（1 つでも違えば失敗）
//   4. 成功してから data-schema.json を 2 にする。その後で元の JSON を消す（写しは残る）
// 失敗したら作りかけの DB と写しを消し、元の JSON にも data-schema.json にも触れずに投げる（起動が止まる）。
// 全部同期で動く。起動の途中の 1 回きりで、その間に別の書き込みは無い。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dbPath, createDb, transaction, sessionTable, taskTable, usageTable, conversationTable, threadTable, memoryStateTable } from './db.mjs';

// 形式 1 の JSON。channels/threads.json と memory/learn-state.json は 0.6.0（形式 1 のまま）が書いていた（スレッドの状態・夜の整理の進み）。
// 置き場からの相対パス（写しの中でも同じ相対パスに置く）
export const LEGACY_FILES = ['sessions.json', 'agent-tasks.json', 'usage.json', 'conversations.json', 'channels/threads.json', 'memory/learn-state.json'];
const THREADS_FILE = 'channels/threads.json', LEARN_FILE = 'memory/learn-state.json';
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const isMap = value => isObject(value);
/** 0.6.0 の core/channels/threads.mjs が読めた形（version 1・threads が連想配列）。ほかの最上位の項目は保存先が無いので止める */
const isThreadsFile = v => isObject(v) && v.version === 1 && isMap(v.threads) && onlyKeys(v, ['version', 'threads']);
/** 0.6.0 の core/memory/learn.mjs が読めた形（version 1・cursor.sessions・cursor.posts・lastRunAt が数）。カーソルの各組は連想配列 */
const isLearnFile = v => isObject(v) && v.version === 1 && isObject(v.cursor) && isMap(v.cursor.sessions) && isMap(v.cursor.posts) && Number.isFinite(v.lastRunAt)
  && onlyKeys(v, ['version', 'cursor', 'lastRunAt']) && Object.values(v.cursor).every(isMap);
/** 夜の整理の進みを DB の行（kind・id・value）にする。空の組は行にならない */
const learnRows = v => [
  ...Object.entries(v.cursor).flatMap(([group, map]) => Object.entries(map).map(([id, value]) => [`cursor.${group}`, id, value])),
  ['meta', 'lastRunAt', v.lastRunAt],
];
/** DB の memory_state を learnRows と同じ形（{ kind: { id: value } }）にして比べるための期待値 */
const learnExpected = v => learnRows(v).reduce((out, [kind, id, value]) => { (out[kind] ??= {})[id] = value; return out; }, {});
const DB_SIDE_FILES = ['-wal', '-shm', '-journal'];

const exists = file => { try { fs.accessSync(file); return true; } catch { return false; } };

function readJson(file, what, check) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`${what}: ${e?.message ?? e}`); }
  if (!check(value)) throw new Error(`${what}: unexpected shape`);
  return value;
}
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function removeDb(dir) {
  for (const suffix of ['', ...DB_SIDE_FILES]) fs.rmSync(dbPath(dir) + suffix, { force: true });
}

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

/** 形式 1 のファイルがあるか（無ければ、移行するものが無い新しい置き場） */
export const legacyFiles = dir => LEGACY_FILES.filter(name => exists(path.join(dir, name)));

/**
 * 形式 1 → 2。options.afterImport(db) はテスト用（取り込み後・突き合わせ前に失敗を差し込む）。
 * 戻り値は { backup, counts }。移行するものが無ければ null
 */
export function migrateSchema1To2(dir, { now = new Date(), afterImport = null } = {}) {
  const present = legacyFiles(dir);
  if (!present.length) return null;

  // 先に全部を読んで形を確かめる。読めないものがあれば、何も作らずに止める
  const sources = {};
  if (present.includes('sessions.json')) sources.sessions = readJson(path.join(dir, 'sessions.json'), 'sessions.json', isObject);
  if (present.includes('agent-tasks.json')) sources.tasks = readJson(path.join(dir, 'agent-tasks.json'), 'agent-tasks.json', isObject);
  if (present.includes('usage.json')) sources.usage = readJson(path.join(dir, 'usage.json'), 'usage.json', v => isObject(v) && v.version === 1 && Array.isArray(v.records));
  if (present.includes('conversations.json')) sources.conversations = readJson(path.join(dir, 'conversations.json'), 'conversations.json', isObject);
  // 0.6.0 が読めなかった形（壊れた JSON・知らない版）は、0.6.0 と同じく読み込まずに止める（上書きして消さない）
  if (present.includes(THREADS_FILE)) sources.threads = readJson(path.join(dir, THREADS_FILE), THREADS_FILE, isThreadsFile);
  if (present.includes(LEARN_FILE)) sources.learn = readJson(path.join(dir, LEARN_FILE), LEARN_FILE, isLearnFile);

  let backup = path.join(dir, `backup-schema1-${stamp(now)}`);
  for (let n = 2; exists(backup); n++) backup = path.join(dir, `backup-schema1-${stamp(now)}-${n}`);
  let db = null;
  try {
    fs.mkdirSync(backup, { recursive: true });
    for (const name of [...present, 'data-schema.json']) {
      if (!exists(path.join(dir, name))) continue;
      fs.mkdirSync(path.dirname(path.join(backup, name)), { recursive: true });
      fs.copyFileSync(path.join(dir, name), path.join(backup, name));
    }
    removeDb(dir);
    db = createDb(dbPath(dir));
    const counts = {};
    const expected = {};
    transaction(db, () => {
      if (sources.sessions) {
        const table = sessionTable(db);
        for (const [id, entry] of Object.entries(sources.sessions)) table.writeAll(id, entry);
        expected.sessions = sources.sessions;
        counts.sessions = Object.keys(sources.sessions).length;
      }
      if (sources.tasks) {
        taskTable(db).save(Object.entries(sources.tasks).map(([id, record]) => [id, JSON.stringify(record)]));
        expected.tasks = sources.tasks;
        counts.tasks = Object.keys(sources.tasks).length;
      }
      if (sources.usage) {
        // 元の JSON の全体を持つ。version・since・migrations・records 以外の最上位の項目も保存する（usage_meta の extra）。
        // 無い since・migrations だけは既定値を補う（読む側はどちらも無いものとして扱っていた）
        const normalized = { ...sources.usage, since: sources.usage.since ?? null, migrations: sources.usage.migrations ?? [] };
        usageTable(db).replace(normalized);
        expected.usage = normalized;
        counts.usage = normalized.records.length;
      }
      if (sources.conversations) {
        conversationTable(db).save(Object.entries(sources.conversations).map(([id, record]) => [id, JSON.stringify(record)]));
        expected.conversations = sources.conversations;
        counts.conversations = Object.keys(sources.conversations).length;
      }
      if (sources.threads) {
        const table = threadTable(db);
        for (const [key, state] of Object.entries(sources.threads.threads)) table.put(key, typeof state?.channelId === 'string' ? state.channelId : key.split('/')[0], JSON.stringify(state));
        expected.threads = sources.threads.threads;
        counts.threads = Object.keys(sources.threads.threads).length;
      }
      if (sources.learn) {
        memoryStateTable(db).save(learnRows(sources.learn));
        expected.learn = learnExpected(sources.learn);
        counts.memoryState = learnRows(sources.learn).length;
      }
    });
    afterImport?.(db);

    // 読み戻して突き合わせる。キーの順は問わず、値は 1 つ残らず同じでなければならない
    const mismatch = [];
    if (expected.sessions && !isDeepStrictEqual(sessionTable(db).loadAll(), expected.sessions)) mismatch.push('sessions.json');
    if (expected.tasks && !isDeepStrictEqual(taskTable(db).loadAll(), expected.tasks)) mismatch.push('agent-tasks.json');
    if (expected.usage && !isDeepStrictEqual(usageTable(db).snapshot(), expected.usage)) mismatch.push('usage.json');
    if (expected.conversations && !isDeepStrictEqual(conversationTable(db).loadAll(), expected.conversations)) mismatch.push('conversations.json');
    if (expected.threads && !isDeepStrictEqual(threadTable(db).loadAll(), expected.threads)) mismatch.push(THREADS_FILE);
    if (expected.learn && !isDeepStrictEqual(memoryStateTable(db).loadAll(), expected.learn)) mismatch.push(LEARN_FILE);
    if (mismatch.length) throw new Error(`read-back differs from the original: ${mismatch.join(', ')}`);

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    return { backup, counts, present };
  } catch (e) {
    try { db?.close(); } catch { /* 閉じるだけ */ }
    removeDb(dir);
    fs.rmSync(backup, { recursive: true, force: true });
    throw e;
  }
}

const backupDirs = dir => fs.readdirSync(dir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-schema1-')).map(entry => path.join(dir, entry.name));

/**
 * 移行した元の JSON を外す。写し（backup-schema1-*）に同じ中身（バイトまで同じ）があるものだけを外し、
 * 無いもの・外せなかったもの（Windows の削除拒否など）は触らずに、名前を返す。投げない: 外せなくても起動は止めず、
 * 形式 2 の次の起動（core/data-schema.mjs）がもう一度試す。形式 2 では、残った元の JSON は読まない（読む経路が無い）
 */
export function removeLegacy(dir, names, { remove = file => fs.rmSync(file, { force: true }) } = {}) {
  const left = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let original;
    try { original = fs.readFileSync(file); } catch { if (exists(file)) left.push(name); continue; }
    const backedUp = backupDirs(dir).some(backup => { try { return fs.readFileSync(path.join(backup, name)).equals(original); } catch { return false; } });
    if (!backedUp) { left.push(name); continue; }
    try { remove(file); } catch { /* 下で残っているかを見る */ }
    if (exists(file)) left.push(name);
  }
  return left;
}

/** 検証が済んだ後。形式番号を 2 にしてから、移行した元の JSON を外す（外し切れなかった分の名前を返す） */
export function finishSchema1To2(dir, present, options = {}) {
  writeSchemaFile(dir, 2);
  return removeLegacy(dir, present, options);
}

/** data-schema.json を 1 回で置き換える（一時ファイルへ書いてから rename） */
export function writeSchemaFile(dir, schema) {
  const file = path.join(dir, 'data-schema.json');
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schema }) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
