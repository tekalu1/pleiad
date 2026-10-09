// 端末が持つ画面の殻（docs/remote.md §8.6、ADR 0901）。ホストの /static-bundle の束をホストごとに 1 つ保存し、
// 窓の読み込み（/ と /index.html）のたびに「持っている key」をホストに見せて確かめる（同じなら 304 で往復 1 回）。
// 確かめた束のファイルは、窓の静的ファイルの要求にプロキシが自分で答える。束の口が無い古いホスト・確かめられなかったときは null で、
// プロキシは今までどおりホストへ流す。保存は書きかけを残さないよう別名に書いてから置き換え、読むときは key を計算し直して確かめる。
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { RESET_CODE } from './frames.mjs';
import { BUNDLE_PATH, BUNDLE_KEY_HEADER, BUNDLE_ENCODING_HEADER, BUNDLE_MAX_BYTES, decodeBundle } from './static-bundle.mjs';

const inflateRaw = promisify(zlib.inflateRaw);
const FETCH_TIMEOUT_MS = 120_000;

/** チャネルで 1 本の GET を流し、{ status, headers, body } を返す。上限を超えたら捨てる。 */
function fetchOver(ch, reqPath, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const stream = ch.openHttp({ method: 'GET', path: reqPath, headers: {} });
    let head = null;
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { stream.reset(RESET_CODE.CANCEL); reject(new Error('static bundle: timeout')); }, timeoutMs);
    timer.unref?.();
    stream.on('response', h => { head = h; });
    stream.on('data', (chunk, release) => {
      size += chunk.length;
      if (size > BUNDLE_MAX_BYTES) { clearTimeout(timer); stream.reset(RESET_CODE.CANCEL); reject(new Error('static bundle: too large')); }
      else chunks.push(chunk);
      release();
    });
    stream.on('end', () => {
      clearTimeout(timer);
      const headers = {};
      for (const [k, v] of Object.entries(head?.headers ?? {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      resolve({ status: head?.status ?? 0, headers, body: Buffer.concat(chunks) });
    });
    stream.on('reset', code => { clearTimeout(timer); reject(Object.assign(new Error('static bundle: reset'), { code })); });
    stream.end().catch(() => {});
  });
}

/**
 *   file: 保存先（端末の置き場の下。ホストごとに 1 つ）
 */
export class StaticCache {
  constructor({ file, log = () => {} }) {
    this.file = file;
    this.log = log;
    this.bundle = null;       // { key, files }
    this.loaded = null;       // Promise
  }

  /** 保存した束を読む（1 回だけ）。無い・壊れていれば持たない。 */
  load() {
    this.loaded ??= fs.readFile(this.file).then(buf => { this.bundle = decodeBundle(buf); }, () => {}).catch(e => {
      this.log(`static cache: 保存した束を使わない (${e.message})`);   // i18n-ignore: ログは訳さない（docs/design.md「多言語対応」）
      this.bundle = null;
    });
    return this.loaded;
  }

  /** ホストに確かめ、使ってよい束を返す（使えなければ null）。ch はつながったチャネル。 */
  async check(ch) {
    await this.load();
    const have = this.bundle?.key ?? '';
    let r;
    try { r = await fetchOver(ch, `${BUNDLE_PATH}?have=${have}&enc=deflate-raw`); }
    catch (e) { this.log(`static cache: 確かめられない (${e.message})`); return null; }   // i18n-ignore: ログは訳さない
    if (r.status === 304 && this.bundle && r.headers[BUNDLE_KEY_HEADER] === have) return this.bundle;
    if (r.status !== 200) return null;   // 古いホスト（404）など
    try {
      const enc = r.headers[BUNDLE_ENCODING_HEADER] ?? 'identity';
      if (enc !== 'identity' && enc !== 'deflate-raw') throw new Error(`unknown encoding ${enc}`);
      const raw = enc === 'deflate-raw' ? await inflateRaw(r.body, { maxOutputLength: BUNDLE_MAX_BYTES }) : r.body;
      const bundle = decodeBundle(raw);
      if (r.headers[BUNDLE_KEY_HEADER] && r.headers[BUNDLE_KEY_HEADER] !== bundle.key) throw new Error('key header mismatch');
      this.bundle = bundle;
      await this.#save(raw).catch(e => this.log(`static cache: 保存できない (${e.message})`));   // i18n-ignore: ログは訳さない
      return bundle;
    } catch (e) {
      this.log(`static cache: 束を使わない (${e.message})`);   // i18n-ignore: ログは訳さない
      return null;
    }
  }

  async #save(raw) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, raw);
    await fs.rename(tmp, this.file);
  }
}
