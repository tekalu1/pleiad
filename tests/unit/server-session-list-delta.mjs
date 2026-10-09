import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-session-list-delta';
export const title = 'サーバーの一覧: 委譲の詳しい中身を外し、差分で返し、中継越しの大きい返事は /bulk で gzip にして渡す（ADR 0903）';

const N = 400;
const ENV = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_BIND: '127.0.0.1' };

// 委譲の子が多い一覧を、会話の表に直に入れて作る（fake の会話を 400 本立てるより速い）
function seed(dir) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'pleiad.db'));
  const now = Date.now();
  const ids = Array.from({ length: N }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  db.exec('BEGIN');
  const s1 = db.prepare('INSERT INTO sessions (session_id) VALUES (?)');
  const s2 = db.prepare('INSERT OR REPLACE INTO session_fields (session_id, field, value) VALUES (?, ?, ?)');
  ids.forEach((id, i) => {
    s1.run(id);
    const put = (f, v) => s2.run(id, f, JSON.stringify(v));
    put('backend', 'fake'); put('title', `会話 ${i}`); put('cwd', 'D:/dev/x'); put('lastModified', now - i * 60_000);
    if (i % 2) {
      put('delegation', { taskId: `ply-task-${i}`, parentSessionId: ids[0], manager: 'ply' });
      put('routing', { mode: 'auto', kind: 'code', difficulty: 'hard', target: { backend: 'codex', model: 'gpt-5.5-codex', account: 'a', effort: 'high' },
        skipped: [{ backend: 'claude', model: 'claude-opus-5-5', reason: 'quota_full', window: { label: '5 時間', used: 0.97 } }],
        judge: { model: 'd1', ms: 400, signal: 'code' }, targetWindows: [{ label: '5 時間', used: 0.4 }, { label: '週', used: 0.2 }] });
    }
  });
  db.exec('COMMIT');
  db.close();
  return ids;
}

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-list-delta-'));
  await (await startServer({ env: ENV, dataDir: dir })).stop();   // 表を作らせる
  const ids = seed(dir);
  const server = await startServer({ env: ENV, dataDir: dir });
  const local = await open({ port: server.port, token: server.token });
  // 中継越しの端末の画面（接続口 core/remote/forward.mjs と同じ印）
  const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`, { headers: { 'x-forwarded-for': 'pleiad-remote' } });
  const pending = new Map();
  let seq = 0;
  remote.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.kind === 'response') { pending.get(m.id)?.(m); pending.delete(m.id); }
  });
  await new Promise((r, j) => { remote.once('open', r); remote.once('error', j); });
  const send = (command, args, extra = {}) => new Promise((r) => {
    const id = `r${++seq}`;
    pending.set(id, r);
    remote.send(JSON.stringify({ kind: 'command', id, command, args, ...extra }));
  });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const u = new URL(p, `http://127.0.0.1:${server.port}`);
    u.searchParams.set('token', server.token);
    http.get(u, { headers }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
  try {
    // 今までの頼み方（引数なし）は、細くした行の配列
    const rows = await local.cmd('listSessions', {});
    const child = rows.find((r) => r.id === ids[1]);
    t.ok('引数なしは配列で全部', Array.isArray(rows) && rows.length === N, String(rows?.length));
    t.ok('行に routing を載せない', child && rows.every((r) => !('routing' in r)), JSON.stringify(child?.routing));
    t.ok('子の行の delegation は依頼元だけ', JSON.stringify(child?.delegation) === JSON.stringify({ parentSessionId: ids[0] }), JSON.stringify(child?.delegation));
    // 操作（core/ops の sessions.list）は細くしない。画面の WS の listSessions の返し方だけを変える
    const byOp = await local.cmd('invoke', { op: 'sessions.list', args: {} }).catch((e) => ({ error: e.message }));
    const opChild = Array.isArray(byOp) ? byOp.find((r) => r.id === ids[1]) : null;
    t.ok('操作（sessions.list）は詳しい中身のまま', Array.isArray(opChild?.routing?.skipped) && opChild.delegation?.taskId === 'ply-task-1', JSON.stringify(opChild?.routing ?? byOp).slice(0, 200));

    // この PC の画面は bulk を添えても WS で返す
    const inline = await local.cmd('listSessions', { delta: true });
    t.ok('delta は番号つきの全部（最初）', inline?.full === true && inline.rows.length === N && typeof inline.seq === 'string');

    // 中継越しの画面: 大きい返事は /bulk/<id> に置かれ、HTTP で gzip にして取れる
    const first = await send('listSessions', { delta: true }, { bulk: true });
    t.ok('中継越しの大きい返事は WS に置き場の URL だけ', first.ok && /^\/bulk\/[0-9a-f]{32}$/.test(first.bulk ?? '') && !('result' in first), JSON.stringify(first).slice(0, 200));
    const noToken = await new Promise((r) => http.get(`http://127.0.0.1:${server.port}${first.bulk}`, (res) => { res.resume(); r(res.statusCode); }));
    t.ok('トークンが無ければ取れない', noToken === 401, String(noToken));
    const fetched = await get(first.bulk, { 'accept-encoding': 'gzip' });
    const body = JSON.parse(zlib.gunzipSync(fetched.body).toString('utf8'));
    t.ok('HTTP で gzip にして返す', fetched.status === 200 && fetched.headers['content-encoding'] === 'gzip' && body.full === true && body.rows.length === N,
      `${fetched.status} ${fetched.headers['content-encoding']} ${fetched.body.length}`);
    t.ok('置き場は 1 回きり', (await get(first.bulk)).status === 404);

    // 変わった行だけ（小さい返事は WS のまま）
    const renamed = await local.cmd('setTitle', { sessionId: ids[200], title: '名前を変えた' });
    const del = await local.cmd('deleteSession', { sessionId: ids[300] });
    const next = await send('listSessions', { delta: true, since: body.seq }, { bulk: true });
    const d = next.result;
    t.ok('変わらない行は送らない', next.ok && renamed === 'ok' && del === 'deleted' && d?.full === false && d.rows.length >= 1 && d.rows.length <= 2 && d.rows.some((r) => r.id === ids[200] && r.title === '名前を変えた'),
      JSON.stringify(d).slice(0, 300));
    t.ok('消した行は removed', d?.removed?.length === 1 && d.removed[0] === ids[300], JSON.stringify(d?.removed));
    t.ok('差分は小さいので WS で返す', !next.bulk && Buffer.byteLength(JSON.stringify(d)) < 4096);
    const stale = await send('listSessions', { delta: true, since: 'nope.1' });
    t.ok('知らない番号なら全部', stale.ok && stale.result?.full === true && stale.result.rows.length === N - 1);
    const bad = await send('listSessions', { delta: true, limit: 'x' });
    t.ok('操作の入力は今までどおり確かめる', bad.ok === false, JSON.stringify(bad).slice(0, 200));
  } finally {
    remote.close();
    local.close?.();
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
