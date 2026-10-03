// データ置き場の形式 1（記録ごとの JSON）→ 2（SQLite）の移行（core/schema-migration.mjs、ADR 0115）。
// 成功・途中で失敗しても元が残る・2 回目の起動では移行しない・整形済みと 1 行（compact）の旧 JSON がどちらも読める・新しい形式は開かない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/server.mjs';
import { ensureDataSchema, ensureDataSchemaSync, openData } from '../../core/data-schema.mjs';
import { dbPath, openReadOnly } from '../../core/db.mjs';
import { readSessions, readAgentTasks, readUsage, readConversationIndex } from '../lib/data-store.mjs';

export const name = 'schema-migration';
export const title = 'データ置き場の形式 1 → 2 の移行: 突き合わせ・写し・失敗しても元が残る・2 回目は移行しない・整形済み/compact 両方';

const entries = (n, shared) => Array.from({ length: n }, (_, k) => ({ id: `e${shared ? k : `${Math.random()}`}`, kind: 'instruction', name: `n${k}`, path: `C:\\p\\${k}`, hash: `h${k}` }));
// 実データに近い会話の記録（contextSession の report.entries は会話をまたいで同じ中身が並ぶ。\ を含むパスと日本語も入れる）
const session = (i, extra = {}) => ({
  history: [{ at: '2026-10-01T00:00:00Z', by: 'human', field: 'title', from: null, to: `題${i}`, reason: null }],
  backend: 'fake', title: `題${i}`, cwd: 'C:\\work\\プロジェクト', createdAt: 1, lastModified: 2, completedAt: 3, mode: 'default', model: '',
  draft: { text: `下書き${i}` }, outbox: [{ id: `m${i}`, args: { prompt: 'p' }, at: '2026-10-01T00:00:00Z', status: 'sent', error: null }], stops: null,
  contextSession: { version: 3, cwd: 'C:\\work', policy: { removedMcp: [] }, pin: null, delivered: null, added: [], report: { version: 3, cwd: 'C:\\work', owners: [], at: 5, entries: entries(5, true), native: null, status: 'ok' } },
  hookRuns: [{ phase: 'started', hookId: 'h', name: 'PreToolUse:Read', event: 'PreToolUse', at: 1 }],
  ...extra,
});
const sessions = () => ({ a: session(1), b: session(2), c: session(3, { contextSession: { report: { entries: [] } } }), d: { history: [] }, e: {}, f: session(5, { contextSession: null }) });
const task = (id, status = 'completed', notification = 'sent') => ({ taskId: id, sessionId: `s-${id}`, parentSessionId: 'p', manager: 'ply', backend: 'codex', depth: 1, task: '依頼', title: 't',
  createdAt: 1, updatedAt: 2, status, notification, result: '結果', error: null, instructions: [], instructionRevision: 0, queue: [] });
const tasks = () => ({ 'ply-task-1': task('ply-task-1'), 'ply-task-2': task('ply-task-2', 'running', 'none') });
const usage = () => ({ version: 1, since: 1000, migrations: ['claude-cost-delta'], records: [
  { id: 'u1', backend: 'claude', at: 1500, inputTokens: 1, outputTokens: 2, cachedTokens: 0, costUsd: 0.5 },
  { id: 'u2', backend: 'codex', at: 1600, inputTokens: 3, outputTokens: 4, cachedTokens: 5, costUsd: null, nativeSessionId: 'n', cumulativeStart: null, cumulativeEnd: null },
] });
const conversations = () => ({ c1: { backend: 'fake', nativeId: null, base: 0, segments: [], info: { title: '会話' } } });

