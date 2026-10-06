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
import { createImageImporter, sniffImage, imageSize, IMPORT_MAX_BYTES, IMPORT_MAX_ACTIVE, ImportFailed } from '../../core/image-import.mjs';
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
// 先頭のヘッダーだけを持つ、大きさ（w×h）つきの画像
const pngOf = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const gifOf = (w, h) => { const b = Buffer.alloc(13); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const jpegOf = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), u16(h), u16(w), Buffer.alloc(12)]);
const webpHead = (fmt) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'latin1'); b.write(fmt, 12, 'latin1'); return b; };
const webpX = (w, h) => { const b = webpHead('VP8X'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const webpL = (w, h) => { const b = webpHead('VP8L'); b[20] = 0x2f; b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21); return b; };
const webpLossy = (w, h) => { const b = webpHead('VP8 '); b.set([0x9d, 0x01, 0x2a], 23); b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b; };
const avifOf = (w, h) => { const ispe = Buffer.alloc(20); ispe.writeUInt32BE(20, 0); ispe.write('ispe', 4, 'latin1'); ispe.writeUInt32BE(w, 12); ispe.writeUInt32BE(h, 16); return Buffer.concat([avif('avif'), ispe]); };
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><title>x</title>');

const respond = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
const PUBLIC = '93.184.216.34';

/** 取り込みの口を作る。fetch は身代わり。名前の解決は table（無い名前は解決できない） */
function importerWith({ fetchFn, table = {}, timeoutMs, dir, lookup: own, ...limits }) {
  const lookup = own ?? (async (host) => { if (!table[host]) throw new Error('ENOTFOUND'); return table[host].map((address) => ({ address })); });
  return createImageImporter({
    target: (sessionId, name) => ({ dir: path.join(dir, sessionId ?? '_new'), rel: `T_${name}` }),
    lookup, fetchFn, ...(timeoutMs ? { timeoutMs } : {}), ...limits,
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

    // ---- 大きさ（先頭のヘッダー）。縦横とも 32px 以下の画像（追跡ピクセル・絵文字）は置かない
    const sizeOf = (buf) => JSON.stringify(imageSize(buf, sniffImage(buf)));
    t.ok('大きさ: PNG・GIF・JPEG（APP0 の後の SOF）・WebP（VP8X・VP8L・VP8）・AVIF（ispe）のヘッダーから縦横を読む',
      sizeOf(pngOf(640, 400)) === '{"width":640,"height":400}' && sizeOf(gifOf(20, 10)) === '{"width":20,"height":10}' && sizeOf(jpegOf(300, 200)) === '{"width":300,"height":200}'
      && sizeOf(webpX(1024, 768)) === '{"width":1024,"height":768}' && sizeOf(webpL(33, 7)) === '{"width":33,"height":7}' && sizeOf(webpLossy(500, 250)) === '{"width":500,"height":250}'
      && sizeOf(avifOf(1200, 630)) === '{"width":1200,"height":630}');
    t.ok('大きさ: 短すぎる・SOF が無い JPEG・ispe が無い AVIF は null', imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), { ext: 'png' }) === null
      && imageSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), Buffer.alloc(30, 7)]), { ext: 'jpg' }) === null && imageSize(avif('avif'), { ext: 'avif' }) === null);

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

    const small = (buf) => importerWith({ table, dir, fetchFn: async () => respond(buf) });
    t.ok('縦横とも 32px 以下の画像は置かない（1×1・32×32。置き場にも残さない）', await code(small(pngOf(1, 1)).importImage({ url: 'https://img.example.com/px.png', sessionId: 'tiny' })) === 'too-small'
      && await code(small(pngOf(32, 32)).importImage({ url: 'https://img.example.com/e.png', sessionId: 'tiny' })) === 'too-small'
      && await code(small(jpegOf(16, 16)).importImage({ url: 'https://img.example.com/e.jpg', sessionId: 'tiny' })) === 'too-small'
      && await code(small(gifOf(1, 1)).importImage({ url: 'https://img.example.com/e.gif', sessionId: 'tiny' })) === 'too-small'
      && await fs.readdir(path.join(dir, 'tiny')).catch(() => []).then((l) => l.length === 0));
    t.ok('どちらかが 33px 以上なら置く（33×32・32×300・大きさが読めないもの）', (await small(pngOf(33, 32)).importImage({ url: 'https://img.example.com/a.png' })).bytes === 33
      && (await small(pngOf(32, 300)).importImage({ url: 'https://img.example.com/b.png' })).kind === 'image' && (await small(PNG).importImage({ url: 'https://img.example.com/c.png' })).bytes === PNG.length);

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
    // 同時に取りに行くのはホスト全体で IMPORT_MAX_ACTIVE 件。超えた分は断らず順番を待つ（待ちの上限を超えたら busy）
    const limited = importerWith({ table, dir, fetchFn: hang, maxWaiting: 2 });
    const held = Array.from({ length: IMPORT_MAX_ACTIVE }, (_, i) => code(limited.importImage({ url: `https://img.example.com/s${i}.png`, importId: `h${i}` })));
    await new Promise((r) => setTimeout(r, 30));
    const waiters = [0, 1].map((i) => code(limited.importImage({ url: `https://img.example.com/w${i}.png`, importId: `w${i}` })));
    await new Promise((r) => setTimeout(r, 30));
    t.ok(`同時に取りに行くのは ${IMPORT_MAX_ACTIVE} 件まで。超えた分は順番を待つ（断らない）`, limited.activeCount === IMPORT_MAX_ACTIVE && limited.waitingCount === 2);
    t.ok('待ちの上限を超えたら busy（待たせない）', await code(limited.importImage({ url: 'https://img.example.com/over.png' })) === 'busy');
    t.ok('順番待ちの 1 件をやめると、取りに行かず cancelled・待ちが減る', limited.cancel('w0') === true && await waiters[0] === 'cancelled' && limited.waitingCount === 1 && limited.activeCount === IMPORT_MAX_ACTIVE);
    limited.cancel('h0');
    await new Promise((r) => setTimeout(r, 30));
    t.ok('枠が空くと、待っていた次の 1 件が取りに行き始める（待ちが空になる）', limited.waitingCount === 0 && limited.activeCount === IMPORT_MAX_ACTIVE);
    for (let i = 1; i < IMPORT_MAX_ACTIVE; i++) limited.cancel(`h${i}`);
    limited.cancel('w1');
    await Promise.all([...held, ...waiters]);
    t.ok('全部やめたら枠が空く', limited.activeCount === 0 && limited.waitingCount === 0);

    // デスクトップとモバイルが同時に貼っても（合わせて枠を超えても）全部入る。同時に取りに行くのは枠まで
    let now = 0, peak = 0;
    const steady = importerWith({ table, dir, fetchFn: async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 40)); now--; return respond(pngOf(64, 64)); } });
    const both = await Promise.all([...Array.from({ length: 6 }, (_, i) => code(steady.importImage({ url: `https://img.example.com/d${i}.png`, importId: `desk${i}`, sessionId: 'desk' }))),
      ...Array.from({ length: 6 }, (_, i) => code(steady.importImage({ url: `https://img.example.com/m${i}.png`, importId: `mob${i}`, sessionId: 'mob' })))]);
    t.ok(`6 枚ずつを 2 つの端末から同時に貼っても 12 枚とも入る（同時に取りに行くのは ${IMPORT_MAX_ACTIVE} 件まで）`, both.every((c) => c === null) && peak === IMPORT_MAX_ACTIVE && steady.activeCount === 0, `${both.join()} peak=${peak}`);

    // 待つ間も 1 枚の制限時間に数える（待ちっぱなしにならない）
    const queueSlow = importerWith({ table, dir, fetchFn: hang, timeoutMs: 150 });
    const first = Array.from({ length: IMPORT_MAX_ACTIVE }, (_, i) => code(queueSlow.importImage({ url: `https://img.example.com/q${i}.png` })));
    await new Promise((r) => setTimeout(r, 20));
    const late = code(queueSlow.importImage({ url: 'https://img.example.com/late.png' }));
    t.ok('順番待ちの間に制限時間が来たら timeout（待ちから外れる）', await late === 'timeout' && queueSlow.waitingCount === 0);
    await Promise.all(first);

    // 名前の解決が終わらなくても、制限時間で失敗にして枠を空ける（解決そのものは止められなくてよい）
    const stuckLookup = () => new Promise(() => {});
    const dns = importerWith({ dir, lookup: stuckLookup, fetchFn: async () => respond(pngOf(64, 64)), timeoutMs: 120, maxActive: 1 });
    const t1 = Date.now();
    t.ok('名前の解決が終わらなくても制限時間で timeout になり、枠が空く', await code(dns.importImage({ url: 'https://stuck.example.com/a.png' })) === 'timeout' && Date.now() - t1 < 2000 && dns.activeCount === 0);
    t.ok('枠が空いているので、次の取り込みは待たされない', await code(dns.importImage({ url: 'https://93.184.216.34/ok.png' })) === null);
    const dnsCancel = importerWith({ dir, lookup: stuckLookup, fetchFn: async () => respond(pngOf(64, 64)) });
    const pendingDns = code(dnsCancel.importImage({ url: 'https://stuck.example.com/b.png', importId: 'dns1' }));
    await new Promise((r) => setTimeout(r, 30));
    t.ok('名前の解決の途中でやめても、すぐ cancelled・枠が空く', dnsCancel.cancel('dns1') === true && await pendingDns === 'cancelled' && dnsCancel.activeCount === 0);

    // ---- やめるが、取りに行く前・書いた後に届いたとき（画面が結果を捨てたら、ファイルを残さない）
    const files = (d) => fs.readdir(path.join(dir, d)).catch(() => []);
    const late1 = importerWith({ table, dir, fetchFn: async () => respond(pngOf(64, 64)) });
    t.ok('まだ届いていない importId のやめるは false。そのあと届いた取り込みは、取りに行かず cancelled', late1.cancel('early-1') === false && await code(late1.importImage({ url: 'https://img.example.com/a.png', importId: 'early-1', sessionId: 'gone1' })) === 'cancelled'
      && (await files('gone1')).length === 0);
    const done1 = await late1.importImage({ url: 'https://img.example.com/b.png', importId: 'after-1', sessionId: 'gone2' });
    t.ok('取れて置いたあとに届いたやめるは、置いたファイルを消す（true）。もう一度は false', (await files('gone2')).length === 1 && late1.cancel('after-1') === true
      && await (async () => { await new Promise((r) => setTimeout(r, 30)); return (await files('gone2')).length === 0; })() && late1.cancel('after-1') === false && done1.path.length > 0);
    // 置く直前にやめられた（target の中で届く）: 書き終わったあとの確認でファイルを消して cancelled
    let hook;
    const midWrite = createImageImporter({ target: (sessionId, name) => { hook.cancel('mid-1'); return { dir: path.join(dir, sessionId), rel: `T_${name}` }; }, lookup: async () => [{ address: PUBLIC }], fetchFn: async () => respond(pngOf(64, 64)) });
    hook = midWrite;
    t.ok('置く直前にやめられたら cancelled。置いたファイルも残らない', await code(midWrite.importImage({ url: 'https://img.example.com/c.png', importId: 'mid-1', sessionId: 'gone3' })) === 'cancelled' && (await files('gone3')).length === 0);

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
      t.ok('サーバー（既定）: 127.0.0.1 の http は断る', Boolean(denied), String(denied));

      const denied2 = await c1.cmd('attachImport', { url: 'https://127.0.0.1:1/ok.png' }).then(() => null, (e) => e.message);
      t.ok('サーバー（既定）: 127.0.0.1 の https も断る', Boolean(denied2), String(denied2));
      await c1.close?.();
      await strictServer.stop?.();
      relaxedServer = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_IMAGE_IMPORT_TEST_ORIGIN: webBase } });
      c2 = await open({ port: relaxedServer.port, token: relaxedServer.token, autoAllow: true });
      const { sessionId } = await c2.cmd('newSession', { backend: 'fake', cwd: ROOT });
      const r = await c2.cmd('attachImport', { url: 'https://cdn.example.com/ok.png', sessionId, name: '構成図', importId: 'imp-1' });
      t.ok('サーバー（緩め）: https の URL をテスト用サーバーへ向け替えて取れて、添付の置き場（会話ごと）に置く。返す形は { path, bytes, kind }（+ mime・name）',
        r.kind === 'image' && r.bytes === PNG.length && r.name === '構成図.png' && path.dirname(r.path) === path.join(dataDir, 'uploads', sessionId) && (await fs.readFile(r.path)).equals(PNG), JSON.stringify(r));
      const notImg = await c2.cmd('attachImport', { url: 'https://cdn.example.com/page', sessionId }).then(() => null, (e) => e.message);
      t.ok('サーバー: 画像でない中身は失敗（置き場にも残さない）', Boolean(notImg) && (await fs.readdir(path.join(dataDir, 'uploads', sessionId))).length === 1);
      const bad = await c2.cmd('attachImport', { url: '' }).then(() => null, (e) => e.message);
      t.ok('サーバー: 入力の検査（空の URL は断る）', Boolean(bad));
      const slow2 = c2.cmd('attachImport', { url: 'https://cdn.example.com/slow.png', sessionId, importId: 'imp-2' }).then(() => 'done', () => 'failed');
      await new Promise((res) => setTimeout(res, 300));
      const cancelled = await c2.cmd('attachImportCancel', { importId: 'imp-2' });
      t.ok('サーバー: attachImportCancel で取りに行っている途中のものをやめる（取り込みは失敗で返る）', cancelled.cancelled === true && await slow2 === 'failed');
      t.ok('サーバー: 知らない importId のやめるは cancelled: false', (await c2.cmd('attachImportCancel', { importId: 'nope' })).cancelled === false);
      const kept = await c2.cmd('attachImport', { url: 'https://cdn.example.com/ok.png', sessionId, name: 'discard', importId: 'imp-3' });
      const cancelAfter = await c2.cmd('attachImportCancel', { importId: 'imp-3' });
      await new Promise((res) => setTimeout(res, 100));
      t.ok('サーバー: 取れて置いたあとに届いたやめるは、置いたファイルを消す（画面が結果を捨てたとき）', cancelAfter.cancelled === true && await fs.stat(kept.path).then(() => false, () => true));
      const early = await c2.cmd('attachImportCancel', { importId: 'imp-4' });
      const afterEarly = await c2.cmd('attachImport', { url: 'https://cdn.example.com/ok.png', sessionId, importId: 'imp-4' }).then(() => null, (e) => e.message);
      t.ok('サーバー: まだ届いていない importId のやめるのあとに届いた取り込みは、取りに行かず失敗（ファイルを置かない）', early.cancelled === false && /やめ/.test(afterEarly ?? '') && (await fs.readdir(path.join(dataDir, 'uploads', sessionId))).length === 1, String(afterEarly));
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
