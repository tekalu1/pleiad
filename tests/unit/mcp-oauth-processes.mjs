// データ置き場を共有する 2 つのプロセス（開発版と配布版の Pleiad が同じ ~/.agent-host を見る場合）の排他。
// 本物の子プロセスを 2 本起動し（tests/lib/mcp-oauth-child.mjs）、同時にリフレッシュと秘密の書き込みをさせる。
// 認可サーバーはローテーションするモック（使ったリフレッシュトークンは無効になる）なので、二重にリフレッシュすれば片方が invalid_grant で落ちる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createSecretStore } from '../../core/secret-store.mjs';
import { createPlyMcp } from '../../core/ply-mcp.mjs';
import { createMcpOAuth } from '../../core/mcp-oauth.mjs';
import { ROOT } from '../lib/server.mjs';
import { mockOAuth, browse, until } from '../lib/mcp-oauth-mock.mjs';

export const name = 'mcp-oauth-processes';
export const title = '外部 MCP: 2 つのプロセスが同時にリフレッシュ・書き込みしても壊れず、リフレッシュは 1 回';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-procs-'));
  // トークン要求を遅らせて、2 つのプロセスのリフレッシュが確実に重なるようにする
  const mock = await mockOAuth({ tokenDelay: 300 });
  const children = [];
  try {
    const dataDir = path.join(tmp, 'data');
    const secrets = createSecretStore({ file: path.join(dataDir, 'mcp-secrets.json') });
    const ply = createPlyMcp({ dataDir, secrets });
    const oauth = createMcpOAuth({ secrets, lockDir: path.join(dataDir, 'mcp-locks') });
    await ply.save({ name: 'remote', mode: 'add', value: { transport: 'http', url: mock.mcpUrl, auth: 'oauth' } });
    const def = await ply.registration('remote');
    const started = await oauth.start('remote', def, await ply.connection('remote', tmp));
    await browse(started.url);
    await until(async () => (await oauth.status('remote', def)).state === 'signed-in');
    const before = (await secrets.get('mcp:remote:oauth')).tokens;

    // 子の時計は 2 時間先（トークンは 1 時間で切れる）
    const script = path.join(ROOT, 'tests', 'lib', 'mcp-oauth-child.mjs');
    for (const id of ['a', 'b']) {
      const child = fork(script, [dataDir, String(2 * 3600_000), id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      const ready = new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', code => reject(new Error(`child ${id} exited ${code}: ${stderr.slice(-500)}`))); });
      const result = new Promise(resolve => child.on('message', m => { if (m !== 'ready') resolve(m); }));
      const exited = new Promise(resolve => child.on('exit', resolve));
      children.push({ child, ready, result, exited });
    }
    await Promise.all(children.map(c => c.ready));
    const calls = mock.as.refreshCalls;
    for (const c of children) c.child.send('go');
    const results = await Promise.race([Promise.all(children.map(c => c.result)), new Promise((_, reject) => setTimeout(() => reject(new Error('children timed out')), 60_000))]);
    await Promise.all(children.map(c => c.exited));

    const errors = results.flatMap(r => r.errors);
    const tokens = results.flatMap(r => r.tokens);
    t.ok('2 つのプロセスとも失敗しない', errors.length === 0, JSON.stringify(errors));
    t.ok('リフレッシュは 2 つのプロセスを合わせて 1 回', mock.as.refreshCalls === calls + 1, String(mock.as.refreshCalls - calls));
    t.ok('どちらのプロセスも同じ新しいトークンを使う', new Set(tokens).size === 1 && tokens[0] !== before.access_token && mock.as.access.has(tokens[0]), JSON.stringify([...new Set(tokens)]));
    const after = (await secrets.get('mcp:remote:oauth')).tokens;
    t.ok('ローテーションした新しいリフレッシュトークンが保存され、AS で有効', after.access_token === tokens[0] && mock.as.refresh.has(after.refresh_token) && !mock.as.refresh.has(before.refresh_token));
    let parsed = null;
    try { parsed = JSON.parse(await fs.readFile(secrets.file, 'utf8')); } catch {}
    t.ok('同時の書き込みでもファイルは壊れない', parsed?.version === 1 && Boolean(parsed.entries));
    t.ok('読んで・変えて・書くを取りこぼさない（2 プロセス × 10 回）', (await secrets.get('counter'))?.n === 20, JSON.stringify(await secrets.get('counter')));
    t.ok('それぞれが書いた項目が全部残る', (await secrets.keys('child:')).length === 20);
    const leftovers = [...await fs.readdir(dataDir), ...await fs.readdir(path.join(dataDir, 'mcp-locks')).catch(() => [])].filter(f => f.endsWith('.tmp') || f.endsWith('.lock'));
    t.ok('ロックと一時ファイルを残さない', leftovers.length === 0, leftovers.join(','));
  } finally {
    for (const c of children) if (c.child.exitCode === null) c.child.kill();
    await mock.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
