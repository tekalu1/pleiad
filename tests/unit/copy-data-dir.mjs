// 実データの写しを作る道具（scripts/copy-data-dir.mjs）: remote/ と秘密を写さない・DB は動いている接続のまま安全に写す・元は変えない
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { writeSessions, writeAgentTasks, readAgentTasks, readSessions } from '../lib/data-store.mjs';
import { openData } from '../../core/data-schema.mjs';
import { sessionTable } from '../../core/db.mjs';

export const name = 'copy-data-dir';
export const title = '実データの写し: remote/ と *-secrets.json を写さない・DB は VACUUM INTO・委譲のタスクは既定で空にする';

const run = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'scripts', 'copy-data-dir.mjs'), ...args], {},
  (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
const exists = file => fs.stat(file).then(() => true, () => false);

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-copy-data-'));
  const src = path.join(root, 'src');
  const handle = (await fs.mkdir(src), openData(src));
  try {
    writeSessions(src, { a: { history: [], title: '会話' } });
    writeAgentTasks(src, { 'ply-task-1': { taskId: 'ply-task-1', status: 'running' } });
    // サーバーが動いているのと同じ: 書き込み用の接続を開いたまま、WAL に未反映の書き込みがある
    sessionTable(handle.db).writeAll('live', { history: [], title: 'WAL の中だけにある' });
    await fs.mkdir(path.join(src, 'remote'));
    await fs.writeFile(path.join(src, 'remote', 'devices.json'), '{"devices":[1]}');
    await fs.writeFile(path.join(src, 'remote', 'secrets.json'), 'SECRET');
    await fs.writeFile(path.join(src, 'mcp-secrets.json'), 'SECRET');
    await fs.writeFile(path.join(src, 'claude-account-secrets.json'), 'SECRET');
    await fs.writeFile(path.join(src, 'control.json'), '{"token":"SECRET"}');
    await fs.writeFile(path.join(src, 'mcp-secrets.json.lock'), '1');
    await fs.writeFile(path.join(src, 'prefs.json'), '{"mode":"plan"}');
    await fs.mkdir(path.join(src, 'conversations'));
    await fs.writeFile(path.join(src, 'conversations', 'a.json'), '{"messages":[]}');
    await fs.writeFile(path.join(src, 'handoff-abc.json'), '{}');
    const before = await fs.readdir(src);

    const dst = path.join(root, 'full');
    const result = JSON.parse(await run(dst, '--source', src));
    const names = await fs.readdir(dst);
    t.ok('remote/・*-secrets.json・control.json・ロックを写さない', !names.includes('remote') && !names.some(name => /secrets|control|\.lock/.test(name)), names.join(','));
    t.ok('設定とそのほかのファイルは写す（会話の本文・引き継ぎも、--light なしなら）', names.includes('prefs.json') && names.includes('conversations') && names.includes('handoff-abc.json'));
    t.ok('DB は WAL の未反映の分ごと写る（VACUUM INTO）', readSessions(dst).live?.title === 'WAL の中だけにある' && readSessions(dst).a?.title === '会話', JSON.stringify(Object.keys(readSessions(dst))));
    t.ok('委譲のタスクは既定で空にする（委譲の続きを走らせない）', Object.keys(readAgentTasks(dst)).length === 0 && result.keepTasks === false);
    t.ok('元は読むだけ（ファイルも中身も変わらない）', sameList(await fs.readdir(src), before) && Object.keys(readAgentTasks(src)).length === 1 && readSessions(src).live?.title === 'WAL の中だけにある');

    const kept = path.join(root, 'kept');
    await run(kept, '--source', src, '--keep-tasks', '--light');
    const keptNames = await fs.readdir(kept);
    t.ok('--keep-tasks は委譲のタスクを残す。--light は本文・引き継ぎを写さない', readAgentTasks(kept)['ply-task-1']?.status === 'running'
      && !keptNames.includes('conversations') && !keptNames.includes('handoff-abc.json') && keptNames.includes('prefs.json'));

    const refused = await run(path.join(src, 'inside'), '--source', src).then(() => null, e => e.message);
    t.ok('元の中・空でない置き場へは写さない', /separate directory/.test(refused ?? '') && !(await exists(path.join(src, 'inside')))
      && /not empty/.test(await run(dst, '--source', src).then(() => '', e => e.message)));
  } finally {
    handle.release();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
