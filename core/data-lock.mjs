// データ置き場をプロセス単位で排他する（ADR 0106）。
//
// 同じデータ置き場を 2 つのプロセスが開くと、片方がメモリに持った会話の記録が、もう片方の削除・更新と食い違い、
// 消した会話が欠けた形で戻る。起動から終了まで 1 つのプロセスだけが持つようにする。
// 置き場の pleiad.lock に PID を書き、生きている別のプロセスが持っていれば起動を止めて理由を出す。古いロック（持ち主が
// もういない）は PID の生死で判断して取り直す。形式の移行の前に取る（core/data-schema.mjs、core/server.mjs）。
// SQLite の locking_mode=EXCLUSIVE ではなくロックファイルにした理由: 別の接続でこの置き場を読む道具（scripts/copy-data-dir.mjs・
// テスト・調査）が、サーバーが動いている間も DB を読める（WAL）ようにするため。それらは書かない。
// 同じプロセスの中では何度取ってもよい（数えて、最後の 1 つが離したときに消す）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n.mjs';

export const LOCK_FILE = 'pleiad.lock';
const held = new Map();   // 解決した置き場 -> { count, token, file }

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** PID のプロセスが生きているか。権限が無くて信号を送れない（EPERM）なら、生きている */
const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
};

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 取れなかったときの例外（pid は持っているプロセス）。メッセージは画面・起動ログにそのまま出る */
export class DataLockedError extends Error {
  constructor(pid, dir) {
    super(t('data.locked', { pid, dir }));
    this.code = 'DATA_LOCKED';
    this.pid = pid;
  }
}

/**
 * 取る。戻り値は離す関数（何度呼んでも 1 回として数える）。pid・isAlive はテストが持ち主を差し替えるためのもの
 */
export function acquireDataLock(dir, { pid = process.pid, isAlive = processAlive } = {}) {
  const key = path.resolve(dir);
  const mine = held.get(key);
  if (!mine) {
    fs.mkdirSync(key, { recursive: true });
    const file = path.join(key, LOCK_FILE);
    const token = crypto.randomUUID();
    let taken = false;
    for (let attempt = 0; attempt < 5 && !taken; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx');
        try { fs.writeSync(fd, JSON.stringify({ pid, token, startedAt: new Date().toISOString() })); } finally { fs.closeSync(fd); }
        taken = true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // 作った直後でまだ中身が無い（別のプロセスが書く前）かもしれないので、少し待って読み直す
        let owner = readOwner(file);
        for (let wait = 0; !owner && wait < 4; wait++) { sleep(50); owner = readOwner(file); }
        if (owner && Number.isInteger(owner.pid) && owner.pid !== pid && isAlive(owner.pid)) throw new DataLockedError(owner.pid, key);
        // 持ち主がもういない（落ちて残った）か、壊れている: 取り直す
        fs.rmSync(file, { force: true });
      }
    }
    if (!taken || readOwner(file)?.token !== token) throw new DataLockedError(readOwner(file)?.pid ?? 0, key);
    held.set(key, { count: 0, token, file });
  }
  const slot = held.get(key);
  slot.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--slot.count > 0) return;
    held.delete(key);
    if (readOwner(slot.file)?.token === slot.token) fs.rmSync(slot.file, { force: true });
  };
}

// 正常に終わるとき（process.exit・シグナルを含む）は、持っているロックを消す。強制終了で残ったものは次の起動が PID で見分ける
process.on('exit', () => {
  for (const slot of held.values()) {
    try { if (readOwner(slot.file)?.token === slot.token) fs.rmSync(slot.file, { force: true }); } catch { /* 次の起動が取り直す */ }
  }
});
