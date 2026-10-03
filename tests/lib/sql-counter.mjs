// SQL の書き込みの量を数える: 文の実行ごとに、変わった行数（changes）と、文に渡した値の大きさ（文字列・バイト列の引数の長さ）を足す。
// node:sqlite の StatementSync#run を差し替える（core/db.mjs の loadSqlite と同じモジュール）。start() から stop() の間だけ数える。
// ファイルの大きさ（WAL の長さ）と違い、WAL を使い回しても実際の書き込み量を表す。
import { loadSqlite } from '../../core/db.mjs';

export function sqlCounter() {
  const { DatabaseSync } = loadSqlite();
  const probe = new DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  const original = proto.run;
  let counting = false;
  let stats = { statements: 0, changes: 0, bytes: 0 };
  proto.run = function (...args) {
    const result = original.apply(this, args);
    if (counting) {
      stats.statements++;
      stats.changes += Number(result.changes);
      for (const arg of args) {
        if (typeof arg === 'string') stats.bytes += Buffer.byteLength(arg);
        else if (arg instanceof Uint8Array) stats.bytes += arg.byteLength;
      }
    }
    return result;
  };
  return {
    start() { stats = { statements: 0, changes: 0, bytes: 0 }; counting = true; },
    stop() { counting = false; return stats; },
    restore() { proto.run = original; },
    /** fn の間だけ数えて返す */
    async measure(fn) { this.start(); try { await fn(); } finally { counting = false; } return stats; },
  };
}
