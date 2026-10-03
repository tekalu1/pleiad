// データ置き場のプロセス単位の排他（core/data-lock.mjs、ADR 0106）。
// 同じ置き場を 2 つのプロセスが開くと、片方がメモリに持った会話の記録が、もう片方の削除・更新と食い違い、
// 消した会話が欠けた形で戻る。起動から終了まで 1 つのプロセスだけが持つ。ロックは OS がプロセスの終了で外す SQLite の排他ロック
// （core/data-lock.mjs）で、PID の生死では判断しない（Windows は PID をすぐ使い回す）。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, startServer } from '../lib/server.mjs';
import { acquireDataLock, DataLockedError, LOCK_FILE, LOCK_DB_FILE } from '../../core/data-lock.mjs';
import { ensureDataSchema, openData } from '../../core/data-schema.mjs';
import { readSessions } from '../lib/data-store.mjs';

export const name = 'data-lock';
export const title = 'データ置き場のロック: 別プロセスが持っている間は起動を止める・強制終了で OS が外す（PID で判断しない）・消した会話を更新で戻さない';

const url = file => pathToFileURL(path.join(ROOT, file)).href;
const exists = file => fs.stat(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = dir => ({ ...process.env, AGENT_HOST_DATA: dir, AGENT_HOST_LOCALE: 'ja', LOCK_URL: url('core/data-lock.mjs'), STORE_URL: url('core/store.mjs'), DB_URL: url('core/db.mjs'), DIR: dir });

/** ロックを持ったまま待つ別プロセス。{ pid, kill() } */
async function holder(dir, script = `const { acquireDataLock } = await import(process.env.LOCK_URL); acquireDataLock(process.env.DIR); console.log('held ' + process.pid); setInterval(() => {}, 1000);`) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: env(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  const pid = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { out += chunk; const m = /held (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.once('exit', code => reject(new Error(`holder exited ${code}\n${err}`)));
  });
  return { pid, async kill() { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; } };
}
const run = (dir, script) => new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', script], { env: env(dir), maxBuffer: 16 * 1024 * 1024 },
  (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-data-lock-'));
  const tmp = async label => { const dir = path.join(root, label); await fs.mkdir(dir, { recursive: true }); return dir; };
  const servers = [];
  try {
    // ---- 同じプロセスの中: 何度でも取れ、最後の 1 つが離したらファイルが消える
    {
      const dir = await tmp('same-process');
      const one = acquireDataLock(dir), two = acquireDataLock(dir);
      const body = JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8'));
      t.ok('ロックファイルに PID を書く', body.pid === process.pid && typeof body.token === 'string' && typeof body.startedAt === 'string');
      one(); one();
      t.ok('同じプロセスの中は何度取ってもよく、残りがある間はファイルを消さない（離す操作は 1 回として数える）', await exists(path.join(dir, LOCK_FILE)));
      two();
      t.ok('最後の 1 つが離したらファイルを消す', !(await exists(path.join(dir, LOCK_FILE))));
    }

    // ---- 別のプロセスが持っている間は取れない。落ちて残ったロックは取り直す
    {
      const dir = await tmp('other-process');
      const other = await holder(dir);
      const error = (() => { try { acquireDataLock(dir); return null; } catch (e) { return e; } })();
      t.ok('生きている別のプロセスが持っていれば、取れずに理由（PID）を出す', error instanceof DataLockedError && error.pid === other.pid && /別の Pleiad/.test(error.message) && error.message.includes(String(other.pid)), error?.message);
      t.ok('取れなかったときは、持ち主のロックに触れない', JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).pid === other.pid);
      const opened = (() => { try { openData(dir); return null; } catch (e) { return e; } })();
      t.ok('openData（store・usage・agent-tasks・conversations が通る）も止まる', opened?.code === 'DATA_LOCKED');
      await other.kill();   // 強制終了: ロックファイルは残る
      t.ok('強制終了で、持ち主のいないロックファイルが残る', await exists(path.join(dir, LOCK_FILE)));
      const release = acquireDataLock(dir);
      t.ok('持ち主がもういないロック（PID が死んでいる）は取り直す', JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).pid === process.pid);
      release();
    }
    {
      // PID は表示だけで、判断に使わない: 落ちて残ったファイルの PID が生きている別のプロセスに使われていても、起動できる
      const dir = await tmp('stale-variants');
      await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, token: 'x' }));   // 生きているプロセス（このテスト自身）の PID
      const a = acquireDataLock(dir);
      t.ok('残ったロックファイルの PID が生きているプロセスのものでも、持ち主がいなければ取れる（PID で判断しない）', JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).token !== 'x');
      a();
      await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.ppid, token: 'x' }));   // 親プロセス（生きている）の PID
      const parentPid = acquireDataLock(dir); parentPid();
      await fs.writeFile(path.join(dir, LOCK_FILE), 'garbage, not json');
      const b = acquireDataLock(dir); b();
      await fs.writeFile(path.join(dir, LOCK_FILE), '');
      const c = acquireDataLock(dir); c();
      t.ok('壊れた・空の pleiad.lock（表示用）があっても取れる', true);
      await fs.writeFile(path.join(dir, LOCK_DB_FILE), 'not a sqlite database, a leftover');
      const d = acquireDataLock(dir);
      t.ok('壊れた pleiad.lock.db（SQLite でない）は作り直して取れる', (await fs.stat(path.join(dir, LOCK_DB_FILE))).size > 0 && !(await fs.readFile(path.join(dir, LOCK_DB_FILE))).includes('leftover'));
      d();
      // 持ち主がいる間は、表示の PID が死んでいる PID でも取れない（判断は OS のロック）
      const other = await holder(dir);
      await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 99999999, token: 'x' }));
      const held = (() => { try { acquireDataLock(dir); return null; } catch (e) { return e; } })();
      t.ok('持ち主が生きていれば、表示の PID が死んだものでも取れない（判断は OS のロック。表示の PID は持ち主のものとは限らない）', held?.code === 'DATA_LOCKED' && held.pid === 99999999);
      await other.kill();
      const after = acquireDataLock(dir); after();
      t.ok('持ち主が強制終了したら、表示の PID に関わらず取れる', true);
    }

    // ---- store: 持っている間は別のプロセスが store を開けず、形式の移行にも入れない
    {
      const dir = await tmp('store');
      const other = await holder(dir, `const store = await import(process.env.STORE_URL); await store.setMeta('a', { title: 'x' }); console.log('held ' + process.pid); setInterval(() => {}, 1000);`);
      const second = await run(dir, `const store = await import(process.env.STORE_URL); await store.getAll();`);
      t.ok('store を開いている間、別のプロセスの store は起動できない（理由に PID）', second.code !== 0 && /別の Pleiad/.test(second.stderr) && second.stderr.includes(String(other.pid)), second.stderr.slice(0, 300));
      await other.kill();
      const third = await run(dir, `const store = await import(process.env.STORE_URL); console.log(JSON.stringify(Object.keys(await store.getAll())));`);
      t.ok('持ち主が落ちたあとは、別のプロセスが引き継げる（記録も残っている）', third.code === 0 && JSON.parse(third.stdout.trim().split(/\r?\n/).pop()).includes('a'), third.stderr.slice(0, 300));
    }
    {
      const dir = await tmp('migration');
      await fs.writeFile(path.join(dir, 'sessions.json'), '{"a":{"title":"x"}}');
      await fs.writeFile(path.join(dir, 'data-schema.json'), '{"schema":1}');
      const other = await holder(dir);
      const error = await ensureDataSchema(dir).then(() => null, e => e);
      t.ok('別のプロセスが持っている間は、形式の移行も始めない（元の JSON はそのまま）', error?.code === 'DATA_LOCKED' && (await fs.readFile(path.join(dir, 'sessions.json'), 'utf8')) === '{"a":{"title":"x"}}'
        && !(await exists(path.join(dir, 'pleiad.db'))), error?.message);
      await other.kill();
    }

    // ---- 消した会話を、更新で欠けた形のまま戻さない（別の手段で DB から消えた会話）
    {
      const dir = await tmp('resurrect');
      const result = await run(dir, `
        const store = await import(process.env.STORE_URL);
        const { openRaw, openReadOnly, dbPath, sessionTable } = await import(process.env.DB_URL);
        const ops = {
          setMeta: id => store.setMeta(id, { title: 'resurrected' }),
          setSessionData: id => store.setSessionData(id, 'draft', { text: 'x' }),
          recordChange: id => store.recordChange(id, { by: 'human', field: 'title', from: 'a', to: 'b' }),
          setMode: id => store.setMode(id, 'plan'),
        };
        await store.setMeta('other', { title: 'kept' });
        for (const name of Object.keys(ops)) await store.setMeta('victim-' + name, { title: 'original', completedAt: 5 });
        await store.getAll();
        const raw = openRaw(dbPath(process.env.DIR));
        for (const name of Object.keys(ops)) sessionTable(raw).remove('victim-' + name);
        raw.close();
        const errors = {};
        for (const [name, run] of Object.entries(ops)) errors[name] = await run('victim-' + name).then(() => null, e => e.message);
        const reader = openReadOnly(process.env.DIR);
        const rows = reader.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id LIKE 'victim-%'").get().n;
        const fields = reader.prepare("SELECT field FROM session_fields WHERE session_id LIKE 'victim-%'").all().map(r => r.field);
        reader.close();
        const all = await store.getAll();
        console.log(JSON.stringify({ errors, rows, fields, inMemory: Object.keys(all).filter(id => id.startsWith('victim-')), other: all.other?.title }));
      `);
      const out = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}');
      t.ok('DB から消えた会話を更新しても、欠けた形で作り直さない（行も項目も無いまま）', out.rows === 0 && out.fields?.length === 0, result.stdout + result.stderr.slice(0, 300));
      t.ok('更新は例外で返り、その会話はメモリからも外れる。ほかの会話は変わらない', Object.values(out.errors ?? {}).length === 4 && Object.values(out.errors).every(message => /removed from the data store/.test(message ?? '')) && out.inMemory?.length === 0 && out.other === 'kept', JSON.stringify(out));
    }

    // ---- サーバー: 同じデータ置き場へ 2 台目は起動しない
    {
      const dir = await tmp('server');
      const first = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: dir });
      servers.push(first);
      const body = JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8'));
      const error = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: dir, timeoutMs: 30_000 }).then(second => { servers.push(second); return null; }, e => e);
      t.ok('同じデータ置き場へ 2 台目のサーバーは起動せず、理由（持ち主の PID）を出して終わる', /別の Pleiad/.test(error?.message ?? '') && error.message.includes(String(body.pid)), error?.message?.slice(0, 400));
      t.ok('起動に失敗した 2 台目は、1 台目のロックに触れない', JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).pid === body.pid);
      await first.stop();
      const again = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: dir });
      servers.push(again);
      t.ok('1 台目が終わったあとは（強制終了でロックが残っていても）起動し直せる', JSON.parse(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).pid !== body.pid);
      void readSessions; void sleep;
    }
  } finally {
    for (const server of servers) await server.stop().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
