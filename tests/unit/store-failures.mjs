// どの公開関数も、DB への書き込みが失敗したら例外を返し、メモリ上の記録を書く前の値のままにする（ADR 0106）。
// 書き込みを失敗させる: 別の接続が書き込みのロック（BEGIN IMMEDIATE）を持つ。store の書き込みは数百 ms 待って SQLITE_BUSY で失敗する。
// ロックを手放せば、同じ呼び出しが通り、メモリと DB が同じになる。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';

export const name = 'store-failures';
export const title = '書き込みの失敗: どの公開関数も例外を返し、メモリは書く前のまま（再起動に要る項目も）';

const url = file => pathToFileURL(path.join(ROOT, file)).href;
const SCRIPT = `
  const store = await import(process.env.STORE_URL);
  const { openRaw, openReadOnly, dbPath, sessionTable } = await import(process.env.DB_URL);
  const canon = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
  await store.setMeta('a', { title: 't', completedAt: 1000, turnStartedAt: 2000, cwd: 'C:/w' });
  await store.setMeta('b', { title: 'b' });
  await store.setSessionData('a', 'outbox', [{ id: 'm1', status: 'queued' }]);
  await store.addStops('a', { tasks: [{ key: 'k1', taskId: 'x' }], reason: 'user' });
  const ops = {
    'setMeta(再起動に要る項目)': () => store.setMeta('a', { completedAt: 5000, unsent: 'u', interrupted: { at: 1, reason: 'user' }, turnStartedAt: null }),
    'setMeta(新しい会話)': () => store.setMeta('fresh', { title: 'new' }),
    setMode: () => store.setMode('a', 'plan'),
    setModel: () => store.setModel('a', 'm'),
    setParent: () => store.setParent('a', 'p'),
    'setSessionData(durable)': () => store.setSessionData('a', 'outbox', [{ id: 'm1', status: 'sent' }], { durable: true }),
    'setSessionData(durable でない)': () => store.setSessionData('a', 'draft', { text: 'd' }),
    'setSessionData(新しい会話)': () => store.setSessionData('fresh2', 'outbox', [{ id: 1 }], { durable: true }),
    recordChange: () => store.recordChange('a', { by: 'human', field: 'title', from: 't', to: 'u', reason: null }),
    markRead: () => store.markRead([['a', 900]]),
    recoverInterruptedTurns: () => store.recoverInterruptedTurns(9999),
    addStops: () => store.addStops('a', { approvals: [{ key: 'k2' }] }),
    takeStops: () => store.takeStops('a', ['k1']),
    clearStops: () => store.clearStops('a'),
    inheritSettings: () => store.inheritSettings('a', 'child'),
    removeSession: () => store.removeSession('b'),
  };
  const snapshot = async () => canon(await store.getAll());
  const dbState = () => { const r = openReadOnly(process.env.DIR); try { return canon(sessionTable(r).loadAll()); } finally { r.close(); } };
  const before = await snapshot();
  const beforeDb = dbState();
  // 別の接続が書き込みのロックを持つ
  const blocker = openRaw(dbPath(process.env.DIR));
  blocker.exec('BEGIN IMMEDIATE');
  const failed = {};
  for (const [name, op] of Object.entries(ops)) {
    const error = await op().then(() => null, e => e.message);
    failed[name] = { threw: error !== null, memoryUnchanged: (await snapshot()) === before };
  }
  blocker.exec('ROLLBACK');
  blocker.close();
  const dbUntouched = dbState() === beforeDb;
  const succeeded = {};
  for (const [name, op] of Object.entries(ops)) {
    const error = await op().then(() => null, e => e.message);
    succeeded[name] = error;
  }
  console.log(JSON.stringify({ failed, dbUntouched, succeeded, same: (await snapshot()) === dbState(), after: JSON.parse(await snapshot()) }));
`;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-store-failures-'));
  try {
    const result = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      env: { ...process.env, AGENT_HOST_DATA: dir, DIR: dir, STORE_URL: url('core/store.mjs'), DB_URL: url('core/db.mjs') }, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop()))));
    for (const [name, r] of Object.entries(result.failed)) {
      t.ok(`${name}: DB に書けなければ例外を返し、メモリは書く前のまま`, r.threw && r.memoryUnchanged, JSON.stringify(r));
    }
    t.ok('失敗した間、DB の中身は 1 つも変わらない', result.dbUntouched === true);
    t.ok('ロックを手放せば、同じ呼び出しが全部通る', Object.values(result.succeeded).every(error => error === null), JSON.stringify(result.succeeded));
    t.ok('通ったあとは、メモリの記録と DB の記録が同じ', result.same === true);
    const a = result.after.a, b = result.after.b;
    t.ok('通った書き込みが反映されている（再起動に要る項目・履歴・stops・継承）', a.completedAt === 5000 && a.unsent === 'u' && a.interrupted?.reason === 'user' && a.mode === 'plan' && a.model === 'm' && a.parent === 'p'
      && a.history?.some(h => h.field === 'title') && result.after.fresh?.title === 'new' && result.after.child?.mode === 'plan' && b === undefined, JSON.stringify(a).slice(0, 300));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
