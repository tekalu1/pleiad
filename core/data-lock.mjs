// データ置き場をプロセス単位で排他する（ADR 0115）。
//
// 同じデータ置き場を 2 つのプロセスが開くと、片方がメモリに持った会話の記録が、もう片方の削除・更新と食い違い、
// 消した会話が欠けた形で戻る。起動から終了まで 1 つのプロセスだけが持つようにする。
// **OS がプロセスの終了で必ず外すロック**にする: データ置き場の小さな別ファイル pleiad.lock.db を node:sqlite で開き、
// locking_mode=EXCLUSIVE で排他ロックを取ったまま、プロセスが生きている間持ち続ける。別のプロセスが同じことをすると
// SQLITE_BUSY になるので、それを「使用中」と判断する。プロセスが落ちれば（強制終了・電源断のあとの再起動を含む）OS がロックを外すので、
// PID の生死は判断に使わない（Windows は PID をすぐ使い回す。落ちて残ったファイルの PID が別のプロセスに使われても、起動できる）。
// 持ち主の表示のために PID を pleiad.lock に書くが、判断には使わない（表示だけ。古くてもよい）。
// pleiad.db 本体には排他を掛けないので、別の接続でこの置き場を読む道具（scripts/copy-data-dir.mjs・テスト・調査）は、
// サーバーが動いている間も DB を読める（WAL。それらは書かない）。形式の移行より前に取る（core/data-schema.mjs、core/server.mjs）。
// 同じプロセスの中では何度取ってもよい（数えて、最後の 1 つが離したときに手放す）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n.mjs';
import { loadSqlite } from './db.mjs';

export const LOCK_FILE = 'pleiad.lock';       // 持ち主の表示用（PID）。判断には使わない
export const LOCK_DB_FILE = 'pleiad.lock.db'; // OS のロックを持つ小さな SQLite
const held = new Map();   // 解決した置き場 -> { count, token, info, db }

/** 取れなかったときの例外（pid は表示用の持ち主。分からなければ null）。メッセージは画面・起動ログにそのまま出る */
export class DataLockedError extends Error {
  constructor(pid, dir) {
    super(t('data.locked', { pid: pid ?? '?', dir }));
    this.code = 'DATA_LOCKED';
    this.pid = pid ?? null;
  }
}

/** 他のプロセスが排他ロックを持っているときの SQLite のエラー（SQLITE_BUSY=5・SQLITE_LOCKED=6） */
const isBusy = e => e?.errcode === 5 || e?.errcode === 6 || /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(e?.message ?? ''));

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** pleiad.lock.db を開いて排他ロックを取る。他のプロセスが持っていれば busy で投げる。取れたら接続（ロックを持つ）を返す */
function lockDatabase(file) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS lock_owner (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT)');
    db.exec('COMMIT');   // EXCLUSIVE モードでは、コミットしても接続を閉じるまで排他ロックを持ち続ける
    return db;
  } catch (e) {
    try { db.close(); } catch { /* 閉じるだけ */ }
    throw e;
  }
}

/**
 * 取る。戻り値は離す関数（何度呼んでも 1 回として数える）。pid はテストが表示用の持ち主を差し替えるためのもの
 */
export function acquireDataLock(dir, { pid = process.pid } = {}) {
  const key = path.resolve(dir);
  if (!held.has(key)) {
    fs.mkdirSync(key, { recursive: true });
    const file = path.join(key, LOCK_DB_FILE);
    const info = path.join(key, LOCK_FILE);
    let db;
    try { db = lockDatabase(file); }
    catch (e) {
      if (isBusy(e)) throw new DataLockedError(readOwner(info)?.pid, key);
      // SQLite のファイルでない（壊れた・途中で切れた）: 持ち主はいないので作り直す。消せなければ元の例外
      fs.rmSync(file, { force: true });
      db = lockDatabase(file);
    }
    const token = crypto.randomUUID();
    try { fs.writeFileSync(info, JSON.stringify({ pid, token, startedAt: new Date().toISOString() })); } catch { /* 表示だけ。書けなくても排他は効いている */ }
    held.set(key, { count: 0, token, info, db });
  }
  const slot = held.get(key);
  slot.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--slot.count > 0) return;
    held.delete(key);
    try { if (readOwner(slot.info)?.token === slot.token) fs.rmSync(slot.info, { force: true }); } catch { /* 表示だけ */ }
    try { slot.db.close(); } catch { /* 閉じるだけ。プロセスが終われば OS が外す */ }
  };
}

// 正常に終わるとき（process.exit・シグナルを含む）は、持っているロックを手放す。強制終了・電源断のあとは、OS が外している
process.on('exit', () => {
  for (const slot of held.values()) {
    try { if (readOwner(slot.info)?.token === slot.token) fs.rmSync(slot.info, { force: true }); } catch { /* 表示だけ */ }
    try { slot.db.close(); } catch { /* 閉じるだけ */ }
  }
});
