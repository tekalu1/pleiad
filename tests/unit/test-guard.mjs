// 再発防止: テストが利用者の本物のデータ置き場（~/.agent-host）を開いて、形式の移行で書き換えてしまわないこと（2026-10-03 に起きた）。
//   - tests/run.mjs（tests/lib/test-env.mjs）が、AGENT_HOST_DATA を一時ディレクトリにし、本物の置き場を PLEIAD_TEST_GUARD_HOME に入れる
//   - 守っている置き場を DB・ロック・形式の移行・設定の JSON で開こうとすると例外（core/test-guard.mjs）。子プロセス・サーバーにも効く
// 確かめるときも本物は開かない: 子プロセスは USERPROFILE を空の偽の家へ向け、その中の .agent-host を守らせる。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, startServer } from '../lib/server.mjs';
import { assertNotGuarded, guardedDirectories } from '../../core/test-guard.mjs';

export const name = 'test-guard';
export const title = '再発防止: テスト中に本物の既定のデータ置き場を開こうとすると例外（DB・ロック・移行・設定）。run.mjs は置き場を一時ディレクトリへ向ける';

const url = file => pathToFileURL(path.join(ROOT, file)).href;
const tree = dir => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };

/** 偽の家（USERPROFILE・HOME）で子プロセスを走らせる。守る置き場は偽の家の .agent-host。本物には届かない */
const inFakeHome = (home, script, extraEnv = {}) => {
  const env = { ...process.env, USERPROFILE: home, HOME: home, PLEIAD_TEST_GUARD_HOME: path.join(home, '.agent-host'), AGENT_HOST_LOCALE: 'ja', CORE: url('core'), ...extraEnv };
  if (!('AGENT_HOST_DATA' in extraEnv)) delete env.AGENT_HOST_DATA;   // 既定の置き場（偽の家の .agent-host）を使わせる
  return new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', script], { env, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
};

