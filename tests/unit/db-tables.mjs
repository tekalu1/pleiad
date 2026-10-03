// 表ごとの読み書き（core/db.mjs）: 会話の記録の項目ごとの行・contextSession.report.entries の重複排除と掃除・形が崩れた入力・使用量・接続の共有と解放
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire, dbPath, createDb, sessionTable, usageTable, conversationTable, taskTable, transaction, loadSqlite } from '../../core/db.mjs';

export const name = 'db-tables';
export const title = 'DB の表: 項目ごとの行・report.entries の重複排除と掃除・形が崩れた入力・使用量・接続の共有';

const entry = (id, extra = {}) => ({ id, kind: 'instruction', name: id, hash: `hash-${id}`, ...extra });
const canon = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const sameJson = (a, b) => canon(a) === canon(b);

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-db-tables-'));
  const db = createDb(dbPath(dir));
  try {
    const sessions = sessionTable(db);
    const count = sql => db.prepare(sql).get().n;

    // ---- 項目ごとの行: 書いた項目だけが変わる
    sessions.writeAll('a', { history: [], title: 'x', outbox: [{ id: 1 }], draft: { text: 'd' } });
    sessions.write('a', { history: [], title: 'y', outbox: [{ id: 99 }], draft: { text: 'changed' } }, ['title']);
    const a = sessions.loadAll().a;
    t.ok('write は指定した項目の行だけを書く（ほかの項目は元のまま）', a.title === 'y' && sameJson(a.outbox, [{ id: 1 }]) && a.draft.text === 'd');
    sessions.write('a', { history: [], title: 'y' }, ['draft', 'outbox']);
    t.ok('値が undefined の項目は行を消す', !('draft' in sessions.loadAll().a) && !('outbox' in sessions.loadAll().a));
    sessions.writeAll('b', {});
    t.ok('write は DB に無い会話を作らない（消された会話を、更新で欠けた形のまま戻さない）', sessions.write('ghost', { title: 'resurrected' }, ['title']) === false && !('ghost' in sessions.loadAll()) && !sessions.ids().includes('ghost'));
    t.ok('write は会話があれば true を返す', sessions.write('a', { title: 'y' }, ['title']) === true);
    t.ok('項目が 0 の会話も、会話として残る（空の記録 {}）', sameJson(sessions.loadAll().b, {}) && sessions.ids().includes('b'));
    sessions.writeAll('n', { stops: null, mode: 'default', turnStartedAt: null });
    t.ok('null の項目は null のまま読み戻す（undefined と区別する）', sessions.loadAll().n.stops === null && 'turnStartedAt' in sessions.loadAll().n);
    sessions.writeAll('weird', true);
    sessions.writeAll('weird-array', [1, 2]);
    t.ok('オブジェクトでない記録も、そのまま読み戻す（壊れた旧データを落とさない）', sessions.loadAll().weird === true && sameJson(sessions.loadAll()['weird-array'], [1, 2]));
    sessions.remove('weird'); sessions.remove('weird-array');

    // ---- contextSession.report.entries
    const report = (entries, extra = {}) => ({ report: { version: 3, cwd: 'C:\\w', at: 1, entries, ...extra }, policy: { removedMcp: [] } });
    sessions.writeAll('c1', { contextSession: report([entry('i1'), entry('i2'), entry('i3')]) });
    sessions.writeAll('c2', { contextSession: report([entry('i1'), entry('i2'), entry('i4')]) });
    t.ok('同じ中身の行は 1 つだけ持つ（6 参照・4 行）', count('SELECT COUNT(*) n FROM context_entry_refs') === 6 && count('SELECT COUNT(*) n FROM context_entries') === 4);
    const loaded = sessions.loadAll();
    t.ok('読み戻すと並びも含めて元の形（会話ごとに別の複製）', sameJson(loaded.c1.contextSession, report([entry('i1'), entry('i2'), entry('i3')]))
      && sameJson(loaded.c2.contextSession.report.entries.map(e => e.id), ['i1', 'i2', 'i4']) && loaded.c1.contextSession.report.entries[0] !== loaded.c2.contextSession.report.entries[0]);
    sessions.write('c2', { contextSession: report([entry('i1'), entry('i5')]) }, ['contextSession']);
    t.ok('置き換えると、その会話の並びだけが変わる', sameJson(sessions.loadAll().c2.contextSession.report.entries.map(e => e.id), ['i1', 'i5']) && sessions.loadAll().c1.contextSession.report.entries.length === 3);
    t.ok('置き換えで誰からも参照されなくなった行は、掃除するまで残る', count('SELECT COUNT(*) n FROM context_entries') === 5);
    t.ok('掃除（sweepEntries）で参照の無い行だけが消える', sessions.sweepEntries() === 1 && count('SELECT COUNT(*) n FROM context_entries') === 4
      && sameJson(sessions.loadAll().c1.contextSession.report.entries.map(e => e.id), ['i1', 'i2', 'i3']));
    sessions.write('c2', { contextSession: null }, ['contextSession']);
    t.ok('contextSession を null にすると参照も消える', sessions.loadAll().c2.contextSession === null && count("SELECT COUNT(*) n FROM context_entry_refs WHERE session_id = 'c2'") === 0);
    sessions.remove('c1');
    t.ok('会話を消すと項目と参照も消え、掃除で本文も消える', !('c1' in sessions.loadAll()) && count("SELECT COUNT(*) n FROM session_fields WHERE session_id = 'c1'") === 0 && sessions.sweepEntries() >= 1 && count('SELECT COUNT(*) n FROM context_entries') === 0);
    for (const [label, value] of [['entries が空', report([])], ['report が数', { report: 1 }], ['entries が文字列', { report: { entries: 'x' } }], ['report が無い', { policy: {} }], ['entries の中に null', report([null, entry('z')])]]) {
      sessions.writeAll('shape', { contextSession: value });
      t.ok(`形が崩れた contextSession も元のまま読み戻す: ${label}`, sameJson(sessions.loadAll().shape.contextSession, value), JSON.stringify(sessions.loadAll().shape.contextSession));
    }

    // ---- トランザクション: 途中で失敗したらその分は残らない
    const failed = (() => { try { transaction(db, () => { sessions.writeAll('tx', { title: 't' }); throw new Error('boom'); }); } catch (e) { return e.message; } })();
    t.ok('トランザクションの途中で投げたら、その分の書き込みは戻る', failed === 'boom' && !('tx' in sessions.loadAll()));
    transaction(db, () => { sessions.writeAll('outer', { title: 'o' }); transaction(db, () => sessions.writeAll('inner', { title: 'i' })); });
    t.ok('入れ子のトランザクションは外側の一部として動く', sessions.loadAll().outer.title === 'o' && sessions.loadAll().inner.title === 'i');

    // ---- 使用量
    const usage = usageTable(db);
    t.ok('使用量: 記録が無ければ snapshot は null', usage.snapshot() === null && usage.count() === 0);
    usage.add({ id: 'u1', backend: 'claude', at: 100, inputTokens: 1 }, { since: 50, migrations: ['m'] });
    usage.add({ id: 'u2', backend: 'codex', at: 200 }, { since: 999, migrations: [] });
    t.ok('使用量: since・migrations は最初の 1 回だけ書く', usage.since() === 50 && sameJson(usage.snapshot().migrations, ['m']) && usage.count() === 2 && usage.has('u2') && !usage.has('zz'));
    t.ok('使用量: recent は backend と時刻で絞る（作った順）', sameJson(usage.recent('claude', 0).map(r => r.id), ['u1']) && usage.recent('claude', 101).length === 0 && usage.recent('codex', 150).length === 1);
    usage.replace({ since: 50, migrations: ['m', 'n'], records: [{ id: 'u1', backend: 'claude', at: 100, inputTokens: 5 }, { id: 'u2', backend: 'codex', at: 200 }] });
    t.ok('使用量: 件数が同じ置き換えは変わった行だけを書き換える（並びを保つ）', usage.snapshot().records[0].inputTokens === 5 && sameJson(usage.snapshot().migrations, ['m', 'n']));
    usage.replace({ since: 50, migrations: ['m'], records: [{ id: 'only', backend: 'claude', at: 1 }] });
    t.ok('使用量: 件数が違う置き換えは全部を入れ替える', sameJson(usage.snapshot().records.map(r => r.id), ['only']));
    usage.replace({ since: 50, migrations: ['m'], future: { kept: true }, note: 'x', records: [{ id: 'only', backend: 'claude', at: 1 }] });
    t.ok('使用量: version・since・migrations・records 以外の最上位の項目も落とさず持つ', sameJson(usage.snapshot(), { version: 1, since: 50, migrations: ['m'], future: { kept: true }, note: 'x', records: [{ id: 'only', backend: 'claude', at: 1 }] }));
    usage.replace({ since: 50, migrations: ['m'], records: [{ id: 'only', backend: 'claude', at: 1 }] });
    t.ok('使用量: 項目が無くなれば消える', !('future' in usage.snapshot()));

    // ---- 委譲のタスク・会話の索引
    const tasks = taskTable(db);
    tasks.save([['t1', JSON.stringify({ taskId: 't1', n: 1 })], ['t2', JSON.stringify({ taskId: 't2', n: 1 })]]);
    tasks.save([['t1', JSON.stringify({ taskId: 't1', n: 2 })]]);
    t.ok('タスク: 同じ id は行を更新し、作った順を保つ', sameJson(Object.keys(tasks.loadAll()), ['t1', 't2']) && tasks.loadAll().t1.n === 2);
    t.ok('タスク: 空の保存も書き込みを試す（保存障害の後の再試行に使う）', (() => { try { tasks.save([]); return true; } catch { return false; } })());
    const conversations = conversationTable(db);
    conversations.save([['x', '{"backend":"fake"}'], ['y', '{"backend":"codex"}']]);
    conversations.save([], ['x']);
    t.ok('会話の索引: 行を足し・消す', sameJson(Object.keys(conversations.loadAll()), ['y']));

    // ---- WAL・接続の共有
    t.ok('WAL・synchronous=NORMAL で開き、形式番号を user_version に書く', db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal' && db.prepare('PRAGMA synchronous').get().synchronous === 1 && db.prepare('PRAGMA user_version').get().user_version === 2);
    t.ok('busy_timeout は数百 ms（イベントループを長く塞がない）', db.prepare('PRAGMA busy_timeout').get().timeout <= 500);
  } finally { db.close(); }

  // ---- DB が使えるかの確認（形式 2 の起動が、空の DB を作って始めない）
  {
    const { openRaw, checkDb, DB_VERSION } = await import('../../core/db.mjs');
    const probe = path.join(dir, 'probe');
    await fs.mkdir(probe);
    const file = path.join(probe, 'pleiad.db');
    t.ok('checkDb: DB が無ければ missing', checkDb(file) === 'missing');
    t.ok('openRaw: 無い DB を黙って作らない（create: true のときだけ作る）', (() => { try { openRaw(file); return false; } catch (e) { return /missing/.test(e.message) && !existsSync(file); } })());
    createDb(file).close();
    t.ok('checkDb: 作ったばかりの DB は使える', checkDb(file) === null);
    const { DatabaseSync } = loadSqlite();
    const edit = sql => { const raw = new DatabaseSync(file); try { raw.exec(sql); } finally { raw.close(); } };
    edit('PRAGMA user_version = 3');
    t.ok('checkDb: user_version が違えば理由を返す', /user_version is 3/.test(checkDb(file) ?? ''));
    t.ok('openRaw は既存の DB の user_version を書き換えない（新しい版の DB を壊さない）', (() => { openRaw(file).close(); const raw = new DatabaseSync(file); try { return raw.prepare('PRAGMA user_version').get().user_version === 3; } finally { raw.close(); } })());
    edit(`PRAGMA user_version = ${DB_VERSION}`);
    edit('DROP TABLE usage_records');
    t.ok('checkDb: 必要な表が無ければ理由を返す', /missing tables: usage_records/.test(checkDb(file) ?? ''));
    await fs.writeFile(file, 'not a database at all, just text');
    t.ok('checkDb: SQLite でないファイルは読めない理由を返す', /unreadable|not a database/i.test(checkDb(file) ?? ''));
  }

  // 接続は同じデータ置き場で共有し、最後の 1 つが離したら閉じる（Windows でデータ置き場を消せる）
  {
    const shared = path.join(dir, 'shared');
    const create = target => createDb(dbPath(target)).close();
    const one = acquire(shared, create), two = acquire(shared, create);
    t.ok('同じ置き場の接続は共有する', one.db === two.db);
    one.release(); one.release();
    t.ok('離す操作は何度呼んでも 1 回として数える（まだ使っている側の接続は閉じない）', (() => { try { two.db.prepare('SELECT 1').get(); return true; } catch { return false; } })());
    two.release();
    t.ok('最後の 1 つが離したら接続を閉じる', (() => { try { two.db.prepare('SELECT 1').get(); return false; } catch { return true; } })());
    await fs.rm(shared, { recursive: true, force: true });
    t.ok('閉じた後は置き場を消せる（-wal・-shm も残らない）', !(await fs.stat(shared).catch(() => null)));
  }

  // node:sqlite の警告は、読み込みの間だけ・SQLite のものに限って捨てる
  {
    const seen = [];
    const onWarning = w => seen.push(w.message);
    process.on('warning', onWarning);
    loadSqlite();
    process.emitWarning('ほかの実験的な機能', 'ExperimentalWarning');
    await new Promise(resolve => setImmediate(resolve));
    process.off('warning', onWarning);
    t.ok('ほかの警告は握りつぶさない（SQLite の警告だけを、読み込みの間に限って捨てる）', seen.some(message => /ほかの実験的な機能/.test(message)) && !seen.some(message => /SQLite/.test(message)));
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
