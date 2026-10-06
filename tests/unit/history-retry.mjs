// ターンの後の履歴の読み出しの読み直し（core/history-retry.mjs）と、ターン用の app-server の止め方（core/backends/codex-rpc.mjs の stop）。
// 2026-09-27 以降、Codex の子のタスクが作業と報告を終えた後に、履歴の読み出しの `(code: 1546) disk I/O error` で「失敗」になった。
// 待てば直るエラーだけを間を空けて読み直し、それ以外はすぐ投げる。stop はプロセスが終わるまで待てる（止めた直後に共有の app-server が読むため）
import path from 'node:path';
import { HISTORY_RETRY_DELAYS_MS, readWithRetry, transientStorageError } from '../../core/history-retry.mjs';
import { CodexRpc } from '../../core/backends/codex-rpc.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'history-retry';
export const title = '履歴の読み出しの読み直し: 一時的な SQLite のエラーだけを 0.5・1・2 秒の間で読み直す・ターン用の app-server の終わりを待てる';

const IOERR = 'codex -32603: failed to list thread history: thread-store internal error: failed to access thread history: error returned from database: (code: 1546) disk I/O error';

/** times 回だけ error で失敗し、その後は value を返す読み出し */
function flaky(times, error, value = 'ok') {
  const read = async () => {
    read.calls++;
    if (read.calls <= times) throw new Error(error);
    return value;
  };
  read.calls = 0;
  return read;
}

export default async function (t) {
  // ---- 見分け
  t.ok('1546（SQLITE_IOERR_TRUNCATE）は一時的', transientStorageError(new Error(IOERR)));
  t.ok('ほかの I/O エラーの拡張コードも一時的（522 = SQLITE_IOERR_SHORT_READ）', transientStorageError(new Error('error returned from database: (code: 522) disk I/O error')));
  t.ok('ロック中（5 = SQLITE_BUSY・文面）も一時的', transientStorageError(new Error('error returned from database: (code: 5) database is locked'))
    && transientStorageError(new Error('SQLITE_BUSY: database is locked')));
  t.ok('壊れている（11 = SQLITE_CORRUPT）は一時的でない', !transientStorageError(new Error('error returned from database: (code: 11) database disk image is malformed')));
  t.ok('SQLite と関係の無いエラーは一時的でない', !transientStorageError(new Error('codex -32600: thread not found')) && !transientStorageError(null));

  // ---- 読み直し（待ちは記録するだけで実際には待たない）
  const run = async (read) => {
    const slept = [], retried = [];
    let value = null, error = null;
    try { value = await readWithRetry(read, { sleep: async (ms) => { slept.push(ms); }, onRetry: (_e, n, ms) => retried.push([n, ms]) }); }
    catch (e) { error = e; }
    return { value, error, slept, retried };
  };
  t.ok('既定の間は 0.5・1・2 秒', JSON.stringify(HISTORY_RETRY_DELAYS_MS) === '[500,1000,2000]');
  {
    const read = flaky(1, IOERR, 'messages');
    const r = await run(read);
    t.ok('1 回失敗したら 0.5 秒空けて読み直し、読めた値を返す', r.value === 'messages' && read.calls === 2 && JSON.stringify(r.slept) === '[500]', JSON.stringify(r));
  }
  {
    const read = flaky(2, IOERR, 'messages');
    const r = await run(read);
    t.ok('2 回失敗しても 0.5・1 秒空けて読み直して読める', r.value === 'messages' && read.calls === 3 && JSON.stringify(r.slept) === '[500,1000]'
      && JSON.stringify(r.retried) === '[[1,500],[2,1000]]', JSON.stringify(r));
  }
  {
    const read = flaky(Infinity, IOERR);
    const r = await run(read);
    t.ok('出続けたら 3 回読み直した後に最後のエラーを投げる', read.calls === 4 && r.error?.message === IOERR && JSON.stringify(r.slept) === '[500,1000,2000]', JSON.stringify({ calls: read.calls, slept: r.slept }));
  }
  {
    const read = flaky(Infinity, 'codex -32600: thread not found');
    const r = await run(read);
    t.ok('一時的でないエラーは読み直さずにすぐ投げる', read.calls === 1 && r.slept.length === 0 && r.error?.message === 'codex -32600: thread not found');
  }

  // ---- ターン用の app-server を止めるときに、プロセスの終わりを待てる
  const previous = process.env.AGENT_HOST_CODEX_BIN;
  process.env.AGENT_HOST_CODEX_BIN = `"${process.execPath}" "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`;
  const rpc = new CodexRpc();
  try {
    await rpc.start();
    const proc = rpc.proc;
    const stopped = rpc.stop();
    t.ok('stop は Promise を返す', typeof stopped?.then === 'function');
    await stopped;
    t.ok('stop が解けた時点でプロセスは終わっている', proc.exitCode !== null || proc.signalCode !== null, JSON.stringify({ exitCode: proc.exitCode, signalCode: proc.signalCode }));
    const again = Date.now();
    await rpc.stop();
    t.ok('動いていないときの stop はすぐ解ける', Date.now() - again < 500);
  } finally {
    rpc.stop();
    if (previous === undefined) delete process.env.AGENT_HOST_CODEX_BIN; else process.env.AGENT_HOST_CODEX_BIN = previous;
  }
}
