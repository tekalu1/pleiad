// ターンの後の履歴の読み出し（取り込み: core/conversations.mjs の runOnce、委譲の結果: core/server.mjs の execute）を、
// 一時的な SQLite のエラーなら間を空けて読み直す。
// Codex は止めたばかりのターン用の app-server と共有の app-server が同じ履歴の DB を開くので、Windows では
// 縮める処理（WAL の切り詰め）がぶつかり、`(code: 1546) disk I/O error`（SQLITE_IOERR_TRUNCATE）で一時的に読めないことがある。
// 少し後に読み直すと読める（2026-10-06。openai/codex #49605 も同じ形。docs/agent-delegation.md「子の結果」）。

/** 読み直すまでの間（ミリ秒）。この回数だけ読み直す */
export const HISTORY_RETRY_DELAYS_MS = [500, 1000, 2000];

// SQLite の主コード。拡張コードは下位 8 ビットが主コード（1546 = 10 + 6 * 256 = SQLITE_IOERR_TRUNCATE）
const SQLITE_BUSY = 5, SQLITE_LOCKED = 6, SQLITE_IOERR = 10;
const TRANSIENT_CODES = new Set([SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR]);

/**
 * 待てば直る SQLite のエラーか（I/O エラー・ロック中）。文面で見る（Codex は JSON-RPC の -32603 に SQLite のコードを文で載せる）。
 * 壊れている（malformed）などの待っても直らないものは偽
 */
export function transientStorageError(err) {
  const text = String(err?.message ?? err ?? '');
  const code = /\(code:\s*(\d+)\)/i.exec(text);
  if (code && TRANSIENT_CODES.has(Number(code[1]) & 0xff)) return true;
  return /disk I\/O error|SQLITE_(?:IOERR|BUSY|LOCKED)\b|database (?:table )?is locked/i.test(text);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * read() を呼ぶ。一時的な SQLite のエラー（transientStorageError）なら delays の間を空けて読み直し、尽きたら最後のエラーを投げる。
 * それ以外のエラーはすぐ投げる。onRetry(err, 何回目, 待つミリ秒) は読み直す前に呼ぶ（ログ用）
 */
export async function readWithRetry(read, { delays = HISTORY_RETRY_DELAYS_MS, sleep = pause, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (err) {
      if (!transientStorageError(err) || attempt >= delays.length) throw err;
      onRetry(err, attempt + 1, delays[attempt]);
      await sleep(delays[attempt]);
    }
  }
}
