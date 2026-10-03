import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';
import { readSessions } from '../lib/data-store.mjs';

export const name = 'store-flush';
export const title = '会話ストアの即時保存（変えた項目の行だけ）・旧ファイルの移行・終了時の保存・同じ値の省略';

const run = (dir, script) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], {
  env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: pathToFileURL(path.join(ROOT, 'core', 'store.mjs')).href,
    DB_URL: pathToFileURL(path.join(ROOT, 'core', 'db.mjs')).href,
    SHUTDOWN_URL: pathToFileURL(path.join(ROOT, 'core', 'shutdown.mjs')).href },
}, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-store-flush-'));
  try {
    // 整形済みの旧 sessions.json（形式 1）を置いておく。最初に触ったときに SQLite へ移る
    await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify({ old: { history: [], title: '以前' } }, null, 2));
    const result = JSON.parse(await run(dir, `
      const { openReadOnly } = await import(process.env.DB_URL);
      const store = await import(process.env.STORE_URL);
      const old = (await store.get('old')).title;
      const reader = openReadOnly(process.env.AGENT_HOST_DATA);
      const version = () => reader.prepare('PRAGMA data_version').get().data_version;
      const row = (field) => reader.prepare('SELECT value FROM session_fields WHERE session_id = ? AND field = ?').get('old', field)?.value;
      await store.setMeta('old', { title: '変更1' });
      await store.setMeta('old', { title: '変更2' });
      const title = row('title');
      await store.setSessionData('old', 'contextSession', { report: 1 });
      const context = row('contextSession');
      const before = version();
      await store.setSessionData('old', 'contextSession', { report: 1 });
      await store.setMeta('old', { title: '変更2' });
      const same = version() === before;
      await store.setSessionData('old', 'outbox', [{ id: 'queued' }], { durable: true });
      const durable = row('outbox');
      const untouched = row('history');
      console.log(JSON.stringify({ old, title, context, same, durable, untouched }));
    `));
    t.ok('旧 sessions.json（整形済み）を読んで SQLite へ移す', result.old === '以前');
    t.ok('setMeta は最新値をすぐ DB に書く（デバウンスしない）', result.title === JSON.stringify('変更2'));
    t.ok('setSessionData も変えた項目の行をすぐ書く', result.context === JSON.stringify({ report: 1 }));
    t.ok('同じ値の setSessionData・setMeta は書き直さない', result.same === true);
    t.ok('durable 指定の setSessionData も復帰前に書く', JSON.parse(result.durable)[0].id === 'queued');
    t.ok('触っていない項目の行は残る', result.untouched === '[]');
    t.ok('移行した元の JSON は消え、写しが残る', !(await fs.stat(path.join(dir, 'sessions.json')).then(() => true, () => false))
      && (await fs.readdir(dir)).some(name => name.startsWith('backup-schema1-')));

    const shutdown = JSON.parse(await run(dir, `
      const store = await import(process.env.STORE_URL);
      const { finishShutdown } = await import(process.env.SHUTDOWN_URL);
      await store.setSessionData('old', 'contextSession', { report: 2 });
      let exited = false;
      finishShutdown(store.flushNow, () => true, () => { exited = true; });
      console.log(JSON.stringify({ exited }));
    `));
    t.ok('作業中の shutdown 合図でも書き終えて終了しない', shutdown.exited === false && readSessions(dir).old.contextSession.report === 2);

    await run(dir, `
      const store = await import(process.env.STORE_URL);
      await store.setMeta('old', { title: '終了直前' });
      process.exit(0);
    `);
    t.ok('終了直前の変更も残る', readSessions(dir).old.title === '終了直前');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
