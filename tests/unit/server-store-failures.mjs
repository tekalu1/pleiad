// 保存（DB への書き込み）の失敗が例外として返るようになったので、待たずに呼んで受けていない箇所があると、処理されない Promise の拒否で
// サーバーが落ちる（Node の既定）。ここでは、サーバー（fake）の DB への書き込みを全部失敗させたまま、代表的な操作と 1 ターンを走らせ、
//   - サーバーが落ちずに応答し続けること
//   - 受けていない拒否（サーバーのログの [unhandledRejection]）が 1 つも無いこと
//   - 書けない間のコマンドが、エラーとして返ること（黙って成功したことにしない）
//   - 書けるようになれば、同じ操作が通って DB に残ること
// を確かめる。書き込みの失敗は tests/lib/fail-writes-preload.mjs（フラグのファイルがある間だけ、サーバーの INSERT・UPDATE・DELETE を失敗させる）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { readSessions } from '../lib/data-store.mjs';
import { readFileSync } from 'node:fs';

export const name = 'server-store-failures';
export const title = '保存が全部失敗しても、サーバーは落ちず、拒否を受け損ねない（[unhandledRejection] が出ない）。書けるようになれば続きが通る';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-store-failures-server-'));
  const dataDir = path.join(scratch, 'data'), flag = path.join(scratch, 'fail-writes');
  const preload = pathToFileURL(path.join(ROOT, 'tests', 'lib', 'fail-writes-preload.mjs')).href;
  let server, c;
  try {
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', PLEIAD_FAIL_FLAG: flag, NODE_OPTIONS: `--import=${preload}` }, dataDir });
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.runTurn({ sessionId, prompt: 'echo:before' }, { ms: 15_000 });
    t.ok('書き込みが通る間は、1 ターン走って会話が DB に残る', !!readSessions(dataDir)[sessionId]?.backend);

    // ---- 書き込みを全部失敗させる
    await fs.writeFile(flag, '1');
    const outcome = async (label, run) => run().then(() => `${label}:ok`, e => `${label}:error(${String(e?.message ?? e).slice(0, 60)})`);
    const results = [];
    results.push(await outcome('saveDraft', () => c.cmd('saveDraft', { sessionId, text: 'draft while failing' })));
    results.push(await outcome('setTitle', () => c.cmd('setTitle', { sessionId, title: 'new title' })));
    results.push(await outcome('setMode', () => c.cmd('setMode', { sessionId, mode: 'plan' })));
    results.push(await outcome('markRead', () => c.cmd('markRead', { reads: [[sessionId, Date.now() + 60_000]] })));
    results.push(await outcome('setStatus', () => c.cmd('setStatus', { sessionId, status: 'x', reason: 'test' })));
    results.push(await outcome('setGrouped', () => c.cmd('setGrouped', { sessionId, ungrouped: true })));
    results.push(await outcome('sendMessage', () => c.cmd('sendMessage', { sessionId, messageId: 'message-while-failing-0001', prompt: 'echo:queued' })));
    const created = await outcome('newSession', () => c.cmd('newSession', { backend: 'fake', cwd: ROOT }));
    results.push(created);
    // 書けない間に 1 ターン走らせる（開始・途中・終わりの保存が全部失敗する）。続けて中断
    results.push(await outcome('runTurn', () => c.cmd('runTurn', { sessionId, prompt: 'echo:while-failing' })));
    await sleep(1500);
    results.push(await outcome('abort', () => c.cmd('abort', { sessionId })));
    results.push(await outcome('runTurn(slow)', () => c.cmd('runTurn', { sessionId, prompt: 'slow' })));
    await sleep(800);
    results.push(await outcome('abort(2)', () => c.cmd('abort', { sessionId })));
    await sleep(1500);

    const errors = results.filter(r => /:error\(/.test(r));
    t.ok('書けない間のコマンドは、黙って成功にせず、エラーとして返る', ['saveDraft', 'setTitle', 'setMode', 'markRead', 'setGrouped', 'newSession'].every(label => results.some(r => r.startsWith(`${label}:error(`))), results.join(' | '));
    t.ok('エラーには保存の失敗の理由が入る', errors.some(r => /injected store failure/.test(r)), errors.join(' | '));
    const alive = await c.cmd('running').then(r => Array.isArray(r?.turns), () => false);
    t.ok('書き込みが全部失敗していても、サーバーは落ちずに応答し続ける', alive);
    const log = server.tail(400);
    t.ok('受けていない拒否（[unhandledRejection]）が 1 つも出ていない', !/\[unhandledRejection\]/.test(log), log.split('\n').filter(line => /unhandledRejection/.test(line)).slice(0, 3).join('\n'));

    t.ok('念のための受け止め（unhandledRejection の登録）が core/server.mjs にある', /process\.on\('unhandledRejection'/.test(readFileSync(path.join(ROOT, 'core', 'server.mjs'), 'utf8')));

    // ---- 書けるようになれば、同じ操作が通る
    await fs.rm(flag, { force: true });
    await c.cmd('saveDraft', { sessionId, text: 'draft after recovery' });
    await c.cmd('setTitle', { sessionId, title: 'recovered title' });
    const saved = readSessions(dataDir)[sessionId];
    t.ok('書けるようになれば、同じ操作が通って DB に残る', saved?.title === 'recovered title' && saved?.draft?.text === 'draft after recovery', JSON.stringify({ title: saved?.title, draft: saved?.draft?.text }));
    t.ok('失敗の間に書けなかった内容は、DB に半端に残っていない（失敗した変更が混ざらない）', saved?.mode !== 'plan' && !saved?.ungrouped);
  } finally {
    c?.close();
    await server?.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
