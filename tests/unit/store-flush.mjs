import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';

export const name = 'store-flush';
export const title = '会話ストアのまとめ書き・旧ファイル・終了時の保存・同じ値の省略';

const run = (dir, script) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', script], {
  env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: pathToFileURL(path.join(ROOT, 'core', 'store.mjs')).href,
    SHUTDOWN_URL: pathToFileURL(path.join(ROOT, 'core', 'shutdown.mjs')).href },
}, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-store-flush-'));
  const file = path.join(dir, 'sessions.json');
  try {
    await fs.writeFile(file, JSON.stringify({ old: { history: [], title: '以前' } }, null, 2));
    const result = JSON.parse(await run(dir, `
      const fs = await import('node:fs/promises');
      const store = await import(process.env.STORE_URL);
      const file = process.env.AGENT_HOST_DATA + '/sessions.json';
      const old = (await store.get('old')).title;
      await store.setMeta('old', { title: '変更1' });
      await store.setMeta('old', { title: '変更2' });
      const memory = (await store.get('old')).title;
      const before = await fs.readFile(file, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 950));
      const after = await fs.readFile(file, 'utf8');
      await store.setSessionData('old', 'contextSession', { report: 1 });
      const deferred = await fs.readFile(file, 'utf8');
      const inMemory = (await store.get('old')).contextSession.report;
      await new Promise(resolve => setTimeout(resolve, 950));
      const saved = await fs.readFile(file, 'utf8');
      const first = (await fs.stat(file, { bigint: true })).mtimeNs.toString();
      await store.setSessionData('old', 'contextSession', { report: 1 });
      await new Promise(resolve => setTimeout(resolve, 950));
      const same = (await fs.stat(file, { bigint: true })).mtimeNs.toString();
      await store.setSessionData('old', 'outbox', [{ id: 'queued' }], { durable: true });
      const durable = await fs.readFile(file, 'utf8');
      console.log(JSON.stringify({ old, memory, before, after, deferred, inMemory, saved, first, same, durable }));
    `));
    t.ok('整形済みの旧ファイルを読み、デバウンス中もキャッシュは最新', result.old === '以前' && result.memory === '変更2' && JSON.parse(result.before).old.title === '以前');
    t.ok('750ms 後に最新値をコンパクトな JSON で保存', JSON.parse(result.after).old.title === '変更2' && !result.after.includes('\n'));
    t.ok('通常の setSessionData は遅延保存しキャッシュにはすぐ反映', !JSON.parse(result.deferred).old.contextSession && result.inMemory === 1 && JSON.parse(result.saved).old.contextSession.report === 1);
    t.ok('同じ setSessionData はデバウンス時間後も書き直さない', result.first === result.same);
    t.ok('durable 指定の setSessionData は復帰前に保存する', JSON.parse(result.durable).old.outbox[0].id === 'queued');

    const shutdown = JSON.parse(await run(dir, `
      const fs = await import('node:fs/promises');
      const store = await import(process.env.STORE_URL);
      const { finishShutdown } = await import(process.env.SHUTDOWN_URL);
      await store.setSessionData('old', 'contextSession', { report: 2 });
      let exited = false;
      finishShutdown(store.flushNow, () => true, () => { exited = true; });
      console.log(JSON.stringify({ exited, saved: JSON.parse(await fs.readFile(process.env.AGENT_HOST_DATA + '/sessions.json', 'utf8')).old.contextSession.report }));
    `));
    t.ok('作業中の shutdown 合図でも保留分を同期保存して終了しない', shutdown.exited === false && shutdown.saved === 2);

    await run(dir, `
      const store = await import(process.env.STORE_URL);
      await store.setMeta('old', { title: '終了直前' });
      process.exit(0);
    `);
    t.ok('終了直前の変更も同期で保存する', JSON.parse(await fs.readFile(file, 'utf8')).old.title === '終了直前');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