const read = file => fs.readFile(file, 'utf8').catch(() => null);
async function seed(dir, { pretty = false } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const write = (name, value) => fs.writeFile(path.join(dir, name), pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  await Promise.all([write('sessions.json', sessions()), write('agent-tasks.json', tasks()), write('usage.json', usage()), write('conversations.json', conversations()),
    fs.writeFile(path.join(dir, 'data-schema.json'), '{"schema":1}\n')]);
}
const snapshot = async dir => Object.fromEntries(await Promise.all(['sessions.json', 'agent-tasks.json', 'usage.json', 'conversations.json', 'data-schema.json'].map(async name => [name, await read(path.join(dir, name))])));
const backups = async dir => (await fs.readdir(dir)).filter(name => name.startsWith('backup-schema1-'));
// キーの順を問わず同じ中身か
const canon = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const sameJson = (a, b) => canon(a) === canon(b);


// 形式 2 の置き場を、別のプロセスで store・conversations から読む（元の JSON ではなく DB だけを読むことを確かめる）
const CHILD_READ = `
  const store = await import(process.env.STORE_URL); const conv = await import(process.env.CONV_URL);
  const ids = Object.keys(await store.getAll()); const c = await conv.conversation('ghostConv');
  console.log(JSON.stringify({ ids, conv: c })); await conv.closeConversations(); store.closeStore();
`;

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-schema-migration-'));
  const tmp = async label => { const dir = path.join(root, label); await fs.mkdir(dir, { recursive: true }); return dir; };
  try {
    // ---- 成功（compact と整形済みの旧 JSON のどちらも読める）
    for (const pretty of [false, true]) {
      const dir = await tmp(pretty ? 'pretty' : 'compact');
      await seed(dir, { pretty });
      const before = await snapshot(dir);
      const result = ensureDataSchemaSync(dir);
      const label = pretty ? '整形済み' : 'compact';
      t.ok(`${label}: 移行して形式番号を 2 にする`, result?.counts?.sessions === 6 && result.counts.tasks === 2 && result.counts.usage === 2 && result.counts.conversations === 1
        && JSON.parse(await read(path.join(dir, 'data-schema.json'))).schema === 2, JSON.stringify(result));
      t.ok(`${label}: 会話の記録は読み戻して元と同じ（report.entries の組み直し・null・空・日本語・\ を含む）`, sameJson(readSessions(dir), sessions()));
      t.ok(`${label}: 委譲のタスク・使用量・会話の索引も同じ`, sameJson(readAgentTasks(dir), tasks()) && sameJson(readUsage(dir), usage()) && sameJson(readConversationIndex(dir), conversations()));
      const names = await backups(dir);
      const backup = path.join(dir, names[0] ?? '-');
      t.ok(`${label}: 移行前の JSON を backup-schema1-<日時>/ へそのまま写す`, names.length === 1 && Object.values(before).every(text => text !== null)
        && (await Promise.all(Object.entries(before).map(async ([file, text]) => (await read(path.join(backup, file))) === text))).every(Boolean));
      t.ok(`${label}: 写したあと、移行した元の JSON をデータ置き場から外す`, !(await read(path.join(dir, 'sessions.json'))) && !(await read(path.join(dir, 'agent-tasks.json')))
        && !(await read(path.join(dir, 'usage.json'))) && !(await read(path.join(dir, 'conversations.json'))));
      // ---- 2 回目の起動では移行しない
      const again = await ensureDataSchema(dir);
      t.ok(`${label}: 2 回目の起動では移行しない（写しも増えない）`, again === null && (await backups(dir)).length === 1 && sameJson(readAgentTasks(dir), tasks()));
    }

    // ---- report.entries は中身のハッシュで 1 つだけ持つ
    {
      const dir = await tmp('dedup');
      await seed(dir);
      ensureDataSchemaSync(dir);
      const db = openReadOnly(dir);
      try {
        const refs = db.prepare('SELECT COUNT(*) AS n FROM context_entry_refs').get().n;
        const rows = db.prepare('SELECT COUNT(*) AS n FROM context_entries').get().n;
        t.ok('同じ中身の report.entries は別の表に 1 つだけ（会話側は参照だけ）', refs === 10 && rows === 5, `refs=${refs} entries=${rows}`);
        const stored = db.prepare("SELECT value FROM session_fields WHERE session_id = 'a' AND field = 'contextSession'").get().value;
        t.ok('会話の行には report.entries の本文を持たない', !stored.includes('"hash":"h0"') && JSON.parse(stored).report.$entries === 5);
      } finally { db.close(); }
    }

    // ---- 途中で失敗したら、元の JSON にも形式番号にも触れず、作りかけの DB と写しを残さない
    {
      const dir = await tmp('failure');
      await seed(dir, { pretty: true });
      const before = await snapshot(dir);
      const error = await ensureDataSchema(dir, { afterImport: () => { throw new Error('injected failure'); } }).then(() => null, e => e);
      t.ok('移行の途中で失敗したら起動を止める（理由を添えて投げる）', /移行できませんでした/.test(error?.message ?? '') && /injected failure/.test(error.message), error?.message);
      t.ok('失敗しても元の JSON と形式番号は 1 バイトも変わらない', sameJson(await snapshot(dir), before));
      t.ok('失敗したら作りかけの DB と写しを消す', !(await read(dbPath(dir))) && !(await read(`${dbPath(dir)}-wal`)) && (await backups(dir)).length === 0);
      // 直せば、次の起動で移行できる
      t.ok('原因が無くなれば、次の起動で移行できる', (await ensureDataSchema(dir))?.counts?.sessions === 6 && readSessions(dir).a?.title === '題1');
    }
    {
      const dir = await tmp('mismatch');
      await seed(dir);
      const before = await snapshot(dir);
      // 取り込んだ後で DB の中身を壊す: 読み戻しの突き合わせが落とす
      const error = await ensureDataSchema(dir, { afterImport: db => { db.exec("DELETE FROM session_fields WHERE session_id = 'a' AND field = 'title'"); } }).then(() => null, e => e);
      t.ok('読み戻した中身が元と違えば失敗する（突き合わせ）', /read-back differs/.test(error?.message ?? '') && /sessions\.json/.test(error.message), error?.message);
      t.ok('突き合わせに失敗しても元は変わらず、番号も上がらない', sameJson(await snapshot(dir), before) && (await backups(dir)).length === 0 && !(await read(dbPath(dir))));
    }
    {
      const dir = await tmp('corrupt');
      await seed(dir);
      await fs.writeFile(path.join(dir, 'agent-tasks.json'), '{"truncated":');
      const before = await snapshot(dir);
      const error = await ensureDataSchema(dir).then(() => null, e => e);
      t.ok('壊れた JSON があれば、何も作らずに起動を止める', /agent-tasks\.json/.test(error?.message ?? '') && sameJson(await snapshot(dir), before) && (await backups(dir)).length === 0 && !(await read(dbPath(dir))));
    }

    // ---- 前回の移行の作りかけの DB が残っていても、消して移行し直す
    {
      const dir = await tmp('leftover');
      await seed(dir);
      await fs.writeFile(dbPath(dir), 'not a database');
      await fs.writeFile(`${dbPath(dir)}-wal`, 'junk');
      t.ok('作りかけの pleiad.db（落ちた移行の残り）は消して移行し直す', (await ensureDataSchema(dir))?.counts?.tasks === 2 && sameJson(readAgentTasks(dir), tasks()));
    }

    // ---- 形式番号の扱い
    {
      const dir = await tmp('fresh');
      t.ok('新しい置き場は移行せず、形式番号 2 を書く', (await ensureDataSchema(dir)) === null && JSON.parse(await read(path.join(dir, 'data-schema.json'))).schema === 2 && (await backups(dir)).length === 0);
      const legacy = await tmp('no-schema-file');
      await fs.writeFile(path.join(legacy, 'sessions.json'), JSON.stringify(sessions()));
      t.ok('形式番号が無い置き場（導入前の版）も、JSON があれば形式 1 として移行する', (await ensureDataSchema(legacy))?.counts?.sessions === 6 && readSessions(legacy).b?.title === '題2');
      const future = await tmp('future');
      await fs.writeFile(path.join(future, 'data-schema.json'), '{"schema":3}');
      await fs.writeFile(path.join(future, 'sessions.json'), '{"keep":{"title":"x"}}');
      const rejected = await ensureDataSchema(future).then(() => null, e => e);
      t.ok('新しい版の形式（3）は開かない。データには触れない', /別の形式/.test(rejected?.message ?? '') && (await read(path.join(future, 'sessions.json'))) === '{"keep":{"title":"x"}}' && !(await read(dbPath(future))));
      const broken = await tmp('broken');
      await fs.writeFile(path.join(broken, 'data-schema.json'), '{}');
      t.ok('壊れた形式番号では黙って作り直さない', await ensureDataSchema(broken).then(() => false, () => true));
      // 古い版は「今の形式と違う番号」を見て止まる（core/data-schema.mjs の旧版の検査: schema !== 1 なら別の形式）
      const migrated = await tmp('old-app');
      await seed(migrated);
      await ensureDataSchema(migrated);
      const schema = JSON.parse(await read(path.join(migrated, 'data-schema.json'))).schema;
      t.ok('移行後の形式番号は 2。形式 1 を前提にした古い版（schema !== 1 で止まる）は起動できない', schema === 2 && schema !== 1);
    }

    // ---- 形式 2 なのに DB が使えないときは、空の DB を作って起動せず、止める
    {
      const missing = await tmp('v2-no-db');
      await fs.writeFile(path.join(missing, 'data-schema.json'), '{"schema":2}\n');
      await fs.writeFile(path.join(missing, 'sessions.json'), '{"keep":{"title":"x"}}');
      const noDb = await ensureDataSchema(missing).then(() => null, e => e);
      t.ok('形式 2 で pleiad.db が無ければ、DB を作らずに起動を止める（データには触れない）', /pleiad\.db/.test(noDb?.message ?? '') && /missing/.test(noDb.message) && !(await read(dbPath(missing)))
        && (await read(path.join(missing, 'sessions.json'))) === '{"keep":{"title":"x"}}', noDb?.message);
      const noDbOpen = (() => { try { openData(missing); return null; } catch (e) { return e; } })();
      t.ok('openData も同じ（store・usage・agent-tasks・conversations が空の DB で始めない）', !!noDbOpen && !(await read(dbPath(missing))), noDbOpen?.message);

      const version = await tmp('v2-bad-version');
      await seed(version);
      await ensureDataSchema(version);
      const sqlite = (await import('../../core/db.mjs')).loadSqlite();
      const edit = (dir, sql) => { const raw = new sqlite.DatabaseSync(dbPath(dir)); try { raw.exec(sql); } finally { raw.close(); } };
      const userVersion = dir => { const raw = new sqlite.DatabaseSync(dbPath(dir), { readOnly: true }); try { return raw.prepare('PRAGMA user_version').get().user_version; } finally { raw.close(); } };
      edit(version, 'PRAGMA user_version = 7');
      const badVersion = await ensureDataSchema(version).then(() => null, e => e);
      t.ok('user_version が違えば止める（DB の形式番号を書き換えない）', /user_version is 7/.test(badVersion?.message ?? '') && userVersion(version) === 7, badVersion?.message);
      edit(version, 'PRAGMA user_version = 2');
      edit(version, 'DROP TABLE agent_tasks');
      const noTable = await ensureDataSchema(version).then(() => null, e => e);
      t.ok('必要な表が無ければ止める（表を作り足して始めない）', /missing tables: agent_tasks/.test(noTable?.message ?? ''), noTable?.message);
      const garbage = await tmp('v2-garbage');
      await fs.writeFile(path.join(garbage, 'data-schema.json'), '{"schema":2}\n');
      await fs.writeFile(dbPath(garbage), 'this is not a sqlite database');
      t.ok('SQLite でないファイルなら止める（上書きしない）', await ensureDataSchema(garbage).then(() => false, () => true) && (await read(dbPath(garbage))) === 'this is not a sqlite database');

      // 新しい置き場だけが DB を作ってよい
      const fresh = await tmp('fresh-db');
      await ensureDataSchema(fresh);
      t.ok('新しい置き場（JSON も DB も無い）は DB を作り、そのうえで形式番号を 2 にする', !!(await read(dbPath(fresh))) && JSON.parse(await read(path.join(fresh, 'data-schema.json'))).schema === 2 && (await ensureDataSchema(fresh)) === null);
      const orphan = await tmp('db-only-bad');
      await fs.writeFile(dbPath(orphan), 'junk');
      t.ok('形式番号が無く DB だけがあるときは、使える DB でなければ新規作成せずに止める', await ensureDataSchema(orphan).then(() => false, () => true) && !(await read(path.join(orphan, 'data-schema.json'))));
    }

    // ---- usage.json は最上位の項目も落とさない（元の JSON 全体を比べる）
    {
      const dir = await tmp('usage-extras');
      await seed(dir);
      await fs.writeFile(path.join(dir, 'usage.json'), JSON.stringify({ ...usage(), futureField: { kept: [1, 2] }, note: '新しい版が足した項目' }));
      await ensureDataSchema(dir);
      t.ok('version・since・migrations・records 以外の最上位の項目も、読み戻して元と同じ（落とさない）', sameJson(readUsage(dir), { ...usage(), futureField: { kept: [1, 2] }, note: '新しい版が足した項目' }));
      const dropped = await tmp('usage-extras-dropped');
      await seed(dropped);
      await fs.writeFile(path.join(dropped, 'usage.json'), JSON.stringify({ ...usage(), futureField: 1 }));
      const error = await ensureDataSchema(dropped, { afterImport: db => { db.exec("DELETE FROM usage_meta WHERE key = 'extra'"); } }).then(() => null, e => e);
      t.ok('保存できなかった項目があれば、突き合わせで移行を止める', /usage\.json/.test(error?.message ?? '') && /read-back differs/.test(error.message) && !!(await read(path.join(dropped, 'usage.json'))) && (await backups(dropped)).length === 0);
    }

    // ---- 形式番号を 2 にしたあと、元の JSON を外せなくても、起動は止めず、次の起動で外し直す
    {
      const dir = await tmp('cleanup-resume');
      await seed(dir);
      const refuse = file => { if (/sessions\.json$|usage\.json$/.test(file)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); return fsSync.rmSync(file, { force: true }); };
      const result = await ensureDataSchema(dir, { remove: refuse });
      t.ok('元の JSON を外せなくても、移行は成功して起動は止めない（形式番号は 2）', result?.counts?.sessions === 6 && JSON.parse(await read(path.join(dir, 'data-schema.json'))).schema === 2
        && !!(await read(path.join(dir, 'sessions.json'))) && !(await read(path.join(dir, 'agent-tasks.json'))), JSON.stringify(result));
      const again = await ensureDataSchema(dir, { remove: () => { throw new Error('still locked'); } });
      t.ok('次の起動（形式 2）でまた外そうとし、外せなくても止めない', again === null && !!(await read(path.join(dir, 'sessions.json'))));
      await ensureDataSchema(dir);
      t.ok('外せるようになれば、写しにあることを確かめてから外す', !(await read(path.join(dir, 'sessions.json'))) && !(await read(path.join(dir, 'usage.json'))) && sameJson(readSessions(dir), sessions()));
      // 写しに無い（中身が違う）JSON は外さない
      await fs.writeFile(path.join(dir, 'sessions.json'), '{"stranger":{"title":"写しに無い"}}');
      await ensureDataSchema(dir);
      t.ok('写しと中身が違う元の JSON は、触らずに残す（外さない・読まない）', (await read(path.join(dir, 'sessions.json'))) === '{"stranger":{"title":"写しに無い"}}' && !('stranger' in readSessions(dir)));
    }

    // ---- 形式 2 のとき、残った元の JSON を読む経路は無い（store・agent-tasks・usage・conversations は DB だけを読む）
    {
      const dir = await tmp('no-json-reads');
      await seed(dir);
      await ensureDataSchema(dir, { remove: () => { throw new Error('keep'); } });   // 元の JSON を残したまま形式 2 にする
      await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify({ ghost: { history: [], title: 'JSON にだけある会話' } }));
      await fs.writeFile(path.join(dir, 'agent-tasks.json'), JSON.stringify({ 'ghost-task': task('ghost-task') }));
      await fs.writeFile(path.join(dir, 'usage.json'), JSON.stringify({ version: 1, since: 1, migrations: [], records: [{ id: 'ghost-usage', backend: 'claude', at: 1 }] }));
      await fs.writeFile(path.join(dir, 'conversations.json'), JSON.stringify({ ghostConv: { backend: 'fake' } }));
      const { createAgentTasks } = await import('../../core/agent-tasks.mjs');
      const { createUsageStore } = await import('../../core/usage.mjs');
      const manager = await createAgentTasks({ dataDir: dir, log: () => {}, silenceMinutes: 0, commandMinutes: 0, prepare: async () => { throw new Error('unused'); }, execute: async () => ({ outcome: 'ok', text: '' }), deliver: async () => 'ok', ready: async () => false });
      const usageStore = createUsageStore(dir);
      try {
        const ids = manager.list().map(r => r.taskId);
        const snapshotNow = await usageStore.snapshot();
        t.ok('agent-tasks・usage は、形式 2 では残った元の JSON を読まない', ids.sort().join() === 'ply-task-1,ply-task-2' && snapshotNow.records.every(r => r.id !== 'ghost-usage') && snapshotNow.records.length === 2, ids.join());
      } finally { await manager.close(); await usageStore.close(); }
      const child = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', CHILD_READ], {
        env: { ...process.env, AGENT_HOST_DATA: dir, AGENT_HOST_LOCALE: 'ja', STORE_URL: pathToFileURL(path.join(ROOT, 'core/store.mjs')).href, CONV_URL: pathToFileURL(path.join(ROOT, 'core/conversations.mjs')).href } },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      const got = JSON.parse(child.stdout.trim().split(/\r?\n/).pop() || '{}');
      t.ok('store・conversations も、形式 2 では残った元の JSON を読まない', child.error === null && !got.ids?.includes('ghost') && got.ids?.includes('a') && got.conv === null, child.stderr.slice(0, 300) + child.stdout);
    }

    // ---- 0.6.0（形式 1 のまま）が書いた channels/threads.json・memory/learn-state.json を取り込む
    {
      // 0.6.0 の core/channels/threads.mjs・core/memory/learn.mjs が書いた形（どちらも整形した JSON）
      const threadsFile = () => ({ version: 1, threads: {
        'c_aaaaaaaa/p_11111111': { channelId: 'c_aaaaaaaa', threadId: 'p_11111111', sessions: { b_owl: 's-owl-1', b_lynx: 's-lynx-1' }, state: 'working', tokens: { input: 1200, output: 340, cached: 900 }, calls: 4, stopped: null, updatedAt: 1790000000000 },
        'c_aaaaaaaa/p_22222222': { channelId: 'c_aaaaaaaa', threadId: 'p_22222222', sessions: { b_owl: 's-owl-2' }, state: 'idle', tokens: { input: 5, output: 6, cached: 0 }, calls: 1, stopped: { by: { kind: 'human' }, at: 1790000001000 }, origin: { channelId: 'c_aaaaaaaa', threadId: 'p_11111111' }, updatedAt: 1790000002000 },
        'c_bbbbbbbb/p_33333333': { channelId: 'c_bbbbbbbb', threadId: 'p_33333333', sessions: {}, state: 'idle', tokens: { input: 0, output: 0, cached: 0 }, calls: 0, stopped: null, updatedAt: 1 },
      } });
      const learnFile = () => ({ version: 1, cursor: { sessions: { 'sess-1': 12, 'sess-2': 0, '会話-3': 7 }, posts: { c_aaaaaaaa: 'p_11111111' }, postOffsets: { c_aaaaaaaa: 4096 } }, lastRunAt: 1790000003000 });
      const put = async (dir, relative, value) => { await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true }); await fs.writeFile(path.join(dir, relative), `${JSON.stringify(value, null, 2)}\n`); };
      const rowsOf = dir => { const db = openReadOnly(dir); try { return { threads: db.prepare('SELECT thread_key, channel_id, data FROM channel_threads ORDER BY thread_key').all(), state: db.prepare('SELECT kind, id, value FROM memory_state ORDER BY kind, id').all() }; } finally { db.close(); } };

      const dir = await tmp('v060-bot-files');
      await seed(dir);
      await put(dir, 'channels/threads.json', threadsFile());
      await put(dir, 'memory/learn-state.json', learnFile());
      const beforeThreads = await read(path.join(dir, 'channels/threads.json')), beforeLearn = await read(path.join(dir, 'memory/learn-state.json'));
      const result = await ensureDataSchema(dir);
      const rows = rowsOf(dir);
      t.ok('threads.json・learn-state.json があれば、移行で DB の行に取り込む（スレッド 3 行・カーソル 3+1+1 行と lastRunAt）', result?.counts?.threads === 3 && result.counts.memoryState === 6
        && rows.threads.length === 3 && rows.state.length === 6, JSON.stringify(result));
      t.ok('スレッドの状態は元と同じ値（channel_id の列はそのスレッドのチャンネル）', rows.threads.every(row => JSON.stringify(JSON.parse(row.data)) === JSON.stringify(threadsFile().threads[row.thread_key]) && row.channel_id === threadsFile().threads[row.thread_key].channelId));
      t.ok('夜の整理の進みは元と同じ値（会話・チャンネルごとのカーソル・byte offset・lastRunAt）', JSON.stringify(rows.state.map(row => [row.kind, row.id, JSON.parse(row.value)])) === JSON.stringify([
        ['cursor.postOffsets', 'c_aaaaaaaa', 4096], ['cursor.posts', 'c_aaaaaaaa', 'p_11111111'], ['cursor.sessions', 'sess-1', 12], ['cursor.sessions', 'sess-2', 0], ['cursor.sessions', '会話-3', 7], ['meta', 'lastRunAt', 1790000003000]]));
      const backup = path.join(dir, (await backups(dir))[0]);
      t.ok('写しに同じ相対パス（channels/threads.json・memory/learn-state.json）でそのまま入る', (await read(path.join(backup, 'channels/threads.json'))) === beforeThreads && (await read(path.join(backup, 'memory/learn-state.json'))) === beforeLearn);
      t.ok('取り込んだあと、元の 2 つの JSON は外れる', !(await read(path.join(dir, 'channels/threads.json'))) && !(await read(path.join(dir, 'memory/learn-state.json'))));
      // 移行したデータを、今のスレッドの部品が読める
      const { createThreadStore } = await import('../../core/channels/threads.mjs');
      const threads = createThreadStore({ dir: path.join(dir, 'channels') });
      try {
        const listed = await threads.list('c_aaaaaaaa');
        t.ok('移行したスレッドの状態を、今のスレッドの部品（createThreadStore）が読める（会話・トークン・止めた印・起こした元が残る）', listed.length === 2
          && listed.find(th => th.threadId === 'p_11111111')?.sessions.b_lynx === 's-lynx-1' && listed.find(th => th.threadId === 'p_22222222')?.stopped?.at === 1790000001000
          && listed.find(th => th.threadId === 'p_22222222')?.origin?.threadId === 'p_11111111' && (await threads.get('c_aaaaaaaa', 'p_11111111')).tokens.input === 1200);
      } finally { await threads.close(); }
      t.ok('2 回目の起動では移行しない（写しも増えない）', (await ensureDataSchema(dir)) === null && (await backups(dir)).length === 1);

      // この 2 つだけがある置き場（会話などの JSON が無い）も移行する
      const only = await tmp('v060-only-bot-files');
      await put(only, 'channels/threads.json', threadsFile());
      t.ok('threads.json だけがある置き場も移行する（形式番号は 2、DB に 3 行）', (await ensureDataSchema(only))?.counts?.threads === 3 && rowsOf(only).threads.length === 3 && JSON.parse(await read(path.join(only, 'data-schema.json'))).schema === 2);
      // 無ければ何もしない
      const none = await tmp('v060-no-bot-files');
      await seed(none);
      const noneResult = await ensureDataSchema(none);
      t.ok('無ければ何もしない（カウントに出ず、行も無い）', noneResult?.counts?.threads === undefined && noneResult?.counts?.memoryState === undefined && rowsOf(none).threads.length === 0 && rowsOf(none).state.length === 0);

      // 壊れていたら、0.6.0 と同じく読み込まずに止める（元にも番号にも触れない。写しも作りかけの DB も残さない）
      for (const [label, relative, content] of [
        ['壊れた threads.json', 'channels/threads.json', '{"version":1,"threads":'],
        ['知らない版の threads.json', 'channels/threads.json', JSON.stringify({ version: 2, threads: {} })],
        ['threads が連想配列でない threads.json', 'channels/threads.json', JSON.stringify({ version: 1, threads: [] })],
        ['壊れた learn-state.json', 'memory/learn-state.json', 'not json'],
        ['知らない版の learn-state.json', 'memory/learn-state.json', JSON.stringify({ ...learnFile(), version: 2 })],
        ['保存先の無い項目がある learn-state.json', 'memory/learn-state.json', JSON.stringify({ ...learnFile(), extra: { keep: true } })],
      ]) {
        const broken = await tmp(`v060-broken-${relative.replace(/\W/g, '')}-${label.length}`);
        await seed(broken);
        await fs.mkdir(path.dirname(path.join(broken, relative)), { recursive: true });
        await fs.writeFile(path.join(broken, relative), content);
        const before = await snapshot(broken);
        const error = await ensureDataSchema(broken).then(() => null, e => e);
        t.ok(`${label}: 読み込まずに起動を止める（元の JSON・形式番号はそのまま。写しも DB も残さない）`, new RegExp(relative.replace('/', '[\\\\/]').replace('.', '\\.')).test(error?.message ?? '') && sameJson(await snapshot(broken), before)
          && (await read(path.join(broken, relative))) === content && (await backups(broken)).length === 0 && !(await read(dbPath(broken))), error?.message);
      }

      // 読み戻した中身が違えば、突き合わせで止める
      const mismatch = await tmp('v060-mismatch');
      await seed(mismatch);
      await put(mismatch, 'channels/threads.json', threadsFile());
      await put(mismatch, 'memory/learn-state.json', learnFile());
      const dropped = await ensureDataSchema(mismatch, { afterImport: db => { db.exec("DELETE FROM channel_threads WHERE thread_key = 'c_bbbbbbbb/p_33333333'"); db.exec("DELETE FROM memory_state WHERE kind = 'cursor.sessions' AND id = 'sess-1'"); } }).then(() => null, e => e);
      t.ok('スレッドの行・カーソルの行が欠けたら、突き合わせで移行を止める（元は残る）', /read-back differs/.test(dropped?.message ?? '') && /channels[\\/]threads\.json/.test(dropped.message) && /memory[\\/]learn-state\.json/.test(dropped.message)
        && !!(await read(path.join(mismatch, 'channels/threads.json'))) && !!(await read(path.join(mismatch, 'memory/learn-state.json'))) && (await backups(mismatch)).length === 0);

      // 形式 2 で元を外せなかった分は、次の起動で（写しにあることを確かめて）外し直す
      const resume = await tmp('v060-cleanup-resume');
      await seed(resume);
      await put(resume, 'channels/threads.json', threadsFile());
      await put(resume, 'memory/learn-state.json', learnFile());
      const refuse = file => { if (/threads\.json$|learn-state\.json$/.test(file)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); return fsSync.rmSync(file, { force: true }); };
      const first = await ensureDataSchema(resume, { remove: refuse });
      t.ok('外せなくても移行は成功し、起動は止めない（元の 2 つが残る）', first?.counts?.threads === 3 && !!(await read(path.join(resume, 'channels/threads.json'))) && !!(await read(path.join(resume, 'memory/learn-state.json'))));
      await ensureDataSchema(resume);
      t.ok('次の起動（形式 2）で、写しにあることを確かめて外し直す', !(await read(path.join(resume, 'channels/threads.json'))) && !(await read(path.join(resume, 'memory/learn-state.json'))) && rowsOf(resume).threads.length === 3);
      await put(resume, 'channels/threads.json', { version: 1, threads: { 'c_zzzzzzzz/p_zzzzzzzz': { channelId: 'c_zzzzzzzz', threadId: 'p_zzzzzzzz' } } });
      await ensureDataSchema(resume);
      t.ok('写しと中身が違う threads.json は外さず、読み込みもしない（形式 2 では DB だけを読む）', !!(await read(path.join(resume, 'channels/threads.json'))) && rowsOf(resume).threads.every(row => row.thread_key !== 'c_zzzzzzzz/p_zzzzzzzz'));
    }

    // ---- 開く（openData）は、書き込みの前に移行を済ませる
    {
      const dir = await tmp('open');
      await seed(dir);
      const handle = openData(dir);
      try {
        const count = handle.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
        t.ok('openData は最初に移行してから返す（どのモジュールが最初に触っても書き込みの前に済む）', count === 6 && (await backups(dir)).length === 1);
      } finally { handle.release(); }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
