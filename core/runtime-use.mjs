// 版ごとの実行場所（%LOCALAPPDATA%\agent-host-runtime。desktop/runtime.cjs）の「使用中の印」。
//
// 実行場所で走るプロセス（サーバー・保持役。docs/zero-downtime-update/design.md §3.5）は、起動時に run\<版>-<pid>.lock.db を
// 排他ロックで開いたまま持つ。掃除する側（main の desktop/runtime.cjs）は、その版の lock を全部開けられたら誰も使っていないとみなす。
// core/data-lock.mjs と同じく、**OS がプロセスの終了で必ず外すロック**で判断する（PID の生死は見ない。Windows は PID をすぐ使い回す）。
// pleiad CLI のような短いプロセスは印を持たない。
import fs from 'node:fs';
import path from 'node:path';
import { loadSqlite } from './db.mjs';

export const RUN_DIR = 'run';
const LOCK_SUFFIX = '.lock.db';
/** ファイル名 <版>-<pid>.lock.db の分解（版にも - が入る: 0.9.1-0123456789ab） */
const LOCK_NAME = /^(.+)-(\d+)\.lock\.db$/;

/** 付けている印の接続。呼び出し側が外す関数を捨てても、接続（=ロック）が GC で閉じないよう、外すまでここで持つ（core/data-lock.mjs の held と同じ） */
const held = new Set();

const isBusy = e => e?.errcode === 5 || e?.errcode === 6 || /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(e?.message ?? ''));

export const runtimeLockFile = (root, key, pid = process.pid) => path.join(root, RUN_DIR, `${key}-${pid}${LOCK_SUFFIX}`);

/** file を開いて排他ロックを取る。他のプロセスが持っていれば busy で投げる。取れたら接続（ロックを持つ）を返す */
function lockDatabase(file) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS runtime_use (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER)');
    db.exec('COMMIT');   // EXCLUSIVE モードでは、コミットしても接続を閉じるまで排他ロックを持ち続ける
    return db;
  } catch (e) {
    try { db.close(); } catch { /* 閉じるだけ */ }
    throw e;
  }
}

/**
 * root の版 key を使っている印を付ける。戻り値は外す関数（何度呼んでもよい）。プロセスが終われば OS が外す。
 * 印を付けられなくても（書き込めない置き場など）起動は止めず、null を返す。戻り値を捨てても印は外れない（接続はモジュールが持つ）
 */
export function markRuntimeInUse({ root, key, pid = process.pid }) {
  let db;
  try {
    fs.mkdirSync(path.join(root, RUN_DIR), { recursive: true });
    db = lockDatabase(runtimeLockFile(root, key, pid));
  } catch { return null; }
  held.add(db);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(db);
    try { db.close(); } catch { /* 閉じるだけ */ }
    try { fs.rmSync(runtimeLockFile(root, key, pid), { force: true }); } catch { /* 残っても次の掃除が拾う */ }
  };
}

/**
 * root の run\ にある、版 key の印を調べる。誰かが持っていれば true。
 * 持ち主のいない（プロセスが落ちて残った）印のファイルはここで消す。key を省くと、どの版でも使われているものがあるかを調べる
 */
export function isRuntimeInUse({ root, key } = {}) {
  const dir = path.join(root, RUN_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  let inUse = false;
  for (const name of names) {
    const match = LOCK_NAME.exec(name);
    if (!match || (key !== undefined && match[1] !== key)) continue;
    const file = path.join(dir, name);
    let db;
    try { db = lockDatabase(file); }
    catch (e) {
      if (isBusy(e)) { inUse = true; continue; }
      // SQLite のファイルでない（壊れた・途中で切れた）。持ち主はいないので消す
      try { fs.rmSync(file, { force: true }); } catch { /* 消せなければ次回 */ }
      continue;
    }
    try { db.close(); } catch { /* 閉じるだけ */ }
    try { fs.rmSync(file, { force: true }); } catch { /* 消せなければ次回 */ }
  }
  return inUse;
}

/** run\ に残っている印のうち、版 key の一覧（掃除が、使われていない版の印だけを見分けるため） */
export function listRuntimeLockKeys(root) {
  try { return [...new Set(fs.readdirSync(path.join(root, RUN_DIR)).map(name => LOCK_NAME.exec(name)?.[1]).filter(Boolean))]; } catch { return []; }
}
