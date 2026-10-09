import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { slimRow, createListDeltas } from '../../core/session-list-delta.mjs';
import { createBulkReplies } from '../../core/bulk-replies.mjs';
import { createSessionListSync } from '../../web/session-list-sync.mjs';

export const name = 'session-list-delta';
export const title = '画面の一覧: 行を細くし、差分で送って同じ一覧に組み立てる。大きい返事は WS の外に 1 回だけ置く（ADR 0179）';

export default async function (t) {
  // ---- 行を細くする
  const routing = { mode: 'auto', kind: 'code', difficulty: 'hard', target: { backend: 'codex', model: 'gpt-5.5-codex', account: 'a', effort: 'high' },
    judge: { model: 'd1', ms: 400 }, skipped: [{ backend: 'claude', reason: 'quota_full' }], targetWindows: [{ label: '5 時間', used: 0.3 }] };
  const remote = { deviceId: 'd1', deviceName: 'Pixel', sessionId: 's9', title: '依頼', mode: 'default' };
  const row = { id: 'a', title: 'x', routing, delegation: { taskId: 'ply-task-1', parentSessionId: 'p', manager: 'ply', remote } };
  const slim = slimRow(row);
  t.ok('routing は載せない', !('routing' in slim), JSON.stringify(slim.routing));
  t.ok('delegation は依頼元と端末の印だけ', JSON.stringify(slim.delegation) === JSON.stringify({ parentSessionId: 'p', remote }), JSON.stringify(slim.delegation));
  t.ok('元の行は変えない', row.routing === routing && row.delegation.taskId === 'ply-task-1');
  const plain = { id: 'b', title: 'y', delegation: null };
  t.ok('委譲でない行はそのまま', slimRow(plain) === plain);
  t.ok('routing: null の欄も外す', JSON.stringify(slimRow({ id: 'b', routing: null, delegation: null })) === '{"id":"b","delegation":null}');
  t.ok('端末の印が無ければ remote を付けない', !('remote' in slimRow({ id: 'c', delegation: { parentSessionId: 'p', taskId: 't' } }).delegation));

  // ---- 差分: 乱数で一覧を動かし、受け手が毎回サーバーと同じ並び・同じ中身に組み立てる
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let nextId = 0;
  const make = () => ({ id: `s${nextId++}`, title: `t${nextId}`, lastModified: nextId, status: null });
  let rows = Array.from({ length: 300 }, make);
  const deltas = createListDeltas();
  const conn = {};
  const sync = createSessionListSync();
  let fullReplies = 0, frontReplies = 0, orderReplies = 0, maxDelta = 0;
  for (let step = 0; step < 200; step++) {
    rows = rows.map((r) => ({ ...r }));
    const kind = rnd(6);
    if (kind === 0) { const i = rnd(rows.length); const [r] = rows.splice(i, 1); r.title += '*'; rows.unshift(r); }       // 送った会話が先頭へ
    else if (kind === 1) rows.unshift(make(), make());                                                                       // 新しい会話
    else if (kind === 2 && rows.length > 10) rows.splice(rnd(rows.length), 1);                                                // 消した
    else if (kind === 3) rows[rnd(rows.length)].status = `st${rnd(5)}`;                                                       // その場で変わる
    else if (kind === 4) { const i = rnd(rows.length - 1); [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]]; }                 // 並びだけ入れ替わる
    const reply = JSON.parse(JSON.stringify(deltas.reply(conn, rows, { since: sync.args().since })));
    if (reply.full) fullReplies++; else if (reply.order) orderReplies++; else if (reply.front) frontReplies++;
    if (!reply.full) maxDelta = Math.max(maxDelta, reply.rows.length);
    const got = sync.apply(reply);
    assert.deepEqual(got, rows, `step ${step}`);
  }
  t.ok('200 回動かしても受け手の一覧がサーバーと同じ', true);
  t.ok('全部を送るのは最初の 1 回だけ', fullReplies === 1, String(fullReplies));
  t.ok('先頭へ上がっただけなら並び全部を送らない', frontReplies > 0 && orderReplies < frontReplies, `front ${frontReplies} order ${orderReplies}`);
  t.ok('差分の行は変わった分だけ', maxDelta <= 2, String(maxDelta));

  // 写しが無い番号（別の接続・古すぎる・起動し直したホスト）なら全部を返す
  const other = deltas.reply({}, rows, { since: sync.args().since });
  t.ok('別の接続の番号では全部を返す', other.full === true && other.rows.length === rows.length);
  const fresh = createListDeltas({ keep: 2 });
  const c2 = {};
  const s1 = fresh.reply(c2, rows).seq;
  fresh.reply(c2, rows); fresh.reply(c2, rows);
  t.ok('古すぎる番号では全部を返す', fresh.reply(c2, rows, { since: s1 }).full === true);
  t.ok('変わらなければ空の差分', (() => { const s = fresh.reply(c2, rows).seq; const r = fresh.reply(c2, rows, { since: s }); return !r.full && r.rows.length === 0 && r.removed.length === 0 && !r.order && !r.front; })());

  // 受け手は組み立てられない返事で写しを捨て、次は全部を頼む
  const broken = createSessionListSync();
  broken.apply({ seq: 'x.1', full: true, rows: [{ id: 'a' }] });
  assert.throws(() => broken.apply({ seq: 'x.2', full: false, rows: [], removed: [], order: ['a', 'zz'] }), (e) => e.listSync === true);
  t.ok('組み立てられなければ写しを捨てて since を外す', broken.args().since === undefined);
  t.ok('古い形（配列）の返事も受ける', broken.apply([{ id: 'q' }]).length === 1 && broken.args().since === undefined);
  const crossed = createSessionListSync();
  crossed.apply({ seq: 'z.2', full: true, rows: [{ id: 'a' }] });
  t.ok('別の写しへの差分（行き違い）は当てずに頼み直す', (() => { try { crossed.apply({ seq: 'z.3', full: false, base: 'z.1', rows: [], removed: ['a'] }); return false; } catch (e) { return e.listSync === true && crossed.args().since === undefined; } })());
  const shared = createSessionListSync();
  shared.apply({ seq: 'y.1', full: true, rows: [{ id: 'a', title: 'a' }] });
  const view = shared.apply({ seq: 'y.2', full: false, rows: [], removed: [] });
  view[0].title = 'changed';   // 画面は行を直に書き換える（sidebarChange）
  t.ok('画面が行を書き換えても手元の写しは変わらない', shared.apply({ seq: 'y.3', full: false, rows: [], removed: [] })[0].title === 'a');

  // ---- WS の外の置き場
  let clock = 1000;
  const bulk = createBulkReplies({ minBytes: 1000, ttlMs: 5000, maxBytes: 10_000, now: () => clock });
  t.ok('小さい返事は置かない', bulk.offer('x'.repeat(999)) === null);
  const big = JSON.stringify({ rows: 'あ'.repeat(1000) });
  const url = bulk.offer(big);
  t.ok('大きい返事は /bulk/<32 桁> に置く', /^\/bulk\/[0-9a-f]{32}$/.test(url ?? ''), url);
  const server = http.createServer(async (req, res) => {
    if (!(await bulk.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(418); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
  try {
    const r1 = await get(url, { 'accept-encoding': 'gzip, deflate' });
    t.ok('gzip を受けるなら縮めて返す', r1.status === 200 && r1.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(r1.body).toString('utf8') === big && r1.body.length < Buffer.byteLength(big) / 5,
      `${r1.status} ${r1.headers['content-encoding']} ${r1.body.length}`);
    t.ok('取り置かない（no-store）', r1.headers['cache-control'] === 'private, no-store');
    t.ok('1 回取ったら消える', (await get(url)).status === 404);
    const url2 = bulk.offer(big);
    const r2 = await get(url2);
    t.ok('gzip を受けなければそのまま', r2.status === 200 && !r2.headers['content-encoding'] && r2.body.toString('utf8') === big);
    const url3 = bulk.offer(big);
    clock += 6000;
    t.ok('取りに来なければ時間で消える', (await get(url3)).status === 404 && bulk.size === 0);
    const urls = Array.from({ length: 6 }, () => bulk.offer('y'.repeat(3000)));
    t.ok('置く合計の上限を超えたら古いものから消す', (await get(urls[0])).status === 404 && (await get(urls[5])).status === 200);
    t.ok('上限より大きい 1 つは置かない（WS で返す）', bulk.offer('z'.repeat(20_000)) === null);
    t.ok('ほかのパスは素通し', (await get('/other')).status === 418);
    t.ok('形の違う id は 404', (await get('/bulk/../../x')).status === 404 || (await get('/bulk/xyz')).status === 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
