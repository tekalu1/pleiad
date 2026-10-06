// 貼り付けた HTML の画像を、ホストが取りに行く口（core/image-import.mjs、WS の attachImport。docs/adr/0141）。
//   - 守り: https のみ・公開アドレスのみ（名前の解決先・IP 直書き・リダイレクト先を毎回検査）・Cookie / Referer / 認証を付けない・
//     リダイレクト 5 回まで・1 枚 10 MiB・時間切れ・やめる・同時の上限・先頭のバイトが png / jpeg / gif / webp / avif のものだけ（SVG・HTML は断る）
//   - 置き場: 添付と同じ（<データ置き場>/uploads/<会話>/…）。同名・同時刻は枝番
//   - サーバー: attachImport / attachImportCancel（fake バックエンド。127.0.0.1 のテスト用サーバーへ向けるのは、緩めの環境変数を渡したときだけ）
// 本物の外へは出ない（検査は名前の解決とアドレスの種類を見るだけで、取りに行く先は身代わりの fetch か 127.0.0.1 のテスト用サーバー）。
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createImageImporter, sniffImage, IMPORT_MAX_BYTES, IMPORT_MAX_ACTIVE, ImportFailed } from '../../core/image-import.mjs';
import { createUrlGuard } from '../../core/mcp-url-guard.mjs';
import { pinnedFetch } from '../../core/pinned-fetch.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'image-import';
export const title = '貼り付けた画像の取り込み: https・公開アドレスのみ・リダイレクトの検査・大きさ・画像でない中身・やめる・置き場・サーバーの口';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 4)]);
const avif = (brand) => { const b = Buffer.alloc(24); b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'latin1'); b.write(brand, 8, 'latin1'); b.write('mif1', 16, 'latin1'); return b; };
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><title>x</title>');

const respond = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
const PUBLIC = '93.184.216.34';