export default async function (t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ply-test-guard-'));
  try {
    // ---- 守る関数
    const home = path.join(root, 'home', '.agent-host');
    const env = { PLEIAD_TEST_GUARD_HOME: home };
    t.ok('守る置き場そのもの・その中は例外（コード TEST_GUARD）', throws(() => assertNotGuarded(home, 'open', env))?.code === 'TEST_GUARD' && throws(() => assertNotGuarded(path.join(home, 'pleiad.db'), 'open', env))?.code === 'TEST_GUARD'
      && throws(() => assertNotGuarded(path.join(home, 'remote', 'x'), 'open', env))?.code === 'TEST_GUARD');
    t.ok('ほかの置き場・名前が似ているだけのものは通る', throws(() => assertNotGuarded(path.join(root, 'other'), 'open', env)) === null && throws(() => assertNotGuarded(`${home}-copy`, 'open', env)) === null && throws(() => assertNotGuarded(path.dirname(home), 'open', env)) === null);
    t.ok('値が無ければ何もしない（普段の起動）', throws(() => assertNotGuarded(home, 'open', {})) === null && guardedDirectories({}).length === 0);
    t.ok('複数の置き場（path.delimiter 区切り）を守れる', throws(() => assertNotGuarded(path.join(root, 'b'), 'open', { PLEIAD_TEST_GUARD_HOME: [home, path.join(root, 'b')].join(path.delimiter) }))?.code === 'TEST_GUARD');
    if (process.platform === 'win32') t.ok('Windows は大小の違いも同じ置き場として守る', throws(() => assertNotGuarded(home.toUpperCase(), 'open', env))?.code === 'TEST_GUARD');
    t.ok('例外のメッセージに、一時の置き場へ向ける対処がある', /AGENT_HOST_DATA/.test(throws(() => assertNotGuarded(home, 'open', env)).message));

    // ---- このプロセス（tests/run.mjs 経由）の環境
    const real = path.join(os.homedir(), '.agent-host');
    t.ok('run.mjs は、本物の置き場を守る対象に入れている', String(process.env.PLEIAD_TEST_GUARD_HOME ?? '').split(path.delimiter).some(dir => path.resolve(dir).toLowerCase() === path.resolve(real).toLowerCase()), String(process.env.PLEIAD_TEST_GUARD_HOME));
    t.ok('run.mjs は、AGENT_HOST_DATA を本物でない置き場（一時ディレクトリ）に向けている', !!process.env.AGENT_HOST_DATA && path.resolve(process.env.AGENT_HOST_DATA).toLowerCase() !== path.resolve(real).toLowerCase(), process.env.AGENT_HOST_DATA);
    t.ok('本物の置き場を開こうとすると、このプロセスでも例外', throws(() => assertNotGuarded(real, 'open'))?.code === 'TEST_GUARD');
    const runSource = fs.readFileSync(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
    t.ok('tests/run.mjs の最初の import は tests/lib/test-env.mjs（どの import よりも前）', /^import [^\n]*from ["']\.\/lib\/test-env\.mjs["']/m.exec(runSource)?.index === runSource.search(/^import /m));
    const inherited = await new Promise(resolve => execFile(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.AGENT_HOST_DATA, process.env.PLEIAD_TEST_GUARD_HOME]))'], (error, stdout) => resolve(JSON.parse(stdout))));
    t.ok('子プロセスは AGENT_HOST_DATA と守る置き場を引き継ぐ', inherited[0] === process.env.AGENT_HOST_DATA && inherited[1] === process.env.PLEIAD_TEST_GUARD_HOME);

    // ---- 守っている置き場を開こうとすると、中身に触れずに例外（偽の家。形式 1 の JSON を置いておき、移行されないことを見る）
    const fakeHome = path.join(root, 'fake-home');
    const data = path.join(fakeHome, '.agent-host');
    await fsp.mkdir(data, { recursive: true });
    await fsp.writeFile(path.join(data, 'sessions.json'), '{"keep":{"title":"本物の代わり"}}');
    await fsp.writeFile(path.join(data, 'data-schema.json'), '{"schema":1}\n');
    const before = tree(data);
    const attempts = {
      'store.get（既定の置き場。開いただけで移行が走る作りだった）': "const store = await import(process.env.CORE + '/store.mjs'); await store.get('x');",
      'store.setMeta': "const store = await import(process.env.CORE + '/store.mjs'); await store.setMeta('x', { title: 'y' });",
      'store.setPref（設定の JSON）': "const store = await import(process.env.CORE + '/store.mjs'); await store.setPref('mode', 'plan');",
      'openData': "const { openData } = await import(process.env.CORE + '/data-schema.mjs'); openData(process.env.HOME + '/.agent-host');",
      'ensureDataSchema（形式の移行）': "const { ensureDataSchema } = await import(process.env.CORE + '/data-schema.mjs'); await ensureDataSchema(process.env.HOME + '/.agent-host');",
      'acquireDataLock': "const { acquireDataLock } = await import(process.env.CORE + '/data-lock.mjs'); acquireDataLock(process.env.HOME + '/.agent-host');",
      'openRaw（DB を直に）': "const { openRaw, dbPath } = await import(process.env.CORE + '/db.mjs'); openRaw(dbPath(process.env.HOME + '/.agent-host'), { create: true });",
      '使用量（createUsageStore）': "const { createUsageStore } = await import(process.env.CORE + '/usage.mjs'); await createUsageStore(process.env.HOME + '/.agent-host').record({ id: 'a', backend: 'x' });",
      '委譲のタスク（createAgentTasks）': "const { createAgentTasks } = await import(process.env.CORE + '/agent-tasks.mjs'); await createAgentTasks({ dataDir: process.env.HOME + '/.agent-host', prepare() {}, execute() {}, deliver() {} });",
    };
    for (const [label, script] of Object.entries(attempts)) {
      const result = await inFakeHome(fakeHome, script);
      t.ok(`${label}: 守っている置き場を開こうとすると例外（コード TEST_GUARD）`, result.code !== 0 && /test guard/.test(result.stderr), result.stderr.slice(0, 200));
    }
    t.ok('どの試みでも、守っている置き場の中身は 1 つも変わらない（移行されず、DB・ロックも作られない）', JSON.stringify(tree(data)) === JSON.stringify(before)
      && fs.readFileSync(path.join(data, 'sessions.json'), 'utf8') === '{"keep":{"title":"本物の代わり"}}' && fs.readFileSync(path.join(data, 'data-schema.json'), 'utf8') === '{"schema":1}\n', tree(data).join(','));

    // 置き場を指定すれば（守っていない）、同じ操作が通る
    const ok = await inFakeHome(fakeHome, "const store = await import(process.env.CORE + '/store.mjs'); await store.setMeta('x', { title: 'y' }); console.log('ok'); store.closeStore();", { AGENT_HOST_DATA: path.join(root, 'other-data') });
    t.ok('別の置き場なら通る（守るのは本物だけ）', ok.code === 0 && /ok/.test(ok.stdout), ok.stderr.slice(0, 200));
    const same = await inFakeHome(fakeHome, "const store = await import(process.env.CORE + '/store.mjs'); await store.get('x');", { AGENT_HOST_DATA: data });
    t.ok('AGENT_HOST_DATA で本物に向けても、例外（置き場の指定では回避できない）', same.code !== 0 && /test guard/.test(same.stderr) && JSON.stringify(tree(data)) === JSON.stringify(before));
    const off = await inFakeHome(fakeHome, "const store = await import(process.env.CORE + '/store.mjs'); await store.setMeta('x', { title: 'y' }); console.log('ok'); store.closeStore();", { PLEIAD_TEST_GUARD_HOME: '' });
    t.ok('守る置き場が空なら、これまでどおり開く（普段の起動は変わらない）。ただしこの確認は偽の家だけ', off.code === 0 && fs.existsSync(path.join(data, 'pleiad.db')));

    // ---- サーバーを子プロセスで立てるテストにも効く: 守っている置き場を指す起動は、移行せずに終わる
    const serverHome = path.join(root, 'server-home');
    const serverData = path.join(serverHome, '.agent-host');
    await fsp.mkdir(serverData, { recursive: true });
    await fsp.writeFile(path.join(serverData, 'sessions.json'), '{"keep":{"title":"サーバー"}}');
    await fsp.writeFile(path.join(serverData, 'data-schema.json'), '{"schema":1}\n');
    const serverBefore = tree(serverData);
    // テストの補助（startServer）は、守っている置き場に prefs.json を置くことも、サーバーを立てることもしない
    const helper = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', PLEIAD_TEST_GUARD_HOME: serverData }, dataDir: serverData, timeoutMs: 30_000 }).then(server => { server.stop(); return null; }, e => e);
    t.ok('startServer は、守っている置き場を指されたら、何も書かずに例外', /test guard/.test(helper?.message ?? '') && JSON.stringify(tree(serverData)) === JSON.stringify(serverBefore), JSON.stringify({ after: tree(serverData), message: helper?.message?.slice(0, 100) }));
    // サーバー本体（core/server.mjs の子プロセス）も、守っている置き場なら起動しない（補助を通らずに起動した場合）
    const child = await new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'core', 'server.mjs')], { cwd: ROOT, timeout: 60_000,
      env: { ...process.env, AGENT_HOST_PORT: '0', AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja', USERPROFILE: serverHome, HOME: serverHome, PLEIAD_TEST_GUARD_HOME: serverData, AGENT_HOST_DATA: serverData } },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stderr })));
    t.ok('サーバー本体も、守っている置き場なら起動せず（終了コード ≠ 0）、置き場に触れない（移行・DB・ロック・prefs.json が作られない）', child.code !== 0 && /test guard/.test(child.stderr) && JSON.stringify(tree(serverData)) === JSON.stringify(serverBefore)
      && fs.readFileSync(path.join(serverData, 'data-schema.json'), 'utf8') === '{"schema":1}\n', JSON.stringify({ code: child.code, after: tree(serverData) }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
