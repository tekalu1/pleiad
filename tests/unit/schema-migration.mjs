// データ置き場の形式 1（記録ごとの JSON）→ 2（SQLite）の移行（core/schema-migration.mjs、ADR 0106）。
// 成功・途中で失敗しても元が残る・2 回目の起動では移行しない・整形済みと 1 行（compact）の旧 JSON がどちらも読める・新しい形式は開かない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