/** 取り込みの口を作る。fetch は身代わり。名前の解決は table（無い名前は解決できない） */
function importerWith({ fetchFn, table = {}, timeoutMs, dir }) {
  const lookup = async (host) => { if (!table[host]) throw new Error('ENOTFOUND'); return table[host].map((address) => ({ address })); };
  return createImageImporter({
    target: (sessionId, name) => ({ dir: path.join(dir, sessionId ?? '_new'), rel: `T_${name}` }),
    lookup, fetchFn, ...(timeoutMs ? { timeoutMs } : {}),
  });
}
const code = (p) => p.then(() => null, (e) => (e instanceof ImportFailed ? e.code : `other:${e?.message}`));
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-image-import-'));
  const table = { 'img.example.com': [PUBLIC], 'cdn.example.com': ['93.184.216.35'], 'inside.example.com': ['10.0.0.8'], 'loop.example.com': ['127.0.0.1'], 'both.example.com': [PUBLIC, '192.168.1.5'] };
  try {
    // ---- 画像の種類（先頭のバイト）
    t.ok('先頭のバイト: PNG・JPEG・GIF・WebP・AVIF を見分ける',
      sniffImage(PNG)?.ext === 'png' && sniffImage(JPEG)?.ext === 'jpg' && sniffImage(GIF)?.ext === 'gif' && sniffImage(WEBP)?.ext === 'webp'
      && sniffImage(avif('avif'))?.mime === 'image/avif' && sniffImage(avif('avis'))?.ext === 'avif');
    t.ok('先頭のバイト: SVG・HTML・短すぎるもの・HEIC（avif でない ftyp）は画像にしない',
      sniffImage(SVG) === null && sniffImage(HTML) === null && sniffImage(Buffer.alloc(0)) === null && sniffImage(Buffer.from([0x89, 0x50])) === null && sniffImage(avif('heic')) === null);

    // ---- 行き先の検査（取りに行く前に断る。fetch は 1 度も呼ばれない）
    let calls = [];
    const never = async (url, init) => { calls.push({ url, init }); return respond(PNG); };
    const strict = importerWith({ fetchFn: never, table, dir });
    const rejected = {
      'http（https でない）': 'http://img.example.com/a.png',
      '127.0.0.1 の直書き': 'https://127.0.0.1/a.png',
      '[::1] の直書き': 'https://[::1]/a.png',
      '私設アドレス（10.x）': 'https://10.1.2.3/a.png',
      '私設アドレス（192.168.x）': 'https://192.168.0.1/a.png',
      'メタデータのアドレス': 'https://169.254.169.254/latest/meta-data',
      '名前の解決先が私設': 'https://inside.example.com/a.png',
      '名前の解決先がループバック': 'https://loop.example.com/a.png',
      '解決先の 1 つが私設': 'https://both.example.com/a.png',
      '解決できない名前': 'https://nowhere.example.com/a.png',
      'ユーザー情報つき': 'https://user:pass@img.example.com/a.png',
      'ftp': 'ftp://img.example.com/a.png',
      'file': 'file:///C:/Windows/win.ini',
      'data': 'data:image/png;base64,AAAA',
      'javascript': 'javascript:alert(1)',
      'URL でない': 'not a url',
    };
    for (const [label, url] of Object.entries(rejected)) {
      const c = await code(strict.importImage({ url }));
      t.ok(`断る: ${label}`, c === 'rejected', c);
    }
    t.ok('断ったものは、1 度も接続しない', calls.length === 0, String(calls.length));

    // ---- 取れる: 接続を解決した答えに固定し、Cookie・Referer・認証を付けない
    calls = [];
    const ok = await strict.importImage({ url: 'https://img.example.com/a/b.png?x=1', sessionId: 's1', name: 'architecture' });
    t.ok('公開アドレスの https は取れる（名前は alt から。拡張子は中身から）', ok.kind === 'image' && ok.mime === 'image/png' && ok.name === 'architecture.png' && ok.bytes === PNG.length, JSON.stringify(ok));
    t.ok('置き場は会話ごとのフォルダー・中身はそのまま', path.dirname(ok.path) === path.join(dir, 's1') && (await fs.readFile(ok.path)).equals(PNG));
    const init = calls[0]?.init ?? {};
    const sent = Object.keys(init.headers ?? {}).map((k) => k.toLowerCase());
    t.ok('接続は検査した答え（IP）に固定する（DNS rebinding の対策）', JSON.stringify(init.pinnedAddresses) === JSON.stringify([PUBLIC]), JSON.stringify(init.pinnedAddresses));
    t.ok('Cookie・Referer・認証ヘッダーを付けない', !sent.some((k) => ['cookie', 'referer', 'authorization', 'proxy-authorization', 'origin'].includes(k)) && !init.credentials, sent.join());
    t.ok('リダイレクトは自分で追う（redirect: manual）・GET', init.redirect === 'manual' && init.method === 'GET');
    const same = await Promise.all([strict.importImage({ url: 'https://img.example.com/1.png', sessionId: 's1', name: 'same' }), strict.importImage({ url: 'https://img.example.com/2.png', sessionId: 's1', name: 'same' })]);
    t.ok('同じ名前の取り込みは別のファイルに置く（上書きしない）', same[0].path !== same[1].path && (await fs.readdir(path.join(dir, 's1'))).filter((f) => f.startsWith('T_same')).length === 2);
    const noName = await strict.importImage({ url: 'https://img.example.com/c.jpg' });
    t.ok('名前が無ければ image。URL からはファイル名を作らない', noName.name === 'image.png' && !/c\.jpg|img\.example/.test(path.basename(noName.path)), noName.path);
    const weird = await strict.importImage({ url: 'https://img.example.com/d.png', name: '../../evil/x.png' });
    t.ok('名前に区切りがあっても置き場の外へ出ない', path.dirname(weird.path) === path.join(dir, '_new') && !path.basename(weird.path).includes('/') , weird.path);

    // ---- リダイレクト: 1 ホップずつ検査して追う（5 回まで）
    const hops = {};
    const chain = importerWith({ table, dir, fetchFn: async (url) => hops[url]?.() ?? respond('gone', { status: 404 }) });
    hops['https://img.example.com/r1'] = () => redirect('https://cdn.example.com/final.png');
    hops['https://cdn.example.com/final.png'] = () => respond(PNG);
    t.ok('公開アドレスへのリダイレクトは追って取れる', (await chain.importImage({ url: 'https://img.example.com/r1' })).bytes === PNG.length);
    hops['https://img.example.com/r2'] = () => redirect('https://inside.example.com/secret.png');
    t.ok('リダイレクト先が私設アドレスなら断る', await code(chain.importImage({ url: 'https://img.example.com/r2' })) === 'rejected');
    hops['https://img.example.com/r3'] = () => redirect('http://cdn.example.com/plain.png');
    t.ok('リダイレクト先が http なら断る', await code(chain.importImage({ url: 'https://img.example.com/r3' })) === 'rejected');
    hops['https://img.example.com/r4'] = () => redirect('https://127.0.0.1/x.png');
    t.ok('リダイレクト先が 127.0.0.1 なら断る', await code(chain.importImage({ url: 'https://img.example.com/r4' })) === 'rejected');
    for (let i = 0; i < 6; i++) hops[`https://img.example.com/c${i}`] = () => redirect(`https://img.example.com/c${i + 1}`);
    hops['https://img.example.com/c5'] = () => respond(PNG);
    hops['https://img.example.com/c6'] = () => respond(PNG);
    t.ok('リダイレクトは 5 回まで（5 回目の先は取れる）', (await chain.importImage({ url: 'https://img.example.com/c0' })).bytes === PNG.length);
    hops['https://img.example.com/c5'] = () => redirect('https://img.example.com/c6');
    t.ok('リダイレクトが 6 回続いたら断る', await code(chain.importImage({ url: 'https://img.example.com/c0' })) === 'rejected');

    // ---- 大きさ・中身・状態
    const body = (buf, headers) => importerWith({ table, dir, fetchFn: async () => respond(buf, { headers }) });
    t.ok('10 MiB ちょうどは取れる', (await body(Buffer.concat([PNG, Buffer.alloc(IMPORT_MAX_BYTES - PNG.length)])).importImage({ url: 'https://img.example.com/e.png' })).bytes === IMPORT_MAX_BYTES);
    t.ok('10 MiB + 1 バイトは断る（Content-Length が嘘でも、読みながら数えて切る）',
      await code(body(Buffer.concat([PNG, Buffer.alloc(IMPORT_MAX_BYTES - PNG.length + 1)]), { 'content-length': '100' }).importImage({ url: 'https://img.example.com/f.png' })) === 'too-large');
    let pulled = 0;
    const big = importerWith({ table, dir, fetchFn: async () => respond(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024 * 1024).fill(9)); } }), { headers: { 'content-length': String(IMPORT_MAX_BYTES * 3) } }) });
    t.ok('Content-Length が上限を超えていれば、本体を読まずに断る', await code(big.importImage({ url: 'https://img.example.com/g.png' })) === 'too-large' && pulled <= 2, `pulled=${pulled}`);
    t.ok('終わらない本体は上限で切る（読み進めない）', await code(importerWith({ table, dir, fetchFn: async () => respond(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024).fill(1)); } })) }).importImage({ url: 'https://img.example.com/h.png' })) === 'too-large');
    t.ok('SVG は断る（Content-Type が image/svg+xml でも image/png と偽っても）', await code(body(SVG, { 'content-type': 'image/png' }).importImage({ url: 'https://img.example.com/i.png' })) === 'not-image'
      && await code(body(SVG, { 'content-type': 'image/svg+xml' }).importImage({ url: 'https://img.example.com/i.svg' })) === 'not-image');
    t.ok('HTML・空・実行ファイルの先頭は画像にしない', await code(body(HTML, { 'content-type': 'image/png' }).importImage({ url: 'https://img.example.com/j.png' })) === 'not-image'
      && await code(body(Buffer.alloc(0)).importImage({ url: 'https://img.example.com/k.png' })) === 'not-image'
      && await code(body(Buffer.from('MZ\u0090\u0000\u0003')).importImage({ url: 'https://img.example.com/l.png' })) === 'not-image');
    t.ok('Content-Type が無い・octet-stream でも、先頭のバイトが画像なら置く（拡張子は中身から）', (await body(WEBP, { 'content-type': 'application/octet-stream' }).importImage({ url: 'https://img.example.com/m', name: 'x' })).name === 'x.webp');
    t.ok('404・500 は取れなかったことにする', await code(importerWith({ table, dir, fetchFn: async () => respond('no', { status: 404 }) }).importImage({ url: 'https://img.example.com/n.png' })) === 'http-status'
      && await code(importerWith({ table, dir, fetchFn: async () => respond('no', { status: 500 }) }).importImage({ url: 'https://img.example.com/n.png' })) === 'http-status');
    t.ok('接続できない（fetch が例外）は取れなかったことにする', await code(importerWith({ table, dir, fetchFn: async () => { throw new TypeError('fetch failed'); } }).importImage({ url: 'https://img.example.com/o.png' })) === 'network');

    // ---- 時間切れ・やめる・同時の上限
    const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true }));
    const slow = importerWith({ table, dir, fetchFn: hang, timeoutMs: 120 });
    const t0 = Date.now();
    t.ok('時間切れ（応答が来ない）', await code(slow.importImage({ url: 'https://img.example.com/p.png' })) === 'timeout' && Date.now() - t0 < 3000);
    const stall = importerWith({ table, dir, timeoutMs: 150, fetchFn: async (url, init) => respond(new ReadableStream({ start(c) { c.enqueue(PNG); init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true }); } })) });
    t.ok('時間切れ（本体が途中で止まる）', await code(stall.importImage({ url: 'https://img.example.com/q.png' })) === 'timeout');
    const cancelable = importerWith({ table, dir, fetchFn: hang });
    const pending = code(cancelable.importImage({ url: 'https://img.example.com/r.png', importId: 'job-1' }));
    await new Promise((r) => setTimeout(r, 30));
    t.ok('取りに行っている途中でやめられる（cancelled・同時の数が戻る）', cancelable.cancel('job-1') === true && await pending === 'cancelled' && cancelable.activeCount === 0);
    t.ok('知らない id・終わった id のやめるは false', cancelable.cancel('job-1') === false && cancelable.cancel('nope') === false);
    const limited = importerWith({ table, dir, fetchFn: hang });
    const held = Array.from({ length: IMPORT_MAX_ACTIVE }, (_, i) => code(limited.importImage({ url: `https://img.example.com/s${i}.png`, importId: `h${i}` })));
    await new Promise((r) => setTimeout(r, 30));
    t.ok(`同時に取りに行くのは ${IMPORT_MAX_ACTIVE} 件まで（超えたら断る）`, await code(limited.importImage({ url: 'https://img.example.com/over.png' })) === 'busy' && limited.activeCount === IMPORT_MAX_ACTIVE);
    for (let i = 0; i < IMPORT_MAX_ACTIVE; i++) limited.cancel(`h${i}`);
    await Promise.all(held);
    t.ok('やめたら枠が空く', limited.activeCount === 0);

    // ---- 本物の接続（127.0.0.1 のテスト用サーバー。検査の差し替えは緩めの検査器だけ）
    const seen = [];
    const srv = await listen((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      if (req.url === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
      if (req.url === '/hop') { res.writeHead(302, { location: '/img.png' }); return res.end(); }
      if (req.url === '/svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(SVG); }
      res.writeHead(404); res.end();
    });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const relaxed = createImageImporter({ target: (s, n) => ({ dir: path.join(dir, 'real'), rel: `R_${n}` }), guard: createUrlGuard({ serverUrl: 'http://127.0.0.1' }), fetchFn: pinnedFetch });
      const real = await relaxed.importImage({ url: `${base}/hop`, name: 'real' });
      t.ok('（緩めの検査器）127.0.0.1 のテスト用サーバーから、リダイレクトを追って取れる', real.bytes === PNG.length && (await fs.readFile(real.path)).equals(PNG));
      const h = seen.at(-1).headers;
      t.ok('実際の要求に Cookie・Referer・認証・Origin が無い', !('cookie' in h) && !('referer' in h) && !('authorization' in h) && !('origin' in h) && /Pleiad/.test(h['user-agent']), JSON.stringify(h));
      t.ok('（緩めの検査器）SVG は断る', await code(relaxed.importImage({ url: `${base}/svg` })) === 'not-image');
      const production = createImageImporter({ target: (s, n) => ({ dir: path.join(dir, 'real'), rel: `P_${n}` }) });
      const before = seen.length;
      t.ok('本番の検査器は 127.0.0.1 のテスト用サーバーを断り、接続もしない', await code(production.importImage({ url: `https://127.0.0.1:${srv.address().port}/img.png` })) === 'rejected'
        && await code(production.importImage({ url: `${base}/img.png` })) === 'rejected' && seen.length === before);
    } finally { await new Promise((r) => srv.close(r)); }

    // ---- サーバー: attachImport / attachImportCancel
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-image-import-srv-'));
    const web = await listen((req, res) => {
      if (req.url === '/ok.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
      if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HTML); }
      if (req.url === '/slow.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.write(PNG); return; }
      res.writeHead(404); res.end();
    });
    const webBase = `http://127.0.0.1:${web.address().port}`;
    let strictServer, relaxedServer, c1, c2;
    try {
      strictServer = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
      c1 = await open({ port: strictServer.port, token: strictServer.token, autoAllow: true });
      const denied = await c1.cmd('attachImport', { url: `${webBase}/ok.png`, name: 'x' }).then(() => null, (e) => e.message);
      t.ok('サーバー（既定）: 127.0.0.1 の http は断る（緩めの環境変数が無ければ、テスト用のサーバーにも届かない）', Boolean(denied), String(denied));
      const denied2 = await c1.cmd('attachImport', { url: 'https://127.0.0.1:1/ok.png' }).then(() => null, (e) => e.message);
      t.ok('サーバー（既定）: 127.0.0.1 の https も断る', Boolean(denied2), String(denied2));
      await c1.close?.();
      await strictServer.stop?.();
      relaxedServer = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_IMAGE_IMPORT_LOOPBACK: '1' } });
      c2 = await open({ port: relaxedServer.port, token: relaxedServer.token, autoAllow: true });
      const { sessionId } = await c2.cmd('newSession', { backend: 'fake', cwd: ROOT });
      const r = await c2.cmd('attachImport', { url: `${webBase}/ok.png`, sessionId, name: '構成図', importId: 'imp-1' });
      t.ok('サーバー（緩め）: 取れて、添付の置き場（会話ごと）に置く。返す形は { path, bytes, kind }（+ mime・name）',
        r.kind === 'image' && r.bytes === PNG.length && r.name === '構成図.png' && path.dirname(r.path) === path.join(dataDir, 'uploads', sessionId) && (await fs.readFile(r.path)).equals(PNG), JSON.stringify(r));
      const notImg = await c2.cmd('attachImport', { url: `${webBase}/page`, sessionId }).then(() => null, (e) => e.message);
      t.ok('サーバー: 画像でない中身は失敗（置き場にも残さない）', Boolean(notImg) && (await fs.readdir(path.join(dataDir, 'uploads', sessionId))).length === 1);
      const bad = await c2.cmd('attachImport', { url: '' }).then(() => null, (e) => e.message);
      t.ok('サーバー: 入力の検査（空の URL は断る）', Boolean(bad));
      const slow2 = c2.cmd('attachImport', { url: `${webBase}/slow.png`, sessionId, importId: 'imp-2' }).then(() => 'done', () => 'failed');
      await new Promise((res) => setTimeout(res, 300));
      const cancelled = await c2.cmd('attachImportCancel', { importId: 'imp-2' });
      t.ok('サーバー: attachImportCancel で取りに行っている途中のものをやめる（取り込みは失敗で返る）', cancelled.cancelled === true && await slow2 === 'failed');
      t.ok('サーバー: 知らない importId のやめるは cancelled: false', (await c2.cmd('attachImportCancel', { importId: 'nope' })).cancelled === false);
    } finally {
      await c1?.close?.(); await c2?.close?.();
      await strictServer?.stop?.(); await relaxedServer?.stop?.();
      web.closeAllConnections?.(); await new Promise((r) => web.close(r));
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
