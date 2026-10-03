// core/server.mjs の中だけで、DB への書き込み（INSERT・UPDATE・DELETE）を失敗させる（NODE_OPTIONS=--import=<このファイル>）。
// PLEIAD_FAIL_FLAG のファイルがある間だけ失敗させる（テストが作る・消す）。サーバーの子プロセスだけに効く
// （サーバー以外の node プロセスでは何もしない）。tests/unit/server-store-failures.mjs が使う。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const entry = String(process.argv[1] ?? '').replaceAll('\\', '/');
const flag = process.env.PLEIAD_FAIL_FLAG;
if (flag && entry.endsWith('core/server.mjs')) {
  const original = process.emitWarning;
  process.emitWarning = () => {};
  let sqlite;
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } finally { process.emitWarning = original; }
  const probe = new sqlite.DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  const run = proto.run;
  proto.run = function (...args) {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(String(this.sourceSQL ?? '')) && fs.existsSync(flag)) {
      throw Object.assign(new Error('injected store failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return run.apply(this, args);
  };
}
