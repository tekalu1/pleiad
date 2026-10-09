// 画面の殻を 1 本に束ねて返す口（GET /static-bundle。形は core/remote/static-bundle.mjs、ADR 0901）。
// 端末のプロキシが版ごとに保存し、リモートの往復を 1 回にするためのもの。ふつうの静的ファイルの応答（1 本ずつ）は変えない。
//
// 要求のたびに web/ をたどって大きさと更新時刻を見る。変わっていなければ前に作った束を使い、変わっていれば作り直す。
// web/ をディスクから読み直す開発の流れ（再起動なしで画面の変更が出る）でも、次の読み込みで新しい key になる。
// 入れるのは、静的ファイルの口が配るもののうち拡張子が MIME にあるものと、extra（/vendor/i18next.mjs）。
// index.html は配るときと同じ置き換え（pleiad-build）を済ませてから入れる。
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { encodeBundle, BUNDLE_KEY_HEADER, BUNDLE_ENCODING_HEADER, BUNDLE_MAX_BYTES } from './remote/static-bundle.mjs';

const deflateRaw = promisify(zlib.deflateRaw);
const NAME_RE = /^[A-Za-z0-9._-]+$/;

async function walk(root, rel = '') {
  const out = [];
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (!NAME_RE.test(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 *   webDir: web/ の場所、mime: 拡張子 → content-type（server.mjs の MIME）
 *   extra: () => [{ path, file, type }]（web/ の外から配るもの）
 *   transform: (urlPath, body) => body（index.html の pleiad-build の置き換え）
 */
export function createStaticBundle({ webDir, mime, extra = () => [], transform = (_p, b) => b }) {
  let cached = null;      // { sig, key, body, deflated: Promise<Buffer> | null }
  let building = null;

  async function sources() {
    const rels = (await walk(webDir)).filter(r => mime[path.extname(r)]).sort();
    const list = rels.map(r => ({ path: `/${r}`, file: path.join(webDir, ...r.split('/')), type: mime[path.extname(r)] }));
    for (const x of extra()) if (!list.some(l => l.path === x.path)) list.push(x);
    const stats = await Promise.all(list.map(l => fs.stat(l.file)));
    const sig = list.map((l, i) => `${l.path}\0${stats[i].size}\0${stats[i].mtimeMs}`).join('\n');
    return { list, sig };
  }

  async function build() {
    const { list, sig } = await sources();
    if (cached?.sig === sig) return cached;
    const files = await Promise.all(list.map(async l => ({ path: l.path, type: l.type, body: transform(l.path, await fs.readFile(l.file)) })));
    const { key, body } = encodeBundle(files);
    if (body.length > BUNDLE_MAX_BYTES) throw new Error('static bundle too large');
    cached = { sig, key, body, deflated: null };
    return cached;
  }

  /** 今の束（同時に来た要求は 1 回の組み立てを待つ）。 */
  async function current() {
    if (!building) building = build().finally(() => { building = null; });
    return building;
  }

  async function handle(req, res, url) {
    let b;
    try { b = await current(); }
    catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('static bundle unavailable');
    }
    const headers = { 'cache-control': 'no-store', [BUNDLE_KEY_HEADER]: b.key, 'x-content-type-options': 'nosniff' };
    if (url.searchParams.get('have') === b.key) { res.writeHead(304, headers); return res.end(); }
    let body = b.body;
    let encoding = 'identity';
    if (url.searchParams.get('enc') === 'deflate-raw') {
      b.deflated ??= deflateRaw(b.body, { level: 6 });
      body = await b.deflated;
      encoding = 'deflate-raw';
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', [BUNDLE_ENCODING_HEADER]: encoding, 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return { current, handle };
}
